(function () {
	var canvas = document.getElementById('map'), gpuCanvas = document.getElementById('mapgpu');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var runToInput = document.getElementById('run-to'), runToStart = document.getElementById('run-to-start');
	var seedInput = document.getElementById('seed'), layerInput = document.getElementById('layer');
	var startInput = document.getElementById('start'), loadInput = document.getElementById('load');
	var engineInput = document.getElementById('engine'), badge = document.getElementById('badge');
	var extractScratch = null;
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var perfMain = document.getElementById('perf-main'), perfKern = document.getElementById('perf-kern');
	var grid = new Grid(Params.level, Params.seed).build(), state = new State(grid, Params.seed);
	var renderer = new Renderer(canvas, state), gpuRenderer = null, playing = false, runTarget = Infinity, dirty = true, lastUpdate = 0;
	var gpu = { on: false, ready: false, busy: false };
	Sim.raster(state);
	Perf.reset();
	// Boot the selected engine on a fresh state. The GPU path builds its kernels
	// asynchronously, runs the boot raster on the device and then renders straight from
	// the arenas; the CPU mirror is only pulled back on demand (probe, save, deposits)
	// and at the event cadence inside GpuSim.step, so no per-frame readback happens.
	function bootEngine(done) {
		if (engineInput.value === 'gpu') {
			if (!navigator.gpu) {
				engineInput.value = 'cpu';
				probe.textContent = 'WebGPU is not available in this browser; staying on the CPU engine.';
				done();
				return;
			}
			gpu.on = true; gpu.ready = false;
			GpuSim.init(state, { fallback: false }).then(function () {
				GpuSim.raster(state);
				gpuRenderer = new GpuRenderer(gpuCanvas).init(state);
				gpuCanvas.hidden = false; canvas.hidden = true;
				gpu.ready = true; dirty = true;
				badge.textContent = 'GPU · L' + Params.level;
				done();
			})['catch'](function (error) {
				gpu.on = false; engineInput.value = 'cpu';
				gpuCanvas.hidden = true; canvas.hidden = false;
				badge.textContent = 'CPU · L' + Params.level;
				probe.textContent = 'GPU engine failed (' + error.message + '); back on CPU.';
				done();
			});
		} else {
			gpu.on = false; gpu.ready = false;
			gpuCanvas.hidden = true; canvas.hidden = false;
			Sim.raster(state);
			badge.textContent = 'CPU · L' + Params.level;
			done();
		}
	}
	engineInput.addEventListener('change', function () {
		setPlaying(false); runTarget = Infinity;
		Perf.reset();
		bootEngine(function () { dirty = true; });
	});
	function setPlaying(value) {
		playing = value; play.textContent = playing ? 'Pause' : 'Play';
		play.setAttribute('aria-pressed', String(playing)); step.disabled = playing;
	}
	play.addEventListener('click', function () { runTarget = Infinity; setPlaying(!playing); });
	step.addEventListener('click', function () {
		runTarget = Infinity;
		if (gpu.on && gpu.ready) {
			if (gpu.busy) return;
			gpu.busy = true;
			GpuSim.step(state, +dtInput.value, GpuSim.Events, GpuSim.Checkpoint, GpuSim.Params).then(function () {
				gpu.busy = false; dirty = true;
			})['catch'](function (error) {
				gpu.busy = false; probe.textContent = 'GPU engine error: ' + error.message;
			});
		} else {
			Sim.step(state, +dtInput.value); dirty = true;
		}
	});
	runToStart.addEventListener('click', function () {
		if (!runToInput.checkValidity()) { runToInput.reportValidity(); return; }
		runTarget = +runToInput.value;
		if (runTarget <= state.t) { probe.textContent = 'Run-to target must be later than the current time.'; return; }
		setPlaying(true);
	});
	layerInput.addEventListener('change', function () { dirty = true; });
	document.getElementById('reset').addEventListener('click', function () {
		if (!seedInput.checkValidity()) { seedInput.reportValidity(); return; }
		setPlaying(false); runTarget = Infinity;
		grid = new Grid(Params.level, +seedInput.value).build();
		state = new State(grid, +seedInput.value, startInput.value === 'hot');
		renderer.state = state;
		probe.textContent = 'Click the map to inspect a column.';
		Perf.reset();
		bootEngine(function () { dirty = true; });
	});
	document.getElementById('save').addEventListener('click', function () {
		if (gpu.on && gpu.ready) {
			GpuSim.download(state).then(saveBlob);
			return;
		}
		saveBlob();
		function saveBlob() {
			var blob = new Blob([Checkpoint.save(state)], { type: 'application/octet-stream' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
			link.download = 'planet-' + (startInput.value === 'hot' ? 'hot' : 'map') + '-' + Math.round(state.t) + 'myr.pgt';
			link.click();
			URL.revokeObjectURL(link.href);
		}
	});
	// Deposit extraction is on demand, so its scratch is allocated on first use, never per frame.
	// On the GPU engine it first pulls the mirror so the potentials are current.
	document.getElementById('deposits').addEventListener('click', function () {
		var extract = function () {
			if (!extractScratch) extractScratch = new Float64Array(grid.V);
			var blob = new Blob([Extract.json(state, 0.15, 12, extractScratch)], { type: 'application/json' });
			var link = document.createElement('a');
			link.href = URL.createObjectURL(blob);
			link.download = 'deposits-' + Math.round(state.t) + 'myr.json';
			link.click();
			URL.revokeObjectURL(link.href);
		};
		if (gpu.on && gpu.ready) { GpuSim.download(state).then(extract, extract); return; }
		extract();
	});
	loadInput.addEventListener('change', function () {
		var file = loadInput.files[0];
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			try {
				setPlaying(false); runTarget = Infinity;
				Checkpoint.load(state, new Uint8Array(reader.result));
				if (gpu.on && gpu.ready) {
					GpuSim.uploadState(state).then(function () { dirty = true; });
				} else {
					Sim.raster(state);
					dirty = true;
				}
			} catch (error) {
				probe.textContent = 'Load failed: ' + error.message;
			}
			loadInput.value = '';
		};
		reader.readAsArrayBuffer(file);
	});
	function probeAt(event, target) {
		var rect = target.getBoundingClientRect();
		var x = Math.min(grid.lookupW - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * grid.lookupW)));
		var y = Math.min(grid.lookupH - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * grid.lookupH)));
		var cell = grid.lookup[(grid.lookupH - 1 - y) * grid.lookupW + x], owner = state.owner[cell];
		if (owner < 0) { probe.textContent = 'Cell ' + cell + ' · uncovered gap, ' + state.gapFrames[cell] + ' frames old.'; return; }
		var rank = 0, names = ['interior', 'transform', 'divergent', 'subduction', 'collision'];
		for (var k = 0; k < grid.ringN[cell]; k++) {
			var e = cell * 6 + k, t = state.edgeType[e], r = t === 1 && state.polarity[e] === 2 ? 4 : t === 1 ? 3 : t === 2 ? 2 : t === 3 ? 1 : 0;
			if (r > rank) rank = r;
		}
		var speed = Math.hypot(state.vel[cell * 3], state.vel[cell * 3 + 1], state.vel[cell * 3 + 2]) / 10000;
		var plate = state.plate[owner];
		probe.textContent = 'Cell ' + cell + ' · column ' + owner + ' · plate ' + (plate + 1) +
			' (born ' + state.plateBirth[plate].toFixed(0) + ' Myr from ' + (state.plateParent[plate] + 1) + ')' +
			'\n' + speed.toFixed(2) + ' cm/yr · ' + names[rank] + ' · trenchDist ' + state.trenchDist[cell] +
			'\nFelsic ' + (state.hFel[owner] / 1000).toFixed(1) + ' km · mafic ' + (state.hMaf[owner] / 1000).toFixed(1) +
			' km · sediment ' + (state.hSed[owner] / 1000).toFixed(1) + ' km' +
			'\nAge ' + state.age[owner].toFixed(1) + ' Myr · elevation ' + Math.round(state.z[cell]) +
			' m · slope ' + (state.slope[cell] * 100).toFixed(2) + '% · damage ' + state.damage[owner].toFixed(2) +
			'\n' + (state.wet[cell] ? 'wet' : 'land') + ' · dynamic ' + Math.round(state.zDyn[owner]) + ' m' +
			'\nOres VMS ' + state.oVms[owner].toFixed(2) + ' · mafic ' + state.oMaf[owner].toFixed(2) +
			' · arc ' + state.oArc[owner].toFixed(2) + ' · oro ' + state.oOro[owner].toFixed(2) +
		' · basin ' + state.oBas[owner].toFixed(2) + ' · placer ' + state.oPla[owner].toFixed(2) +
		' · fert ' + state.fert[owner].toFixed(2);
	}
	// The inspector reads the CPU state, so on the GPU engine a click first pulls the mirror
	// back (one readback, on demand only) and then reports from it.
	function probeClick(event) {
		if (gpu.on && gpu.ready) {
			GpuSim.download(state).then(function () { probeAt(event, event.currentTarget); });
			return;
		}
		probeAt(event, event.currentTarget);
	}
	canvas.addEventListener('click', probeClick);
	gpuCanvas.addEventListener('click', probeClick);
	function frame(now) {
		var dt = +dtInput.value, steps = 0;
		if (playing) {
			steps = +speedInput.value;
			if (runTarget < Infinity) steps = Math.min(steps, Math.max(0, Math.ceil((runTarget - state.t) / dt - 1e-9)));
			if (steps > 0) {
				if (gpu.on && gpu.ready) {
					// Frames submit to the device without any readback; only the event
					// cadence inside GpuSim.step pulls the mirror back to the CPU.
					if (!gpu.busy) {
						gpu.busy = true;
						GpuSim.advance(state, dt, steps).then(function () {
							gpu.busy = false; dirty = true;
						})['catch'](function (error) {
							gpu.busy = false; setPlaying(false);
							probe.textContent = 'GPU engine error: ' + error.message;
						});
					}
				} else {
					Sim.advance(state, dt, steps); dirty = true;
				}
			}
			if (runTarget < Infinity && state.t >= runTarget - dt * 0.5) {
				runTarget = Infinity; setPlaying(false);
			}
		}
		if (dirty) {
			if (gpu.on && gpu.ready) gpuRenderer.draw(layerInput.value);
			else renderer.draw(layerInput.value);
			dirty = false;
		}
		Perf.frame(now, steps, dt);
		if (Perf.due(now)) {
			Perf.update(now);
			perfMain.textContent = Perf.text;
			if (gpu.on && gpu.ready) {
				GpuSim.tsCollect();
				var ts = GpuSim.tsReport();
				perfKern.textContent = (ts ? ts + ' · ' : 'no kernel timing · ')
					+ 'CPU mirror one event cycle old';
			} else {
				perfKern.textContent = Perf.detail;
			}
		}
		if (now - lastUpdate > 150) {
			time.textContent = state.t.toFixed(1) + ' Myr';
			status.textContent = (state.meanSpeed / 10000).toFixed(2) + ' cm/yr · Tm ' + state.Tm.toFixed(2)
				+ ' · ' + state.plateCount + ' plates · ' + state.splits + '↔ ' + state.merges + '⇄';
			lastUpdate = now;
		}
		requestAnimationFrame(frame);
	}
	if (/[?&]bench=1/.test(location.search)) {
		// The benchmark lives in its own page (bench.html — the climate-repo GUI
		// pattern): redirect, preserving the level/dt/steps query overrides.
		var extra = location.search.slice(1).replace('bench=1', '').replace(/^&/, '');
		location.replace('bench.html' + (extra ? '?' + extra : ''));
	} else {
		requestAnimationFrame(frame);
	}
}());

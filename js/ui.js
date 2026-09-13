(function () {
	var canvas = document.getElementById('map'), gpuCanvas = document.getElementById('mapgpu');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var runToInput = document.getElementById('run-to'), runToStart = document.getElementById('run-to-start');
	var seedInput = document.getElementById('seed'), layerInput = document.getElementById('layer');
	var startInput = document.getElementById('start'), loadInput = document.getElementById('load');
	var engineInput = document.getElementById('engine'), badge = document.getElementById('badge');
	var levelInput = document.getElementById('level'), gridInfo = document.getElementById('grid-info');
	var extractScratch = null;
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var perfStrip = document.getElementById('perf-rows'), copyPerf = document.getElementById('copy-perf');
	// ?level= / ?seed= / ?engine= / ?dt= / ?steps= pre-fill the world controls, so a capture
	// request can name the run it wants (index.html?level=7&engine=gpu) instead of describing
	// clicks - the affordance bench.html already has, and the reason its runs are repeatable
	// from a log line. A level the select does not offer is ignored rather than built: Grid
	// takes 0-7, so a stray ?level=9 would throw before the page drew anything.
	var query = new URLSearchParams(location.search);
	function offeredLevel(level) {
		for (var i = 0; i < levelInput.options.length; i++) {
			if (+levelInput.options[i].value === level) return true;
		}
		return false;
	}
	if (offeredLevel(+query.get('level'))) Params.level = +query.get('level');
	if (query.get('seed')) Params.seed = +query.get('seed') >>> 0;
	var grid = new Grid(Params.level, Params.seed).build(), state = new State(grid, Params.seed);
	var renderer = new Renderer(canvas, state), gpuRenderer = null, playing = false, runTarget = Infinity, dirty = true, lastUpdate = 0;
	// Frames the GPU play path has actually submitted since the last rAF: the strip counts
	// real work, not the frames that were requested while a round trip held the queue.
	var ran = 0;
	// `pending` is the in-flight play/step promise, `busy` the frame loop's own guard. They are
	// not the same thing: a rebuild has to wait for the transfer to settle, because it swaps the
	// grid, the state and the device arenas underneath it (see whenGpuIdle).
	var gpu = { on: false, ready: false, busy: false, pending: null };
	levelInput.value = String(Params.level);
	seedInput.value = String(Params.seed);
	if (query.get('dt')) dtInput.value = query.get('dt');
	if (query.get('steps')) speedInput.value = query.get('steps');
	if (query.get('engine')) engineInput.value = query.get('engine');
	Sim.raster(state);
	Perf.reset();
	function paintBadge() {
		badge.textContent = (gpu.on && gpu.ready ? 'GPU · L' : 'CPU · L') + grid.level;
	}
	// The map-top line carries the resolution the design quotes (0.1.5 §1): the cell count and
	// the edge of an equal-area cell, 223 / 112 / 56 km at L5 / L6 / L7.
	function paintGrid() {
		var km = Math.sqrt(4 * Math.PI * Params.radius * Params.radius / grid.V) / 1000;
		gridInfo.textContent = 'EQUIRECTANGULAR / ' + grid.V.toLocaleString() + ' CELLS / '
			+ Math.round(km) + ' KM';
	}
	// Every path that rebuilds the world or the engine waits for the in-flight GPU transfer
	// first. GpuSim.init releases the arenas a transfer is sized against, and a mirror that
	// lands after the swap would write the new world's buffers from the old world's numbers -
	// the frame loop is already paused and `busy` refuses a new Step click, so nothing else can
	// start in between.
	function whenGpuIdle(done) {
		var inflight = gpu.pending;
		gpu.pending = null;
		if (!inflight) { done(); return; }
		inflight.then(done, done);
	}
	// One world rebuild, shared by the Resolution select, Reset world and Load: the columns are
	// Lagrangian on one grid, so a different level is a different world and there is nothing to
	// carry over. `after` runs once the engine is ready on the new world.
	function rebuildWorld(level, seed, hot, after) {
		Params.level = level;
		grid = new Grid(level, seed).build();
		state = new State(grid, seed, hot);
		renderer = new Renderer(canvas, state);
		extractScratch = null;   // sized to the old grid.V
		levelInput.value = String(level);
		seedInput.value = String(seed);
		paintGrid();
		probe.textContent = 'Click the map to inspect a column.';
		Perf.reset();
		bootEngine(function () {
			dirty = true;
			if (after) after();
		});
	}
	function rebuildWhenIdle(level, seed, hot, after) {
		setPlaying(false); runTarget = Infinity;
		whenGpuIdle(function () { rebuildWorld(level, seed, hot, after); });
	}
	// Boot the selected engine on a fresh state. The GPU path builds its kernels
	// asynchronously, runs the boot raster on the device and then renders straight from
	// the arenas; the CPU mirror is only pulled back on demand (probe, save, deposits)
	// and at the event cadence inside GpuSim.play, so no per-frame readback happens.
	function bootEngine(done) {
		if (engineInput.value === 'gpu') {
			if (!navigator.gpu) {
				engineInput.value = 'cpu';
				probe.textContent = 'WebGPU is not available in this browser; staying on the CPU engine.';
				done();
				return;
			}
			gpu.on = true; gpu.ready = false;
			// The device outlives the world: a level switch re-inits the arenas on it rather
			// than asking for a second adapter (the bench's one-planet-per-level does the same).
			GpuSim.init(state, { device: GpuSim.device, fallback: false }).then(function () {
				GpuSim.raster(state);
				gpuRenderer = new GpuRenderer(gpuCanvas).init(state);
				gpuCanvas.hidden = false; canvas.hidden = true;
				gpu.ready = true; dirty = true;
				paintBadge();
				done();
			})['catch'](function (error) {
				gpu.on = false; engineInput.value = 'cpu';
				gpuCanvas.hidden = true; canvas.hidden = false;
				paintBadge();
				probe.textContent = 'GPU engine failed (' + error.message + '); back on CPU.';
				done();
			});
		} else {
			gpu.on = false; gpu.ready = false;
			gpuCanvas.hidden = true; canvas.hidden = false;
			Sim.raster(state);
			paintBadge();
			done();
		}
	}
	engineInput.addEventListener('change', function () {
		setPlaying(false); runTarget = Infinity;
		Perf.reset();
		whenGpuIdle(function () { bootEngine(function () { dirty = true; }); });
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
			gpu.pending = GpuSim.step(state, +dtInput.value, GpuSim.Events, GpuSim.Checkpoint, GpuSim.Params).then(function () {
				gpu.busy = false; dirty = true;
			})['catch'](function (error) {
				gpu.busy = false; console.error('GPU engine error', error);
				probe.textContent = 'GPU engine error: ' + error.message;
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
		rebuildWhenIdle(grid.level, +seedInput.value, startInput.value === 'hot');
	});
	// A new resolution is a new world: same seed and start, rebuilt from scratch, because the
	// crust lives on columns of one particular grid and nothing carries across grids.
	levelInput.addEventListener('change', function () {
		if (!seedInput.checkValidity()) { seedInput.reportValidity(); levelInput.value = String(grid.level); return; }
		var level = +levelInput.value;
		// The CPU engine is the calibrated L5 path (design 0.1.5 §1); it runs L6-L7 too, at a
		// few frames per second, and saying so once beats looking like a hang.
		var slow = level > 5 && engineInput.value === 'cpu';
		rebuildWhenIdle(level, +seedInput.value, startInput.value === 'hot', slow ? function () {
			probe.textContent = 'L' + level + ' on the CPU engine runs at a few frames/s; L6-L7 are the WebGPU path.';
		} : null);
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
			loadInput.value = '';
			var bytes = new Uint8Array(reader.result), head;
			try { head = Checkpoint.peek(bytes); }
			catch (error) { probe.textContent = 'Load failed: ' + error.message; return; }
			if (!offeredLevel(head.level)) {
				probe.textContent = 'Load failed: that world is L' + head.level + ', this page offers L5-L7.';
				return;
			}
			// The blob carries the level and seed it was written at, so the world is rebuilt to
			// match and then restored into it: with a Resolution select a mismatch is the normal
			// case, not a corrupt file, and "checkpoint level 5" is not an instruction.
			rebuildWhenIdle(head.level, head.seed, startInput.value === 'hot', function () {
				try {
					Checkpoint.load(state, bytes);
					probe.textContent = 'Loaded L' + head.level + ' seed ' + head.seed + ' at t '
						+ state.t.toFixed(1) + ' Myr.';
					if (gpu.on && gpu.ready) {
						GpuSim.uploadState(state).then(function () { dirty = true; });
					} else {
						Sim.raster(state);
						dirty = true;
					}
				} catch (error) {
					probe.textContent = 'Load failed: ' + error.message;
				}
			});
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
	// The perf strip is one row per part of the report (Perf.rows), plus the kernel line:
	// on the GPU engine that is the device's own timestamp table, on the CPU engine the
	// per-kernel JS laps Perf already folded in. Rows are rebuilt at 2 Hz, never per frame.
	function stripRows() {
		if (!(gpu.on && gpu.ready)) return Perf.rows;
		GpuSim.tsCollect();
		var ts = GpuSim.tsReport(), rows = Perf.rows.slice();
		rows[Perf.SLOT.KERNELS] = ts ? ts + ' · CPU mirror one event cycle old'
			: 'no kernel timing (the adapter lacks timestamp-query) · CPU mirror one event cycle old';
		return rows;
	}
	// One span per slot, created once: appending and removing row elements at 2 Hz is what made
	// the strip flicker and everything under it reflow, since the parts come and go (an event
	// window, a checkpoint) and the row count moved the strip's height. style.css reserves one
	// line track per slot, so rewriting text in place cannot move the page at all.
	function mountStrip() {
		while (perfStrip.children.length < Perf.SLOTS) perfStrip.appendChild(document.createElement('span'));
		while (perfStrip.children.length > Perf.SLOTS) perfStrip.removeChild(perfStrip.lastChild);
	}
	function showStrip(rows) {
		for (var i = 0; i < perfStrip.children.length; i++) perfStrip.children[i].textContent = rows[i] || '';
	}
	// The capture an agent session needs, in one paste: which engine and world the numbers
	// came from, then the strip exactly as it reads on screen.
	function perfReport() {
		return 'engine ' + (gpu.on && gpu.ready ? 'gpu' : 'cpu') + ' · L' + grid.level
			+ ' · dt ' + dtInput.value + ' · ' + speedInput.value + ' steps/frame · view ' + layerInput.value
			+ ' · ' + startInput.value + ' start · seed ' + seedInput.value
			+ '\n' + Perf.report(stripRows())
			+ '\nt ' + state.t.toFixed(1) + ' Myr · ' + badge.textContent;
	}
	Clipboard.bind(copyPerf, perfReport);

	function frame(now) {
		var dt = +dtInput.value, steps = 0;
		if (playing) {
			steps = +speedInput.value;
			if (runTarget < Infinity) steps = Math.min(steps, Math.max(0, Math.ceil((runTarget - state.t) / dt - 1e-9)));
			if (steps > 0) {
				if (gpu.on && gpu.ready) {
					// Frames submit to the device without any readback; only the event
					// cadence inside GpuSim.play pulls the mirror back to the CPU.
					if (!gpu.busy) {
						gpu.busy = true;
						gpu.pending = GpuSim.play(state, dt, steps).then(function (done) {
							gpu.busy = false; ran += done; dirty = true;
						})['catch'](function (error) {
							gpu.busy = false; setPlaying(false);
							// The probe line is easy to miss and the loop stops dead here, so
							// the stack goes to the console too: an engine error must reach a log.
							console.error('GPU engine error', error);
							probe.textContent = 'GPU engine error: ' + error.message;
						});
					}
				} else {
					Sim.advance(state, dt, steps); ran += steps; dirty = true;
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
		Perf.frame(now, ran, dt); ran = 0;
		if (Perf.due(now)) {
			Perf.update(now);
			showStrip(stripRows());
		}
		if (now - lastUpdate > 150) {
			time.textContent = state.t.toFixed(1) + ' Myr';
			status.textContent = (state.meanSpeed / 10000).toFixed(2) + ' cm/yr · Tm ' + state.Tm.toFixed(2)
				+ ' · ' + state.plateCount + ' plates · ' + state.splits + '↔ ' + state.merges + '⇄';
			lastUpdate = now;
		}
		requestAnimationFrame(frame);
	}
	paintGrid();
	paintBadge();
	mountStrip();
	// The page's own default is the CPU engine, whose world is already rastered; a prefilled
	// ?engine=gpu has to boot the device before a frame tries to draw from it.
	if (engineInput.value === 'gpu') bootEngine(function () { dirty = true; });
	if (/[?&]bench=1/.test(location.search)) {
		// The benchmark lives in its own page (bench.html — the climate-repo GUI
		// pattern): redirect, preserving the level/dt/steps query overrides.
		var extra = location.search.slice(1).replace('bench=1', '').replace(/^&/, '');
		location.replace('bench.html' + (extra ? '?' + extra : ''));
	} else {
		requestAnimationFrame(frame);
	}
}());

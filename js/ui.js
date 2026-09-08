(function () {
	var canvas = document.getElementById('map');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var seedInput = document.getElementById('seed'), layerInput = document.getElementById('layer');
	var startInput = document.getElementById('start'), loadInput = document.getElementById('load');
	var extractScratch = null;
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var perfMain = document.getElementById('perf-main'), perfKern = document.getElementById('perf-kern');
	var grid = new Grid(Params.level, Params.seed).build(), state = new State(grid, Params.seed);
	var renderer = new Renderer(canvas, state), playing = false, dirty = true, lastUpdate = 0;
	Sim.raster(state);
	Perf.reset();
	function setPlaying(value) {
		playing = value; play.textContent = playing ? 'Pause' : 'Play';
		play.setAttribute('aria-pressed', String(playing)); step.disabled = playing;
	}
	play.addEventListener('click', function () { setPlaying(!playing); });
	step.addEventListener('click', function () { Sim.step(state, +dtInput.value); dirty = true; });
	layerInput.addEventListener('change', function () { dirty = true; });
	document.getElementById('reset').addEventListener('click', function () {
		if (!seedInput.checkValidity()) { seedInput.reportValidity(); return; }
		setPlaying(false);
		grid = new Grid(Params.level, +seedInput.value).build();
		state = new State(grid, +seedInput.value, startInput.value === 'hot');
		renderer.state = state;
		Sim.raster(state); dirty = true; probe.textContent = 'Click the map to inspect a column.';
		Perf.reset();
	});
	document.getElementById('save').addEventListener('click', function () {
		var blob = new Blob([Checkpoint.save(state)], { type: 'application/octet-stream' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'planet-' + (startInput.value === 'hot' ? 'hot' : 'map') + '-' + Math.round(state.t) + 'myr.pgt';
		link.click();
		URL.revokeObjectURL(link.href);
	});
	// Deposit extraction is on demand, so its scratch is allocated on first use, never per frame.
	document.getElementById('deposits').addEventListener('click', function () {
		if (!extractScratch) extractScratch = new Float64Array(grid.V);
		var blob = new Blob([Extract.json(state, 0.15, 12, extractScratch)], { type: 'application/json' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'deposits-' + Math.round(state.t) + 'myr.json';
		link.click();
		URL.revokeObjectURL(link.href);
	});
	loadInput.addEventListener('change', function () {
		var file = loadInput.files[0];
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			try {
				setPlaying(false);
				Checkpoint.load(state, new Uint8Array(reader.result));
				Sim.raster(state);
				dirty = true;
			} catch (error) {
				probe.textContent = 'Load failed: ' + error.message;
			}
			loadInput.value = '';
		};
		reader.readAsArrayBuffer(file);
	});
	canvas.addEventListener('click', function (event) {
		var rect = canvas.getBoundingClientRect();
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
	});
	function frame(now) {
		var dt = +dtInput.value, steps = 0;
		if (playing) { steps = +speedInput.value; Sim.advance(state, dt, steps); dirty = true; }
		if (dirty) { renderer.draw(layerInput.value); dirty = false; }
		Perf.frame(now, steps, dt);
		if (Perf.due(now)) {
			Perf.update(now);
			perfMain.textContent = Perf.text;
			perfKern.textContent = Perf.detail;
		}
		if (now - lastUpdate > 150) {
			time.textContent = state.t.toFixed(1) + ' Myr';
			status.textContent = (state.meanSpeed / 10000).toFixed(2) + ' cm/yr · Tm ' + state.Tm.toFixed(2)
				+ ' · ' + state.plateCount + ' plates · ' + state.splits + '↔ ' + state.merges + '⇄';
			lastUpdate = now;
		}
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
}());

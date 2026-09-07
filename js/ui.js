(function () {
	var canvas = document.getElementById('map');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var seedInput = document.getElementById('seed'), layerInput = document.getElementById('layer');
	var time = document.getElementById('time'), gaps = document.getElementById('gaps'), probe = document.getElementById('probe');
	var grid = new Grid(Params.level, Params.seed).build(), state = new State(grid, Params.seed);
	var renderer = new Renderer(canvas, state), playing = false, dirty = true, lastUpdate = 0;
	Sim.raster(state);
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
		// The seed controls both the land mask and the plate initialization.
		grid = new Grid(Params.level, +seedInput.value).build();
		state = new State(grid, +seedInput.value); renderer.state = state;
		Sim.raster(state); dirty = true; probe.textContent = 'Click the map to inspect a column.';
	});
	canvas.addEventListener('click', function (event) {
		var rect = canvas.getBoundingClientRect();
		var x = Math.min(grid.lookupW - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * grid.lookupW)));
		var y = Math.min(grid.lookupH - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * grid.lookupH)));
		var cell = grid.lookup[(grid.lookupH - 1 - y) * grid.lookupW + x], owner = state.owner[cell];
		if (owner < 0) { probe.textContent = 'Cell ' + cell + ' · uncovered. Crust creation is not implemented yet.'; return; }
		probe.textContent = 'Cell ' + cell + ' · column ' + owner + ' · plate ' + (state.plate[owner] + 1) + '\nFelsic ' + (state.hFel[owner] / 1000).toFixed(1) + ' km · mafic ' + (state.hMaf[owner] / 1000).toFixed(1) + ' km\nAge ' + state.age[owner].toFixed(1) + ' Myr · elevation ' + Math.round(state.z[cell]) + ' m';
	});
	function frame(now) {
		if (playing) { Sim.advance(state, +dtInput.value, +speedInput.value); dirty = true; }
		if (dirty) { renderer.draw(layerInput.value); dirty = false; }
		if (now - lastUpdate > 150) {
			time.textContent = state.t.toFixed(1) + ' Myr';
			gaps.textContent = (100 * state.gaps / grid.V).toFixed(1) + '% uncovered';
			lastUpdate = now;
		}
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
}());

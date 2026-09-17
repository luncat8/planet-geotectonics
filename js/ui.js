(function () {
	var canvas = document.getElementById('map'), gpuCanvas = document.getElementById('mapgpu');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var cadenceInput = document.getElementById('cadence');
	var runToInput = document.getElementById('run-to'), runToStart = document.getElementById('run-to-start');
	var seedInput = document.getElementById('seed'), layerGroup = document.getElementById('layer');
	var currentLayer = 'plate';
	function layerValue() { return currentLayer; }
	// One writer for the view mode: click, keyboard and hover all land here.
	function setLayer(value) { if (currentLayer === value) return; currentLayer = value; dirty = true; }
	var startInput = document.getElementById('start'), loadInput = document.getElementById('load');
	var followInput = document.getElementById('follow');
	var engineInput = document.getElementById('engine'), badge = document.getElementById('badge');
	var coolingInput = document.getElementById('cooling'), tmInput = document.getElementById('tm');
	var frictionInput = document.getElementById('friction'), eroInput = document.getElementById('ero');
	var reliefInput = document.getElementById('relief');
	var seaInput = document.getElementById('sea'), seaVolInput = document.getElementById('sea-vol');
	var tmValue = document.getElementById('tm-value'), frictionValue = document.getElementById('friction-value');
	var eroValue = document.getElementById('ero-value'), reliefValue = document.getElementById('relief-value');
	var seaValue = document.getElementById('sea-value'), seaVolValue = document.getElementById('sea-vol-value');
	var v3dInput = document.getElementById('v3d'), map3d = document.getElementById('map3d');
	var dispInput = document.getElementById('disp'), k3dInput = document.getElementById('k3d');
	var dispValue = document.getElementById('disp-value');
	// Sea controls (0.3.5): two sliders, one active - the last one touched takes the level
	// and greys the other. The level slider writes Params.sea directly (a recolour on both
	// engines); the volume slider names a conserved quantity (x of the sea-0 volume V0) and
	// the level is solved from the hypsometric histogram. There is no mode flag: the two
	// defaults agree (0 km = 1.00x), so the first-paint coast is the same whichever slider
	// is active. waterArmed defers the volume solve to the frame loop (one per rAF at most,
	// input events fire faster); waterDirty marks a changed bathymetry for the 2 Hz tick.
	var waterActive = 'level', waterArmed = false, waterDirty = true, waterData = null;
	function seaKm(sea) { return (sea >= 0 ? '+' : '') + (sea / 1000).toFixed(1); }
	var levelInput = document.getElementById('level'), gridInfo = document.getElementById('grid-info');
	var levelLabel = levelInput.parentNode, speedLabel = speedInput.parentNode;
	var extractScratch = null;
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var perfStrip = document.getElementById('perf-rows');
	// --- Adjust: the live sliders (0.3.3) --------------------------------------------------
	// Four knobs that apply mid-play on both engines with no restart: the mantle temperature
	// and its cooling switch (state), the asthenosphere friction and the erosion scale (Params,
	// carried to the kernels through frameIn), and the elevation ramp (the renderers only).
	// The knobs' compiled defaults, read before any pre-fill writes them: the copy header
	// reports only what differs from these, and Params is written in place so there is no
	// pristine copy left by the time it is asked.
	var ADJ_DEFAULTS = { friction: Params.friction, eroScale: Params.eroScale, zRange: Params.zRange };
	// The readouts are rewritten at 2 Hz by the Tm follow, so they are fixed-width (tabular
	// digits, min-width in style.css): a number that changes width would move the label.
	function paintAdjust() {
		tmValue.textContent = (+tmInput.value).toFixed(2);
		frictionValue.textContent = (+frictionInput.value).toFixed(2);
		eroValue.textContent = (+eroInput.value).toFixed(2);
		reliefValue.textContent = (+reliefInput.value).toFixed(1) + ' km';
		seaValue.textContent = seaKm(Params.sea) + ' km';
		// The volume readout always carries the solved level: that is the quantity the map
		// actually uses, and it is what the inactive control keeps, dimmed, while greyed.
		// The clamps are named: x = 0 is a dry planet, past full submersion a flooded one.
		var volText = (+seaVolInput.value).toFixed(2) + '×';
		if (waterData) volText += waterData.level <= Water.ZLO ? ' · dry'
			: waterData.level >= Water.ZHI ? ' · flooded'
			: ' · ' + seaKm(waterData.level) + ' km';
		seaVolValue.textContent = volText;
		seaInput.parentNode.classList[waterActive === 'level' ? 'remove' : 'add']('off');
		seaVolInput.parentNode.classList[waterActive === 'volume' ? 'remove' : 'add']('off');
	}
	// The follow waits for the hand, not for the focus: a range input keeps focus after a drag,
	// so gating the rewrite on `document.activeElement` left the control stuck on the value it
	// was last touched at until the user clicked somewhere else. A touch of the control arms the
	// hold and the strip's own ticks retire it, so a thumb under the pointer is never rewritten
	// and an idle control is back on the sim a second later. The page's own writes - a
	// pre-fill, a rebuild, a load - do not arm it: a fresh page follows from its first tick.
	var TM_FOLLOW_HOLD = 2, tmFollowHold = 0;
	function holdTmFollow() { tmFollowHold = TM_FOLLOW_HOLD; }
	// The Tm control writes the world's temperature and re-anchors the cooling baseline so the
	// curve leaves from the slider (Mantle.setTm); it is the only writer of either, so moving
	// friction or the ramp cannot nudge the temperature by way of the slider's rounding.
	function applyTm() {
		Mantle.setTm(state, +tmInput.value);
		paintAdjust();
	}
	// One direction, one writer: every path that moves the other three sliders - a pointer, a
	// keyboard, a ?-pre-fill - lands the control's value on its consumer through here.
	function applyAdjust() {
		Params.friction = +frictionInput.value;
		Params.eroScale = +eroInput.value;
		var range = +reliefInput.value * 1000;
		// The ramp is read per draw by both renderers; a range change is a recolour, not a
		// view move, so it sets `dirty` (the frame loop's draw), never applyView.
		if (range !== Params.zRange) { Params.zRange = range; dirty = true; }
		paintAdjust();
	}
	// The other direction, for the paths that hand the page a world it did not set: a rebuild
	// starts on the new world's own start temperature, and Load takes the temperature and the
	// cooling flag from the blob. The Params knobs are global settings and carry over.
	// Water controls are display-only. The level slider writes the level in its own handler;
	// the volume solve is deferred to the frame loop (one per rAF at most - input events fire
	// faster, and the L7 solve is ~2 ms) and re-run by the 2 Hz tick while the volume slider
	// is active, so the coast tracks the moving bathymetry. Never in the simulation hot loop.
	function applySeaLevel() {
		waterActive = 'level'; waterArmed = false; waterDirty = false;
		// A recolour, not a view move: `dirty` is the frame loop's draw gate on both engines.
		Params.sea = +seaInput.value * 1000;
		dirty = true;
		paintAdjust();
	}
	function solveWater() {
		waterData = Water.fromElevations(state.z, +seaVolInput.value);
		Params.sea = waterData.level; Params.seaVolScale = +seaVolInput.value;
		waterArmed = false; waterDirty = false;
		dirty = true;
		paintAdjust();
	}
	function armSeaVolume() { waterActive = 'volume'; waterArmed = true; paintAdjust(); }
	seaInput.addEventListener('input', applySeaLevel);
	seaVolInput.addEventListener('input', armSeaVolume);

	// --- 3D view (0.5.0) -------------------------------------------------------------------
	// A WebGPU render of the same world the map shows: an icosphere displaced by the
	// segment-final heights, a sea shell at Params.sea, one light. The session borrows
	// the GPU engine's device (the gather binds cellF) or boots a render-only one and
	// takes state.z per frame (cellZ upload); either way the sim is untouched. Orbit and
	// zoom are uniform writes, so unlike the 2D view they never defer a sim step.
	var v3d = { on: false, busy: false, r3d: null }, v3dToken = 0;
	var v3dDisp = 10, v3dK = 8, v3dYaw = 0.65, v3dPitch = 0.42, v3dDist = 3;
	var V3D_KS = [6, 7, 8, 9];
	function paintV3d() { dispValue.textContent = v3dDisp.toFixed(1) + '×'; }
	function applyDisp() {
		v3dDisp = +dispInput.value;
		if (v3d.r3d) v3d.r3d.exag = v3dDisp;
		paintV3d();
		if (v3d.on) dirty = true;
	}
	function applyK3d() {
		var k = +k3dInput.value;
		// An unoffered k (a stray ?k3d= or a cleared select) lands back on the default.
		if (V3D_KS.indexOf(k) < 0) { k3dInput.value = '8'; k = 8; }
		v3dK = k;
		if (v3d.on) { releaseV3d(); setV3d(true); }   // a one-time mesh rebuild, not a world rebuild
	}
	function releaseV3d() {
		if (v3d.r3d) { v3d.r3d.release(); v3d.r3d = null; }
		v3d.on = false;
		map3d.hidden = true;
		// The engine's own canvas takes the map slot back (bootEngine keeps it that way).
		(gpu.on && gpu.ready ? gpuCanvas : canvas).hidden = false;
		layerGroup.classList.remove('off');
	}
	// The boot itself, minus the user-path gates: the engine (and its device) is final
	// when this runs. `token` voids a boot that a toggle-off or a re-init overtook.
	function bootV3dNow(done) {
		var token = ++v3dToken;
		v3d.busy = true;
		var r3d = new Render3D(map3d);
		var gpuMode = gpu.on && gpu.ready;
		var opts = gpuMode
			? { device: GpuSim.S.device, k: v3dK, look: GpuSim.S.buf.lookup, V: grid.V, zSource: 'cellF', cellF: GpuSim.S.buf.cellF, lw: grid.lookupW, lh: grid.lookupH }
			: { device: null, k: v3dK, look: grid.lookup, V: grid.V, zSource: 'cellZ', lw: grid.lookupW, lh: grid.lookupH };
		var finish = function (error) {
			if (token !== v3dToken) { if (!error && r3d.target) r3d.release(); return; }
			v3d.busy = false;
			if (error) {
				v3dInput.checked = false;
				probe.textContent = '3D view failed (' + error.message + '); the 2D map stays.';
				dirty = true;
			} else {
				r3d.exag = v3dDisp;
				v3d.r3d = r3d; v3d.on = true;
				map3d.hidden = false; canvas.hidden = true; gpuCanvas.hidden = true;
				layerGroup.classList.add('off');
				probe.textContent = '3D on · k' + v3dK + ' · ' + r3d.vCount.toLocaleString() + ' vertices · drag orbits, wheel zooms.';
			}
			if (token === v3dToken) done(error);
		};
		if (opts.device) {
			try { r3d.init(opts); } catch (error) { finish(error); return; }
			finish(null);
			return;
		}
		// CPU engine: the render-only device the sim never needed. Default limits hold
		// (the fattest mesh is 94 MB of buffers); no feature asks beyond the base set.
		navigator.gpu.requestAdapter().then(function (adapter) {
			if (!adapter) { finish(new Error('no WebGPU adapter')); return; }
			adapter.requestDevice().then(function (device) {
				if (token !== v3dToken) { finish(new Error('superseded')); return; }
				opts.device = device;
				try { r3d.init(opts); } catch (error) { finish(error); return; }
				finish(null);
			}, finish);
		}, finish);
	}
	function setV3d(on) {
		if (v3d.busy) { v3dInput.checked = v3d.on; return; }
		if (!on) { releaseV3d(); dirty = true; return; }
		if (!navigator.gpu) {
			v3dInput.checked = false; v3dInput.disabled = true;
			probe.textContent = 'WebGPU is not available in this browser; the 3D view needs it.';
			return;
		}
		if (switching) {
			v3dInput.checked = false;
			probe.textContent = 'Wait for the engine switch, then try the 3D view again.';
			return;
		}
		// An in-flight GPU transfer may be sizing buffers this boot would borrow.
		whenGpuIdle(function () { bootV3dNow(function () { dirty = true; }); });
	}
	// Called from bootEngine's completion: the engine settled on some device, so a 3D
	// that was on (or was prefilled on) re-inits against the new world. Release first -
	// a level switch resizes cellZ and a GPU switch swaps the very device under the
	// gather's bind group (the 0.3.4 leak lesson).
	function rebootV3d() {
		var want = v3dInput.checked || v3d.on;
		releaseV3d();
		if (!want) return;
		if (!navigator.gpu) {
			v3dInput.checked = false; v3dInput.disabled = true;
			probe.textContent = 'WebGPU is not available in this browser; the 3D view needs it.';
			return;
		}
		bootV3dNow(function () { dirty = true; });
	}
	v3dInput.addEventListener('change', function () { setV3d(v3dInput.checked); });
	dispInput.addEventListener('input', applyDisp);
	k3dInput.addEventListener('change', applyK3d);

	function syncAdjust() {
		coolingInput.checked = state.cooling === 1;
		tmInput.value = state.Tm.toFixed(2);
		paintAdjust();
	}
	// The capture's own record of the sliders: only what differs from the defaults is
	// printed, and the line's own query (?tm=1.2&cool=0&fric=1.4&ero=0.6&relief=9) names
	// the settings a re-run needs.
	function adjustReport() {
		// The temperature and its switch are one part: "Tm 1.20 cooling off" reads as what it
		// is - the world's temperature and whether it is still decaying. A pinned world names
		// its temperature even when the baseline never moved (cooling was switched off
		// mid-run), because that is the setting a re-run has to be told.
		var parts = [], tm = [];
		var moved = state.Tm0 !== (state.hotStart ? Params.TmHot : Params.Tm0);
		if (moved || state.cooling !== 1) tm.push('Tm ' + state.Tm.toFixed(2));
		if (state.cooling !== 1) tm.push('cooling off');
		if (tm.length) parts.push(tm.join(' '));
		if (Params.friction !== ADJ_DEFAULTS.friction) parts.push('friction ' + Params.friction + 'x');
		if (Params.eroScale !== ADJ_DEFAULTS.eroScale) parts.push('erosion ' + Params.eroScale + 'x');
		if (Params.zRange !== ADJ_DEFAULTS.zRange) parts.push('relief ' + (Params.zRange / 1000).toFixed(1) + ' km');
		// Whichever slider is active names the control that produced the world; the defaults
		// (level 0 / 1.00x) print nothing.
		if (waterActive === 'volume') {
			if (Math.abs(+seaVolInput.value - 1) > 1e-9 || Math.abs(Params.sea) > 1) parts.push('sea vol ' + (+seaVolInput.value).toFixed(2) + 'x (' + seaKm(Params.sea) + ' km)');
		} else if (Math.abs(Params.sea) > 1) parts.push('sea ' + seaKm(Params.sea) + ' km');
		return parts.length ? 'adj ' + parts.join(' · ') : '';
	}
	// A press arms the hold as much as a move does: a thumb the pointer has taken but not yet
	// shifted is still a hand on the control, and rewriting it then is what the follow must not do.
	tmInput.addEventListener('input', function () { holdTmFollow(); applyTm(); });
	tmInput.addEventListener('pointerdown', holdTmFollow);
	frictionInput.addEventListener('input', applyAdjust);
	eroInput.addEventListener('input', applyAdjust);
	reliefInput.addEventListener('input', applyAdjust);
	// Cooling off pins Tm at the stored value; turning it back on resumes the curve from
	// wherever the world is (setTm re-anchors the baseline), so re-checking cannot teleport
	// the temperature back onto the decay the world left behind.
	coolingInput.addEventListener('change', function () {
		state.cooling = coolingInput.checked ? 1 : 0;
		if (state.cooling) Mantle.setTm(state, state.Tm);
	});

	// ?level= / ?seed= / ?engine= / ?dt= / ?steps= pre-fill the world controls, so a capture
	// request can name the run it wants (index.html?level=7&engine=gpu) instead of describing
	// clicks - the affordance bench.html already has, and the reason its runs are repeatable
	// from a log line. A level the select does not offer is ignored rather than built: Grid
	// takes 0-7, so a stray ?level=9 would throw before the page drew anything. The adjust
	// pre-fill rides the same list: ?tm=1.4&cool=0&fric=1.5&ero=0.5&relief=9 is exactly the
	// header line a non-default capture copies.
	var query = new URLSearchParams(location.search);
	function offeredLevel(level) {
		for (var i = 0; i < levelInput.options.length; i++) {
			if (+levelInput.options[i].value === level) return true;
		}
		return false;
	}
	// A slider value the page cannot hold is ignored, like an unoffered ?level=: the numbers
	// land in Params and in the world's temperature, where a NaN would be unrecoverable.
	function prefilled(name, input) {
		var raw = query.get(name), v = +raw;
		if (!raw || !Number.isFinite(v)) return false;
		input.value = String(v);
		return true;
	}
	if (offeredLevel(+query.get('level'))) Params.level = +query.get('level');
	if (query.get('seed')) Params.seed = +query.get('seed') >>> 0;
	var grid = new Grid(Params.level, Params.seed).build(), state = new State(grid, Params.seed);
	var renderer = new Renderer(canvas, state), gpuRenderer = null, playing = false, runTarget = Infinity, dirty = true, lastUpdate = 0;
	// The view is independent of the simulated world. Its quaternion is deliberately not
	// clamped: each pointer move composes one small surface rotation, so many full turns stay
	// usable instead of snapping at a latitude or longitude limit. `viewVersion` is bumped by
	// every move; the frame loop draws it once and knows exactly which frames re-sample.
	var viewQ = new Float64Array([0, 0, 0, 1]), viewPointer = new Float64Array(3), viewNext = new Float64Array(3);
	var viewVersion = 0, shownVersion = -1, viewHold = 0;
	// A press that never travels this far is the probe click, not a drag: hand tremor must not
	// eat the inspector, and a click-sized nudge must not move the view.
	var DRAG_PX = 4;
	// Frames the step gate stays closed after the view last moved. One frame is not enough:
	// a drag whose pointermove stream is thinner than the frame rate (a 60 Hz mouse on a
	// 120 Hz display, coalesced moves under load) leaves frames with no move in them, and an
	// empty frame is exactly where a GPU batch - and the event round trip inside it - slips in
	// mid-drag. Three frames is ~50 ms at 60 Hz: too short to feel like a resume delay, wide
	// enough to span a move stream at a third of the frame rate.
	var VIEW_HOLD_FRAMES = 3;
	var pan = { target: null, pointerId: null, active: false, moved: false, counted: false, suppressClick: false };
	// The final on-device drag capture needs to prove that a real pan exercised the step
	// gate, not merely report an idle strip. These scalars are reset with the world/engine
	// and cost no allocation in the rAF path.
	var viewStats = { drags: 0, moves: 0, pixels: 0, closes: 0, deferred: 0, reopens: 0, gated: false };
	function resetViewStats() {
		viewStats.drags = 0; viewStats.moves = 0; viewStats.pixels = 0;
		viewStats.closes = 0; viewStats.deferred = 0; viewStats.reopens = 0; viewStats.gated = false;
	}
	function viewGateReport() {
		if (!viewStats.drags) return '';
		return 'view gate: ' + viewStats.drags + ' drag' + (viewStats.drags === 1 ? '' : 's')
			+ ' · ' + viewStats.moves + ' moves · ' + Math.round(viewStats.pixels) + ' px'
			+ ' · closed ' + viewStats.closes + 'x · deferred ' + viewStats.deferred + ' rAF'
			+ ' · re-opened ' + viewStats.reopens + 'x';
	}
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
	// The event cadence is a Params setting, not world state, so like dt it applies
	// live (both engines read Params.eventCadence at the top of every step); the
	// canonical run stays at 1 Myr - the 5/10 Myr options are the fast-forward.
	if (query.get('cadence')) cadenceInput.value = query.get('cadence');
	Params.eventCadence = +cadenceInput.value;
	if (query.get('engine')) engineInput.value = query.get('engine');
	// The adjust pre-fill lands on the world before its first raster, so a capture request
	// starts on the settings it named instead of on the defaults.
	prefilled('tm', tmInput);
	prefilled('fric', frictionInput);
	prefilled('ero', eroInput);
	prefilled('relief', reliefInput);
	prefilled('disp', dispInput);
	// The detail select takes only the k values it offers (an unoffered ?k3d= is ignored,
	// as always) - the generic prefill would leave a refused select on its first option.
	var k3dAsked = +query.get('k3d');
	if (V3D_KS.indexOf(k3dAsked) >= 0) k3dInput.value = String(k3dAsked);
	v3dDisp = +dispInput.value; v3dK = +k3dInput.value;
	if (query.get('v3d') === '1') v3dInput.checked = true;
	paintV3d();
	// ?seavol= makes the volume slider the active control; ?sea= keeps the level one, and
	// wins the tie when both are given. Either first paint is the same coast: the defaults
	// agree (level 0 = 1.00x).
	var seaPrefilled = prefilled('sea', seaInput);
	if (prefilled('seavol', seaVolInput) && !seaPrefilled) waterActive = 'volume';
	Params.seaVolScale = +seaVolInput.value;
	if (query.get('cool')) coolingInput.checked = query.get('cool') !== '0';
	state.cooling = coolingInput.checked ? 1 : 0;
	applyTm();
	applyAdjust();
	Sim.raster(state);
	if (waterActive === 'volume') solveWater();
	else Params.sea = +seaInput.value * 1000;
	Perf.reset();
	function paintBadge() {
		badge.textContent = (gpu.on && gpu.ready ? 'GPU · L' : 'CPU · L') + grid.level;
	}
	// "Slow on the CPU engine" warning: L7, and L6 with more than one step per frame,
	// run at a few frames per second on the CPU. Amber on the labels and controls, not
	// red - the run is slow, not broken - and only on the CPU engine, since L6-L7 are
	// the WebGPU path. Painted from the selects, so every path that changes engine or
	// level (the boot fallbacks included) repaints it through bootEngine's completion.
	function paintSlow() {
		var cpu = engineInput.value !== 'gpu';
		var level = +levelInput.value, steps = +speedInput.value;
		var slow = cpu && (level === 7 || (level === 6 && steps > 1));
		levelLabel.classList[slow ? 'add' : 'remove']('slow');
		speedLabel.classList[slow && steps > 1 ? 'add' : 'remove']('slow');
	}
	// The one gate the frame loop and an in-flight GPU batch both ask: is the view moving, or
	// did it move within the last VIEW_HOLD_FRAMES? `viewHold` is the frame loop's count; the
	// version term is what a batch sees, because a move that lands while the batch is awaiting
	// its round trip has bumped the version without any frame having counted it yet.
	function viewLive() {
		return viewHold !== 0 || viewVersion !== shownVersion;
	}
	// Both renderers keep the view; the version bump is what the frame loop acts on - never
	// `dirty`, because a view move on the CPU engine is a re-sample and a repaint, not a
	// recolour, and the GPU engine draws it as its ordinary one-triangle frame.
	function applyView() {
		if (renderer && renderer.setView) renderer.setView(viewQ);
		if (gpuRenderer && gpuRenderer.setView) gpuRenderer.setView(viewQ);
		viewVersion++;
	}
	applyView();
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
	// The canvas blit rides a drained queue, never a heavy encoder: the spec vends a
	// fresh transparent-black drawing buffer on each getCurrentTexture after the
	// presentation, and the compositor shows whatever is in it at the next refresh - a
	// blit queued behind an unfinished segment would still be in flight then and present
	// black (the black frames every setting heavier than the refresh used to flash). The
	// blit is a sub-millisecond pass on an empty queue, so it always completes before its
	// presentation. The .then guards a rebuild: a level switch sets ready=false, so a
	// drain that resolves mid-rebuild blits nothing.
	function presentWhenDrained() {
		if (!(gpu.on && gpu.ready)) return;
		GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
			if (gpu.on && gpu.ready) gpuRenderer.present();
		});
	}
	// One world rebuild, shared by the Resolution select, Reset world and Load: the columns are
	// Lagrangian on one grid, so a different level is a different world and there is nothing to
	// carry over. `after` runs once the engine is ready on the new world.
	function rebuildWorld(level, seed, hot, after) {
		Params.level = level;
		grid = new Grid(level, seed).build();
		state = new State(grid, seed, hot);
		// A fresh world starts on its own start temperature and the Tm slider follows it; the
		// cooling switch is the user's and carries over, as the Params knobs (friction,
		// erosion, relief) do - they are global settings, not world state.
		state.cooling = coolingInput.checked ? 1 : 0;
		syncAdjust();
		renderer = new Renderer(canvas, state);
		renderer.setView(viewQ);
		extractScratch = null;   // sized to the old grid.V
		waterDirty = true;       // a new bathymetry: the volume tick re-solves against it
		levelInput.value = String(level);
		seedInput.value = String(seed);
		paintGrid();
		probe.textContent = 'Click the map to inspect a column; drag it to pan.';
		Perf.reset();
		resetViewStats();
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
		var doneSlow = function () { paintSlow(); rebootV3d(); done(); };
		if (engineInput.value === 'gpu') {
			if (!navigator.gpu) {
				engineInput.value = 'cpu';
				probe.textContent = 'WebGPU is not available in this browser; staying on the CPU engine.';
				doneSlow();
				return;
			}
			gpu.on = true; gpu.ready = false;
		// The device outlives the world: a level switch re-inits the arenas on it rather
		// than asking for a second adapter (the bench's one-planet-per-level does the same).
		GpuSim.init(state, { device: GpuSim.device, fallback: false }).then(function () {
			// A device-side failure used to look like "the sim does nothing": the play
			// promise never settles, so gpu.busy stayed true and the strip went on
			// ticking fps over an idle loop. Stop the run, drop the dead device (the
			// next GPU boot must ask for a fresh adapter) and say so.
			if (GpuSim.device && !GpuSim.device.lostHooked) {
				GpuSim.device.lostHooked = true;
				GpuSim.device.lost.then(function (info) {
					if (playing) setPlaying(false);
					GpuSim.device = null;
					probe.textContent = 'GPU device lost (' + (info && info.reason || 'unknown reason')
						+ '); the map is frozen. Switch the engine away and back to retry.';
				});
			}
			GpuSim.raster(state);
			// The old renderer's world texture is a device allocation, not a GC victim.
			if (gpuRenderer) gpuRenderer.release();
			gpuRenderer = new GpuRenderer(gpuCanvas).init(state);
				if (gpuRenderer.setView) gpuRenderer.setView(viewQ);
				gpuCanvas.hidden = false; canvas.hidden = true;
				gpu.ready = true; dirty = true;
				paintBadge();
				doneSlow();
			})['catch'](function (error) {
				gpu.on = false; engineInput.value = 'cpu';
				gpuCanvas.hidden = true; canvas.hidden = false;
				paintBadge();
				probe.textContent = 'GPU engine failed (' + error.message + '); back on CPU.';
				doneSlow();
			});
		} else {
			gpu.on = false; gpu.ready = false;
			gpuCanvas.hidden = true; canvas.hidden = false;
			Sim.raster(state);
			paintBadge();
			doneSlow();
		}
	}
	// Engine switching keeps the run: the world lives in `state`, so the other engine
	// takes over at the same t instead of the run stopping. A GPU handover pulls the
	// full mirror first - the light event mirror leaves the cell arrays one event cycle
	// old, and the CPU engine would restart from those. While the handover is in flight
	// the frame loop keeps drawing but starts no steps (`switching`): the CPU mirror of
	// a GPU run is not the world to advance, and a fresh GPU boot must not race a batch.
	var switching = false;
	engineInput.addEventListener('change', function () {
		if (switching) { engineInput.value = gpu.on && gpu.ready ? 'gpu' : 'cpu'; return; }
		var wasGpu = gpu.on && gpu.ready;
		switching = true; gpu.ready = false;
		Perf.reset();
		resetViewStats();
		whenGpuIdle(function () {
			(wasGpu ? GpuSim.download(state) : Promise.resolve()).then(function () {
				bootEngine(function () { dirty = true; switching = false; });
			}, function () { switching = false; });
		});
	});
	// Fast-forward escape hatch: rebuild the plate table only every 5/10 Myr instead
	// of every 1 Myr. No rebuild needed: Events.cycle is span-aware and both engines
	// read Params.eventCadence per step; the span due next can be several Myr long.
	cadenceInput.addEventListener('change', function () {
		Params.eventCadence = +cadenceInput.value;
	});
	speedInput.addEventListener('change', paintSlow);
	function setPlaying(value) {
		playing = value; play.textContent = playing ? 'Pause' : 'Play';
		play.setAttribute('aria-pressed', String(playing)); step.disabled = playing;
	}
	play.addEventListener('click', function () { runTarget = Infinity; setPlaying(!playing); });
	step.addEventListener('click', function () {
		runTarget = Infinity;
		if (gpu.on && gpu.ready) {
			if (gpu.busy) return;
			gpu.busy = true; waterDirty = true;
			gpu.pending = GpuSim.step(state, +dtInput.value, GpuSim.Events, GpuSim.Checkpoint, GpuSim.Params)
				.then(function () {
					return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
						if (!(gpu.on && gpu.ready)) return;
						if (v3d.on) { v3d.r3d.redraw(); v3d.r3d.presentWhenDrained(); return; }
						gpuRenderer.redraw(layerValue());
						return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
							if (gpu.on && gpu.ready) gpuRenderer.present();
						});
					});
				}).then(function () {
					gpu.busy = false; dirty = false; shownVersion = viewVersion;
				})['catch'](function (error) {
					gpu.busy = false; console.error('GPU engine error', error);
					probe.textContent = 'GPU engine error: ' + error.message;
				});
		} else {
			Sim.step(state, +dtInput.value); dirty = true; waterDirty = true;
		}
	});
	runToStart.addEventListener('click', function () {
		if (!runToInput.checkValidity()) { runToInput.reportValidity(); return; }
		runTarget = +runToInput.value;
		if (runTarget <= state.t) { probe.textContent = 'Run-to target must be later than the current time.'; return; }
		setPlaying(true);
	});
	layerGroup.addEventListener('change', function (event) {
		if (event.target && event.target.name === 'layer') setLayer(event.target.value);
	});
	// A hover-capable fine pointer switches the view mode by hovering, no click: the
	// radio's checked state follows so a later click cannot undo the hover choice. Touch
	// and stylus-only devices keep the click - there is no resting hover to steer with.
	var hoverFine = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
	if (hoverFine) layerGroup.addEventListener('pointerover', function (event) {
		var node = event.target;
		while (node && node !== layerGroup && node.tagName !== 'LABEL') node = node.parentNode;
		if (!node || node === layerGroup) return;
		for (var i = 0; i < node.children.length; i++) {
			var input = node.children[i];
			if (input.getAttribute && input.getAttribute('name') === 'layer') {
				input.checked = true;
				setLayer(input.value);
			}
		}
	});
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
					// The blob owns the temperature and the cooling flag; the sliders follow it.
					syncAdjust();
					probe.textContent = 'Loaded L' + head.level + ' seed ' + head.seed + ' at t '
						+ state.t.toFixed(1) + ' Myr.';
					waterDirty = true;   // the loaded world's bathymetry feeds the next volume solve
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
		var rect = mapRect(target);
		var x = Math.min(grid.lookupW - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * grid.lookupW)));
		var y = Math.min(grid.lookupH - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * grid.lookupH)));
		if (renderer.updateViewLookup) renderer.updateViewLookup();
		var mapLookup = renderer.viewLookup || grid.lookup;
		var cell = mapLookup[(grid.lookupH - 1 - y) * grid.lookupW + x], owner = state.owner[cell];
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
			'\n' + (state.z[cell] < Params.sea ? 'wet' : 'land') + ' · depth ' + Math.max(0, Params.sea - state.z[cell]).toFixed(0) + ' m · dynamic ' + Math.round(state.zDyn[owner]) + ' m' +
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
	function mapRect(target) {
		if (target.getBoundingClientRect) return target.getBoundingClientRect();
		return { left: 0, top: 0, width: target.width || grid.lookupW, height: target.height || grid.lookupH };
	}
	function pointerDirection(event, target, out, knownRect) {
		var rect = knownRect || mapRect(target);
		MapView.direction(out, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
	}
	// The drag never pauses the sim by itself: the frame loop owns the gate and defers a step
	// only while the view is moving and for VIEW_HOLD_FRAMES after it stops, so the sim runs
	// under a held-still pointer and resumes as soon as the pointer rests - with or without the
	// mouse still down.
	function beginPan(event) {
		if (event.button !== undefined && event.button !== 0) return;
		if (pan.active) endPan(event);
		var target = event.currentTarget, rect = mapRect(target);
		if (!rect.width || !rect.height) return;
		pan.target = target; pan.rect = rect; pan.pointerId = event.pointerId; pan.active = true; pan.moved = false; pan.counted = false;
		pan.startX = event.clientX; pan.startY = event.clientY;
		pan.lastX = event.clientX; pan.lastY = event.clientY;
		pointerDirection(event, target, viewPointer, rect);
		if (target.setPointerCapture && event.pointerId !== undefined) target.setPointerCapture(event.pointerId);
		if (target.style) target.style.cursor = 'grabbing';
		if (event.preventDefault) event.preventDefault();
	}
	function movePan(event) {
		if (!pan.active || event.currentTarget !== pan.target) return;
		if (pan.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== pan.pointerId) return;
		// Inside the dead zone nothing composes and pan.lastX / pan.lastY stay at the press, so
		// the first real move composes from the press position: coalesced moves cannot drift
		// the view, and the dead-zone wobble is replayed into the drag instead of vanishing.
		if (!pan.moved && Math.abs(event.clientX - pan.startX) < DRAG_PX && Math.abs(event.clientY - pan.startY) < DRAG_PX) return;
		pan.moved = true;
		var next = viewNext, rect = pan.rect;
		var dx = event.clientX - pan.lastX, dy = event.clientY - pan.lastY;
		var turns = Math.max(Math.abs(dx) / rect.width, Math.abs(dy) / rect.height);
		var segments = Math.max(1, Math.ceil(turns * 4)), changed = false;
		for (var part = 1; part <= segments; part++) {
			var f = part / segments;
			MapView.direction(next, pan.lastX + dx * f - rect.left, pan.lastY + dy * f - rect.top, rect.width, rect.height);
			if (MapView.drag(viewQ, viewPointer[0], viewPointer[1], viewPointer[2], next[0], next[1], next[2])) changed = true;
			viewPointer[0] = next[0]; viewPointer[1] = next[1]; viewPointer[2] = next[2];
		}
		pan.lastX = event.clientX; pan.lastY = event.clientY;
		if (changed) {
			if (!pan.counted) { pan.counted = true; viewStats.drags++; }
			viewStats.moves++;
			viewStats.pixels += Math.hypot(dx, dy);
			applyView();
		}
		if (event.preventDefault) event.preventDefault();
	}
	function endPan(event) {
		if (!pan.active) return;
		if (event && event.currentTarget && event.currentTarget !== pan.target) return;
		var target = pan.target, moved = pan.moved;
		if (target.releasePointerCapture && pan.pointerId !== undefined) target.releasePointerCapture(pan.pointerId);
		if (target.style) target.style.cursor = 'grab';
		pan.active = false; pan.target = null; pan.rect = null; pan.pointerId = null; pan.moved = false; pan.suppressClick = moved;
	}
	function mapClick(event) {
		if (pan.suppressClick) { pan.suppressClick = false; return; }
		probeClick(event);
	}
	// With "Info follows pointer" on, hovering keeps the inspector on the cell under the
	// pointer. It reads the CPU state as it is - on the GPU engine that is the mirror, one
	// event cycle old - because a readback per move would stall the device queue; a click
	// still pulls a fresh mirror through probeClick.
	function followMove(event) {
		if (!followInput.checked || pan.active) return;
		probeAt(event, event.currentTarget);
	}
	function bindPan(target) {
		target.addEventListener('pointerdown', beginPan);
		target.addEventListener('pointermove', movePan);
		target.addEventListener('pointermove', followMove);
		target.addEventListener('pointerup', endPan);
		target.addEventListener('pointercancel', endPan);
		target.addEventListener('click', mapClick);
	}
	bindPan(canvas);
	bindPan(gpuCanvas);
	// The 3D orbit: the same 4 px dead zone as the 2D drag, but yaw/pitch on the camera
	// instead of the surface quaternion, and deliberately no view-gate bump - an orbit is
	// a uniform write, so the sim never defers for it on either engine.
	var V3D_TURN = 0.005;
	var orbit = { active: false, id: null, lastX: 0, lastY: 0, moved: false };
	map3d.addEventListener('pointerdown', function (event) {
		if (event.button !== undefined && event.button !== 0) return;
		orbit.active = true; orbit.id = event.pointerId;
		orbit.lastX = event.clientX; orbit.lastY = event.clientY; orbit.moved = false;
		if (map3d.setPointerCapture && event.pointerId !== undefined) map3d.setPointerCapture(event.pointerId);
		if (event.preventDefault) event.preventDefault();
	});
	map3d.addEventListener('pointermove', function (event) {
		if (!orbit.active || (event.pointerId !== undefined && event.pointerId !== orbit.id)) return;
		if (!orbit.moved && Math.abs(event.clientX - orbit.lastX) < DRAG_PX && Math.abs(event.clientY - orbit.lastY) < DRAG_PX) return;
		v3dYaw -= (event.clientX - orbit.lastX) * V3D_TURN;
		v3dPitch = Math.max(-Render3D.PITCH_MAX, Math.min(Render3D.PITCH_MAX, v3dPitch + (event.clientY - orbit.lastY) * V3D_TURN));
		orbit.lastX = event.clientX; orbit.lastY = event.clientY;
		orbit.moved = true;
		if (v3d.r3d) v3d.r3d.setOrbit(v3dYaw, v3dPitch, v3dDist);
		if (v3d.on) dirty = true;
		if (event.preventDefault) event.preventDefault();
	});
	function endOrbit(event) {
		if (!orbit.active || (event && event.pointerId !== undefined && event.pointerId !== orbit.id)) return;
		orbit.active = false; orbit.id = null; orbit.moved = false;
	}
	map3d.addEventListener('pointerup', endOrbit);
	map3d.addEventListener('pointercancel', endOrbit);
	map3d.addEventListener('wheel', function (event) {
		if (!v3d.on) return;
		if (event.preventDefault) event.preventDefault();
		v3dDist *= event.deltaY > 0 ? 1.12 : 1 / 1.12;
		if (v3dDist < Render3D.DIST_MIN) v3dDist = Render3D.DIST_MIN;
		if (v3dDist > Render3D.DIST_MAX) v3dDist = Render3D.DIST_MAX;
		if (v3d.r3d) v3d.r3d.setOrbit(v3dYaw, v3dPitch, v3dDist);
		dirty = true;
	});
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
	// The capture an agent session needs, in one paste: the one-line environment header (which
	// browser, OS/CPU type, GPU type - no UA string, no adapter model, no seconds), then which
	// engine and world the numbers came from, then the strip exactly as it reads on screen.
	function perfReport() {
		var engine = gpu.on && gpu.ready ? 'gpu' : 'cpu';
		var rig = Env.line() + (engine === 'gpu' && GpuSim.adapter ? ' · gpu ' + Env.gpu(GpuSim.adapter) : '');
		var viewGate = viewGateReport(), adjust = adjustReport();
		// The 3D is a view setting, so it names itself only when it differs from the
		// default (off); its knobs follow the adj line's convention.
		var v3dLine = '';
		if (v3d.on) {
			v3dLine = ' · 3d on';
			if (v3dDisp !== 10) v3dLine += ' · disp ' + v3dDisp + 'x';
			if (v3dK !== 8) v3dLine += ' · k' + v3dK;
		}
		return rig
			+ '\nengine ' + engine + ' · L' + grid.level
			+ ' · dt ' + dtInput.value + ' · ' + speedInput.value + ' steps/frame · view ' + layerValue()
			+ ' · ' + startInput.value + ' start · seed ' + seedInput.value
			+ ' · cadence ' + Params.eventCadence + ' Myr' + v3dLine
			+ '\n' + Perf.report(stripRows())
			+ (viewGate ? '\n' + viewGate : '')
			+ (adjust ? '\n' + adjust : '')
			+ '\nt ' + state.t.toFixed(1) + ' Myr · ' + badge.textContent;
	}
	Clipboard.bind(perfStrip, perfReport, Clipboard.classAck(perfStrip));
	perfStrip.addEventListener('keydown', function (event) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		perfStrip.click();
	});

	function frame(now) {
		var dt = +dtInput.value, steps = 0;
		var viewMoved = viewVersion !== shownVersion;
		// Set by the render tail the moment this rAF's play encoder is built with the
		// draw inside it; the bottom repaint gate then skips the standalone draw submit.
		var mergedThisFrame = false;
		// The step gate is the view, never the pointer: it closes on the frame a move lands and
		// stays closed for VIEW_HOLD_FRAMES more, so a held-still button pauses nothing and a
		// resting pointer resumes the sim whether or not it is still down. Both engines need it,
		// for different costs: a CPU frame that re-samples the view pays ~18 ms at L5 on top of
		// the step, and a GPU batch that contains the event round trip holds the device queue
		// for the readback (25.5 ms of its 28.5 ms on device) and the main thread for the unpack
		// and the cycle, with its compute queued ahead of the drag's draws - one stutter per
		// cadence, every eventCadence/dt frames. Deferring the batch is the only cheap move: an
		// in-flight round trip cannot be cancelled, and running the frames without it would
		// advance sim time past the due date and collapse every skipped cycle into one oversized
		// span.
		if (viewMoved) viewHold = VIEW_HOLD_FRAMES;
		else if (viewHold > 0) viewHold--;
		var gateClosed = viewLive();
		if (!playing) viewStats.gated = false;
		else if (gateClosed) {
			viewStats.deferred++;
			if (!viewStats.gated) { viewStats.gated = true; viewStats.closes++; }
		} else if (viewStats.gated) {
			viewStats.gated = false; viewStats.reopens++;
		}
		if (playing && !gateClosed && !switching) {
			steps = +speedInput.value;
			if (runTarget < Infinity) steps = Math.min(steps, Math.max(0, Math.ceil((runTarget - state.t) / dt - 1e-9)));
			if (steps > 0) {
				if (gpu.on && gpu.ready) {
					// Frames submit to the device without any readback; only the event
					// cadence inside GpuSim.play pulls the mirror back to the CPU. `viewLive`
					// lets a batch that a drag caught mid-encoder stop at its next segment
					// boundary (the round-trip edge) instead of queueing the rest of its
					// compute under the pointer - at most one encoder, FIN_MAX frames.
					if (!gpu.busy) {
						waterDirty = true;   // the batch moves the bathymetry the volume solve reads
						// K11 is on demand: the status line refreshes on the 150 ms tick,
						// so ask for one diagnostic frame per tick instead of every frame.
						if (now - lastUpdate > 150) GpuSim.wantDiag();
					// The play encoder still carries the visible draw - the 2D world pass or,
					// with the 3D view on, the 3D's gather + land/water/rim (0.5.0) - which
					// keeps the render path and the event-boundary semantics of GpuSim.play
					// intact. The VISIBLE canvas is not touched here: once the segment has
					// finished, redraw the latest buffers on their own tiny pass and only
					// then blit to the canvas. That order is what keeps L7 from staying
					// black under continuous play - a present queued on the same drain as
					// the next heavy segment lands behind that segment again.
					var renderTail = function (enc) {
						mergedThisFrame = true;
						if (v3d.on) v3d.r3d.append(enc);
						else gpuRenderer.appendTo(enc, layerValue());
					};
					gpu.busy = true;
					gpu.pending = GpuSim.play(state, dt, steps, viewLive, { render: renderTail })
						.then(function (done) {
							return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
								if (!(gpu.on && gpu.ready)) return done;
								if (v3d.on) {
									v3d.r3d.redraw();
									v3d.r3d.presentWhenDrained();
									return done;
								}
								gpuRenderer.redraw(layerValue());
								return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
									if (gpu.on && gpu.ready) gpuRenderer.present();
									return done;
								});
							});
						}).then(function (done) {
								gpu.busy = false; ran += done;
								// The redraw above used the current buffers, layer and view, so the
								// visible frame is current even if the user changed the view or layer
								// while the batch was in flight.
								dirty = false; shownVersion = viewVersion;
							})['catch'](function (error) {
								gpu.busy = false; setPlaying(false);
								// The probe line is easy to miss and the loop stops dead here, so
								// the stack goes to the console too: an engine error must reach a log.
								console.error('GPU engine error', error);
								probe.textContent = 'GPU engine error: ' + error.message;
							});
					}
				} else {
					Sim.advance(state, dt, steps); ran += steps; dirty = true; waterDirty = true;
				}
			}
			if (runTarget < Infinity && state.t >= runTarget - dt * 0.5) {
				runTarget = Infinity; setPlaying(false);
			}
		}
	// A volume drag only arms the solve; it lands here, once per rAF at most, so the draw
	// below already sees the solved level (the level slider wrote Params.sea in its handler).
	if (waterArmed) solveWater();
	// `dirty` is a changed layer or state and recolours the cells; a view move alone only
	// re-samples the screen table and repaints the last colours (the GPU draw is one
	// triangle either way). On the GPU engine the canvas always shows the world texture,
	// and the blit onto it rides a drained queue (presentWhenDrained) - never a pass
	// inside the heavy segment encoder, which would present black on heavy settings.
	// The 3D view owns the frame when it is on: the same redraw + drained-blit shape, on
	// the sim device (cellF gather) or its own (cellZ upload packed here); the orbit and
	// the knobs only move bytes, and a CPU play frame redraws every rAF like the 2D.
	if (v3d.on) {
		if (mergedThisFrame) {
			dirty = false; shownVersion = viewVersion;
		} else if (dirty || viewMoved || (playing && !(gpu.on && gpu.ready))) {
			v3d.r3d.redraw(state);
			v3d.r3d.presentWhenDrained();
			dirty = false; shownVersion = viewVersion;
		}
	} else if (gpu.on && gpu.ready) {
		if (mergedThisFrame) {
			// The play path already owns this rAF's world draw; the visible frame is
			// refreshed when that batch finishes (see the play promise above), so a
			// same-frame redraw here would only duplicate work.
			dirty = false; shownVersion = viewVersion;
		} else if (dirty || viewMoved) {
			// Paused frames and drag/view-only frames still redraw immediately: no heavy
			// batch is in charge of the visible frame, so repaint the world now and blit
			// it once the tiny draw has drained.
			gpuRenderer.redraw(layerValue());
			presentWhenDrained();
			dirty = false; shownVersion = viewVersion;
		}
	} else if (dirty || viewMoved) {
		if (dirty) {
			renderer.draw(layerValue());
			dirty = false; shownVersion = viewVersion;
		} else {
			renderer.paint();
			shownVersion = viewVersion;
		}
	}
		Perf.frame(now, ran, dt); ran = 0;
		if (Perf.due(now)) {
			Perf.v3dText = v3d.on && v3d.r3d ? v3d.r3d.tsLine() : '';
			Perf.update(now);
			showStrip(stripRows());
			if (waterActive === 'volume' && waterDirty) solveWater();
			// The Mantle Tm slider follows the sim on the strip's own 2 Hz tick while cooling
			// is on, and never while a hand is on the control: the hold holdTmFollow arms is
			// retired after the rewrite check, so it covers its own ticks.
			if (state.cooling && !tmFollowHold) {
				tmInput.value = state.Tm.toFixed(2);
				paintAdjust();
			}
			if (tmFollowHold > 0) tmFollowHold--;
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
	paintSlow();
	mountStrip();
	// The page's own default is the CPU engine, whose world is already rastered; a prefilled
	// ?engine=gpu has to boot the device before a frame tries to draw from it. A prefilled
	// ?v3d=1 rides the engine boot's completion on the GPU path (bootEngine's hook); on
	// the CPU path the render-only device boots here.
	if (engineInput.value === 'gpu') bootEngine(function () { dirty = true; });
	else rebootV3d();
	if (/[?&]bench=1/.test(location.search)) {
		// The benchmark lives in its own page (bench.html — the climate-repo GUI
		// pattern): redirect, preserving the level/dt/steps query overrides.
		var extra = location.search.slice(1).replace('bench=1', '').replace(/^&/, '');
		location.replace('bench.html' + (extra ? '?' + extra : ''));
	} else {
		requestAnimationFrame(frame);
	}
}());

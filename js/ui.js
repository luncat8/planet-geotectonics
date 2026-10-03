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
	var presetInput = document.getElementById('preset'), presetLabel = document.getElementById('preset-label');
	var reconInput = document.getElementById('recon'), reconLabel = document.getElementById('recon-label');
	var reconValue = document.getElementById('recon-value');
	var earthScore = null;
	// Starts that boot from an Earth pack (0.4.0/0.4.5): present day, plus the historical
	// checkpoints - whatever Earth.history names, so a new checkpoint needs no change here.
	// The Preset select belongs to these only.
	function isEarthStart(v) { return v === 'earth' || (typeof Earth !== 'undefined' && !!Earth.history[v]); }
	function paintStart() {
		var earth = isEarthStart(startInput.value);
		presetLabel.hidden = !earth;
		// Reconstruct slider (0.4.6 Mode K): only on an Earth start with a rotation model.
		var hasModel = typeof Rotations !== 'undefined' && Rotations.count > 0;
		if (reconLabel) reconLabel.hidden = !(earth && hasModel);
	}
	startInput.addEventListener('change', paintStart);
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
	var mesh3dInput = document.getElementById('mesh3d'), norm3dInput = document.getElementById('norm3d');
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
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var prospectPanel = document.getElementById('prospect'), prospectLedger = null, prospectClickSerial = 0;
	var campaignButton = document.getElementById('campaign'), campaignProgress = document.getElementById('campaign-progress');
	var campaignKind = document.getElementById('deposit-kind'), campaignExport = document.getElementById('export-discovered');
	var coreDepth = document.getElementById('core-depth'), coreExport = document.getElementById('export-core');
	var lastCoreState = null, lastCoreCell = -1, lastCoreSection = null, lastInstrumentText = '';
	var markerCanvas = document.getElementById('markers'), markerContext = markerCanvas.getContext('2d');
	var campaignPreparing = false, campaignRequest = 0, campaignJob = null, campaignView = null, campaignReadback = null;
	var campaignRefreshArmed = false, markersDirty = false;
	// The discovery overlay paints from the campaign view when one exists and from the
	// session ledger otherwise: a local find is on the map before any regional sweep. The hit
	// cache mirrors what was actually painted (projected x, y and the record per marker), so a
	// map click lands on a marker in the same space the painter used. Paint is capped at the
	// campaign's own sampling budget; a local session rarely comes close.
	var MARKER_PAINT_CAP = 2048, LEDGER_ROWS = 200, MARKER_HIT_PX = 7;
	var markerHits = new Float64Array(MARKER_PAINT_CAP * 2), markerHitRecords = new Array(MARKER_PAINT_CAP);
	var markerHitsN = 0, ledgerMarkers = null, selectedDeposit = null, ledgerSortDesc = false;
	var instrumentInputs = [];
	for (var inst = 0; inst < Instruments.LIST.length; inst++)
		instrumentInputs.push(document.getElementById('inst-' + Instruments.LIST[inst].id));
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

	// --- Reconstruct slider (0.4.6 Mode K) -------------------------------------------------
	// Exact rigid reconstruction: put every column where the rotation model says it was at
	// `epoch`. No dt, no physics, reversible. Display-side only - writes no sim parameter.
	// The scrub owns the plates' q while it lasts: the first input snapshots the live q and
	// the release ('change') puts it back and re-rasters through the sim's own ownership
	// passes, so leaving the slider returns to the live sim state (plan §5) - on a steered
	// world that snapshot IS the model pose at the sim's own epoch.
	// GPU path: download -> reconstruct -> upload; the restore skips the download because
	// the mirror already holds the scrubbed columns and only q changes.
	var reconSnap = new Float64Array(Params.plateCap * 4), reconLive = false;
	function paintRecon() {
		if (reconValue) reconValue.textContent = (+reconInput.value).toFixed(0) + ' Ma';
	}
	function applyRecon() {
		var epoch = +reconInput.value;
		paintRecon();
		if (!isEarthStart(startInput.value)) return;
		// Pause any running sim - reconstruct is a display scrub, not a forward run.
		if (playing) setPlaying(false);
		runTarget = Infinity;
		var doRecon = function () {
			try {
				if (!reconLive) { reconLive = true; reconSnap.set(state.q); }
				var r = Earth.reconstruct(state, epoch);
				if (r) probe.textContent = 'Reconstruct ' + epoch.toFixed(0) + ' Ma · moved ' + r.moved + ' · stuck ' + r.stuck + ' (' + r.stuckPlates + ' plates) · ' + (earthScore ? Earth.describe(earthScore) : '');
				else probe.textContent = 'Reconstruct ' + epoch.toFixed(0) + ' Ma';
			} catch (e) {
				probe.textContent = 'Reconstruct failed: ' + e.message;
				console.error(e);
			}
			dirty = true;
			waterDirty = true;
		};
		var doReconGpu = function () {
			// GPU: need to pull mirror, reconstruct on CPU state, then push back.
			if (gpu.on && gpu.ready) {
				whenGpuIdle(function () {
					GpuSim.download(state).then(function () {
						doRecon();
						GpuSim.uploadState(state).then(function () { dirty = true; });
					});
				});
			} else {
				doRecon();
			}
		};
		// If a GPU batch is in flight, wait for it before touching state.
		whenGpuIdle(doReconGpu);
	}
	function restoreRecon() {
		if (!reconLive) return;
		reconLive = false;
		// The slider is a jog control: it returns to 0 the moment the world does, so the
		// copy header (which reads the slider) never claims a scrub the map is not showing.
		reconInput.value = '0';
		paintRecon();
		var apply = function () {
			state.q.set(reconSnap);
			Earth.refresh(state);
			dirty = true;
			waterDirty = true;
			probe.textContent = earthScore ? Earth.describe(earthScore)
				: 'Click the map to inspect a column; drag it to pan.';
		};
		if (gpu.on && gpu.ready) {
			whenGpuIdle(function () {
				apply();
				GpuSim.uploadState(state).then(function () { dirty = true; });
			});
		} else {
			apply();
		}
	}
	if (reconInput) {
		reconInput.addEventListener('input', applyRecon);
		reconInput.addEventListener('change', restoreRecon);
		// Query prefill ?recon=250
		var reconQuery = new URLSearchParams(location.search).get('recon');
		if (reconQuery !== null && Number.isFinite(+reconQuery)) {
			reconInput.value = String(Math.max(0, Math.min(540, +reconQuery)));
		}
		paintRecon();
	}

	// --- 3D view (0.5.0) -------------------------------------------------------------------
	// A WebGPU render of the same world the map shows: a mesh (the icosphere, or the
	// 0.5.5 equirectangular lattice) displaced by the segment-final heights, a sea shell
	// at Params.sea, one light, normals from screen-space derivatives or from the height
	// field (0.5.5). The session borrows the GPU engine's device (the gather binds cellF)
	// or boots a render-only one and takes state.z per frame (cellZ upload); either way
	// the sim is untouched. Orbit and zoom are uniform writes, so unlike the 2D view they
	// never defer a sim step.
	var v3d = { on: false, busy: false, r3d: null }, v3dToken = 0;
	var v3dDisp = 10, v3dMesh = 'ico', v3dDetail = Render3D.DEFAULT_DETAIL.ico;
	var v3dNorm = 'deriv', v3dYaw = 0.65, v3dPitch = 0.42, v3dDist = 3;
	function paintV3d() { dispValue.textContent = v3dDisp.toFixed(1) + '×'; }
	// The detail select is mode-aware: its options are the module's table, rebuilt in
	// place, so the page, the URL and the session cannot disagree about what a mode
	// offers. `want` lands on the default when it is not one of them (a stray ?k3d=).
	function paintDetail(want) {
		var list = Render3D.DETAILS[v3dMesh], i, o;
		while (k3dInput.firstChild) k3dInput.removeChild(k3dInput.firstChild);
		for (i = 0; i < list.length; i++) {
			o = document.createElement('option');
			o.value = list[i][0]; o.textContent = list[i][1];
			k3dInput.appendChild(o);
		}
		var d = Render3D.parseDetail(v3dMesh, want);
		v3dDetail = d ? d.token : Render3D.DEFAULT_DETAIL[v3dMesh];
		k3dInput.value = v3dDetail;
	}
	function applyDisp() {
		v3dDisp = +dispInput.value;
		if (v3d.r3d) v3d.r3d.exag = v3dDisp;
		paintV3d();
		if (v3d.on) dirty = true;
	}
	// A detail change swaps the mesh buffers on the live session - one-time work, never a
	// world rebuild and, unlike the 0.5.0 release-and-reboot, never a session teardown.
	function applyDetail() {
		var d = Render3D.parseDetail(v3dMesh, k3dInput.value);
		v3dDetail = d ? d.token : Render3D.DEFAULT_DETAIL[v3dMesh];
		k3dInput.value = v3dDetail;
		if (v3d.r3d) v3d.r3d.setMesh(v3dMesh, v3dDetail);
		if (v3d.on) dirty = true;
	}
	function applyMesh() {
		v3dMesh = mesh3dInput.value === 'grid' ? 'grid' : 'ico';
		paintDetail(Render3D.DEFAULT_DETAIL[v3dMesh]);
		if (v3d.r3d) v3d.r3d.setMesh(v3dMesh, v3dDetail);
		if (v3d.on) dirty = true;
	}
	function applyNorm() {
		v3dNorm = norm3dInput.value === 'analytic' ? 'analytic' : 'deriv';
		if (v3d.r3d) v3d.r3d.setNormals(v3dNorm);
		if (v3d.on) dirty = true;
	}
	function releaseV3d() {
		if (v3d.r3d) { v3d.r3d.release(); v3d.r3d = null; }
		v3d.on = false;
		map3d.hidden = true;
		// The engine's own canvas takes the map slot back (bootEngine keeps it that way).
		(gpu.on && gpu.ready ? gpuCanvas : canvas).hidden = false;
		layerGroup.classList.remove('off');
		paintDepositMarkers();
	}
	// The session's init options, read when the device is finally in hand - a mesh or
	// detail change made while the adapter promise was in flight lands on the session
	// that boots, not on the one that was asked for.
	function v3dOpts(device) {
		var gpuMode = device !== null && gpu.on && gpu.ready;
		var o = { device: device, mesh: v3dMesh, detail: v3dDetail, norm: v3dNorm, V: grid.V,
			zSource: gpuMode ? 'cellF' : 'cellZ', lw: grid.lookupW, lh: grid.lookupH,
			look: gpuMode ? GpuSim.S.buf.lookup : grid.lookup };
		if (gpuMode) o.cellF = GpuSim.S.buf.cellF;
		return o;
	}
	// The boot itself, minus the user-path gates: the engine (and its device) is final
	// when this runs. `token` voids a boot that a toggle-off or a re-init overtook.
	function bootV3dNow(done) {
		var token = ++v3dToken;
		v3d.busy = true;
		var r3d = new Render3D(map3d);
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
				markerCanvas.hidden = true;
				layerGroup.classList.add('off');
				probe.textContent = '3D on · ' + (v3dMesh === 'grid' ? 'heightmap ' : 'icosphere ') + v3dDetail
					+ ' · ' + r3d.vCount.toLocaleString() + ' vertices · drag orbits, wheel zooms.';
			}
			if (token === v3dToken) done(error);
		};
		if (gpu.on && gpu.ready) {
			try { r3d.init(v3dOpts(GpuSim.S.device)); } catch (error) { finish(error); return; }
			finish(null);
			return;
		}
		// CPU engine: the render-only device the sim never needed. Default limits hold
		// (the fattest mesh is k9's 90 MB of buffers); no feature asks beyond the base set.
		navigator.gpu.requestAdapter().then(function (adapter) {
			if (!adapter) { finish(new Error('no WebGPU adapter')); return; }
			adapter.requestDevice().then(function (device) {
				if (token !== v3dToken) { finish(new Error('superseded')); return; }
				try { r3d.init(v3dOpts(device)); } catch (error) { finish(error); return; }
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
	mesh3dInput.addEventListener('change', applyMesh);
	k3dInput.addEventListener('change', applyDetail);
	norm3dInput.addEventListener('change', applyNorm);

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
	var prospectIntro = 'Select an instrument, then click one map cell to survey it. Hover only updates the column inspector; it never adds survey coverage.';
	function selectedInstrumentIds() {
		var ids = [];
		for (var i = 0; i < instrumentInputs.length; i++)
			if (instrumentInputs[i].checked) ids.push(Instruments.LIST[i].id);
		return ids;
	}
	function prospectCapture() {
		var ids = selectedInstrumentIds(), line = ids.length ? 'prospect inst ' + ids.join(',') : '';
		if (coreDepth.value !== '5000') {
			if (line) line += ' · ';
			line += 'core ' + (coreDepth.value === 'basement' ? 'basement' : campaignCount(+coreDepth.value) + 'm');
		}
		if (campaignView && campaignView.summary) {
			if (line) line += ' · ';
			line += 'campaign ' + campaignView.epochMyr.toFixed(1) + ' Myr · '
				+ campaignView.summary.records + ' found · ' + campaignView.summary.viable + ' viable'
				+ (campaignView.partial ? ' · partial' : '');
		}
		return line;
	}
	function campaignCount(value) { return Math.floor(value).toLocaleString('en-US'); }
	function massText(value) {
		var amount = value, unit = 't';
		if (amount >= 1e9) { amount /= 1e9; unit = 'Gt'; }
		else if (amount >= 1e6) { amount /= 1e6; unit = 'Mt'; }
		else if (amount >= 1e3) { amount /= 1e3; unit = 'kt'; }
		return Number(amount.toPrecision(3)).toLocaleString('en-US') + ' ' + unit;
	}
	function campaignContained(record) {
		var parts = [];
		for (var metal in record.contained) parts.push(metal + ' ' + massText(record.contained[metal]));
		return parts.join(' ');
	}
	function sampleMarkerClass(catalogue, ledger, kind, viable, cap) {
		var groups = [], quotas = [], fractions = [], total = 0, k, i;
		for (k = 0; k < Deposits.KINDS.length; k++) groups.push([]);
		for (i = 0; i < catalogue.records.length; i++) {
			var record = catalogue.records[i];
			if (!ledger.byId[record.id] || record.viable !== viable || (kind !== 'all' && record.kind !== kind)) continue;
			groups[record.kindIndex].push(record); total++;
		}
		var out = [];
		if (total <= cap) {
			for (k = 0; k < groups.length; k++) out = out.concat(groups[k]);
		} else {
			var allocated = 0;
			for (k = 0; k < groups.length; k++) {
				var ideal = cap * groups[k].length / total;
				quotas[k] = Math.floor(ideal); fractions[k] = ideal - quotas[k]; allocated += quotas[k];
			}
			while (allocated < cap) {
				var best = -1, fraction = -1;
				for (k = 0; k < groups.length; k++) {
					if (quotas[k] < groups[k].length && fractions[k] > fraction) { best = k; fraction = fractions[k]; }
				}
				if (best < 0) break;
				quotas[best]++; fractions[best] = -1; allocated++;
			}
			for (k = 0; k < groups.length; k++) {
				var n = groups[k].length, take = quotas[k];
				for (i = 0; i < take; i++) out.push(groups[k][Math.min(n - 1, Math.floor((i + 0.5) * n / take))]);
			}
		}
		out.sort(function (a, b) { return a.cell !== b.cell ? a.cell - b.cell : a.kindIndex - b.kindIndex; });
		return { records: out, total: total };
	}
	function campaignSummaryText(view) {
		var summary = view.summary, totals = [], key;
		for (key in summary.contained) totals.push(key + ' ' + massText(summary.contained[key]));
		var text = 'viable deposits ' + campaignCount(summary.viable) + ' · contained in the ground\n  '
			+ (totals.length ? totals.join('   ') : 'no viable contained metal in the ledger');
		text += '\ndiscovered deposits ' + campaignCount(summary.records) + ' · sub-economic '
			+ campaignCount(summary.records - summary.viable) + ' · kind ' + summary.kind;
		// The monetary scenario is a second, independent question, so it gets its own line
		// rather than replacing the count above. `viable` never mentions a price; this one
		// never mentions a grade cutoff. The two columns are where they disagree.
		if (summary.money && typeof DepositEconomics !== 'undefined') {
			text += '\nmoney scenario-positive ' + campaignCount(summary.money.positive)
				+ ' · net ' + DepositEconomics.money(summary.money.net)
				+ ' · viable but does not pay ' + campaignCount(summary.money.geoOnly)
				+ ' · pays but fails the class screen ' + campaignCount(summary.money.moneyOnly);
		}
		text += '\nlargest viable by contained metal · ' + (summary.kind === 'all' ? 'all kinds' : summary.kind);
		var listed = 0;
		function topLine(record, indent) {
			var entry = prospectLedger.byId[record.id];
			return '\n' + indent + '#' + record.id + '  ' + record.kind + ' · '
				+ (entry ? Instruments.confidence[entry.confidence] + ' · ' : '')
				+ campaignContained(record) + '   ' + Number(record.size.toPrecision(3)).toLocaleString('en-US')
				+ ' ' + record.unit + ' · ' + record.variant + ' · ' + record.host + ', ' + record.ageMyr + ' Ma';
		}
		// `summary.top` is the global ladder under the active filter: the all-kinds view gains a
		// cross-kind ranking, and a filtered one reads the same rows the per-kind block repeats.
		for (var t = 0; t < summary.top.length && t < 5; t++) text += topLine(summary.top[t], '  '), listed++;
		if (summary.kind === 'all') {
			for (var k = 0; k < summary.byKind.length; k++) {
				var group = summary.byKind[k];
				if (!group.top.length) continue;
				text += '\n  ' + group.kind;
				for (var r = 0; r < group.top.length && r < 3; r++) text += topLine(group.top[r], '    ');
				listed++;
			}
		}
		if (!listed) text += '\n  no viable discoveries for this filter';
		text += '\nepoch ' + view.epochMyr.toFixed(1) + ' Myr · surveyed '
			+ campaignCount(prospectLedger.cellsN) + ' cells · instruments ' + view.instruments.join(',');
		text += '\nmarkers filled viable ' + campaignCount(view.viableMarkers.records.length) + '/'
			+ campaignCount(view.viableMarkers.total) + ' · hollow sub-economic '
			+ campaignCount(view.nonviableMarkers.records.length) + '/'
			+ campaignCount(view.nonviableMarkers.total);
		if (view.stale) text += '\nSTALE snapshot · refresh to survey the current world';
		if (view.partial) text += '\npartial campaign · the valid surveyed ledger is retained';
		return text;
	}
	function campaignProgressText() {
		if (campaignPreparing) return 'Preparing a coherent snapshot · playback is paused. Click Cancel setup to stop.';
		if (campaignJob && campaignJob.running) {
			return 'campaign ' + Math.floor(100 * campaignJob.cursor / campaignJob.total) + '% · '
				+ campaignCount(campaignJob.cursor) + ' cells · ' + campaignCount(campaignJob.found)
				+ ' found · ' + campaignCount(campaignJob.viable) + ' viable';
		}
		if (!campaignView) return 'No regional campaign. Local clicks survey only the selected cell footprint.';
		var line = (campaignView.partial ? 'partial campaign' : 'campaign complete') + ' · '
			+ campaignCount(campaignView.summary.records) + ' found · '
			+ campaignCount(campaignView.summary.viable) + ' viable · snapshot '
			+ campaignView.epochMyr.toFixed(1) + ' Myr';
		if (campaignView.stale) line = 'stale — press again to refresh · ' + line;
		else if (campaignRefreshArmed) line = 'press again to refresh · ' + line;
		return line;
	}
	// One composition for the report panel: the pinned deposit, the last survey report and
	// the last core log, in that order, each optional.
	function paintProspectPanel() {
		var text = '';
		var pinned = selectedDeposit === null ? null : prospectLedger.byId[selectedDeposit];
		if (pinned) text += Instruments.depositText(pinned) + '\n\n';
		if (lastInstrumentText) text += lastInstrumentText + '\n\n';
		if (lastCoreState === state && lastCoreSection) text += Core.text(lastCoreSection);
		prospectPanel.textContent = text || prospectIntro;
	}
	function refreshLastCore() {
		if (lastCoreState !== state || lastCoreCell < 0) return;
		try {
			lastCoreSection = Core.section(state, lastCoreCell, coreDepth.value);
			coreExport.disabled = !lastCoreSection;
			paintProspectPanel();
		} catch (error) {
			lastCoreSection = null; coreExport.disabled = true;
			prospectPanel.textContent = 'Core failed: ' + error.message;
		}
	}
	function paintCampaignControls() {
		campaignButton.textContent = campaignPreparing ? 'Cancel setup'
			: campaignJob && campaignJob.running ? 'Cancel campaign'
			: campaignView && campaignView.stale ? 'Refresh stale campaign'
			: 'Survey all cells · build viable map';
		campaignProgress.textContent = campaignProgressText();
		campaignExport.disabled = !campaignView;
	}
	function refreshCampaignView(preserveReport) {
		if (!campaignView) { paintDepositMarkers(); campaignExport.disabled = true; return; }
		var kind = campaignKind.value || 'all';
		campaignView.summary = Deposits.summary(state, {
			catalogue: campaignView.catalogue, ledger: prospectLedger, kind: kind
		});
		campaignView.viableMarkers = sampleMarkerClass(campaignView.catalogue, prospectLedger, kind, true, 1536);
		campaignView.nonviableMarkers = sampleMarkerClass(campaignView.catalogue, prospectLedger, kind, false, 512);
		campaignView.stale = !!campaignView.invalidated || Deposits.stale(state, campaignView.catalogue);
		campaignExport.disabled = false;
		if (!preserveReport) prospectPanel.textContent = campaignSummaryText(campaignView);
		paintCampaignControls();
		markersDirty = true;
		paintDepositMarkers();
	}
	var kindPrefill = query.get('depkind');
	if (kindPrefill !== null) {
		var kindName = kindPrefill.toLowerCase();
		for (var ki = 0; ki < campaignKind.options.length; ki++)
			if (campaignKind.options[ki].value === kindName) campaignKind.value = kindName;
	}
	var corePrefill = query.get('core');
	if (corePrefill !== null) {
		var coreValue = corePrefill.toLowerCase(), coreAliases = {
			'500m': '500', '500': '500', '2k': '2000', '2km': '2000', '2000': '2000',
			'5k': '5000', '5km': '5000', '5000': '5000', 'basement': 'basement', 'to basement': 'basement'
		};
		if (coreAliases[coreValue]) coreDepth.value = coreAliases[coreValue];
	}
	var instPrefill = query.get('inst');
	if (instPrefill !== null) {
		var requested = Object.create(null), names = instPrefill.toLowerCase().split(',');
		for (var n = 0; n < names.length; n++) requested[names[n].trim()] = 1;
		for (var p = 0; p < instrumentInputs.length; p++)
			instrumentInputs[p].checked = !!requested[Instruments.LIST[p].id];
	}
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
	prospectLedger = new Instruments.Ledger(grid.V);
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
	// The mesh and normals selects take only what the module offers; the detail select's
	// options follow the mesh, and an unoffered ?k3d= (the wrong namespace, or a k the
	// mesh does not have) lands on that mesh's default rather than on the first option.
	if (query.get('mesh') === 'grid') v3dMesh = 'grid';
	if (query.get('norm') === 'analytic') v3dNorm = 'analytic';
	mesh3dInput.value = v3dMesh;
	norm3dInput.value = v3dNorm;
	paintDetail(query.get('k3d') === null ? Render3D.DEFAULT_DETAIL[v3dMesh] : query.get('k3d'));
	v3dDisp = +dispInput.value;
	if (query.get('v3d') === '1') v3dInput.checked = true;
	paintV3d();
	// ?seavol= makes the volume slider the active control; ?sea= keeps the level one, and
	// wins the tie when both are given. Either first paint is the same coast: the defaults
	// agree (level 0 = 1.00x).
	var seaPrefilled = prefilled('sea', seaInput);
	if (prefilled('seavol', seaVolInput) && !seaPrefilled) waterActive = 'volume';
	Params.seaVolScale = +seaVolInput.value;
	if (query.get('cool')) coolingInput.checked = query.get('cool') !== '0';
	// ?start=pangaea&preset=game boots straight onto a start pack (0.4.0/0.4.5), the same
	// world the Startup fieldset rebuilds; a missing pack falls back to the map start.
	if (query.get('start')) startInput.value = query.get('start');
	if (query.get('preset')) presetInput.value = query.get('preset');
	paintStart();
	if (isEarthStart(startInput.value)) {
		var bootPack = Earth.pick(Params.level, startInput.value);
		if (bootPack) {
			Earth.apply(state, bootPack, { realistic: presetInput.value === 'realistic' });
			earthScore = Earth.score(state, bootPack);
			probe.textContent = Earth.describe(earthScore);
		} else {
			startInput.value = 'map';
			paintStart();
		}
	}
	state.cooling = state.prescribedOmega ? 0 : (coolingInput.checked ? 1 : 0);
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
		var inflight = gpu.pending, readback = campaignReadback, waits = [];
		gpu.pending = null;
		if (inflight) waits.push(inflight);
		if (readback && readback !== inflight) waits.push(readback);
		if (!waits.length) { done(); return; }
		Promise.all(waits.map(function (promise) {
			return Promise.resolve(promise).then(function () {}, function () {});
		})).then(done);
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
	function rebuildWorld(level, seed, start, after) {
		prospectClickSerial++;
		Params.level = level;
		grid = new Grid(level, seed).build();
		state = new State(grid, seed, start === 'hot');
		// An Earth start (0.4.0/0.4.5) replaces the procedural columns with the decoded
		// pack: the realistic preset pins the poles and the thermal budget - the modern
		// pack's constant NNR poles, or, on an epoch pack carrying model ids (0.4.6c),
		// omega(t) steered from the rotation model with the topology frozen - and the
		// game preset lets the procedural mantle drive the continents.
		earthScore = null;
		if (isEarthStart(start)) {
			var pack = Earth.pick(level, start);
			if (pack) {
				Earth.apply(state, pack, { realistic: presetInput.value === 'realistic' });
				earthScore = Earth.score(state, pack);
			} else {
				start = 'map';
			}
		}
		// A fresh world starts on its own start temperature and the Tm slider follows it; the
		// cooling switch is the user's and carries over, as the Params knobs (friction,
		// erosion, relief) do - they are global settings, not world state. The realistic
		// Earth preset pins the budget instead (prescribedOmega worlds run cooling-free).
		state.cooling = state.prescribedOmega ? 0 : (coolingInput.checked ? 1 : 0);
		syncAdjust();
		renderer = new Renderer(canvas, state);
		renderer.setView(viewQ);
		Deposits.release();      // catalogue scratch and cache were sized to the old grid.V
		prospectLedger = new Instruments.Ledger(grid.V);
		prospectPanel.textContent = prospectIntro;
		refreshLedgerMarkers();  // the overlay and the list follow the ledger of the new world
		refreshLedgerRows();
		waterDirty = true;       // a new bathymetry: the volume tick re-solves against it
		levelInput.value = String(level);
		seedInput.value = String(seed);
		reconLive = false;       // a new world owns its q again; the scrub snapshot is void
		if (reconInput) { reconInput.value = '0'; paintRecon(); }
		paintGrid();
		probe.textContent = earthScore ? Earth.describe(earthScore)
			: 'Click the map to inspect a column; drag it to pan.';
		Perf.reset();
		resetViewStats();
		bootEngine(function () {
			dirty = true;
			if (after) after();
		});
	}
	function rebuildWhenIdle(level, seed, start, after) {
		discardCampaignForRebuild();
		setPlaying(false); runTarget = Infinity;
		whenGpuIdle(function () { rebuildWorld(level, seed, start, after); });
	}
	function paintDepositMarkers() {
		// Campaign-sampled sets while a campaign view stands, the ledger otherwise; a running
		// or preparing campaign owns neither, and 3D has no overlay at all. Both sources carry
		// { viable: { records }, nonviable: { records } } so one painter draws either.
		var sets = null;
		if (!v3d.on && !campaignPreparing && !(campaignJob && campaignJob.running))
			sets = campaignView
				? { viable: campaignView.viableMarkers, nonviable: campaignView.nonviableMarkers }
				: ledgerMarkers;
		if (!sets) { markerCanvas.hidden = true; markerHitsN = 0; markersDirty = false; return; }
		var base = gpu.on && gpu.ready ? gpuCanvas : canvas;
		var width = base.width || grid.lookupW, height = base.height || grid.lookupH;
		if (markerCanvas.width !== width) markerCanvas.width = width;
		if (markerCanvas.height !== height) markerCanvas.height = height;
		markerCanvas.hidden = false;
		markerContext.clearRect(0, 0, width, height);
		markerHitsN = 0;
		var pos = grid.pos, projected = markerProject || (markerProject = new Float64Array(2));
		function diamondPath(x, y, radius) {
			markerContext.beginPath();
			markerContext.moveTo(x, y - radius); markerContext.lineTo(x + radius, y);
			markerContext.lineTo(x, y + radius); markerContext.lineTo(x - radius, y); markerContext.closePath();
		}
		function diamond(record, viable) {
			var dir = record.direction, b = record.cell * 3;
			var dx = dir ? dir[0] : pos[b], dy = dir ? dir[1] : pos[b + 1], dz = dir ? dir[2] : pos[b + 2];
			MapView.project(projected, dx, dy, dz, viewQ, width, height);
			var x = projected[0], y = projected[1], radius = 3.5;
			diamondPath(x, y, radius);
			if (viable) { markerContext.fillStyle = '#8ce1b2'; markerContext.fill(); }
			else { markerContext.strokeStyle = '#f2c46d'; markerContext.lineWidth = 1.5; markerContext.stroke(); }
			if (record.id === selectedDeposit) {
				markerContext.save();
				markerContext.strokeStyle = '#8ce1b2'; markerContext.lineWidth = 1.5;
				diamondPath(x, y, radius * 2); markerContext.stroke();
				markerContext.restore();
			}
			if (markerHitsN < MARKER_PAINT_CAP) {
				markerHits[markerHitsN * 2] = x; markerHits[markerHitsN * 2 + 1] = y;
				markerHitRecords[markerHitsN] = record; markerHitsN++;
			}
			if (x < radius) {
				markerContext.save(); markerContext.translate(width, 0);
				diamondPath(x, y, radius);
				if (viable) markerContext.fill(); else markerContext.stroke(); markerContext.restore();
			} else if (x > width - radius) {
				markerContext.save(); markerContext.translate(-width, 0);
				diamondPath(x, y, radius);
				if (viable) markerContext.fill(); else markerContext.stroke(); markerContext.restore();
			}
		}
		var nonviable = sets.nonviable.records, viable = sets.viable.records;
		for (var i = 0; i < nonviable.length; i++) diamond(nonviable[i], false);
		for (var j = 0; j < viable.length; j++) diamond(viable[j], true);
		markersDirty = false;
	}
	var markerProject = null;
	// The ledger-backed marker set for local discoveries, in the campaign's shape so the
	// painter and the kinds filter treat both sources the same. Empty means hidden.
	function refreshLedgerMarkers() {
		var kind = campaignKind.value || 'all', viable = [], sub = [], i;
		for (i = 0; i < prospectLedger.found.length; i++) {
			var record = prospectLedger.found[i].record;
			if (!record || (kind !== 'all' && record.kind !== kind)) continue;
			if (record.viable) viable.push(record); else sub.push(record);
		}
		ledgerMarkers = viable.length || sub.length
			? { viable: { records: viable, total: viable.length }, nonviable: { records: sub, total: sub.length } }
			: null;
		markersDirty = true;
		paintDepositMarkers();
	}
	// The discovery list: one row per ledger record, always the ledger - a campaign only
	// widens it. A row click pins the deposit exactly like a marker click, so both views of
	// a discovery select the same entry and the same marker ring.
	var ledgerList = document.getElementById('ledger-list'), ledgerCount = document.getElementById('ledger-count');
	var ledgerSortSelect = document.getElementById('ledger-sort'), ledgerSortDir = document.getElementById('ledger-sort-dir');
	function ledgerSortValue(key, entry, record) {
		if (key === 'size') return record.size;
		if (key === 'contained') return Deposits.principalOf(record);
		if (key === 'depth') return record.top;
		if (key === 'confidence') return entry.confidence;
		if (key === 'kind') return record.kindIndex;
		return entry.serial;
	}
	function ledgerRowText(entry, record) {
		return '#' + record.id + ' · ' + record.kind + ' ' + record.variant
			+ ' · ' + Number(record.size.toPrecision(3)).toLocaleString('en-US') + ' ' + record.unit
			+ ' · top ' + record.top + ' m · ' + Instruments.confidence[entry.confidence]
			+ (record.viable ? ' · viable' : ' · sub-economic');
	}
	function refreshLedgerRows() {
		var kind = campaignKind.value || 'all', items = [], i;
		// A record the last survey retired is no longer a discovery: drop the pin with it,
		// or a later find of the same anchor would come back already selected.
		if (selectedDeposit !== null && !prospectLedger.byId[selectedDeposit]) selectedDeposit = null;
		for (i = 0; i < prospectLedger.found.length; i++) {
			var entry = prospectLedger.found[i], record = entry.record;
			if (!record || (kind !== 'all' && record.kind !== kind)) continue;
			items.push({ entry: entry, record: record });
		}
		while (ledgerList.children.length) ledgerList.removeChild(ledgerList.children[0]);
		ledgerCount.textContent = campaignCount(items.length) + ' found';
		if (!items.length) { ledgerList.hidden = true; return; }
		ledgerList.hidden = false;
		var desc = ledgerSortDesc, key = ledgerSortSelect.value;
		items.sort(function (a, b) {
			var av = ledgerSortValue(key, a.entry, a.record), bv = ledgerSortValue(key, b.entry, b.record);
			var d = av !== bv ? av - bv : a.entry.serial - b.entry.serial;
			return desc ? -d : d;
		});
		var shown = items.length < LEDGER_ROWS ? items.length : LEDGER_ROWS;
		for (i = 0; i < shown; i++) {
			var item = items[i], row = document.createElement('button');
			row.classList.add('ledger-row');
			if (selectedDeposit === item.record.id) row.classList.add('sel');
			row.textContent = ledgerRowText(item.entry, item.record);
			row.addEventListener('click', function (picked) {
				return function () { selectDeposit(picked.record.id); };
			}(item));
			ledgerList.appendChild(row);
		}
		if (items.length > shown) {
			var more = document.createElement('small');
			more.classList.add('ledger-more');
			more.textContent = (items.length - shown) + ' more behind this sort and filter';
			ledgerList.appendChild(more);
		}
	}
	// A pin is a view, not a mode: the survey below it still runs on the same click.
	function selectDeposit(id) {
		selectedDeposit = selectedDeposit === id ? null : id;
		markersDirty = true;
		paintDepositMarkers();
		refreshLedgerRows();
		paintProspectPanel();
	}
	// Marker clicks resolve in the projected canvas space the painter just used, with the
	// seam wrapped - the hit cache holds only what is actually visible on the overlay.
	// Several records share one cell, so their diamonds land within a few pixels of each
	// other: the nearest marker wins, and a filled viable one wins a tie over a hollow
	// sub-economic one, because the filled diamond is the one drawn on top.
	function hitDeposit(event) {
		var base = gpu.on && gpu.ready ? gpuCanvas : canvas;
		var rect = mapRect(base), width = base.width || grid.lookupW;
		if (!rect.width || !rect.height) return null;
		var x = (event.clientX - rect.left) / rect.width * width;
		var y = (event.clientY - rect.top) / rect.height * (base.height || grid.lookupH);
		var limit = MARKER_HIT_PX * MARKER_HIT_PX;
		var best = null, bestDist = limit, bestViable = false;
		for (var i = 0; i < markerHitsN; i++) {
			var dx = Math.abs(markerHits[i * 2] - x); dx = Math.min(dx, width - dx);
			var dy = Math.abs(markerHits[i * 2 + 1] - y);
			var dist = dx * dx + dy * dy;
			if (dist > bestDist) continue;
			var viable = !!markerHitRecords[i].viable;
			if (dist === bestDist && best && !(viable && !bestViable)) continue;
			best = markerHitRecords[i]; bestDist = dist; bestViable = viable;
		}
		return best ? best.id : null;
	}
	ledgerSortSelect.addEventListener('change', refreshLedgerRows);
	ledgerSortDir.addEventListener('click', function () {
		ledgerSortDesc = !ledgerSortDesc;
		ledgerSortDir.textContent = ledgerSortDesc ? '↑ high first' : '↓ low first';
		refreshLedgerRows();
	});
	function noteCampaignSurvey(result) {
		if (!campaignJob || !campaignJob.running || !result || !result.found) return;
		var catalogue = campaignJob.catalogue;
		for (var i = 0; i < result.found.length; i++) {
			var record = result.found[i].record;
			if (campaignJob.seen[record.id]) continue;
			for (var at = catalogue.cellStart[record.cell]; at < catalogue.cellStart[record.cell + 1]; at++) {
				var snapshotRecord = catalogue.records[at];
				if (snapshotRecord.id !== record.id) continue;
				campaignJob.seen[record.id] = 1; campaignJob.found++;
				if (snapshotRecord.viable) campaignJob.viable++;
				break;
			}
		}
		paintCampaignControls();
	}
	function finalizeCampaign(job) {
		if (!job || state !== job.state) return;
		campaignView = {
			catalogue: job.catalogue, instruments: job.instruments.slice(0), epochMyr: job.epochMyr,
			frame: job.frame, time: job.time, partial: !!(job.cancelled || job.invalidated || !job.done),
			invalidated: !!job.invalidated
		};
		campaignJob = null; campaignPreparing = false; campaignRefreshArmed = false;
		setPlaying(false);
		refreshCampaignView();
		// A sweep surveys every cell, so it retires and adds records like a local click does:
		// the list and the pin follow the ledger here rather than at the next click.
		refreshLedgerRows();
	}
	function discardCampaignForRebuild() {
		campaignRequest++;
		if (campaignJob && campaignJob.running) Instruments.cancelCampaign(campaignJob);
		campaignJob = null; campaignPreparing = false; campaignView = null;
		campaignRefreshArmed = false; markersDirty = false;
		lastCoreState = null; lastCoreCell = -1; lastCoreSection = null; lastInstrumentText = '';
		coreExport.disabled = true;
		// The ledger itself belongs to the world the rebuild replaces; drop every view built
		// on it, so no frame can paint stale discoveries while the boot is still in flight.
		selectedDeposit = null; ledgerMarkers = null; markerHitsN = 0;
		markerCanvas.hidden = true; markerContext.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
		prospectPanel.textContent = prospectIntro;
		refreshLedgerRows();
		paintCampaignControls();
	}
	function failCampaignSetup(error, token) {
		if (token !== campaignRequest) return;
		campaignPreparing = false;
		paintCampaignControls();
		campaignProgress.textContent = 'Campaign could not start: ' + error.message;
		paintDepositMarkers();
		setPlaying(false);
	}
	function beginCampaign(world, selected, token) {
		if (token !== campaignRequest || state !== world) return;
		try {
			var catalogue = Deposits.build(world);
			var job = Instruments.startCampaign(world, catalogue, selected, prospectLedger);
			if (!job.ok) { failCampaignSetup(new Error(job.reason), token); return; }
			campaignView = null; campaignJob = job; campaignPreparing = false;
			campaignRefreshArmed = false; markerCanvas.hidden = true; campaignExport.disabled = true;
			setPlaying(false); paintCampaignControls();
		} catch (error) { failCampaignSetup(error, token); }
	}
	function startRegionalCampaign() {
		if (campaignPreparing) {
			campaignRequest++; campaignPreparing = false; campaignRefreshArmed = false;
			paintCampaignControls(); setPlaying(false);
			markersDirty = true; paintDepositMarkers();
			return;
		}
		if (campaignJob && campaignJob.running) {
			var cancelled = campaignJob;
			Instruments.cancelCampaign(cancelled);
			finalizeCampaign(cancelled);
			return;
		}
		var selected = selectedInstrumentIds();
		if (!selected.length) {
			campaignProgress.textContent = 'No instruments selected. Choose at least one, then start the regional campaign.';
			return;
		}
		if (campaignView && Deposits.stale(state, campaignView.catalogue) && !campaignRefreshArmed) {
			campaignRefreshArmed = true;
			campaignProgress.textContent = 'stale — press again to refresh; the new campaign pauses playback.';
			campaignButton.textContent = 'Refresh stale campaign';
			return;
		}
		campaignRefreshArmed = false;
		var world = state, token = ++campaignRequest;
		campaignPreparing = true; markerCanvas.hidden = true;
		setPlaying(false); runTarget = Infinity; paintCampaignControls();
		if (gpu.on && gpu.ready) {
			whenGpuIdle(function () {
				if (token !== campaignRequest || state !== world) return;
				var readback;
				try { readback = Promise.resolve(GpuSim.download(world)); }
				catch (error) { failCampaignSetup(error, token); return; }
				campaignReadback = readback;
				readback.then(function () {
					if (campaignReadback === readback) campaignReadback = null;
					beginCampaign(world, selected, token);
				}, function (error) {
					if (campaignReadback === readback) campaignReadback = null;
					failCampaignSetup(error, token);
				});
			});
		} else beginCampaign(world, selected, token);
	}
	campaignButton.addEventListener('click', startRegionalCampaign);
	campaignKind.addEventListener('change', function () {
		if (campaignView) refreshCampaignView(); else refreshLedgerMarkers();
		refreshLedgerRows();
	});
	coreDepth.addEventListener('change', refreshLastCore);
	coreExport.addEventListener('click', function () {
		if (!lastCoreSection) return;
		var blob = new Blob([Core.json(lastCoreSection)], { type: 'application/json' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'core-cell-' + lastCoreCell + '-' + (coreDepth.value === 'basement' ? 'basement' : coreDepth.value + 'm') + '.json';
		link.click(); URL.revokeObjectURL(link.href);
	});
	campaignExport.addEventListener('click', function () {
		if (!campaignView) return;
		var json = Deposits.json(state, {
			catalogue: campaignView.catalogue, ledger: prospectLedger, kind: campaignKind.value || 'all'
		});
		var blob = new Blob([json], { type: 'application/json' }), link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'discovered-deposits-' + Math.round(campaignView.epochMyr) + 'myr.json';
		link.click(); URL.revokeObjectURL(link.href);
	});
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
		if (campaignLocked()) startRegionalCampaign();
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
	function campaignLocked() { return campaignPreparing || !!(campaignJob && campaignJob.running); }
	function setPlaying(value) {
		playing = value; play.textContent = playing ? 'Pause' : 'Play';
		play.setAttribute('aria-pressed', String(playing));
		play.disabled = campaignLocked(); step.disabled = playing || campaignLocked();
	}
	play.addEventListener('click', function () {
		if (campaignLocked()) return;
		runTarget = Infinity; setPlaying(!playing);
	});
	step.addEventListener('click', function () {
		if (campaignLocked()) return;
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
		if (campaignLocked()) return;
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
		rebuildWhenIdle(grid.level, +seedInput.value, startInput.value);
	});
	// A new resolution is a new world: same seed and start, rebuilt from scratch, because the
	// crust lives on columns of one particular grid and nothing carries across grids.
	levelInput.addEventListener('change', function () {
		if (!seedInput.checkValidity()) { seedInput.reportValidity(); levelInput.value = String(grid.level); return; }
		var level = +levelInput.value;
		// The CPU engine is the calibrated L5 path (design 0.1.5 §1); it runs L6-L7 too, at a
		// few frames per second, and saying so once beats looking like a hang.
		var slow = level > 5 && engineInput.value === 'cpu';
		rebuildWhenIdle(level, +seedInput.value, startInput.value, slow ? function () {
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
			link.download = 'planet-' + startInput.value + '-' + Math.round(state.t) + 'myr.pgt';
			link.click();
			URL.revokeObjectURL(link.href);
		}
	});
	// The full catalogue is an explicit, user-requested O(V) build - the one place a click is
	// allowed to pay for every cell. Its scratch is allocated on first use, never per frame.
	// On the GPU engine it first pulls the mirror so the potentials are current.
	document.getElementById('deposits').addEventListener('click', function () {
		var extract = function () {
			var blob = new Blob([Deposits.json(state)], { type: 'application/json' });
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
			rebuildWhenIdle(head.level, head.seed, startInput.value, function () {
				try {
					Checkpoint.load(state, bytes);
					// The blob owns the temperature and the cooling flag; the sliders follow it.
					// prescribedOmega and rotationHistory are not checkpoint scalars: the
					// rebuild's Earth.apply re-derived both from the start pack and the preset
					// select (realistic holds the poles - and steers an epoch pack that carries
					// model ids - game lets the mantle drive), and Checkpoint.load leaves the
					// flags and the rotRec tables untouched.
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
	function cellAt(x, y, target) {
		if (v3d.on && target === map3d) return cellAt3d(x, y);
		var rect = mapRect(target);
		var px = Math.min(grid.lookupW - 1, Math.max(0, Math.floor((x - rect.left) / rect.width * grid.lookupW)));
		var py = Math.min(grid.lookupH - 1, Math.max(0, Math.floor((y - rect.top) / rect.height * grid.lookupH)));
		if (renderer.updateViewLookup) renderer.updateViewLookup();
		var mapLookup = renderer.viewLookup || grid.lookup;
		return mapLookup[(grid.lookupH - 1 - py) * grid.lookupW + px];
	}
	function probeAt(event, target) {
		var cell = cellAt(event.clientX, event.clientY, target);
		if (cell >= 0) probeReport(cell);
	}
	// The 3D inspector: the pointer ray is intersected with the unit planet (Render3D.pick,
	// the camera's own basis maths), then maps the hit direction to the gather's uv convention.
	// Hover reads the CPU mirror as it is; a click pulls it first, exactly like the 2D map.
	var pickDir = new Float64Array(3);
	function cellAt3d(x, y) {
		var r3d = v3d.r3d;
		if (!r3d || !r3d.pick) return -1;
		var rect = mapRect(map3d);
		if (!r3d.pick(pickDir, x - rect.left, y - rect.top, rect.width, rect.height)) {
			probe.textContent = 'Off the planet.';
			return -1;
		}
		var u = Math.atan2(pickDir[2], pickDir[0]) / MapView.TAU + 0.5;
		var v = Math.asin(Math.max(-1, Math.min(1, pickDir[1]))) / Math.PI + 0.5;
		var px = Math.min(grid.lookupW - 1, Math.max(0, Math.floor(u * grid.lookupW)));
		var py = Math.min(grid.lookupH - 1, Math.max(0, Math.floor(v * grid.lookupH)));
		return grid.lookup[py * grid.lookupW + px];
	}
	function probeAt3d(event) {
		var cell = cellAt3d(event.clientX, event.clientY);
		if (cell >= 0) probeReport(cell);
	}
	function probeReport(cell) {
		var owner = state.owner[cell];
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
	function inspectCell(cell, selected) {
		probeReport(cell);
		try {
			if (selected.length) {
				var result = Instruments.survey(state, cell, selected, prospectLedger);
				noteCampaignSurvey(result);
				lastInstrumentText = Instruments.report(result);
			} else lastInstrumentText = 'No instruments selected; this click logs a core without adding survey coverage.';
			lastCoreCell = cell; lastCoreState = state;
			refreshLastCore();
			if (campaignView) refreshCampaignView(true); else refreshLedgerMarkers();
			refreshLedgerRows();
		} catch (error) {
			prospectPanel.textContent = (selected.length ? 'Survey' : 'Core') + ' failed: ' + error.message;
			console.error('Prospecting/core report failed', error);
		}
	}
	// Resolve the cell while the event and current view are still live; then snapshot the
	// selected tools and world before GPU readback. Neither a cleared currentTarget, a later pan,
	// nor a world rebuild can redirect this survey to a different cell or session.
	function probeClick(event) {
		var cell = cellAt(event.clientX, event.clientY, event.currentTarget);
		if (!Number.isInteger(cell) || cell < 0) return;
		// A click that lands on a painted marker pins that deposit; a click anywhere else with
		// a pin in place releases it. Both keep the survey's own meaning of a click.
		if (!markerCanvas.hidden) {
			var pin = markerHitsN ? hitDeposit(event) : null;
			if (pin !== null) selectDeposit(pin);
			else if (selectedDeposit !== null) selectDeposit(selectedDeposit);
		}
		var selected = selectedInstrumentIds(), world = state, serial = ++prospectClickSerial;
		if (gpu.on && gpu.ready) {
			var transfer = campaignJob && campaignJob.running && campaignJob.state === world
				? Promise.resolve() : campaignReadback || GpuSim.download(world);
			Promise.resolve(transfer).then(function () {
				if (state === world && serial === prospectClickSerial) inspectCell(cell, selected);
			}).catch(function (error) {
				if (state !== world || serial !== prospectClickSerial) return;
				probe.textContent = 'GPU readback failed: ' + error.message;
				if (selected.length) prospectPanel.textContent = 'Survey failed: ' + error.message;
				console.error('Prospecting readback failed', error);
			});
			return;
		}
		inspectCell(cell, selected);
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
		orbit.suppressClick = orbit.moved;   // a drag that ends on the canvas is not a pick
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
	// The inspector works over the 3D view too: hover follows the pointer ("Info follows
	// pointer", shared with the 2D map), a click that is not an orbit pins the column -
	// with a fresh GPU mirror through probeClick, exactly like the 2D map's click.
	map3d.addEventListener('pointermove', function (event) {
		if (orbit.active || !v3d.on || !followInput.checked) return;
		probeAt3d(event);
	});
	map3d.addEventListener('click', function (event) {
		if (orbit.suppressClick) { orbit.suppressClick = false; return; }
		if (!v3d.on) return;
		probeClick(event);
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
		var viewGate = viewGateReport(), adjust = adjustReport(), prospect = prospectCapture();
		var recon = reconInput && +reconInput.value ? 'recon ' + (+reconInput.value).toFixed(0) + ' Ma' : '';
		// The 3D is a view setting, so it names itself only when it differs from the
		// default (off); its knobs follow the adj line's convention.
		var v3dLine = '';
		if (v3d.on) {
			v3dLine = ' · 3d on';
			if (v3dDisp !== 10) v3dLine += ' · disp ' + v3dDisp + 'x';
			if (v3dMesh !== 'ico') v3dLine += ' · mesh ' + v3dMesh;
			if (v3dDetail !== Render3D.DEFAULT_DETAIL[v3dMesh]) v3dLine += ' · ' + v3dDetail;
			if (v3dNorm !== 'deriv') v3dLine += ' · norm ' + v3dNorm;
		}
		return rig
			+ '\nengine ' + engine + ' · L' + grid.level
			+ ' · dt ' + dtInput.value + ' · ' + speedInput.value + ' steps/frame · view ' + layerValue()
			+ ' · ' + startInput.value + ' start · seed ' + seedInput.value
			+ ' · cadence ' + Params.eventCadence + ' Myr'
			+ (state.rotationHistory ? ' · steered' : '') + v3dLine
			+ (recon ? ' · ' + recon : '')
			+ '\n' + Perf.report(stripRows())
			+ (viewGate ? '\n' + viewGate : '')
			+ (adjust ? '\n' + adjust : '')
			+ (prospect ? '\n' + prospect : '')
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
		if (campaignJob && campaignJob.running) {
			var activeCampaign = campaignJob;
			try {
				Instruments.campaignStep(activeCampaign, 256, 1.25);
				paintCampaignControls();
				if (activeCampaign.done || activeCampaign.cancelled || activeCampaign.invalidated)
					finalizeCampaign(activeCampaign);
			} catch (error) {
				Instruments.cancelCampaign(activeCampaign);
				activeCampaign.reason = error.message;
				finalizeCampaign(activeCampaign);
				campaignProgress.textContent = 'Campaign stopped: ' + error.message + ' · partial ledger retained.';
			}
		}
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
		if (markersDirty || viewMoved) paintDepositMarkers();
		Perf.frame(now, ran, dt); ran = 0;
		if (Perf.due(now)) {
			Perf.v3dText = v3d.on && v3d.r3d ? v3d.r3d.tsLine() : '';
			Perf.update(now);
			if (campaignView && Deposits.stale(state, campaignView.catalogue) !== campaignView.stale) {
				if (!Deposits.stale(state, campaignView.catalogue)) campaignView.invalidated = false;
				campaignRefreshArmed = false;
				refreshCampaignView();
			}
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

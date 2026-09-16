(function () {
	var canvas = document.getElementById('map'), gpuCanvas = document.getElementById('mapgpu');
	var play = document.getElementById('play'), step = document.getElementById('step');
	var dtInput = document.getElementById('dt'), speedInput = document.getElementById('speed');
	var cadenceInput = document.getElementById('cadence');
	var runToInput = document.getElementById('run-to'), runToStart = document.getElementById('run-to-start');
	var seedInput = document.getElementById('seed'), layerGroup = document.getElementById('layer');
	var currentLayer = 'plate';
	function layerValue() { return currentLayer; }
	var startInput = document.getElementById('start'), loadInput = document.getElementById('load');
	var followInput = document.getElementById('follow');
	var engineInput = document.getElementById('engine'), badge = document.getElementById('badge');
	var levelInput = document.getElementById('level'), gridInfo = document.getElementById('grid-info');
	var extractScratch = null;
	var time = document.getElementById('time'), status = document.getElementById('gaps'), probe = document.getElementById('probe');
	var perfStrip = document.getElementById('perf-rows');
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
	Sim.raster(state);
	Perf.reset();
	function paintBadge() {
		badge.textContent = (gpu.on && gpu.ready ? 'GPU · L' : 'CPU · L') + grid.level;
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
		renderer = new Renderer(canvas, state);
		renderer.setView(viewQ);
		extractScratch = null;   // sized to the old grid.V
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
		resetViewStats();
		whenGpuIdle(function () { bootEngine(function () { dirty = true; }); });
	});
	// Fast-forward escape hatch: rebuild the plate table only every 5/10 Myr instead
	// of every 1 Myr. No rebuild needed: Events.cycle is span-aware and both engines
	// read Params.eventCadence per step; the span due next can be several Myr long.
	cadenceInput.addEventListener('change', function () {
		Params.eventCadence = +cadenceInput.value;
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
			gpu.pending = GpuSim.step(state, +dtInput.value, GpuSim.Events, GpuSim.Checkpoint, GpuSim.Params)
				.then(function () {
					return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
						if (!(gpu.on && gpu.ready)) return;
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
			Sim.step(state, +dtInput.value); dirty = true;
		}
	});
	runToStart.addEventListener('click', function () {
		if (!runToInput.checkValidity()) { runToInput.reportValidity(); return; }
		runTarget = +runToInput.value;
		if (runTarget <= state.t) { probe.textContent = 'Run-to target must be later than the current time.'; return; }
		setPlaying(true);
	});
	layerGroup.addEventListener('change', function (event) {
		if (event.target && event.target.name === 'layer') currentLayer = event.target.value;
		dirty = true;
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
		var viewGate = viewGateReport();
		return rig
			+ '\nengine ' + engine + ' · L' + grid.level
			+ ' · dt ' + dtInput.value + ' · ' + speedInput.value + ' steps/frame · view ' + layerValue()
			+ ' · ' + startInput.value + ' start · seed ' + seedInput.value
			+ ' · cadence ' + Params.eventCadence + ' Myr'
			+ '\n' + Perf.report(stripRows())
			+ (viewGate ? '\n' + viewGate : '')
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
		if (playing && !gateClosed) {
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
						// K11 is on demand: the status line refreshes on the 150 ms tick,
						// so ask for one diagnostic frame per tick instead of every frame.
						if (now - lastUpdate > 150) GpuSim.wantDiag();
						// The play encoder still carries the world draw (GpuRenderer.appendTo),
						// which keeps the render path and the event-boundary semantics of
						// GpuSim.play intact. The VISIBLE canvas is not touched here: once the
						// segment has finished, redraw the latest buffers on their own tiny
						// world pass and only then blit to the canvas. That order is what keeps
						// L7 from staying black under continuous play - a present queued on the
						// same drain as the next heavy segment lands behind that segment again.
						var renderTail = function (enc) {
							mergedThisFrame = true;
							gpuRenderer.appendTo(enc, layerValue());
						};
						gpu.busy = true;
						gpu.pending = GpuSim.play(state, dt, steps, viewLive, { render: renderTail })
							.then(function (done) {
								return GpuSim.S.device.queue.onSubmittedWorkDone().then(function () {
									if (!(gpu.on && gpu.ready)) return done;
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
					Sim.advance(state, dt, steps); ran += steps; dirty = true;
				}
			}
			if (runTarget < Infinity && state.t >= runTarget - dt * 0.5) {
				runTarget = Infinity; setPlaying(false);
			}
		}
	// `dirty` is a changed layer or state and recolours the cells; a view move alone only
	// re-samples the screen table and repaints the last colours (the GPU draw is one
	// triangle either way). On the GPU engine the canvas always shows the world texture,
	// and the blit onto it rides a drained queue (presentWhenDrained) - never a pass
	// inside the heavy segment encoder, which would present black on heavy settings.
	if (gpu.on && gpu.ready) {
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

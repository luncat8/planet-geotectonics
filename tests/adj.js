// The live adjustments (0.3.3): temperature with its cooling switch and Mantle Tm slider,
// the friction and erosion scales the kernels read from frameIn, and the elevation ramp.
// Nothing here is a new physics claim - it is the slider wiring, pinned where the world
// would silently ignore it: mantle.js/sim-gpu.js (the pinned Tm), plates.js and surface.js
// (the two scales, with friction's default exactness), checkpoint.js (VERSION 2 + cooling),
// the two renderers (the ramp), and the page, where the controls do the writing.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const Mantle = require('../js/mantle.js');
const Plates = require('../js/plates.js');
const Surface = require('../js/surface.js');
const Checkpoint = require('../js/checkpoint.js');
const Renderer = require('../js/render.js');
const GpuSim = require('../js/gpu/sim-gpu.js');
const { makeDom, installGlobals } = require('./dom-stub.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const DT = 0.1;
const world = (level, seed) => {
	const s = new State(new Grid(level, seed).build(), seed);
	s.ckptCap = 0;
	Sim.raster(s);
	return s;
};

// --- 1. Cooling off pins Tm, and re-enabling resumes from the same baseline ---------------
{
	const s = world(3, 7);
	Sim.advance(s, DT, 200);
	const cooled = s.Tm;
	assert.ok(cooled < s.Tm0, 'the default world cools: ' + cooled + ' < ' + s.Tm0);

	s.cooling = 0;
	Sim.advance(s, DT, 200);
	assert.equal(s.Tm, cooled, 'cooling off freezes Tm across 200 frames');

	// Back on: the curve resumes from where the world is, not from the decay it would have
	// had - the point of the re-anchor.
	s.cooling = 1;
	Mantle.setTm(s, s.Tm);
	Sim.advance(s, DT, 200);
	assert.ok(s.Tm < cooled && s.Tm > Params.Tfloor, 're-enabled cooling decays on from ' + cooled + ': ' + s.Tm);
	// Exactly the curve it re-anchored onto: Mantle.update ran at the frame's own t, which
	// sim.step increments after the physics (hence the one-step lag).
	assert.equal(s.Tm, Mantle.Tm(s.t - DT, s.Tm0), 'and stays on its own baseline');

	// The GPU engine's block filler reads the same flag (it is what the device is told).
	const g = world(3, 7);
	const block = new Float32Array(GpuSim.FIN_FIELDS);
	GpuSim.fillFrame(g, block, 0, DT, 300, 3000);
	assert.ok(block[2] < g.Tm0, 'the block carries the cooled Tm');
	g.cooling = 0;
	g.Tm = 0.62;
	GpuSim.fillFrame(g, block, 0, DT, 310, 3100);
	assert.equal(block[2], Math.fround(0.62), 'cooling off ships the stored Tm to the kernels');

	// The two scales ride the block's promoted slots, so the device reads what the sliders say.
	Params.friction = 1.5;
	Params.eroScale = 0.25;
	GpuSim.fillFrame(g, block, 0, DT, 320, 3200);
	assert.equal(block[GpuSim.FIN_FRICTION], Math.fround(1.5), 'friction is in its slot');
	assert.equal(block[GpuSim.FIN_EROSCALE], Math.fround(0.25), 'and erosion in its own');
	Params.friction = 1;
	Params.eroScale = 1;
}

// --- 2. The Mantle Tm slider re-derives the baseline ---------------------------------------
{
	const s = world(3, 7);
	for (const value of [1.4, Params.Tfloor, 2]) {
		Mantle.setTm(s, value);
		assert.ok(Math.abs(s.Tm - value) < 1e-15, 't 0: Tm is the slider ' + value + ': ' + s.Tm);
		assert.ok(Math.abs(Mantle.Tm(s.t, s.Tm0) - value) < 1e-12, 't 0: the curve passes through it');
	}
	Sim.advance(s, DT, 3000);                                  // 300 Myr of cooling
	const t = s.t;
	for (const value of [1.9, 0.5, 1]) {
		Mantle.setTm(s, value);
		assert.equal(s.Tm, value, 'mid-run: the world is on the slider at t ' + t);
		assert.ok(Math.abs(Mantle.Tm(t, s.Tm0) - value) < 1e-12,
			'mid-run: the re-derived baseline passes through ' + value + ' at t ' + t);
		assert.ok(s.Tm0 > value, 'and the baseline is the warm end of the curve');
	}
	// Cooling off: no baseline arithmetic, the value is the pinned temperature.
	s.cooling = 0;
	Mantle.setTm(s, 0.8);
	assert.equal(s.Tm, 0.8);
	Sim.advance(s, DT, 100);
	assert.equal(s.Tm, 0.8, 'and it stays there');
}

// --- 3. Friction scales Ea, exactly at the default -----------------------------------------
{
	// Oceanic cells with a slope and no subducting edge: their ridge push is the whole
	// damping law, so the slider's effect can be read off one cell.
	function ridgeCells(s, want) {
		const cells = [];
		for (let c = 0; c < s.grid.V && cells.length < want; c++) {
			const owner = s.owner[c];
			if (owner < 0 || s.hFel[owner] >= Params.hOceanic) continue;
			const b = c * 3;
			if (!(Math.hypot(s.gradZ[b], s.gradZ[b + 1], s.gradZ[b + 2]) > 0)) continue;
			let convergent = false;
			for (let k = 0; k < s.grid.ringN[c]; k++) {
				if (s.edgeType[c * 6 + k] === 1 && s.polarity[c * 6 + k] === -1) convergent = true;
			}
			if (!convergent) cells.push(c);
		}
		assert.ok(cells.length === want, 'a fresh world has ' + want + ' plain oceanic cells, found ' + cells.length);
		return cells;
	}
	// The default 1.0 must leave the push bit-identical to the baked Ea, which is what the
	// slider sits on.
	const s = world(3, 7);
	const cells = ridgeCells(s, 8);
	const invCD = Math.exp(-Params.Ea * (1 / s.Tm - 1));
	for (const c of cells) {
		for (let i = 0; i < 3; i++) {
			assert.equal(s.wEq[c * 3 + i], -Params.kRidge * invCD * s.gradZ[c * 3 + i],
				'ridge push ' + i + ' at default friction is the baked path exactly');
		}
	}

	// The slider is Ea: friction 2 must equal Ea 6 bit for bit, and friction 0 leaves the
	// forces undamped (exp(0) = 1).
	const reference = world(3, 7), scaled = world(3, 7);
	reference.Tm = scaled.Tm = 0.8;
	Params.Ea = 6;
	Plates.forces(reference);
	Params.Ea = 3; Params.friction = 2;
	Plates.forces(scaled);
	for (let i = 0; i < reference.wEq.length; i++) {
		assert.equal(scaled.wEq[i], reference.wEq[i], 'friction 2x is Ea 6, word ' + i);
	}
	Params.friction = 0;
	Plates.forces(scaled);
	for (const c of cells) {
		for (let i = 0; i < 3; i++) {
			assert.equal(scaled.wEq[c * 3 + i], -Params.kRidge * scaled.gradZ[c * 3 + i],
				'friction 0 leaves the ridge push undamped');
		}
	}
	Params.friction = 1;
}

// --- 4. The erosion law: the quadratic knee, at the plan's reference elevations -------------
{
	// Three columns that differ only in elevation and one plain column, all with the same
	// slope, so the intake difference is the law and nothing else. hSed and hMaf start at 0,
	// so what erosion takes comes off hFel and can be read back as a height.
	const g = new Grid(3, 7).build();
	const s = new State(g, 7);
	s.ckptCap = 0; s.n = g.V;
	for (let c = 0; c < g.V; c++) {
		s.owner[c] = c; s.cell[c] = c; s.alive[c] = 1; s.plate[c] = 0;
		s.hFel[c] = 300000; s.hMaf[c] = 0; s.hSed[c] = 0; s.age[c] = 500;
		s.z[c] = 1000; s.slope[c] = Params.slopeRef;
		s.low[c] = -1;
	}
	const knee = Params.zKnee, cells = [0, 1, 2];
	const heights = { 0: knee * 0.5, 1: knee, 2: knee * 2 };
	for (const c of cells) s.z[c] = heights[c];
	// One frame's intake: the routing passes hand the eroded crust straight back as sediment on
	// its own column, so a measurement starts from clean columns and reads the hFel drop.
	function intake(cell) {
		s.hSed.fill(0); s.mobile.fill(0); s.mobileFel.fill(0); s.mobilePla.fill(0);
		s.outflow.fill(0); s.outflowFel.fill(0); s.outflowPla.fill(0); s.stay.fill(0);
		const before = s.hFel[cell];
		Surface.route(s, DT);
		return before - s.hFel[cell];
	}
	const took = cells.map((c) => intake(c));
	const linear = heights[cells[1]] * Params.kEro * (1 + 2) * DT;   // the old law, at the knee
	assert.ok(Math.abs(took[1] - linear) < 1e-9, 'the knee is continuous with the linear law: '
		+ took[1] + ' vs ' + linear);
	const ratioLow = took[0] / (heights[cells[0]] * Params.kEro * 3 * DT);
	const ratioHigh = took[2] / (heights[cells[2]] * Params.kEro * 3 * DT);
	assert.ok(Math.abs(ratioLow - 0.25) < 1e-9, '2.5 km erodes at a quarter of the old rate: ' + ratioLow);
	assert.ok(Math.abs(ratioHigh - 4) < 1e-9, '13 km at four times: ' + ratioHigh);

	// The scale itself, as a literal: 1 km of relief at the reference slope (the 1 + 2 factor)
	// loses 1.85 m per Myr at the calibrated 9 km knee. Everything above is relative to
	// Params.zKnee and so moves with it, which is exactly what must not happen quietly - the
	// knee sets the law's whole scale, and moving it is a release calibration change that has
	// to look like one here as well as in the rig's longrun (14.1 % continents at 6.5 km).
	const perMyr = Params.kEro * 1000 * Math.pow(1000 / Params.zKnee, 2) * 3;
	assert.ok(Math.abs(perMyr - 1.85) < 0.01, 'the calibrated intake at 1 km: ' + perMyr.toFixed(3) + ' m/Myr');

	// Erosion × scales the intake, and 0 turns it off.
	Params.eroScale = 0.5;
	assert.ok(Math.abs(intake(cells[1]) - linear * 0.5) < 1e-9, 'Erosion × 0.5 halves the intake');
	Params.eroScale = 0;
	assert.equal(intake(cells[1]), 0, 'Erosion × 0 leaves the crust alone');
	Params.eroScale = 1;
}

// --- 5. The checkpoint: VERSION 2 carries the cooling flag ----------------------------------
{
	assert.equal(Checkpoint.VERSION, 2, 'the version word moved with the scalar table');
	assert.ok(Checkpoint.SCALARS.includes('cooling'), 'cooling is checkpointed');
	const s = world(3, 7);
	s.cooling = 0; s.Tm = 1.25; s.Tm0 = 0.9;
	const blob = Checkpoint.save(s);
	const back = new State(new Grid(3, 7).build(), 7);
	back.ckptCap = 0;
	Checkpoint.load(back, blob);
	assert.equal(back.cooling, 0, 'the flag survives the round trip');
	assert.equal(back.Tm, 1.25, 'and so does the pinned temperature');
	Sim.advance(back, DT, 50);
	assert.equal(back.Tm, 1.25, 'a loaded world stays pinned');

	// A v1 blob is rejected by the version word, before any table is read: there is no
	// legacy layout to support.
	const v1 = Uint8Array.from(blob);
	new Uint32Array(v1.buffer, 4, 1)[0] = 1;
	assert.throws(() => Checkpoint.load(back, v1), (e) => e instanceof RangeError && /version 1/.test(e.message),
		'a v1 blob is refused with the version it carries');
	assert.throws(() => Checkpoint.peek(v1), /version 1/);
}

// --- 6. The relief ramp is a renderer setting ------------------------------------------------
{
	const s = world(3, 7);
	let peak = -1, mid = -1, trench = -1;
	for (let c = 0; c < s.grid.V && (peak < 0 || mid < 0 || trench < 0); c++) {
		if (s.owner[c] < 0) continue;
		if (peak < 0) peak = c;
		else if (mid < 0) mid = c;
		else trench = c;
	}
	s.z[peak] = 9000; s.z[mid] = 3000; s.z[trench] = -9000;
	const r = new Renderer({ getContext: () => ({
		createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
		putImageData: () => {}
	}) }, s);
	// The ramp the renderer documents: land saturates at +zRange and the deep-water floor at
	// -zRange, symmetrically. The bytes come out of a Uint8Array so the expected values clamp
	// exactly the way the drawn ones do.
	function expected(z, range) {
		const high = Math.min(1, z / range), shallow = Math.max(0, 1 + z / range), out = new Uint8Array(3);
		if (z < 0) { out[0] = 15 + 23 * shallow; out[1] = 40 + 95 * shallow; out[2] = 69 + 100 * shallow; }
		else { out[0] = 100 + 145 * high; out[1] = 156 + 79 * high; out[2] = 112 + 113 * high; }
		return Array.from(out);
	}
	function colorsAt(range, cell) {
		Params.zRange = range;
		r.draw('z');
		return Array.from(r.colors.slice(cell * 3, cell * 3 + 3));
	}
	assert.deepEqual(colorsAt(6500, peak), expected(9000, 6500), 'the default ramp saturates a 9 km peak');
	assert.deepEqual(colorsAt(20000, peak), expected(9000, 20000), 'a 20 km ramp does not');
	assert.notDeepEqual(colorsAt(6500, mid), colorsAt(20000, mid), 'a 3 km slope recolours');
	assert.deepEqual(colorsAt(6500, trench), [15, 40, 69], '9 km down is the floor of the default ramp');
	assert.deepEqual(colorsAt(20000, trench), expected(-9000, 20000), 'and the floor moves with the ramp');
	Params.zRange = 6500;
}

// --- 7. The page: the controls write, and the copy header records ---------------------------
const MODULES = ['env', 'geodesics', 'params', 'water', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges',
	'plates', 'contact', 'column-update', 'surface', 'events', 'checkpoint', 'perf', 'clipboard',
	'extract', 'sim', 'render'];
const indexHtml = read('index.html');
function loadPage(search) {
	const api = makeDom(indexHtml);
	api.location.search = search || '';
	installGlobals(api, {});
	for (const file of MODULES) {
		vm.runInThisContext(read('js/' + file + '.js'), { filename: 'js/' + file + '.js' });
	}
	vm.runInThisContext(read('js/ui.js'), { filename: 'js/ui.js' });
	const el = (id) => {
		const node = api.document.getElementById(id);
		assert.ok(node, 'index.html has #' + id);
		return node;
	};
	return {
		api: api, el: el, Params: globalThis.Params,
		// The world's temperature is the HUD's, read back the way an operator reads it.
		tm: () => +/Tm (\d+\.\d+)/.exec(el('gaps').textContent)[1],
		pump: (frames, from) => api.pump(frames, from === undefined ? 1000 : from, 16.7),
		copy: () => { el('perf-rows').click(); return api.document.copied[api.document.copied.length - 1]; }
	};
}

// A default page says nothing about adjustments and starts on the calibrated values.
const plain = loadPage('');
assert.equal(plain.Params.friction, 1, 'friction boots at its default');
assert.equal(plain.Params.eroScale, 1, 'erosion too');
assert.equal(plain.Params.zRange, 6500, 'and the ramp is the original +/- 6.5 km');
assert.equal(plain.el('tm-value').textContent, '1.00', 'the readouts start on the slider values');
assert.equal(plain.el('friction-value').textContent, '1.00');
assert.equal(plain.el('ero-value').textContent, '1.00');
assert.equal(plain.el('relief-value').textContent, '6.5 km');
plain.pump(40, 1000);
assert.ok(!/^adj /m.test(plain.copy()), 'a default capture keeps the header shape:\n' + plain.copy());

// The ?-pre-fill names the settings a capture's own header line copies.
const asked = loadPage('?tm=1.4&cool=0&fric=1.5&ero=0.5&relief=9');
assert.equal(asked.el('cooling').checked, false, '?cool=0 unchecks Cooling');
assert.equal(asked.el('tm').value, '1.4');
assert.equal(asked.Params.friction, 1.5, '?fric= reaches the kernels');
assert.equal(asked.Params.eroScale, 0.5, '?ero= too');
assert.equal(asked.Params.zRange, 9000, '?relief= is kilometres on the control, metres in the ramp');
assert.equal(asked.el('tm-value').textContent, '1.40', 'the readouts follow the pre-fill');
assert.equal(asked.el('friction-value').textContent, '1.50');
assert.equal(asked.el('ero-value').textContent, '0.50');
assert.equal(asked.el('relief-value').textContent, '9.0 km');
asked.pump(40, 1000);
assert.equal(asked.tm(), 1.4, 'the pre-filled temperature is the world\'s');
assert.ok(asked.copy().includes('\nadj Tm 1.40 cooling off · friction 1.5x · erosion 0.5x · relief 9.0 km\n'),
	'the capture names every adjustment, in the plan\'s order:\n' + asked.copy());

// A slider moves the world, not just the panel: friction and erosion land on Params, and the
// temperature on the state the HUD reads.
asked.el('friction').value = '2.5';
asked.el('friction').dispatch('input');
asked.el('ero').value = '1.25';
asked.el('ero').dispatch('input');
asked.el('tm').value = '0.6';
asked.el('tm').dispatch('input');
assert.equal(asked.Params.friction, 2.5, 'a slider move is a live Params write');
assert.equal(asked.Params.eroScale, 1.25);
asked.pump(20, 2000);
assert.equal(asked.tm(), 0.6, 'and a live temperature');
assert.equal(asked.el('friction-value').textContent, '2.50', 'the readout tracks the control');

// The Tm slider follows the sim at 2 Hz while cooling is on, and stops while the user has a
// hand on it. Focus is not that signal: a range input keeps it long after the drag, so a focus
// gate leaves the control frozen on the user's last value until they click somewhere else. A
// touch arms a hold the strip's own ticks retire, so the follow resumes by itself.
const idle = loadPage('');
assert.equal(idle.el('cooling').checked, true, 'cooling is on by default');
idle.el('tm').value = '0.50';                   // the control is out of step with the world
idle.pump(40, 1000);
assert.equal(idle.el('tm').value, idle.tm().toFixed(2), 'the follow rewrote the control from the sim');
assert.equal(idle.el('tm-value').textContent, idle.tm().toFixed(2), 'and its readout with it');

const follow = loadPage('');
follow.el('play').click();
follow.pump(400, 1000);                             // 40 Myr: the world has left the start value
const cooled = follow.tm();
assert.ok(cooled < 1 && cooled > 0.9, 'the running world has cooled to ' + cooled);
follow.api.document.activeElement = follow.el('tm');
follow.el('tm').dispatch('pointerdown');             // a hand on the control, focused as after a drag
follow.el('tm').value = '1.50';
follow.pump(40, 8000);                               // two strip ticks inside the hold
assert.equal(follow.el('tm').value, '1.50', 'the ticks under the hand leave the control alone');
follow.pump(40, 12000);
assert.equal(follow.el('tm').value, follow.tm().toFixed(2),
	'the hold retires on its own: the follow resumes while the control still has focus');
follow.el('tm').dispatch('input');                   // a key move arms it the same way
follow.el('tm').value = '1.50';
follow.pump(40, 16000);
assert.equal(follow.el('tm').value, '1.50', 'an input event is a hand on the control too');

// Moving the other sliders must not re-anchor the temperature, and must not hold the Tm follow
// off either: the hold belongs to the control the user touches, not to the panel.
const stray = loadPage('');
stray.el('play').click();
stray.pump(400, 1000);                               // 40 Myr of cooling under the running sim
const running = stray.tm();
assert.ok(running < 1 && running > 0.9, 'the running world has cooled a little: ' + running);
stray.el('tm').value = '0.50';
stray.el('friction').value = '2';
stray.el('friction').dispatch('input');
stray.el('relief').value = '18';
stray.el('relief').dispatch('input');
stray.pump(40, 8000);
assert.equal(stray.tm(), running, 'the other sliders leave the temperature alone');
assert.equal(stray.el('tm').value, running.toFixed(2), 'and the follow keeps the Tm control on the world');

// Switching Cooling off mid-run pins whatever the world had reached: the capture has to name
// that temperature, because the run it describes no longer starts on the default curve.
const midcool = loadPage('');
midcool.el('play').click();
midcool.pump(400, 1000);                             // 40 Myr: Tm has left the start value
const pinnedTm = midcool.tm();
assert.ok(pinnedTm < 1 && pinnedTm > 0.9, 'the world has cooled a little: ' + pinnedTm);
midcool.el('cooling').checked = false;
midcool.el('cooling').dispatch('change');
midcool.pump(40, 3000);
assert.equal(midcool.tm(), pinnedTm, 'the switch pins the running temperature');
midcool.pump(60, 6000);
assert.equal(midcool.tm(), pinnedTm, 'and it stays pinned');
assert.ok(midcool.copy().includes('\nadj Tm ' + pinnedTm.toFixed(2) + ' cooling off\n'),
	'the capture names the pinned temperature and the switch:\n' + midcool.copy());

// With cooling off there is nothing to follow: the slider is the temperature.
const pinned = loadPage('?cool=0&tm=0.5');
pinned.pump(40, 1000);
assert.equal(pinned.el('tm').value, '0.5', 'a pinned temperature stays on the control');
assert.equal(pinned.tm(), 0.5, 'and in the world');
pinned.el('tm').value = '0.9';
pinned.el('tm').dispatch('input');
pinned.pump(40, 2000);
assert.equal(pinned.tm(), 0.9, 'moving the slider moves the pinned world');

// The relief slider is a recolour: it dirties the map on the CPU engine, and one frame later
// the canvas has been painted from a fresh draw.
const painted = loadPage('');
const mapCanvas = painted.el('map'), putsBefore = mapCanvas.puts;
painted.el('relief').value = '3';
painted.el('relief').dispatch('input');
assert.equal(painted.Params.zRange, 3000, 'the ramp is metres');
painted.pump(2, 1000);
assert.ok(mapCanvas.puts > putsBefore, 'the map repainted after the ramp change');
assert.ok(painted.copy().includes('\nadj relief 3.0 km\n'), 'and the header names it');

console.log('PASS adj: cooling pins Tm and re-anchors on resume, the friction and erosion scales are '
	+ 'live (friction 2x is Ea 6 bit for bit), the erosion knee is continuous, quadratic and at its calibrated scale, '
	+ 'VERSION 2 carries cooling, and the page sliders write, follow and report');

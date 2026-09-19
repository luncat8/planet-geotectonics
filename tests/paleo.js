// paleo.js tests (0.4.5): the historical checkpoint packs (Pangaea 250 Ma, Gondwana 200 Ma).
// Provenance (epoch/geometry/zero poles), the loader's zero-pole guard, fidelity to the
// source raster, the forward-reconstruction score against the modern map, and a short
// stable forward run. The full-epoch convergence trajectories (250 Myr, ~1 min) live in
// experiments/paleo-score.js - the measured numbers are filed under experiments/logs/.
const fs = require('fs');
const { assert, Grid, State, Sim, equal } = require('./helpers.js');
const Earth = require('../js/earth.js');
require('../js/data/earth-1deg.js');
require('../js/data/earth-250Ma.js');
require('../js/data/earth-200Ma.js');

const CASES = [
	{ name: 'earth-250Ma', epoch: 250, plates: 9, wet: 0.6824, bin: '250Ma_1deg.bin' },
	{ name: 'earth-200Ma', epoch: 200, plates: 9, wet: 0.6321, bin: '200Ma_1deg.bin' }
];
const packs = Earth.packs();

// --- provenance: epoch, geometry, plate table, zero poles --------------------------------
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	assert.ok(pk, c.name + ' registered');
	assert.equal(pk.epoch, c.epoch, c.name + ' epoch');
	assert.equal(pk.w, 360, c.name + ' width');
	assert.equal(pk.h, 180, c.name + ' height');
	assert.equal(pk.plates.count, c.plates, c.name + ' plate count');
	for (let p = 0; p < pk.plates.count; p++) {
		const v = pk.plates.poles[p];
		assert.ok(v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0,
			c.name + ' plate ' + p + ' carries zero poles (no NNR model for past epochs)');
	}
	assert.ok(/Scotese & Wright 2018/.test(pk.source), c.name + ' source names the reconstruction');
}

// --- decode + zero-pole guard: 'realistic' must not prescribe a frozen world -------------
const g5 = new Grid(5, 7).build();
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	const s = new State(g5, 7);
	Earth.apply(s, pk, { realistic: true });
	assert.equal(s.plateCount, c.plates, c.name + ' plateCount');
	assert.equal(s.prescribedOmega, 0, c.name + ': zero-pole guard drops the prescription');
	assert.equal(s.cooling, 0, c.name + ': realistic still pins the thermal budget');
	let sumOmega = 0;
	for (let p = 0; p < s.plateCount; p++)
		sumOmega += Math.hypot(s.omega[p * 3], s.omega[p * 3 + 1], s.omega[p * 3 + 2]);
	assert.ok(sumOmega > 0, c.name + ': boot raster derived non-zero rotations');
	const sc = Earth.score(s, pk);
	console.log('  ' + Earth.describe(sc));
	assert.ok(Math.abs(sc.wetFraction - c.wet) <= 0.01, c.name + ' wet ' + sc.wetFraction.toFixed(4));
	assert.ok(sc.meanLand > 800 && sc.meanLand < 1200, c.name + ' mean land ' + sc.meanLand.toFixed(0));
	assert.ok(sc.meanOcean > -4800 && sc.meanOcean < -3500, c.name + ' mean ocean ' + sc.meanOcean.toFixed(0));
	assert.ok(sc.rms <= 100, c.name + ' round-trip RMS ' + sc.rms.toFixed(1) + ' m');
}

// --- fidelity: the pack's land mask IS the map's land mask (its own source raster bin) ---
function binMask(binPath, grid) {
	const b = fs.readFileSync(binPath);
	const W = b.readUInt16LE(0), H = b.readUInt16LE(2), n = W * H, off = 6;
	const z = new Int16Array(n);
	for (let i = 0; i < n; i++) z[i] = b.readInt16LE(off + i * 2);
	const kind = b.slice(off + 2 * n + n, off + 2 * n + 2 * n);
	const m = new Uint8Array(grid.V);
	const scratch = new Float64Array(2);
	for (let c = 0; c < grid.V; c++) {
		const b3 = c * 3;
		Earth.coords(W, H, grid.pos[b3], grid.pos[b3 + 1], grid.pos[b3 + 2], scratch);
		const at = Math.min(H - 1, Math.round(scratch[1])) * W + ((Math.round(scratch[0]) % W) + W) % W;
		m[c] = ((kind[at] & 1) && z[at] >= 0) ? 1 : 0;
	}
	return m;
}
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	const iou = Earth.iou(Earth.landFromPack(pk, g5), binMask('data/earth/paleo/' + c.bin, g5));
	assert.ok(iou.iou >= 0.99, c.name + ' encodes its raster: IoU ' + iou.iou.toFixed(4));
}

// --- the forward-reconstruction score: the checkpoints are genuinely different from the
// --- modern map, by a measurable amount (the gap experiments/paleo-score.js tracks) ------
const modern = packs.find(p => p.name === 'earth' && p.w === 360);
const modernM = Earth.landFromPack(modern, g5);
assert.equal(Earth.iou(modernM, modernM).iou, 1, 'self IoU is 1');
assert.ok(Earth.fraction(modernM) > 0.25 && Earth.fraction(modernM) < 0.35,
	'modern reference is the real modern land fraction: ' + (100 * Earth.fraction(modernM)).toFixed(2) + '%');
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	const iou = Earth.iou(Earth.landFromPack(pk, g5), modernM);
	assert.ok(iou.iou > 0.1 && iou.iou < 0.6, c.name + '-vs-modern IoU ' + iou.iou.toFixed(3));
}

// --- short forward run (20 Myr): stable, evolving, deterministic -------------------------
const pk250 = packs.find(p => p.name === 'earth-250Ma');
const g4 = new Grid(4, 7).build();
const a = new State(g4, 7), b = new State(g4, 7);
Earth.apply(a, pk250, {});
Earth.apply(b, pk250, {});
equal(a, b);
const m0 = Earth.landFromState(a);
Sim.advance(a, 0.1, 200);
Sim.advance(b, 0.1, 200);
equal(a, b);
assert.equal(a.finite, 1, '20 Myr forward run stays finite');
assert.ok(a.plateCount <= a.plateCap, 'plate count in the cap');
assert.ok(a.meanSpeed > 0 && a.meanSpeed < 600000, 'speed inside the pole window');
const m20 = Earth.landFromState(a);
assert.ok(Earth.iou(m0, m20).iou < 0.999, 'land mask evolved over the run');

console.log('PASS paleo: checkpoint provenance, zero-pole guard, raster fidelity, modern IoU scoring, 20 Myr stability');

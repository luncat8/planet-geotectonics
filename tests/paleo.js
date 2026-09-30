// paleo.js tests (0.4.5, extended 0.4.6c): the historical checkpoint packs (Pangaea 250 Ma,
// Gondwana 200 Ma). Provenance (epoch/geometry/plate table), the re-baked model codes and
// poles, the steered ('realistic') and procedural ('game') loader paths, the zero-pole guard
// for a model-less pack, fidelity to the source raster, the forward-reconstruction score
// against the modern map, and short stable forward runs. The full-epoch convergence
// trajectories (250 Myr, ~1 min) live in experiments/paleo-score.js - the measured numbers
// are filed under experiments/logs/.
const fs = require('fs');
const { assert, Grid, State, Sim, equal } = require('./helpers.js');
const Earth = require('../js/earth.js');
const Plates = require('../js/plates.js');
const Events = require('../js/events.js');
const Rotations = require('../js/rotations.js');
const Params = require('../js/params.js');
require('../js/data/earth-1deg.js');
require('../js/data/earth-250Ma.js');
require('../js/data/earth-200Ma.js');

const CASES = [
	{ name: 'earth-250Ma', epoch: 250, plates: 92, model: 84, wet: 0.6824, bin: '250Ma_1deg.bin' },
	{ name: 'earth-200Ma', epoch: 200, plates: 111, model: 103, wet: 0.6321, bin: '200Ma_1deg.bin' }
];
const packs = Earth.packs();

// --- provenance: epoch, geometry, plate table, model codes and poles (0.4.6c) ------------
// The re-baked epoch packs carry the rotation model's own plate ids: a plate with a code
// has the model's stage omega at the pack epoch, an oceanic Voronoi plate has no code and
// no pole - dead ocean floor is honest about not knowing its kinematics.
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	assert.ok(pk, c.name + ' registered');
	assert.equal(pk.epoch, c.epoch, c.name + ' epoch');
	assert.equal(pk.w, 360, c.name + ' width');
	assert.equal(pk.h, 180, c.name + ' height');
	assert.equal(pk.plates.count, c.plates, c.name + ' plate count');
	assert.ok(Array.isArray(pk.plates.codes) && pk.plates.codes.length === c.plates,
		c.name + ' carries one code per plate');
	let model = 0;
	for (let p = 0; p < pk.plates.count; p++) {
		const v = pk.plates.poles[p], code = pk.plates.codes[p];
		if (code === null) {
			assert.ok(v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0,
				c.name + ' ocean plate ' + p + ' carries a zero pole');
			continue;
		}
		model++;
		assert.ok(/^[0-9]{3}$/.test(code), c.name + ' plate ' + p + ' code is a 3-digit model id: ' + code);
		assert.ok(Rotations.of(code), c.name + ' plate ' + p + ' code ' + code + ' resolves in the rotation model');
		assert.ok(v[3] > 0, c.name + ' model plate ' + p + ' (' + code + ') carries a non-zero pole');
		assert.ok(Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-9, c.name + ' plate ' + p + ' pole axis is a unit vector');
	}
	assert.equal(model, c.model, c.name + ' model plates');
	assert.ok(/Scotese & Wright 2018/.test(pk.source), c.name + ' source names the reconstruction');
}

// --- decode + steered load: 'realistic' becomes Mode S, and every code binds -------------
const g5 = new Grid(5, 7).build();
for (const c of CASES) {
	const pk = packs.find(p => p.name === c.name);
	const s = new State(g5, 7);
	Earth.apply(s, pk, { realistic: true });
	assert.equal(s.plateCount, c.plates, c.name + ' plateCount');
	assert.equal(s.rotationHistory, 1, c.name + ': realistic on a model pack is steered');
	assert.equal(s.prescribedOmega, 1, c.name + ': a steered world is a prescribed world');
	assert.equal(s.cooling, 0, c.name + ': realistic still pins the thermal budget');
	let sumOmega = 0;
	for (let p = 0; p < s.plateCount; p++) {
		const rec = s.rotRec[p], code = pk.plates.codes[p];
		assert.equal(!!rec, code !== null, c.name + ' plate ' + p + ' rotRec matches its code');
		assert.equal(s.rotRemap[p], -1, c.name + ': the codes path needs no remap');
		sumOmega += Math.hypot(s.omega[p * 3], s.omega[p * 3 + 1], s.omega[p * 3 + 2]);
	}
	assert.ok(sumOmega > 0, c.name + ': boot raster derived non-zero rotations');
	const sc = Earth.score(s, pk);
	console.log('  ' + Earth.describe(sc));
	assert.ok(Math.abs(sc.wetFraction - c.wet) <= 0.01, c.name + ' wet ' + sc.wetFraction.toFixed(4));
	assert.ok(sc.meanLand > 800 && sc.meanLand < 1200, c.name + ' mean land ' + sc.meanLand.toFixed(0));
	assert.ok(sc.meanOcean > -4800 && sc.meanOcean < -3500, c.name + ' mean ocean ' + sc.meanOcean.toFixed(0));
	assert.ok(sc.rms <= 100, c.name + ' round-trip RMS ' + sc.rms.toFixed(1) + ' m');
	// The game preset hands the same pack to the procedural mantle: no steering, no
	// prescription - the 0.4.6c wiring must not leak into it.
	const g = new State(g5, 7);
	Earth.apply(g, pk, {});
	assert.equal(g.rotationHistory, 0, c.name + ': game is not steered');
	assert.equal(g.prescribedOmega, 0, c.name + ': game lets K10 drive');
	assert.equal(g.plateCount, c.plates, c.name + ': game keeps the pack plate count');
}

// --- the zero-pole guard still fires for a model-less pack -------------------------------
// Synthetic: the 250 Ma pack with its poles zeroed and its codes dropped (the 0.4.5 shape).
{
	const pk = packs.find(p => p.name === 'earth-250Ma');
	const poleless = Object.assign({}, pk);
	poleless.plates = Object.assign({}, pk.plates,
		{ poles: pk.plates.poles.map(() => [0, 0, 0, 0]), codes: null });
	delete poleless._decoded;
	const s = new State(g5, 7);
	Earth.apply(s, poleless, { realistic: true });
	assert.equal(s.prescribedOmega, 0, 'zero-pole guard drops the prescription on a model-less pack');
	assert.equal(s.rotationHistory, 0, 'a model-less pack is never steered');
	assert.equal(s.cooling, 0, 'realistic still pins the thermal budget');
	// The guard's contract: with the prescription dropped, K10 drives the plates like the
	// game preset, so the boot raster solves non-zero rotations from the mantle.
	let sumOmega = 0;
	for (let p = 0; p < s.plateCount; p++)
		sumOmega += Math.hypot(s.omega[p * 3], s.omega[p * 3 + 1], s.omega[p * 3 + 2]);
	assert.ok(sumOmega > 0, 'a model-less realistic world boots K10-driven');
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

// --- short forward run (20 Myr, game preset): stable, evolving, deterministic ------------
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

// --- short steered run (20 Myr, Mode S): omega tracks the model, topology freezes ---------
{
	const s = new State(g4, 7);
	Earth.apply(s, pk250, { realistic: true });
	const plates0 = s.plateCount;
	// splits/merges are the Events topology ledgers; spawns/deaths/overlaps belong to the
	// contact physics, which §6 keeps on - a steered world still subducts crust.
	const ledger0 = [s.splits, s.merges];
	const q0 = Float64Array.from(s.q.subarray(0, s.plateCount * 4));
	Sim.advance(s, 0.1, 200);
	assert.equal(s.finite, 1, 'steered 20 Myr run stays finite');
	assert.equal(s.plateCount, plates0, 'steered run freezes the topology');
	assert.deepEqual([s.splits, s.merges], ledger0, 'steered run moves no topology ledger');
	// Dead ocean floor stays put, exactly; the model plates travel (a floor, not all: a
	// plate the model holds still inside this 20 Myr window is legal).
	let movedModel = 0;
	for (let p = 0; p < s.plateCount; p++) {
		const bb = p * 4;
		let moved = false;
		for (let k = 0; k < 4; k++) if (s.q[bb + k] !== q0[bb + k]) moved = true;
		if (pk250.plates.codes[p] === null) assert.ok(!moved, 'ocean plate ' + p + ' stays put while steered');
		else if (moved) movedModel++;
	}
	assert.ok(movedModel >= 40, movedModel + '/84 model plates travelled in 20 Myr');
	// omega after the run is the model's omega for the step window just left: integrate
	// steers at the time it is about to leave, so the live value sits at epoch0-(t-dt).
	// Same stage, same f64 ops, same cap - the pin is exact equality, not a tolerance.
	const wg = new Float64Array(3), ws = new Float64Array(3), cap = Params.vMax / Params.radius;
	for (let p = 0; p < s.plateCount; p++) {
		const rec = s.rotRec[p];
		if (!rec) continue;
		Rotations.pole(rec, s.epoch0 - (s.t - 0.1), wg, 0);
		Rotations.vecToSim(wg, 0, ws, 0);
		const m = Math.hypot(ws[0], ws[1], ws[2]);
		if (m > cap) {
			const k = cap / m;
			ws[0] *= k; ws[1] *= k; ws[2] *= k;
		}
		const bb = p * 3;
		assert.ok(s.omega[bb] === ws[0] && s.omega[bb + 1] === ws[1] && s.omega[bb + 2] === ws[2],
			'plate ' + p + ' omega is the model omega for its step window');
	}
	// An explicit cycle on a steered world is compact+census only.
	Events.cycle(s);
	assert.equal(s.plateCount, plates0, 'Events.cycle on a steered world keeps the plate count');
	assert.deepEqual([s.splits, s.merges], ledger0, 'Events.cycle on a steered world touches no topology');
}

console.log('PASS paleo: checkpoint provenance, model codes and poles, steered load and guard, zero-pole guard, raster fidelity, modern IoU scoring, 20 Myr stability (game + steered)');

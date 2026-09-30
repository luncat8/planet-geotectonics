const { assert, Grid, State } = require('./helpers.js');
const Columns = require('../js/columns.js');
const Mantle = require('../js/mantle.js');
const Plates = require('../js/plates.js');
const Edges = require('../js/edges.js');
const Params = require('../js/params.js');
const g = new Grid(5, 7).build();
const s = new State(g, 7);
const R = Params.radius, Ox = 0.012, Oy = -0.007, Oz = 0.004;
Columns.move(s); Columns.bin(s); Columns.raster(s);
Edges.velocities(s);   // plateCells, as in the frame pipeline
for (let c = 0; c < g.V; c++) {
	const b = c * 3, x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2];
	s.uMantle[b] = R * (Oy * z - Oz * y);
	s.uMantle[b + 1] = R * (Oz * x - Ox * z);
	s.uMantle[b + 2] = R * (Ox * y - Oy * x);
}
s.omega.fill(0);
Plates.reduce(s, 1);
for (let p = 0; p < s.plateCount; p++) {
	assert.ok(Math.abs(s.omega[p * 3] - Ox) < 1e-9);
	assert.ok(Math.abs(s.omega[p * 3 + 1] - Oy) < 1e-9);
	assert.ok(Math.abs(s.omega[p * 3 + 2] - Oz) < 1e-9);
}
s.plumeCount = 0;
Mantle.update(s);
s.omega.fill(0);
Plates.reduce(s, 1);
function residual(p, wx, wy, wz) {
	let E = 0;
	for (let c = 0; c < g.V; c++) {
		const owner = s.owner[c];
		if (owner < 0 || s.plate[owner] !== p) continue;
		const b = c * 3, x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2];
		const vx = R * (wy * z - wz * y), vy = R * (wz * x - wx * z), vz = R * (wx * y - wy * x);
		const dx = s.uMantle[b] - vx, dy = s.uMantle[b + 1] - vy, dz = s.uMantle[b + 2] - vz;
		E += g.A0[c] * (dx * dx + dy * dy + dz * dz);
	}
	return E;
}
let worse = 0, compared = 0;
for (let p = 0; p < s.plateCount; p++) {
	const wx = s.omega[p * 3], wy = s.omega[p * 3 + 1], wz = s.omega[p * 3 + 2];
	const E0 = residual(p, wx, wy, wz), step = 1e-4;
	assert.ok(residual(p, wx + step, wy, wz) >= E0 * 0.999999);
	assert.ok(residual(p, wx, wy + step, wz) >= E0 * 0.999999);
	assert.ok(residual(p, wx, wy, wz + step) >= E0 * 0.999999);
	for (let n = 0; n < 40; n++) {
		const rx = (n * 17 % 100 - 50) / 2000, ry = (n * 29 % 100 - 50) / 2000, rz = (n * 41 % 100 - 50) / 2000;
		compared++;
		if (residual(p, wx + rx, wy + ry, wz + rz) < E0) worse++;
	}
}
assert.equal(worse, 0);

// --- Mode S (0.4.6c): steer reads the rotation model, the cap binds, integrate is gated ---
const Rotations = require('../js/rotations.js');
const Quat = require('../js/quat.js');
{
	const w = new State(g, 7);
	const cap = Params.vMax / Params.radius;
	const wg = new Float64Array(3), ws = new Float64Array(3);
	w.plateCount = 3;
	w.epoch0 = 250;
	w.rotationHistory = 1;
	w.rotRec[0] = Rotations.of('701');   // Africa: a slow craton, far under the cap
	w.rotRec[1] = Rotations.of('306');   // a shard whose 10 Ma stage runs ~154 cm/yr
	// plate 2 keeps no record: dead ocean floor, steer must leave its omega alone
	w.omega[6] = 0.001; w.omega[7] = -0.002; w.omega[8] = 0.0005;

	w.t = 20;                            // epoch 230 Ma: both stages under the cap
	Plates.steer(w);
	Rotations.pole(w.rotRec[0], 230, wg, 0);
	Rotations.vecToSim(wg, 0, ws, 0);
	assert.ok(Math.hypot(ws[0], ws[1], ws[2]) < cap, '701 at 230 Ma is under the cap');
	assert.ok(w.omega[0] === ws[0] && w.omega[1] === ws[1] && w.omega[2] === ws[2],
		'steer writes the model omega bit-exact, in the sim frame');
	Rotations.pole(w.rotRec[1], 230, wg, 0);
	Rotations.vecToSim(wg, 0, ws, 0);
	assert.ok(Math.hypot(ws[0], ws[1], ws[2]) < cap, '306 at 230 Ma is under the cap');
	assert.ok(w.omega[3] === ws[0] && w.omega[4] === ws[1] && w.omega[5] === ws[2],
		'steer writes the model omega for every plate with a record');
	assert.ok(w.omega[6] === 0.001 && w.omega[7] === -0.002 && w.omega[8] === 0.0005,
		'a plate without a record keeps its omega');

	w.t = 240;                           // epoch 10 Ma: the 306 shard is over the cap
	Plates.steer(w);
	Rotations.pole(w.rotRec[1], 10, wg, 0);
	const raw = Math.hypot(wg[0], wg[1], wg[2]);
	assert.ok(raw > cap, 'the 306 10 Ma stage exceeds the cap (' + (raw * Params.radius / 10000).toFixed(0) + ' cm/yr)');
	const m = Math.hypot(w.omega[3], w.omega[4], w.omega[5]);
	assert.ok(Math.abs(m - cap) < 1e-15, 'steer clamps |omega| to vMax/R');
	Rotations.vecToSim(wg, 0, ws, 0);
	const k = cap / raw;
	assert.ok(Math.abs(w.omega[3] - ws[0] * k) < 1e-18 && Math.abs(w.omega[4] - ws[1] * k) < 1e-18
		&& Math.abs(w.omega[5] - ws[2] * k) < 1e-18, 'the clamp scales the magnitude and keeps the direction');

	// integrate steers first (rotationHistory) and advances q with exactly that omega.
	const q0 = Float64Array.from(w.q.subarray(0, 12));
	Plates.integrate(w, 0.1);
	const qe = Float64Array.from(q0);
	for (let p = 0; p < 3; p++) Quat.integrate(qe, p * 4, w.omega, p * 3, 0.1);
	for (let i = 0; i < 12; i++) assert.ok(w.q[i] === qe[i], 'integrate advances q with the steered omega');

	// Without rotationHistory, integrate must not touch omega: K10's world is bit-identical.
	w.rotationHistory = 0;
	w.t = 0;
	const sentinel = Float64Array.from(w.omega.subarray(0, 9));
	Plates.integrate(w, 0.1);
	for (let i = 0; i < 9; i++) assert.ok(w.omega[i] === sentinel[i], 'unsteered integrate reads omega, never writes it');
}
console.log('PASS plates: rigid-field ω identity and drag-only least squares', { compared }, 'steer: model ω, cap, gated integrate');

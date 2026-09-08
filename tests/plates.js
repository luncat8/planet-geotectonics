const { assert, Grid, State } = require('./helpers.js');
const Columns = require('../js/columns.js');
const Mantle = require('../js/mantle.js');
const Plates = require('../js/plates.js');
const Params = require('../js/params.js');
const g = new Grid(5, 7).build();
const s = new State(g, 7);
const R = Params.radius, Ox = 0.012, Oy = -0.007, Oz = 0.004;
Columns.move(s); Columns.bin(s); Columns.raster(s);
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
console.log('PASS plates: rigid-field ω identity and drag-only least squares', { compared });

const { assert, Grid, State, Sim } = require('./helpers.js');
const Columns = require('../js/columns.js');
const g = new Grid(5, 7).build(), cosCap = Math.cos(Math.PI / 6);
for (const dt of [0.1, 0.01]) {
	const s = new State(g, 7);
	s.n = 0; s.plateCount = 1; s.q.fill(0); s.q[3] = 1; s.omega.fill(0); s.fixedOmega = 1;
	s.omega[2] = 50000 / 6371000;
	s.alive.fill(0);
	for (let c = 0; c < g.V; c++) {
		if (g.pos[c * 3] < cosCap) continue;
		const i = s.n++;
		s.body.set(g.pos.subarray(c * 3, c * 3 + 3), i * 3);
		s.cell[i] = c; s.plate[i] = 0; s.alive[i] = 1;
	}
	const start = performance.now();
	Sim.advance(s, dt, 10000);
	const theta = 10000 * dt * s.omega[2];
	let intersection = 0, union = 0, gaps = 0, total = 0, cumulative = 0, p99 = 0;
	for (let c = 0; c < g.V; c++) {
		const dot = g.pos[c * 3] * Math.cos(theta) + g.pos[c * 3 + 1] * Math.sin(theta);
		const exact = dot >= cosCap, got = s.owner[c] >= 0;
		if (exact && got) intersection++;
		if (exact || got) union++;
		if (dot > Math.cos(Math.PI / 6 - 2 * g.nbrDist[c] / 6371000) && !got) gaps++;
	}
	for (const n of s.climbHistogram) total += n;
	for (let i = 0; i < 32; i++) { cumulative += s.climbHistogram[i]; if (cumulative >= total * 0.99) { p99 = i; break; } }
	const iou = intersection / union;
	console.log({ dt, Myr: dt * 10000, iou, gaps, p99, msPerFrame: (performance.now() - start) / 10000 });
	assert.ok(iou >= 0.95); assert.equal(gaps, 0); assert.ok(p99 <= 3);
}
// BIN has no small occupancy limit; distance ties choose the lowest column index.
const s = new State(g, 7);
s.n = 20;
for (let i = 0; i < s.n; i++) { s.cell[i] = 0; s.world.set(g.pos.subarray(0, 3), i * 3); }
Columns.bin(s); Columns.raster(s);
assert.equal(s.count[0], 20); assert.equal(s.owner[0], 0);
console.log('PASS raster: transport, crowded bins, deterministic ties');

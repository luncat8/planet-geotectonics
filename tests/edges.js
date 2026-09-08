const { assert, Grid, State } = require('./helpers.js');
const Columns = require('../js/columns.js');
const Edges = require('../js/edges.js');
const Params = require('../js/params.js');
const g = new Grid(3, 7).build();
const s = new State(g, 7);
const W = Params.U0 / Params.radius;
s.fixedOmega = 1; s.plateCount = 2; s.q.fill(0);
for (let i = 0; i < s.n; i++) {
	s.plate[i] = g.pos[i * 3 + 1] >= 0 ? 0 : 1;
	s.hFel[i] = s.plate[i] === 0 ? 35000 : 0;
	s.hMaf[i] = s.plate[i] === 0 ? 0 : 7000;
	s.age[i] = s.plate[i] === 0 ? 500 : 80;
	s.q[s.plate[i] * 4 + 3] = 1;
}
s.omega.fill(0); s.omega[2] = W; s.omega[5] = -W;
Columns.move(s); Columns.bin(s); Columns.raster(s);
Edges.classify(s);
function expected(relN, old) {
	if (relN < -Params.epsHi) return Edges.CONVERGENT;
	if (relN > Params.epsHi) return Edges.DIVERGENT;
	if (Math.abs(relN) > Params.epsLo && (old === Edges.CONVERGENT || old === Edges.DIVERGENT)) return old;
	return Edges.TRANSFORM;
}
let boundary = 0, wrong = 0, trench = 0, collision = 0, subduct = 0;
for (let c = 0; c < g.V; c++) {
	for (let k = 0; k < g.ringN[c]; k++) {
		const e = c * 6 + k, j = g.ring[e], pi = s.cellPlate[c], pj = s.cellPlate[j];
		if (pi === 65535 || pj === 65535) continue;
		if (pi === pj) {
			assert.equal(s.edgeType[e], Edges.INTERIOR);
			continue;
		}
		boundary++;
		assert.equal(s.edgeType[e], expected(s.relN[e], Edges.INTERIOR));
		if (s.edgeType[e] !== expected(s.relN[e], Edges.INTERIOR)) wrong++;
		if (s.polarity[e] === 2) collision++;
		if (s.polarity[e] === 1 || s.polarity[e] === -1) subduct++;
	}
	if (s.trenchDist[c] === 0) trench++;
}
assert.ok(boundary > 20);
assert.equal(wrong, 0);
assert.ok(subduct > 0);
assert.ok(trench > 0);
const saved = new Float64Array(s.vel);
let flips = 0, samples = 0;
for (let n = 0; n < 80; n++) {
	const old = Int8Array.from(s.edgeType);
	for (let i = 0; i < s.vel.length; i++) s.vel[i] = saved[i] + ((n * 13 + i * 17) % 1000 - 500);
	Edges.relatives(s);
	for (let e = 0; e < s.edgeType.length; e++) {
		if (old[e] === Edges.INTERIOR && s.edgeType[e] === Edges.INTERIOR) continue;
		if (old[e] === Edges.INTERIOR || s.edgeType[e] === Edges.INTERIOR) continue;
		samples++;
		if (old[e] !== s.edgeType[e]) flips++;
	}
	s.edgeType.set(old);
}
s.vel.set(saved);
const flicker = samples ? flips / samples : 0;
assert.ok(flicker < 0.05, 'flicker ' + flicker);
console.log('PASS edges:', { boundary, trench, subduct, flicker });

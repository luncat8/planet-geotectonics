const { assert, Grid, State, Sim } = require('./helpers.js');
const Columns = require('../js/columns.js');
const Surface = require('../js/surface.js');
const Edges = require('../js/edges.js');
const Plates = require('../js/plates.js');
const Params = require('../js/params.js');
const g = new Grid(3, 7).build();
const s = new State(g, 7);
s.prescribedOmega = 1; s.plateCount = 2; s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
for (let c = 0; c < g.V; c++) {
	const north = g.pos[c * 3 + 2] >= 0;
	s.plate[c] = north ? 0 : 1; s.hFel[c] = 35000; s.hMaf[c] = 0; s.age[c] = 500;
}
const W = 25000 / Params.radius;
s.omega.fill(0); s.omega[0] = W; s.omega[3] = -W; s.uMantle.fill(0); s.plumeCount = 0;
function load(thickness) {
	for (let c = 0; c < g.V; c++) s.hFel[c] = thickness;
	Columns.move(s); Columns.bin(s); Columns.raster(s); Surface.elevation(s); Edges.classify(s); Plates.forces(s);
	let total = 0, count = 0;
	for (let c = 0; c < g.V; c++) {
		const o = s.owner[c];
		if (o < 0) continue;
		const b = c * 3;
		total += Math.hypot(s.wEq[b], s.wEq[b + 1], s.wEq[b + 2]);
		count++;
	}
	return { total, count };
}
const thin = load(35000), thick = load(70000);
console.log({ thinLoad: thin.total / thin.count, thickLoad: thick.total / thick.count, ratio: thick.total / thin.total });
assert.ok(thick.total > thin.total * 1.2, 'thick collision barrier did not grow');
const natural = new State(new Grid(2, 7).build(), 7);
Sim.raster(natural); Sim.advance(natural, 0.1, 250);
assert.equal(natural.finite, 1);
console.log('PASS forces: collision load grows with continental thickness and stale contacts stay finite');

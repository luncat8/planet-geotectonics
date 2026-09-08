const { assert, Grid, State } = require('./helpers.js');
const Surface = require('../js/surface.js');
const g = new Grid(2, 7).build();
const s = new State(g, 7);
s.owner.fill(-1); s.cell.fill(-1); s.alive.fill(0); s.n = g.V;
for (let c = 0; c < g.V; c++) {
	s.owner[c] = c; s.cell[c] = c; s.alive[c] = 1; s.plate[c] = 0; s.hFel[c] = 35000; s.hMaf[c] = 0; s.hSed[c] = 0; s.age[c] = 500;
}
const cone = 0, basin = g.ring[0];
s.hFel[cone] = 70000;
s.hFel[basin] = 0; s.hMaf[basin] = 7000; s.age[basin] = 80;
function mass() {
	let total = 0;
	for (let i = 0; i < s.n; i++) if (s.alive[i]) total += s.hFel[i] + s.hMaf[i] + s.hSed[i];
	for (let c = 0; c < g.V; c++) total += s.mobile[c];
	return total;
}
Surface.elevation(s);
const before = mass(), h0 = s.hFel[cone];
Surface.route(s, 0.1);
const after = mass();
console.log({ coneBeforeKm: h0 / 1000, coneAfterKm: s.hFel[cone] / 1000, basinSedKm: s.hSed[basin] / 1000, massError: after - before });
assert.ok(s.hFel[cone] < h0, 'the cone must erode');
assert.ok(s.hSed[basin] > 0, 'eroded material must reach the adjacent basin');
assert.ok(Math.abs(after - before) < 1e-9, 'surface mass ' + (after - before));
for (let frame = 0; frame < 1000; frame++) { Surface.elevation(s); Surface.route(s, 0.1); }
let checker = 0;
for (let c = 0; c < g.V; c++) {
	const low = s.low[c];
	if (low >= 0 && s.z[c] > s.z[low] + 20 && s.low[low] >= 0 && s.z[low] > s.z[s.low[low]] + 20) checker++;
}
assert.ok(checker === 0, 'two-cell routing oscillation ' + checker);
console.log('PASS erosion: cone mass reaches basin, total crust plus mobile conserved, routing settles');

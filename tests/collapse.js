const { assert, Grid, State } = require('./helpers.js');
const ColumnUpdate = require('../js/column-update.js');
const g = new Grid(3, 7).build();
const s = new State(g, 7);
s.owner.fill(-1); s.cell.fill(-1); s.alive.fill(0); s.n = g.V; s.plumeCount = 0;
for (let c = 0; c < g.V; c++) {
	s.owner[c] = c; s.cell[c] = c; s.alive[c] = 1; s.plate[c] = 0; s.hFel[c] = 35000; s.age[c] = 500;
}
for (let c = 0; c < g.V; c++) if (g.pos[c * 3 + 2] > 0.72) s.hFel[c] = 80000;
function mass() { let sum = 0; for (let i = 0; i < s.n; i++) if (s.alive[i]) sum += s.hFel[i]; return sum; }
const before = mass();
for (let frame = 0; frame < 10000; frame++) ColumnUpdate.step(s, 0.1);
const after = mass();
let peak = 0;
for (let i = 0; i < s.n; i++) if (s.alive[i] && s.hFel[i] > peak) peak = s.hFel[i];
console.log({ plateauCells: Array.from(s.hFel).filter((x, i) => i < s.n && x > 50000).length, peakKm: peak / 1000, massError: after - before });
assert.ok(peak < 70000, 'plateau did not collapse: ' + peak);
assert.ok(Math.abs(after - before) / before < 1e-12, 'collapse mass ' + (after - before));
console.log('PASS collapse: thick plateau spreads symmetrically and conserves felsic mass');

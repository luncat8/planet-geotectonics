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
// Sediment joins the collapse (0.5.0): where the total column is over the regime, the
// blanket flows to thinner neighbours - felsic untouched (its own guard stays shut), each
// material exactly conserved.
{
	const hi = Array.from(g.pos).reduce((a, p, i) => p[2] > g.pos[a * 3 + 2] ? i : a, 0);
	const ring = Array.from({ length: g.ringN[hi] }, (_, k) => g.ring[hi * 6 + k]);
	const at = ring[0];
	s.hFel[hi] = 35000; s.hSed[hi] = 30000;      // total 65 km: over the regime
	for (const n of ring) { s.hFel[n] = 35000; s.hSed[n] = 0; }   // room everywhere around
	const sum = (f) => ring.reduce((a, n) => a + f(n), f(hi));
	const fel0 = sum((c) => s.hFel[c]), sed0 = sum((c) => s.hSed[c]);
	ColumnUpdate.collapse(s, 0.1);
	assert.ok(s.hSed[hi] < 30000 && s.hSed[at] > 0, 'the blanket flows to the thin neighbours');
	assert.equal(sum((c) => s.hFel[c]), fel0, 'felsic is untouched while its own guard is shut');
	assert.ok(Math.abs(sum((c) => s.hSed[c]) - sed0) < 1e-9, 'sediment is conserved exactly');
}
console.log('PASS collapse: thick plateau spreads symmetrically and conserves felsic mass,'
	+ ' sediment joins the flow under the total-column regime test');

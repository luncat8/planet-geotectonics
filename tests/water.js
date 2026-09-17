const assert = require('node:assert/strict');
const Water = require('../js/water.js');
function close(a, b, e = 1e-9) { assert.ok(Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`); }
const z = Float64Array.from([-120, -60, 0, 60, 120, NaN]);
const h = Water.histogram(z);
assert.equal(h.n.reduce((a, b) => a + b, 0), 5);
let previous = 0;
for (let level = Water.ZLO; level <= Water.ZHI; level += 333) {
  const v = Water.volumeAt(Water.fromElevations(z, 1).histogram, level);
  assert.ok(v >= previous); previous = v;
}
const world = Water.fromElevations(z, 1);
close(world.v0, Water.volumeBelow(z, 0));
close(Water.solve(world.histogram, world.v0), 0, 1e-6);
for (const scale of [0, .25, 1, 2, 4]) {
  const w = Water.fromElevations(z, scale);
  close(Water.volumeAt(w.histogram, w.level), w.volume, 1e-8);
}
assert.equal(Water.fromElevations(z, 0).level, Water.ZLO);
assert.equal(Water.fromElevations(z, 1000).level, Water.ZHI);
console.log('PASS water: monotone hypsometry, conserved volume, NaN gaps and clamps');

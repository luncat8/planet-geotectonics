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

// A flat seafloor sitting exactly on a bucket edge: the cells land in the bucket that
// starts there, and solve inverts volumeAt to float noise (the quadratic branch).
const flat = Float64Array.from({ length: 64 }, () => Water.ZLO + 200 * Water.WIDTH);
const hf = Water.fromElevations(flat, 1).histogram;
assert.equal(hf.n[200], 64, 'cells on a bucket edge land in the bucket starting there');
for (const d of [0.37, 12.5, Water.WIDTH - 0.11]) {
  const level = flat[0] + d;
  close(Water.solve(hf, Water.volumeAt(hf, level)), level, 1e-9);
}

// The same seafloor away from the edge: the uniform-within-bucket model deviates from the
// analytic fill while the level sits inside the cells' bucket, bounded by N*w^2/8 (the plan
// tolerance); past that bucket the first-moment term is exact again.
const off = Float64Array.from({ length: 64 }, () => Water.ZLO + 200 * Water.WIDTH + Water.WIDTH / 2);
const ho = Water.fromElevations(off, 1).histogram;
let worst = 0;
for (const d of [1, 15, 29, 45, 59]) {
  const level = off[0] + d;
  const model = Water.volumeAt(ho, level), truth = 64 * d;
  worst = Math.max(worst, Math.abs(model - truth));
}
assert.ok(worst <= 64 * Water.WIDTH * Water.WIDTH / 8, 'intra-bucket model error ' + worst + ' within the bound');
close(Water.volumeAt(ho, off[0] + 45), 64 * 45, 1e-12);

// A target that lands inside an empty bucket: the solve degrades to the linear branch and
// still inverts volumeAt exactly.
const gap = Float64Array.from([-5000, 5000]);
const hg = Water.fromElevations(gap, 1).histogram;
assert.equal(hg.n[Math.floor((123.4 - Water.ZLO) / Water.WIDTH)], 0, 'the target bucket is empty');
close(Water.solve(hg, Water.volumeAt(hg, 123.4)), 123.4, 1e-9);
console.log('PASS water: monotone hypsometry, conserved volume, NaN gaps and clamps');

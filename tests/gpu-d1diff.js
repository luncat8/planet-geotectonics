/* gpu-d1diff.js - the defect-D1 cross-engine layer diff (js/gpu/d1diff.js) on a
   pure CPU rig: no device needed, every number is reachable.

   The diff localizes a CPU/GPU plate-speed divergence to one pipeline layer by
   comparing the intermediates the mirror already ships: per cell uMantle/wEq,
   per plate M/rhs (device stores them / A0[0]), the fit (omegaTarget) and the
   relaxed omega. This test pins, in the tests/gui.js mutation style:

     1. a healthy f32-rounded mirror is quiet and the A0[0] rescale is exact;
     2. each named layer fires only when ITS array is perturbed;
     3. the forgot-to-rescale trap (M/rhs at raw scale) names accumulation;
     3b. sub-threshold noise (1e-5) stays quiet;
     4. NaN is a failure, never a vacuous pass;
     5. the capture table names every plate and the named failure carries the layer.

   Run: node tests/gpu-d1diff.js */
'use strict';
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const D1Diff = require('../js/gpu/d1diff.js');

const LEVEL = 3, SEED = 7, DT = 0.1;

function world(frames) {
	const s = new State(new Grid(LEVEL, SEED).build(), SEED);
	s.reset(SEED);
	s.ckptCap = 0;
	Sim.raster(s);
	for (let i = 0; i < frames; i++) Sim.step(s, DT);
	return s;
}

// What a full GPU download leaves in the mirror: f32-rounded values, with M and
// rhs still divided by A0[0] (reduceB normalizes before the f32 cofactor solve).
// A real device's arithmetic error is larger than this storage rounding, but
// the floor margin (1e-3 gate vs ~1e-5 healthy tracking) is what matters here.
function mirror(cpu) {
	const A0 = Math.fround(cpu.grid.A0[0]);
	const g = {
		grid: cpu.grid, plateCount: cpu.plateCount,
		M: new Float64Array(cpu.M.length), rhs: new Float64Array(cpu.rhs.length),
		omegaTarget: new Float64Array(cpu.omegaTarget.length), omega: new Float64Array(cpu.omega.length),
		uMantle: new Float64Array(cpu.uMantle.length), wEq: new Float64Array(cpu.wEq.length)
	};
	for (let i = 0; i < cpu.M.length; i++) g.M[i] = Math.fround(cpu.M[i] / A0);
	for (let i = 0; i < cpu.rhs.length; i++) g.rhs[i] = Math.fround(cpu.rhs[i] / A0);
	for (const name of ['omegaTarget', 'omega', 'uMantle', 'wEq']) {
		for (let i = 0; i < cpu[name].length; i++) g[name][i] = Math.fround(cpu[name][i]);
	}
	return g;
}

function quiet(res, msg) {
	assert.equal(res.layer, null, msg + ' - names no layer');
	assert.ok(res.finite, msg + ' - finite');
	for (const f of ['M', 'rhs', 'fit', 'omega']) assert.ok(res.worst[f] < 1e-4, msg + ' - ' + f + ' quiet');
	assert.ok(res.cells.uMantle.rel < 1e-4, msg + ' - uMantle quiet');
	assert.ok(res.cells.wEq.rel < 1e-4, msg + ' - wEq quiet');
	assert.deepEqual(D1Diff.failures(res, 'x'), [], msg + ' - no named failures');
}

// 1. healthy mirrors at boot and after the frame-5 parity stretch.
quiet(D1Diff.compare(world(0), mirror(world(0))), 'boot');
const cpu5 = world(5), gpu5 = mirror(cpu5);
let res = D1Diff.compare(cpu5, gpu5);
quiet(res, 'frame 5');
assert.equal(res.nP, cpu5.plateCount, 'every plate is compared');
assert.equal(res.plates.length, cpu5.plateCount, 'the per-plate table has one row per plate');
for (let c = 0; c < res.V; c++) {
	if (cpu5.owner[c] >= 0) break;
}

// 2. each layer perturbation names exactly that layer.
function perturb(fn) {
	const g = mirror(cpu5);
	fn(g);
	return D1Diff.compare(cpu5, g);
}
function onlyLayer(res, want, msg) {
	assert.equal(res.layer, want, msg + ' names ' + want);
	for (const f of ['inputs', 'accumulation', 'solve', 'trajectory']) {
		assert.equal(res.flags[f], f === want, msg + ' flag ' + f);
	}
	const fails = D1Diff.failures(res, 'frame 5');
	assert.equal(fails.length, 1, msg + ' produces exactly one named failure');
	assert.ok(fails[0].indexOf(want.toUpperCase()) >= 0, msg + ' failure names the layer: ' + fails[0]);
}

// inputs: a 5% field-velocity error on one cell. Pick an owned cell with real flow.
let cell = 0;
for (let c = 0; c < cpu5.grid.V; c++) {
	const u = Math.hypot(cpu5.uMantle[c * 3], cpu5.uMantle[c * 3 + 1], cpu5.uMantle[c * 3 + 2]);
	if (cpu5.owner[c] >= 0 && u > Params.vRef * 0.5) { cell = c; break; }
}
onlyLayer(perturb(function (g) { g.uMantle[cell * 3 + 1] *= 1.05; }), 'inputs', 'uMantle perturbation');
onlyLayer(perturb(function (g) {
	for (let k = 0; k < 3; k++) g.wEq[cell * 3 + k] += 0.05 * Params.vRef;
}), 'inputs', 'wEq perturbation');

// accumulation: a 10% error in one plate's normalized M, then in rhs.
let pBig = 0, mBig = 0;
for (let p = 0; p < cpu5.plateCount; p++) {
	let n = 0;
	for (let k = 0; k < 9; k++) n += gpu5.M[p * 9 + k] * gpu5.M[p * 9 + k];
	if (n > mBig) { mBig = n; pBig = p; }
}
onlyLayer(perturb(function (g) { g.M[pBig * 9] *= 1.1; }), 'accumulation', 'M perturbation');
onlyLayer(perturb(function (g) { g.rhs[pBig * 3 + 2] *= 1.1; }), 'accumulation', 'rhs perturbation');

// solve: the fit moves while the equations and the stored omega stay put.
let pFit = 0, fBig = 0;
for (let p = 0; p < cpu5.plateCount; p++) {
	const n = Math.hypot(cpu5.omegaTarget[p * 3], cpu5.omegaTarget[p * 3 + 1], cpu5.omegaTarget[p * 3 + 2]);
	if (n > fBig) { fBig = n; pFit = p; }
}
onlyLayer(perturb(function (g) {
	for (let k = 0; k < 3; k++) g.omegaTarget[pFit * 3 + k] *= 1.5;
}), 'solve', 'fit perturbation');

// trajectory: M/rhs/fit agree, the relaxed omega does not.
onlyLayer(perturb(function (g) {
	for (let k = 0; k < 3; k++) g.omega[pFit * 3 + k] *= 1.5;
}), 'trajectory', 'omega perturbation');

// 3. the rescale trap: mirroring M/rhs back at RAW scale (the forget-to-divide-
// by-A0[0] bug) must name accumulation loudly, not pass.
const raw = mirror(cpu5);
for (let i = 0; i < cpu5.M.length; i++) raw.M[i] = Math.fround(cpu5.M[i]);
for (let i = 0; i < cpu5.rhs.length; i++) raw.rhs[i] = Math.fround(cpu5.rhs[i]);
res = D1Diff.compare(cpu5, raw);
assert.equal(res.layer, 'accumulation', 'un-rescaled M/rhs names accumulation');
assert.ok(res.worst.M > 1e9, 'the raw-scale delta is gigantic, not a near-threshold fluke');

// 3b. uniform 1e-5 perturbation - 100x under the gate, as f32 tracking is -
// must stay quiet; 1e-2 on the same arrays must not.
function scaled(factor) {
	const g = mirror(cpu5);
	for (const name of ['M', 'rhs', 'omegaTarget', 'omega', 'uMantle', 'wEq']) {
		for (let i = 0; i < g[name].length; i++) g[name][i] *= 1 + factor * (i % 7 === 0 ? 1 : 0.25);
	}
	return D1Diff.compare(cpu5, g);
}
quiet(scaled(1e-5), 'sub-threshold 1e-5 noise');
assert.notEqual(scaled(2e-2).layer, null, 'a 2% layer error is not quiet');

// 4. NaN never compares as "equal": a poisoned input names a layer and kills finite.
const nan = mirror(cpu5);
nan.uMantle[cell * 3] = NaN;
res = D1Diff.compare(cpu5, nan);
assert.ok(!res.finite, 'NaN flips finite off');
assert.equal(res.layer, 'inputs', 'NaN names the layer it lives in');
assert.ok(D1Diff.failures(res, 'frame 5')[0].indexOf('non-finite') >= 0, 'and says so');

// 5. the capture table: labelled, every plate present, worst plate repeated.
const lines = D1Diff.lines(res, 'frame 5');
assert.equal(lines.length, 6, 'four per-plate lines plus two per-cell lines');
for (let p = 1; p <= res.plates.length; p++) {
	assert.ok(lines.some(function (l) { return l.indexOf('p' + p + ' ') >= 0; }),
		'plate ' + p + ' appears in a table line');
}
assert.ok(lines.every(function (l) { return l.indexOf('D1 frame 5') >= 0; }), 'every line carries the checkpoint label');
assert.ok(lines[0].indexOf('M/A0[0]') >= 0 && lines[1].indexOf('rhs/A0[0]') >= 0, 'M and rhs are labelled rescaled');
assert.ok(lines[4].indexOf('uMantle') >= 0 && lines[5].indexOf('wEq') >= 0, 'per-cell families present');

// Boot tables too: at boot alpha = 1 so omega equals the fit, but the table is
// identical in shape and a healthy boot mirror stays quiet there as well.
const cpu0 = world(0);
quiet(D1Diff.compare(cpu0, mirror(cpu0)), 'boot table');
const bootLines = D1Diff.lines(D1Diff.compare(cpu0, mirror(cpu0)), 'boot');
assert.equal(bootLines.length, 6);

console.log('PASS gpu-d1diff: cross-engine layer diff names inputs/accumulation/solve/trajectory '
	+ 'under perturbation, stays quiet on a healthy f32 mirror, and rescales M/rhs by A0[0]');

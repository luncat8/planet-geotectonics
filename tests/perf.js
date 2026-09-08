// Node proxy for the browser throughput target (acceptance 7). Chrome is usually faster than
// node on the same V8, so this is a floor plus a report, not the target itself.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Perf = require('../js/perf.js');
const TARGET = 60, FLOOR = 40;
const STRICT = process.argv.includes('--release') || process.env.PERF_STRICT === '1';
const g = new Grid(5, 7).build();
const s = new State(g, 7);
Sim.raster(s);
Sim.advance(s, 0.1, 50);          // warm up the JIT
Perf.reset();
const frames = 300;
const start = performance.now();
Sim.advance(s, 0.1, frames);
const wall = performance.now() - start;
const perStep = wall / frames;
const fps = 1000 / perStep;
const breakdown = {};
for (let i = 0; i < Perf.NAMES.length; i++) breakdown[Perf.NAMES[i]] = +(Perf.kern[i] / Perf.windowSteps).toFixed(3);
console.log({ level: 5, cells: g.V, columns: s.n, msPerStep: +perStep.toFixed(2), framesPerSec: +fps.toFixed(1), target: TARGET });
console.log(breakdown);
const required = STRICT ? TARGET : FLOOR;
assert.ok(fps >= required, 'throughput target: ' + fps.toFixed(1) + ' < ' + required + ' frames/s');
console.log((fps >= TARGET ? 'PASS' : 'NOTE') + ' perf: ' + fps.toFixed(1) + ' frames/s at L5 (target ' + TARGET
	+ ', development floor ' + FLOOR + (STRICT ? ', strict' : '') + ')');

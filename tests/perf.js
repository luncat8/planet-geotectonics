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

// The strip is one row per part (throughput, distribution, events, checkpoint, kernel laps):
// the HUD renders rows and the copy button joins them with newlines, so a paste keeps the
// parts separable. Pin the row set here - a row that silently merges back into the throughput
// line is exactly the readability bug this split fixed.
Perf.reset();
let now = 0;
for (let i = 0; i < 40; i++) { now += 5.6; Perf.frame(now, 1, 0.1); }
Perf.event(31.7, 26.2, 2.0, 0.3, 25.5);
Perf.ckpt(4.2);
Perf.kern[Perf.K.CONTACT] = 2;
Perf.windowSteps = 1;
Perf.update(now);
assert.equal(Perf.rows.length, 5, 'one row each for throughput, distribution, events, checkpoint, kernels');
assert.ok(/^\d+\.\d fps/.test(Perf.rows[0]), 'row 0 is throughput: ' + Perf.rows[0]);
assert.ok(!Perf.rows[0].includes('p95') && !Perf.rows[0].includes('events'),
	'the throughput row carries nothing else');
assert.ok(/^p95 \d+\.\d ms · max \d+\.\d ms$/.test(Perf.rows[1]), 'row 1 is the gap distribution: ' + Perf.rows[1]);
assert.equal(Perf.rows[2], 'events 1 (31.7 ms = dl 26.2 [wait 25.5] + cyc 2.0 + up 0.3)');
assert.equal(Perf.rows[3], 'ckpt 4.2 ms');
assert.equal(Perf.rows[4], 'contact 2.00');
assert.equal(Perf.report(), Perf.rows.join('\n'), 'report() is the rows, newline joined');
Perf.reset();
assert.equal(Perf.rows.length, 0, 'reset clears the rows');
console.log('PASS perf strip rows: 5 rows, report() joins them');

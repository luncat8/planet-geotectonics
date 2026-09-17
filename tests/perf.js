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

// The strip is one slot per part (throughput, distribution, events, checkpoint, kernel laps)
// and `rows` is always SLOTS long: the HUD owns that many line tracks and rewrites their text
// in place, so a part appearing or disappearing cannot move the rows below it or change the
// strip's height (style.css reserves one track per slot). Pin both halves here - a row that
// silently merges back into the throughput line is the readability bug the split fixed, and a
// slot that shifts position is the reflow bug the reservation fixes.
Perf.reset();
assert.equal(Perf.rows.length, Perf.SLOTS, 'reset leaves one empty row per slot');
assert.deepEqual(Perf.SLOT, { TEXT: 0, DIST: 1, EVENTS: 2, CKPT: 3, KERNELS: 4, V3D: 5 }, 'slot order');
let now = 0;
for (let i = 0; i < 40; i++) { now += 5.6; Perf.frame(now, 1, 0.1); }
Perf.event(31.7, 26.2, 2.0, 0.3, 25.5);
Perf.ckpt(4.2);
Perf.kern[Perf.K.CONTACT] = 2;
Perf.windowSteps = 1;
Perf.update(now);
assert.equal(Perf.rows.length, Perf.SLOTS, 'one row each for throughput, distribution, events, checkpoint, kernels');
assert.ok(/^\d+\.\d fps/.test(Perf.rows[Perf.SLOT.TEXT]), 'slot 0 is throughput: ' + Perf.rows[0]);
assert.ok(!Perf.rows[Perf.SLOT.TEXT].includes('p95') && !Perf.rows[Perf.SLOT.TEXT].includes('events'),
	'the throughput row carries nothing else');
assert.ok(/^p95 \d+\.\d ms · max \d+\.\d ms$/.test(Perf.rows[Perf.SLOT.DIST]),
	'slot 1 is the gap distribution: ' + Perf.rows[1]);
assert.equal(Perf.rows[Perf.SLOT.EVENTS], 'events 1 (31.7 ms = dl 26.2 [wait 25.5] + cyc 2.0 + up 0.3)');
assert.equal(Perf.rows[Perf.SLOT.CKPT], 'ckpt 4.2 ms');
assert.equal(Perf.rows[Perf.SLOT.KERNELS], 'contact 2.00');
// report() drops the empty reserved slots (the V3D row is '' with the view off), so the
// copy is the non-empty rows joined - a paste never carries a blank line for a quiet slot.
assert.equal(Perf.report(), Perf.rows.filter(function (r) { return r; }).join('\n'),
	'report() is the non-empty rows, newline joined');

// A window with no transfer keeps the slots where they are: the kernel row must not slide up
// into the events slot, which is what moved the strip's contents (and its height) at 2 Hz.
Perf.update(now + 500);
assert.equal(Perf.rows[Perf.SLOT.EVENTS], '', 'no event this window: the slot is empty, not gone');
assert.equal(Perf.rows[Perf.SLOT.CKPT], '', 'no checkpoint this window');
assert.equal(Perf.rows[Perf.SLOT.KERNELS], '', 'no kernel over the floor this window');
assert.equal(Perf.rows.length, Perf.SLOTS, 'still one row per slot');
// The 3D row is the page's own line (0.5.0): '' until the view is on, then whatever
// its timestamp ring reported on this tick.
assert.equal(Perf.rows[Perf.SLOT.V3D], '', 'the 3D slot ships empty');
Perf.v3dText = '3d gather 0.31 · land 1.20 · water 0.55 · rim 0.08 ms';
Perf.update(now + 500);
assert.equal(Perf.rows[Perf.SLOT.V3D], Perf.v3dText, 'the page fills the 3D slot on the tick');
Perf.v3dText = '';
Perf.update(now + 500);
assert.equal(Perf.rows[Perf.SLOT.V3D], '', 'and the row empties again with the view off');
assert.equal(Perf.report(), Perf.rows[Perf.SLOT.TEXT] + '\n' + Perf.rows[Perf.SLOT.DIST],
	'report() drops the reserved-but-empty slots: ' + JSON.stringify(Perf.report()));
Perf.reset();
assert.equal(Perf.rows.length, Perf.SLOTS, 'reset clears the rows to one empty per slot');
console.log('PASS perf strip slots: ' + Perf.SLOTS + ' fixed rows, report() drops the empty ones');

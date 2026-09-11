'use strict';
// 0.3-plan Phase I acceptance: the instrumentation itself must cost < 0.1 ms/frame
// at L5. This measures the CPU-side JS cost of the Phase I additions, in node:
//   (a) Perf.gap ring write              - once per rAF frame (I2)
//   (b) Perf.update (2 Hz strip build)   - includes gapStats p95/max + event/ckpt lines (I2)
//   (c) timestamp slot bookkeeping       - the JS side of sim-gpu.js runGroups/frame,
//       67 dispatches (one L5 frame); the WebGPU driver calls
//       (insertTimestamp / resolveQuerySet / mapAsync) are not in this number
// The sum (a) + (c) + (b) amortized at 2 Hz must stay far below 100 us/frame.

var Perf = require('../js/perf.js');

var FRAMES = 200000, TS_MAX = 70, K = 67;

function bench(name, fn) {
	var i;
	for (i = 0; i < 2000; i++) fn(); // warm
	var t0 = process.hrtime.bigint();
	for (i = 0; i < FRAMES; i++) fn();
	var us = Number(process.hrtime.bigint() - t0) / 1e3 / FRAMES;
	console.log('  ' + name + ': ' + us.toFixed(3) + ' us/frame');
	return us;
}

console.log('0.3 Phase I instrumentation overhead, ' + FRAMES + ' frames, node ' + process.version);

// (a) gap ring write + EMA, driven like the rAF loop (ui.js calls Perf.frame(now, steps, dt))
var now = 0;
var a = bench('frame() gap ring + EMA (I2, per frame)', function () { now += 16.7; Perf.frame(now, 1, 0.1); });

// (b) the 2 Hz strip build, worst case (event + checkpoint counters non-empty)
Perf.event(3.2); Perf.event(2.8); Perf.ckpt(9.1);
var upd = 0;
{
	var t0 = process.hrtime.bigint(), i;
	for (i = 0; i < 1000; i++) { now += 16.7; Perf.update(now); }
	upd = Number(process.hrtime.bigint() - t0) / 1e3 / 1000;
}
console.log('  strip build Perf.update (I2, 2 Hz): ' + upd.toFixed(1) + ' us/call -> '
	+ (upd / 50).toFixed(3) + ' us/frame');

// (c) timestamp bookkeeping at L5 scale: 67 kernels x (slot index, name hash, ring write)
var names = [], k;
for (k = 0; k < K; k++) names.push('kernel' + k);
var tsNameIdx = {}, tsNameTab = [];
var tsSlotNames = new Int32Array(4 * TS_MAX), tsSlotUsed = new Int32Array(4);
var ringI = 0, slot = 0;
var c = bench('ts slot bookkeeping (I1, JS side, ' + K + ' dispatches)', function () {
	slot = 0;
	var i;
	for (i = 0; i < K; i++) {
		if (slot >= TS_MAX) throw new Error('timestamp slots exhausted');
		var idx = tsNameIdx[names[i]];
		if (idx === undefined) {
			idx = tsNameTab.length;
			tsNameIdx[names[i]] = idx;
			tsNameTab.push(names[i]);
		}
		tsSlotNames[ringI * TS_MAX + slot] = idx;
		slot++;
	}
	tsSlotUsed[ringI] = slot;
	ringI = (ringI + 1) % 4;
});

var total = a + c + upd / 50;
console.log('  total instrumentation: ' + total.toFixed(3) + ' us/frame (budget 100 us/frame)');
if (total >= 100) { console.log('FAIL: instrumentation overhead at/over budget'); process.exit(1); }
console.log('PASS: instrumentation overhead far below the 0.1 ms/frame budget');

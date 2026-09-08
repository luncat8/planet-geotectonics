/* perf.js - frame-loop instrumentation.
   The per-frame path only accumulates numbers into preallocated slots; the text lines are
   rebuilt at 2 Hz (TEXT_MS), so the string building never lands in the hot path. */
var Perf = {
	TEXT_MS: 500, TAU_STEP: 250, TAU_FPS: 500, MIN_KERNEL_MS: 0.05,
	NAMES: ['events', 'integrate', 'move', 'bin', 'raster', 'mantle', 'edges',
		'contact', 'apply', 'column', 'surface', 'forces', 'reduce', 'diag'],
	K: {
		EVENTS: 0, INTEGRATE: 1, MOVE: 2, BIN: 3, RASTER: 4, MANTLE: 5, EDGES: 6,
		CONTACT: 7, APPLY: 8, COLUMN: 9, SURFACE: 10, FORCES: 11, REDUCE: 12, DIAG: 13
	},
	kern: new Float64Array(14),
	stepMs: 0, frameMs: 0, fps: 0, stepsPerSec: 0, myrPerSec: 0,
	windowSteps: 0, lastFrame: 0, lastText: 0, text: '', detail: '',
	clock: function () {
		return performance.now();
	},
	reset: function () {
		Perf.kern.fill(0);
		Perf.stepMs = 0; Perf.frameMs = 0; Perf.fps = 0; Perf.stepsPerSec = 0; Perf.myrPerSec = 0;
		Perf.windowSteps = 0; Perf.lastFrame = 0; Perf.lastText = 0;
		Perf.text = ''; Perf.detail = '';
	},
	// One lap per kernel: adds now - from to the kernel slot and returns the fresh stamp.
	lap: function (id, from) {
		var now = performance.now();
		Perf.kern[id] += now - from;
		return now;
	},
	step: function (ms) {
		Perf.stepMs += (ms - Perf.stepMs) * (1 - Math.exp(-ms / Perf.TAU_STEP));
		Perf.windowSteps++;
	},
	frame: function (now, steps, dt) {
		var gap = Perf.lastFrame ? now - Perf.lastFrame : 0;
		Perf.lastFrame = now;
		if (!(gap > 0)) return;
		var a = 1 - Math.exp(-gap / Perf.TAU_FPS);
		Perf.frameMs += (gap - Perf.frameMs) * a;
		Perf.fps += (1000 / gap - Perf.fps) * a;
		Perf.stepsPerSec += (steps * 1000 / gap - Perf.stepsPerSec) * a;
		Perf.myrPerSec += (steps * dt * 1000 / gap - Perf.myrPerSec) * a;
	},
	due: function (now) {
		return now - Perf.lastText >= Perf.TEXT_MS;
	},
	update: function (now) {
		Perf.lastText = now;
		var per = Perf.windowSteps || 1, names = Perf.NAMES, line = '', kern = Perf.kern;
		for (var i = 0; i < names.length; i++) {
			var ms = kern[i] / per;
			kern[i] = 0;
			if (ms < Perf.MIN_KERNEL_MS) continue;
			line += (line ? '  ' : '') + names[i] + ' ' + ms.toFixed(2);
		}
		Perf.windowSteps = 0;
		Perf.detail = line;
		Perf.text = Perf.fps.toFixed(1) + ' fps  ·  step ' + Perf.stepMs.toFixed(2) + ' ms  ·  frame '
			+ Perf.frameMs.toFixed(1) + ' ms  ·  ' + Perf.stepsPerSec.toFixed(0) + ' steps/s  ·  '
			+ Perf.myrPerSec.toFixed(1) + ' Myr/s';
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Perf;

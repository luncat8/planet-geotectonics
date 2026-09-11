/* perf.js - frame-loop instrumentation.
   The per-frame path only accumulates numbers into preallocated slots; the text lines are
   rebuilt at 2 Hz (TEXT_MS), so the string building never lands in the hot path.
   Frame gaps keep a 1 s window (ring) so the HUD reports p95/max next to the EMA
   averages: an average alone cannot see the periodic spikes the GPU event round trips
   produce (0.3-plan Phase I2). */
var Perf = {
	TEXT_MS: 500, TAU_STEP: 250, TAU_FPS: 500, MIN_KERNEL_MS: 0.05, GAP_WINDOW_MS: 1000,
	NAMES: ['events', 'integrate', 'move', 'bin', 'raster', 'mantle', 'edges',
		'contact', 'apply', 'column', 'surface', 'forces', 'reduce', 'diag'],
	K: {
		EVENTS: 0, INTEGRATE: 1, MOVE: 2, BIN: 3, RASTER: 4, MANTLE: 5, EDGES: 6,
		CONTACT: 7, APPLY: 8, COLUMN: 9, SURFACE: 10, FORCES: 11, REDUCE: 12, DIAG: 13
	},
	kern: new Float64Array(14),
	stepMs: 0, frameMs: 0, fps: 0, stepsPerSec: 0, myrPerSec: 0,
	windowSteps: 0, lastFrame: 0, lastText: 0, text: '', detail: '',
	gaps: new Float64Array(512), gapT: new Float64Array(512), gapI: 0, gapSort: new Float64Array(512),
	// Event round trip (download + events + upload) and checkpoint push wall times,
	// accumulated by the GPU step path and reported over the 2 Hz text window.
	evMs: 0, evN: 0, ckMs: 0, ckN: 0,
	clock: function () {
		return performance.now();
	},
	reset: function () {
		Perf.kern.fill(0);
		Perf.stepMs = 0; Perf.frameMs = 0; Perf.fps = 0; Perf.stepsPerSec = 0; Perf.myrPerSec = 0;
		Perf.windowSteps = 0; Perf.lastFrame = 0; Perf.lastText = 0;
		Perf.text = ''; Perf.detail = '';
		Perf.gapI = 0; Perf.gaps.fill(0); Perf.gapT.fill(0);
		Perf.evMs = 0; Perf.evN = 0; Perf.ckMs = 0; Perf.ckN = 0;
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
	event: function (ms) {
		Perf.evMs += ms; Perf.evN++;
	},
	ckpt: function (ms) {
		Perf.ckMs += ms; Perf.ckN++;
	},
	frame: function (now, steps, dt) {
		var gap = Perf.lastFrame ? now - Perf.lastFrame : 0;
		Perf.lastFrame = now;
		if (!(gap > 0)) return;
		Perf.gaps[Perf.gapI] = gap;
		Perf.gapT[Perf.gapI] = now;
		Perf.gapI = (Perf.gapI + 1) % Perf.gaps.length;
		var a = 1 - Math.exp(-gap / Perf.TAU_FPS);
		Perf.frameMs += (gap - Perf.frameMs) * a;
		Perf.fps += (1000 / gap - Perf.fps) * a;
		Perf.stepsPerSec += (steps * 1000 / gap - Perf.stepsPerSec) * a;
		Perf.myrPerSec += (steps * dt * 1000 / gap - Perf.myrPerSec) * a;
	},
	due: function (now) {
		return now - Perf.lastText >= Perf.TEXT_MS;
	},
	// Gaps inside GAP_WINDOW_MS, copied into the scratch buffer; p95/max line.
	// Typed arrays sort the whole buffer only (no range overload), so the unused
	// tail is padded with Infinity before sorting - the first n entries then hold
	// the n real gaps in order. Unwritten slots read 0 and are skipped.
	gapStats: function (now) {
		var n = 0, i;
		for (i = 0; i < Perf.gaps.length; i++) {
			if (Perf.gaps[i] <= 0 || now - Perf.gapT[i] > Perf.GAP_WINDOW_MS) continue;
			Perf.gapSort[n++] = Perf.gaps[i];
		}
		if (n < 8) return '';
		for (i = n; i < Perf.gapSort.length; i++) Perf.gapSort[i] = Infinity;
		Perf.gapSort.sort();
		return 'p95 ' + Perf.gapSort[Math.min(n - 1, Math.floor(0.95 * (n - 1)))].toFixed(1)
			+ ' ms · max ' + Perf.gapSort[n - 1].toFixed(1) + ' ms';
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
		var dist = Perf.gapStats(now);
		var events = Perf.evN > 0 ? '  ·  events ' + Perf.evN + ' (' + (Perf.evMs / Perf.evN).toFixed(1) + ' ms)' : '';
		var ckpt = Perf.ckN > 0 ? '  ·  ckpt ' + (Perf.ckMs / Perf.ckN).toFixed(1) + ' ms' : '';
		Perf.evMs = 0; Perf.evN = 0; Perf.ckMs = 0; Perf.ckN = 0;
		Perf.text = Perf.fps.toFixed(1) + ' fps  ·  step ' + Perf.stepMs.toFixed(2) + ' ms  ·  frame '
			+ Perf.frameMs.toFixed(1) + ' ms  ·  ' + Perf.stepsPerSec.toFixed(0) + ' steps/s  ·  '
			+ Perf.myrPerSec.toFixed(1) + ' Myr/s' + (dist ? '  ·  ' + dist : '') + events + ckpt;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Perf;

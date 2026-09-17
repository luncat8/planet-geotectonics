/* Display-only eustatic water level (0.3.5).
 * The simulation remains calibrated at z=0; this module only derives the level used by
 * the map and inspector.  The histogram deliberately uses the same fixed constants as
 * the eventual GPU implementation so CPU tests and the browser agree.
 */
var Water = (function () {
	var NB = 512, ZLO = -15000, ZHI = 15000, WIDTH = (ZHI - ZLO) / NB;
	function histogram(z) {
		var n = new Float64Array(NB), sum = new Float64Array(NB);
		for (var i = 0; i < z.length; i++) {
			var value = z[i];
			if (!Number.isFinite(value)) continue;
			var k = Math.floor((value - ZLO) / WIDTH);
			if (k < 0) k = 0; else if (k >= NB) k = NB - 1;
			n[k]++; sum[k] += value;
		}
		return { n: n, sum: sum, count: z.length };
	}
	function make(h) {
		var n = h.n, sum = h.sum, pn = new Float64Array(NB + 1), ps = new Float64Array(NB + 1);
		for (var k = 0; k < NB; k++) { pn[k + 1] = pn[k] + n[k]; ps[k + 1] = ps[k] + sum[k]; }
		return { n: n, sum: sum, pn: pn, ps: ps, count: pn[NB] };
	}
	// Integral of max(0, level-z), with the documented uniform-within-bucket model.
	function volumeAt(h, level) {
		if (!(h.count > 0)) return 0;
		if (level <= ZLO) return 0;
		if (level >= ZHI) return h.count * level - h.ps[NB];
		var k = Math.max(0, Math.min(NB - 1, Math.floor((level - ZLO) / WIDTH)));
		var base = h.pn[k] * level - h.ps[k];
		var f = (level - (ZLO + k * WIDTH)) / WIDTH;
		// Empty buckets contribute nothing; otherwise assume samples are uniform in the bin.
		return base + h.n[k] * WIDTH * f * f / 2;
	}
	function solve(h, target) {
		if (!(h.count > 0) || !(target > 0)) return ZLO;
		var full = h.count * ZHI - h.ps[NB];
		if (target >= full) return ZHI;
		var k = 0;
		while (k < NB && volumeAt(h, ZLO + (k + 1) * WIDTH) < target) k++;
		var level0 = ZLO + k * WIDTH, below = h.pn[k] * level0 - h.ps[k];
		var delta = target - below, count = h.pn[k], inBin = h.n[k];
		if (!(inBin > 0)) return count > 0 ? level0 + delta / count : level0;
		// V = below + count*WIDTH*f + inBin*WIDTH*f²/2.
		var a = inBin * WIDTH / 2, b = count * WIDTH;
		var f = (-b + Math.sqrt(Math.max(0, b * b + 4 * a * delta))) / (2 * a);
		return Math.max(level0, Math.min(level0 + WIDTH, level0 + f * WIDTH));
	}
	function fromElevations(z, scale) {
		var h = make(histogram(z)), v0 = volumeAt(h, 0), x = Math.max(0, Number(scale));
		return { histogram: h, v0: v0, volume: v0 * x, level: solve(h, v0 * x) };
	}
	function volumeBelow(z, level) { return volumeAt(make(histogram(z)), level); }
	return { NB: NB, ZLO: ZLO, ZHI: ZHI, WIDTH: WIDTH, histogram: histogram, volumeAt: volumeAt,
		solve: solve, fromElevations: fromElevations, volumeBelow: volumeBelow };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Water;

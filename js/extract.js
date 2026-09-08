var ExtractDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
// Deposit extraction (design §8). Not part of the simulation: it runs on demand, so it may
// allocate. The core never reads any of this.
//
// A potential is a column field, but source, discharge and trap fall inside one or two cells
// at 10–50 km resolution, so the field is blurred by one cell and its local maxima are the
// deposits. The context tag is what the game turns into a named resource.
var Extract = {
	// One-cell blur of a column field onto cells. Uncovered cells stay 0, so a deposit cannot
	// hide under a gap.
	blur: function (s, field, out) {
		var g = s.grid;
		for (var c = 0; c < g.V; c++) {
			var o = s.owner[c];
			if (o < 0) { out[c] = 0; continue; }
			var sum = field[o], n = 1;
			for (var k = 0; k < g.ringN[c]; k++) {
				var oj = s.owner[g.ring[c * 6 + k]];
				if (oj < 0) continue;
				sum += field[oj]; n++;
			}
			out[c] = sum / n;
		}
		return out;
	},
	// Host crust of a cell, for the context tag.
	host: function (s, c) {
		var o = s.owner[c], p = ExtractParams;
		if (o < 0) return 'none';
		if (s.hSed[o] > 2000 && s.hSed[o] > s.hFel[o] && s.hSed[o] > s.hMaf[o]) return 'sediment';
		if (s.hFel[o] >= p.hOceanic) return s.hFel[o] > p.hOro ? 'thick continental' : 'continental';
		return 'oceanic';
	},
	// Ranked local maxima of one blurred potential above `min`. A plateau is resolved by cell
	// index, so the same world always yields the same list.
	peaks: function (s, blurred, min, out) {
		var g = s.grid;
		for (var c = 0; c < g.V; c++) {
			var v = blurred[c];
			if (v < min) continue;
			var best = true;
			for (var k = 0; k < g.ringN[c]; k++) {
				var j = g.ring[c * 6 + k], w = blurred[j];
				if (w > v || (w === v && j < c)) { best = false; break; }
			}
			if (best) out.push({ cell: c, value: v });
		}
		return out;
	},
	compare: function (a, b) {
		return a.value !== b.value ? b.value - a.value : a.cell - b.cell;
	},
	// Every potential's deposits, ranked by value, each with a context tag. `perClass` caps how
	// many of one class are emitted so a saturated world cannot bury the interesting ones.
	deposits: function (s, min, perClass, blurScratch) {
		var fields = ExtractDiag.ORE_FIELDS, names = ExtractDiag.ORE_NAMES, list = [];
		for (var k = 0; k < 6; k++) {
			Extract.blur(s, s[fields[k]], blurScratch);
			var peaks = Extract.peaks(s, blurScratch, min, []);
			peaks.sort(Extract.compare);
			for (var at = 0; at < peaks.length && at < perClass; at++) {
				var c = peaks[at].cell, o = s.owner[c];
				list.push({
					kind: names[k],
					cell: c,
					value: +peaks[at].value.toFixed(4),
					host: Extract.host(s, c),
					depth: o >= 0 ? Math.round(-s.z[c]) : 0,
					age: o >= 0 ? +s.age[o].toFixed(1) : 0,
					epoch: +s.t.toFixed(1),
					plate: o >= 0 ? s.plate[o] : -1,
					lat: +Math.asin(Math.max(-1, Math.min(1, s.grid.pos[c * 3 + 1]))).toFixed(4)
				});
			}
		}
		return list;
	},
	json: function (s, min, perClass, blurScratch) {
		return JSON.stringify({
			format: 'pgt-deposits', version: 1, level: s.grid.level, seed: s.seed,
			t: +s.t.toFixed(3), potentials: ExtractDiag.ORE_NAMES,
			totals: Array.prototype.slice.call(s.oreSum, 0).map(function (v) { return +v.toFixed(2); }),
			deposits: Extract.deposits(s, min, perClass, blurScratch)
		}, null, 1);
	}
};
var ExtractParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
if (typeof module !== 'undefined' && module.exports) module.exports = Extract;

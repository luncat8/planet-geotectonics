// Field primitives for the deposit catalogue (design §8). Not part of the simulation: they run
// on demand, so they may allocate. The core never reads any of this.
//
// A potential is a column field, but source, discharge and trap fall inside one or two cells
// at 10-50 km resolution, so the field is blurred by one cell and its local maxima are the
// deposits. `js/deposits.js` turns a maximum into a record; this file only shapes the field.
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
	}
};
var ExtractParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
if (typeof module !== 'undefined' && module.exports) module.exports = Extract;

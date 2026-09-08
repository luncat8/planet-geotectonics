var ColumnQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var ColumnParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var Columns = {
	climb: function (s, c, x, y, z) {
		var g = s.grid, pos = g.pos, steps = 0;
		var best = pos[c * 3] * x + pos[c * 3 + 1] * y + pos[c * 3 + 2] * z;
		for (;;) {
			var next = c;
			for (var k = 0; k < g.ringN[c]; k++) {
				var j = g.ring[c * 6 + k], b = j * 3;
				var dot = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
				if (dot <= best) continue;
				best = dot; next = j;
			}
			if (next === c) break;
			c = next; steps++;
		}
		s.maxClimb = Math.max(s.maxClimb, steps);
		s.climbHistogram[Math.min(31, steps)]++;
		return c;
	},
	move: function (s) {
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var b = i * 3;
			ColumnQuat.rotate(s.world, b, s.q, s.plate[i] * 4, s.body, b);
			s.cell[i] = Columns.climb(s, s.cell[i], s.world[b], s.world[b + 1], s.world[b + 2]);
		}
	},
	bin: function (s) {
		s.count.fill(0);
		for (var i = 0; i < s.n; i++) if (s.alive[i]) s.count[s.cell[i]]++;
		s.offset[0] = 0;
		for (var c = 0; c < s.grid.V; c++) {
			s.offset[c + 1] = s.offset[c] + s.count[c]; s.cursor[c] = s.offset[c];
		}
		// Ascending column traversal gives each bin a deterministic index order without a sort.
		for (var i = 0; i < s.n; i++) if (s.alive[i]) s.entries[s.cursor[s.cell[i]]++] = i;
	},
	raster: function (s) {
		var g = s.grid, radius = ColumnParams.radius;
		s.gaps = 0;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, best = Infinity, owner = -1;
			for (var k = -1; k < g.ringN[c]; k++) {
				var j = k < 0 ? c : g.ring[c * 6 + k];
				for (var at = s.offset[j]; at < s.offset[j + 1]; at++) {
					var i = s.entries[at], w = i * 3;
					var dx = s.world[w] - g.pos[b], dy = s.world[w + 1] - g.pos[b + 1], dz = s.world[w + 2] - g.pos[b + 2];
					var d = dx * dx + dy * dy + dz * dz;
					if (d > best || (d === best && owner >= 0 && i > owner)) continue;
					best = d; owner = i;
				}
			}
			if (best > s.gapLimit2[c]) owner = -1;
			s.owner[c] = owner; s.distance[c] = Math.sqrt(best) * radius;
			s.cellPlate[c] = owner < 0 ? 65535 : s.plate[owner];
			if (owner < 0) { s.gaps++; s.z[c] = NaN; continue; }
			// Surface.elevation is authoritative after raster; leaving the old value here keeps
			// MOVE/BIN/RASTER a pure ownership kernel and avoids a second isostasy implementation.
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Columns;

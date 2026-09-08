// K0 plate-level events, cadence ~1 Myr (Params.eventCadence). Runs at the top of the frame,
// before MOVE/BIN, so every index consumer downstream sees the compacted numbering.
// Phase E adds split and merge; compaction is already needed by Phase C contact.
var Events = {
	cycle: function (s) {
		Events.compact(s);
	},
	copy: function (s, from, to) {
		var a = from * 3, b = to * 3;
		s.body[b] = s.body[a]; s.body[b + 1] = s.body[a + 1]; s.body[b + 2] = s.body[a + 2];
		s.world[b] = s.world[a]; s.world[b + 1] = s.world[a + 1]; s.world[b + 2] = s.world[a + 2];
		s.area[to] = s.area[from];
		s.hFel[to] = s.hFel[from]; s.hMaf[to] = s.hMaf[from]; s.hSed[to] = s.hSed[from];
		s.age[to] = s.age[from]; s.damage[to] = s.damage[from]; s.zDyn[to] = s.zDyn[from];
		s.plate[to] = s.plate[from]; s.cell[to] = s.cell[from];
		s.alive[to] = 1;
	},
	compact: function (s) {
		var dst = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			if (dst !== i) Events.copy(s, i, dst);
			dst++;
		}
		for (var j = dst; j < s.n; j++) {
			s.alive[j] = 0;
			s.cell[j] = -1;
			s.consumedBy[j] = -1;
		}
		s.n = dst;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Events;

var ColumnParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// K8 COLUMN: per-column bookkeeping that needs no neighbours. Phase D adds damage/heal,
// gravitational collapse and ore accumulation here.
var ColumnUpdate = {
	step: function (s, dt) {
		var relax = Math.min(1, dt / ColumnParams.tauDyn);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			s.age[i] += dt;
			s.zDyn[i] -= s.zDyn[i] * relax;
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnUpdate;

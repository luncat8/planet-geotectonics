var ColumnParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// K8 COLUMN: age, weakening, plume melt and symmetric gravitational collapse. Surface owns the
// zDyn relaxation because its flexure pass needs the complete pre-update field.
var ColumnUpdate = {
	smoothstep: function (x, lo, hi) {
		var t = (x - lo) / (hi - lo);
		t = Math.max(0, Math.min(1, t));
		return t * t * (3 - 2 * t);
	},
	collapse: function (s, dt) {
		var p = ColumnParams, g = s.grid, delta = s.collapseDelta;
		delta.fill(0);
		for (var c = 0; c < g.V; c++) {
			var oi = s.owner[c];
			if (oi < 0) continue;
			for (var k = 0; k < g.ringN[c]; k++) {
				var j = g.ring[c * 6 + k];
				if (j <= c) continue;
				var oj = s.owner[j];
				if (oj < 0 || oj === oi || Math.max(s.hFel[oi], s.hFel[oj]) <= p.hCollapse) continue;
				var flux = p.kCollapse * dt * (s.hFel[oj] - s.hFel[oi])
					* 0.5 * (1 / g.ringN[c] + 1 / g.ringN[j]);
				delta[oi] += flux; delta[oj] -= flux;
			}
		}
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			s.hFel[i] = Math.max(0, s.hFel[i] + delta[i]);
		}
	},
	step: function (s, dt) {
		var p = ColumnParams, g = s.grid, invRef = 1 / p.vRef;
		ColumnUpdate.collapse(s, dt);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			s.age[i] += dt;
			var cell = s.cell[i], ext = cell >= 0 ? Math.max(0, s.ext[cell]) : 0, tangent = 0;
			if (cell >= 0) {
				for (var k = 0; k < g.ringN[cell]; k++) {
					var rel = Math.abs(s.relT[cell * 6 + k]);
					if (rel > tangent) tangent = rel;
				}
			}
			var continental = ColumnUpdate.smoothstep(s.hFel[i], 10000, 35000);
			var old = ColumnUpdate.smoothstep(s.age[i], 20, 200);
			var strength = Math.max(0.3, Math.min(1.3, 0.3 + 0.7 * continental + 0.3 * old)) / Math.max(0.35, s.Tm);
			var growth = p.kDam * ext / p.extRef / strength + p.kDamT * tangent * invRef;
			s.damage[i] = Math.max(0, Math.min(1, s.damage[i] + dt * (growth - p.kHeal * s.damage[i])));
			var heat = cell >= 0 ? s.plumeT[cell] : 0;
			var lip = p.kLip * s.Tm * Math.max(0, heat - 0.25) * dt;
			if (lip > 0) {
				s.hMaf[i] += lip; s.producedMaf += lip * s.A0ref;
			}
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnUpdate;

var ColumnParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var ColumnEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
// K8 COLUMN: age, weakening, plume melt, metallogeny and symmetric gravitational collapse.
// Surface owns the zDyn relaxation because its flexure pass needs the complete pre-update field.
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
	// Cells within one ring of a continent–continent convergent or a continental transform
	// edge. Dilation happens here, per qualifying edge, because belt edges are few and
	// continental columns are many: the column pass then reads one flag instead of a ring.
	belt: function (s) {
		var g = s.grid, p = ColumnParams, E = ColumnEdges, belt = s.belt;
		belt.fill(0);
		for (var c = 0; c < g.V; c++) {
			var oc = s.owner[c];
			if (oc < 0) continue;
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, t = s.edgeType[e];
				if (t === E.INTERIOR) continue;
				var j = g.ring[e], oj = s.owner[j];
				if (oj < 0) continue;
				if (t === E.CONVERGENT) {
					if (s.polarity[e] !== 2) continue;
				} else if (t !== E.TRANSFORM || s.hFel[oc] < p.hOceanic || s.hFel[oj] < p.hOceanic) continue;
				ColumnUpdate.dilate(s, c); ColumnUpdate.dilate(s, j);
			}
		}
	},
	dilate: function (s, c) {
		var g = s.grid;
		s.belt[c] = 1;
		for (var k = 0; k < g.ringN[c]; k++) s.belt[g.ring[c * 6 + k]] = 1;
	},
	// Metallogeny (design §8): the column-local factories that read this frame's K0/K5 output.
	// The basin factory lives in K9 instead, because it needs the elevation K9 has just made. Every rate carries (1 − o)
	// saturation and kDecay, so a potential is bounded by 1 and a factory that stops leaves its
	// signature to fade over ~500 Myr. `tangent` and `heat` come from the pass that called this,
	// which has already scanned the column's ring.
	ore: function (s, i, normal, tangent, spread, heat, dt) {
		var p = ColumnParams, g = s.grid, fert = s.fert[i], cell = s.cell[i];
		// VMS: hydrothermal circulation at a spreading ridge, so only on oceanic crust.
		if (s.hFel[i] < p.hOceanic && spread > 0) {
			s.oVms[i] += (1 - s.oVms[i]) * p.kV * s.Tm * Math.min(1, spread / p.vRef) * fert * dt;
		}
		if (heat > 0) s.oMaf[i] += (1 - s.oMaf[i]) * p.kM * heat * fert * dt;
		var orogenic = s.hFel[i] > p.hOro
			|| (s.hFel[i] >= p.hOceanic && cell >= 0 && s.belt[cell] === 1);
		if (orogenic) {
			s.oOro[i] += (1 - s.oOro[i]) * p.kO * (normal + tangent) / p.vRef * s.damage[i] * fert * dt;
		}
		var decay = 1 - p.kDecay * dt;
		s.oVms[i] *= decay; s.oMaf[i] *= decay; s.oArc[i] *= decay;
		s.oOro[i] *= decay; s.oBas[i] *= decay; s.oPla[i] *= decay;
	},
	step: function (s, dt) {
		var p = ColumnParams, g = s.grid, invRef = 1 / p.vRef;
		ColumnUpdate.collapse(s, dt);
		ColumnUpdate.belt(s);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			s.age[i] += dt;
			var cell = s.cell[i], ext = cell >= 0 ? Math.max(0, s.ext[cell]) : 0;
			var tangent = 0, normal = 0, spread = 0;
			if (cell >= 0) {
				for (var k = 0; k < g.ringN[cell]; k++) {
					var e = cell * 6 + k, rel = Math.abs(s.relT[e]), n = Math.abs(s.relN[e]);
					if (rel > tangent) tangent = rel;
					if (n > normal) normal = n;
					if (s.edgeType[e] === ColumnEdges.DIVERGENT && s.relN[e] > spread) spread = s.relN[e];
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
			ColumnUpdate.ore(s, i, normal, tangent, spread, heat, dt);
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnUpdate;

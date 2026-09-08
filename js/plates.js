var PlateQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var PlateParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var PlateEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var Plates = {
	integrate: function (s, dt) {
		for (var p = 0; p < s.plateCount; p++) PlateQuat.integrate(s.q, p * 4, s.omega, p * 3, dt);
	},
	// Equivalent basal velocities w (design §6.3): every force except drag, expressed as the
	// mantle speed that would push as hard. Divided by cD(Tm) = exp(Ea(1/Tm − 1)), so a cooling
	// asthenosphere damps slab pull and ridge push into a stagnant lid with no code switch.
	forces: function (s) {
		var g = s.grid, p = PlateParams, R = p.radius, w = s.wEq, inv = g.gradInv;
		var ocean = p.hOceanic, ridge = p.kRidge / R, coll = p.vColl / p.vRef;
		var invCD = Math.exp(-p.Ea * (1 / s.Tm - 1));
		ridge *= invCD; coll *= invCD;
		var slab = p.vSlab * invCD / p.ageSlab;
		w.fill(0);
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, owner = s.owner[c];
			if (owner < 0) continue;
			var x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2], zi = s.z[c];
			if (zi === zi && s.hFel[owner] < ocean) {
				var bx = 0, by = 0, bz = 0;
				for (var k = 0; k < g.ringN[c]; k++) {
					var j = g.ring[c * 6 + k], zj = s.z[j];
					if (zj !== zj) continue;
					var dz = zj - zi, jb = j * 3;
					bx += dz * g.pos[jb]; by += dz * g.pos[jb + 1]; bz += dz * g.pos[jb + 2];
				}
				var i9 = c * 9;
				var gx = inv[i9] * bx + inv[i9 + 1] * by + inv[i9 + 2] * bz;
				var gy = inv[i9 + 3] * bx + inv[i9 + 4] * by + inv[i9 + 5] * bz;
				var gz = inv[i9 + 6] * bx + inv[i9 + 7] * by + inv[i9 + 8] * bz;
				var rn = gx * x + gy * y + gz * z;
				w[b] -= ridge * (gx - x * rn);
				w[b + 1] -= ridge * (gy - y * rn);
				w[b + 2] -= ridge * (gz - z * rn);
			}
			for (var k2 = 0; k2 < g.ringN[c]; k2++) {
				var e = c * 6 + k2;
				if (s.edgeType[e] !== PlateEdges.CONVERGENT) continue;
				var pol = s.polarity[e], push;
				if (pol === 2) {
					// Collision resistance brakes both plates; gathering over the ring covers the
					// far side too, because relN and faceN are antisymmetric per direction.
					var closing = -s.relN[e];
					if (closing <= 0) continue;
					push = -coll * closing;
				} else if (pol === -1) {
					push = slab * Math.min(p.ageSlab, s.age[owner]);
				} else continue;
				var nb = e * 3;
				w[b] += push * g.faceN[nb];
				w[b + 1] += push * g.faceN[nb + 1];
				w[b + 2] += push * g.faceN[nb + 2];
			}
		}
	},
	solve3: function (m, p, b, o, out, w) {
		var a00 = m[p], a01 = m[p + 1], a02 = m[p + 2];
		var a10 = m[p + 3], a11 = m[p + 4], a12 = m[p + 5];
		var a20 = m[p + 6], a21 = m[p + 7], a22 = m[p + 8];
		var det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
		if (Math.abs(det) < 1e-30) { out[w] = 0; out[w + 1] = 0; out[w + 2] = 0; return; }
		var inv = 1 / det, bx = b[o], by = b[o + 1], bz = b[o + 2];
		out[w] = ((a11 * a22 - a12 * a21) * bx + (a02 * a21 - a01 * a22) * by + (a01 * a12 - a02 * a11) * bz) * inv;
		out[w + 1] = ((a12 * a20 - a10 * a22) * bx + (a00 * a22 - a02 * a20) * by + (a02 * a10 - a00 * a12) * bz) * inv;
		out[w + 2] = ((a10 * a21 - a11 * a20) * bx + (a01 * a20 - a00 * a21) * by + (a00 * a11 - a01 * a10) * bz) * inv;
	},
	reduce: function (s, dt) {
		var g = s.grid, R = PlateParams.radius, nP = s.plateCount, m = s.M, rhs = s.rhs;
		m.fill(0); rhs.fill(0);
		for (var c = 0; c < g.V; c++) {
			var owner = s.owner[c];
			if (owner < 0) continue;
			var p = s.plate[owner];
			if (p >= nP) continue;
			var b = c * 3, x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2], A = g.A0[c], pb = p * 9;
			m[pb] += A * (1 - x * x); m[pb + 1] += -A * x * y; m[pb + 2] += -A * x * z;
			m[pb + 3] += -A * y * x; m[pb + 4] += A * (1 - y * y); m[pb + 5] += -A * y * z;
			m[pb + 6] += -A * z * x; m[pb + 7] += -A * z * y; m[pb + 8] += A * (1 - z * z);
			var ux = s.uMantle[b] + s.wEq[b], uy = s.uMantle[b + 1] + s.wEq[b + 1];
			var uz = s.uMantle[b + 2] + s.wEq[b + 2], f = A / R, rb = p * 3;
			rhs[rb] += f * (y * uz - z * uy);
			rhs[rb + 1] += f * (z * ux - x * uz);
			rhs[rb + 2] += f * (x * uy - y * ux);
		}
		var alpha = Math.min(1, dt / PlateParams.tauOmega), cap = PlateParams.vMax / R;
		for (var p = 0; p < nP; p++) {
			var pb = p * 9, eps = s.plateCells[p] < 3 ? 1e-4 * g.A0[0] : 1e-18;
			m[pb] += eps; m[pb + 4] += eps; m[pb + 8] += eps;
			Plates.solve3(m, pb, rhs, p * 3, s.omegaTarget, p * 3);
			var ox = s.omega[p * 3], oy = s.omega[p * 3 + 1], oz = s.omega[p * 3 + 2];
			var nx = ox + (s.omegaTarget[p * 3] - ox) * alpha;
			var ny = oy + (s.omegaTarget[p * 3 + 1] - oy) * alpha;
			var nz = oz + (s.omegaTarget[p * 3 + 2] - oz) * alpha;
			var mag = Math.hypot(nx, ny, nz);
			if (mag > cap) { var k = cap / mag; nx *= k; ny *= k; nz *= k; }
			s.omega[p * 3] = nx; s.omega[p * 3 + 1] = ny; s.omega[p * 3 + 2] = nz;
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Plates;

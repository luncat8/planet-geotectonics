var EdgeParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var Edges = {
	INTERIOR: 0, CONVERGENT: 1, DIVERGENT: 2, TRANSFORM: 3,
	velocities: function (s) {
		var g = s.grid, R = EdgeParams.radius, nP = s.plateCount, mean = 0, max = 0, n = 0;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, owner = s.owner[c], plate = 65535;
			if (owner >= 0) plate = s.plate[owner];
			s.cellPlate[c] = plate;
			if (plate >= nP) { s.vel[b] = 0; s.vel[b + 1] = 0; s.vel[b + 2] = 0; continue; }
			var x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2], w = plate * 3;
			var ox = s.omega[w], oy = s.omega[w + 1], oz = s.omega[w + 2];
			var vx = R * (oy * z - oz * y), vy = R * (oz * x - ox * z), vz = R * (ox * y - oy * x);
			s.vel[b] = vx; s.vel[b + 1] = vy; s.vel[b + 2] = vz;
			var speed = Math.hypot(vx, vy, vz);
			mean += speed; if (speed > max) max = speed; n++;
		}
		s.meanSpeed = n ? mean / n : 0; s.maxSpeed = max;
	},
	relatives: function (s) {
		var g = s.grid, hi = EdgeParams.epsHi, lo = EdgeParams.epsLo, changes = 0;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, pi = s.cellPlate[c], nx0 = g.pos[b], ny0 = g.pos[b + 1], nz0 = g.pos[b + 2];
			for (var k = 0; k < 6; k++) {
				var e = c * 6 + k, j = g.ring[e];
				if (j < 0) { s.relN[e] = 0; s.relT[e] = 0; s.edgeType[e] = Edges.INTERIOR; continue; }
				var pj = s.cellPlate[j], old = s.edgeType[e];
				if (pi === 65535 || pj === 65535 || pi === pj) {
					s.relN[e] = 0; s.relT[e] = 0;
					if (old !== Edges.INTERIOR) changes++;
					s.edgeType[e] = Edges.INTERIOR;
					continue;
				}
				var jb = j * 3;
				var dvx = s.vel[jb] - s.vel[b], dvy = s.vel[jb + 1] - s.vel[b + 1], dvz = s.vel[jb + 2] - s.vel[b + 2];
				var nx = g.faceN[e * 3], ny = g.faceN[e * 3 + 1], nz = g.faceN[e * 3 + 2];
				var relN = dvx * nx + dvy * ny + dvz * nz;
				var tx = ny0 * nz - nz0 * ny, ty = nz0 * nx - nx0 * nz, tz = nx0 * ny - ny0 * nx;
				s.relN[e] = relN; s.relT[e] = dvx * tx + dvy * ty + dvz * tz;
				var type = Edges.TRANSFORM;
				if (relN < -hi) type = Edges.CONVERGENT;
				else if (relN > hi) type = Edges.DIVERGENT;
				else if (Math.abs(relN) > lo && (old === Edges.CONVERGENT || old === Edges.DIVERGENT)) type = old;
				if (type !== old) changes++;
				s.edgeType[e] = type;
			}
		}
		s.typeChanges = changes;
	},
	polarity: function (s) {
		var g = s.grid, ocean = EdgeParams.hOceanic;
		s.polarity.fill(0);
		for (var c = 0; c < g.V; c++) {
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k;
				if (s.edgeType[e] !== Edges.CONVERGENT) continue;
				var oi = s.owner[c], oj = s.owner[g.ring[e]];
				if (oi < 0 || oj < 0) continue;
				var ocI = s.hFel[oi] < ocean, ocJ = s.hFel[oj] < ocean;
				if (!ocI && !ocJ) { s.polarity[e] = 2; continue; }
				var iSubducts;
				if (ocI && ocJ) {
					iSubducts = s.age[oi] > s.age[oj] || (s.age[oi] === s.age[oj] && oi < oj);
				} else iSubducts = ocI;
				s.polarity[e] = iSubducts ? -1 : 1;
			}
		}
	},
	trench: function (s) {
		var g = s.grid, d = s.trenchDist;
		d.fill(3);
		for (var c = 0; c < g.V; c++) {
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, pol = s.polarity[e];
				if (pol === 1) d[c] = 0;
				else if (pol === -1) d[g.ring[e]] = 0;
			}
		}
		for (var pass = 0; pass < 2; pass++) {
			var from = pass, to = pass + 1;
			for (var c = 0; c < g.V; c++) {
				if (d[c] !== from) continue;
				var plate = s.cellPlate[c];
				for (var k = 0; k < g.ringN[c]; k++) {
					var j = g.ring[c * 6 + k];
					if (s.cellPlate[j] !== plate) continue;
					if (d[j] > to) d[j] = to;
				}
			}
		}
	},
	extension: function (s) {
		var g = s.grid, kPlume = EdgeParams.kPlume;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, flux = 0;
			// Midpoint flux is polluted: Σ n_ij L_ij ≠ 0 on this dual. Differences annihilate rigid Ω×r.
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, j = g.ring[e], jb = j * 3;
				var ux = s.uMantle[jb] - s.vel[jb] - (s.uMantle[b] - s.vel[b]);
				var uy = s.uMantle[jb + 1] - s.vel[jb + 1] - (s.uMantle[b + 1] - s.vel[b + 1]);
				var uz = s.uMantle[jb + 2] - s.vel[jb + 2] - (s.uMantle[b + 2] - s.vel[b + 2]);
				flux += 0.5 * (ux * g.faceN[e * 3] + uy * g.faceN[e * 3 + 1] + uz * g.faceN[e * 3 + 2]) * g.edgeLen[e];
			}
			s.ext[c] = flux / g.A0[c] + kPlume * s.plumeT[c];
		}
	},
	classify: function (s) {
		Edges.velocities(s); Edges.relatives(s); Edges.polarity(s); Edges.trench(s); Edges.extension(s);
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Edges;

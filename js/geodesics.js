/* geodesics.js - icosahedral dual-hex grid generation (pure mesh math, no WebGL) */
var PLANET_R = 6.371e6;

function Grid(level, seed) {
	if (!Number.isInteger(level) || level < 0 || level > 7) throw new RangeError('Grid level must be 0–7');
	this.level = level;
	this.seed = seed === undefined ? 12345 : seed;
}

Grid.mulberry32 = function (a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

Grid.norm = function (v) {
	var l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}
Grid.cross = function (a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
Grid.dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Grid.sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
// Metric surface distance -> chord between unit position vectors. Column and cell geometry is
// unit-sphere, thresholds are metres; every distance test needs this conversion.
Grid.chord = function (dist) { return 2 * Math.sin(dist / (2 * PLANET_R)); }
Grid.inv3 = function (m, out) {
	var det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
	var inv = 1 / det;
	out[0] = (m[4] * m[8] - m[5] * m[7]) * inv;
	out[1] = (m[2] * m[7] - m[1] * m[8]) * inv;
	out[2] = (m[1] * m[5] - m[2] * m[4]) * inv;
	out[3] = (m[5] * m[6] - m[3] * m[8]) * inv;
	out[4] = (m[0] * m[8] - m[2] * m[6]) * inv;
	out[5] = (m[2] * m[3] - m[0] * m[5]) * inv;
	out[6] = (m[3] * m[7] - m[4] * m[6]) * inv;
	out[7] = (m[1] * m[6] - m[0] * m[7]) * inv;
	out[8] = (m[0] * m[4] - m[1] * m[3]) * inv;
	return out;
}

Grid.prototype.build = function () {
	var level = this.level, seed = this.seed;
	var R = PLANET_R;
	var t = (1 + Math.sqrt(5)) / 2;
	var pos = [
		[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
		[0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
		[t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
	].map(Grid.norm);

	var faces = [
		[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
		[1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
		[3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
		[4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
	];

	for (var s = 0; s < level; s++) {
		var cache = new Map();
		var mid = function (a, b) {
			var key = a < b ? a * 1e7 + b : b * 1e7 + a;
			var hit = cache.get(key);
			if (hit !== undefined) return hit;
			var p2 = Grid.norm([
				pos[a][0] + pos[b][0],
				pos[a][1] + pos[b][1],
				pos[a][2] + pos[b][2],
			]);
			var idx = pos.length;
			pos.push(p2);
			cache.set(key, idx);
			return idx;
		};
		var nf = [];
		for (var fi = 0; fi < faces.length; fi++) {
			var f = faces[fi];
			var ab = mid(f[0], f[1]), bc = mid(f[1], f[2]), ca = mid(f[2], f[0]);
			nf.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]);
		}
		faces = nf;
	}

	var V = pos.length;

	var nextMap = new Array(V);
	for (var i = 0; i < V; i++) nextMap[i] = new Map();
	for (var fi2 = 0; fi2 < faces.length; fi2++) {
		var f2 = faces[fi2];
		nextMap[f2[0]].set(f2[1], f2[2]);
		nextMap[f2[1]].set(f2[2], f2[0]);
		nextMap[f2[2]].set(f2[0], f2[1]);
	}

	var rings = new Array(V);
	for (var i2 = 0; i2 < V; i2++) {
		var m = nextMap[i2];
		var start = m.keys().next().value;
		var ring = [start];
		var cur = start;
		for (var g = 0; g < 8; g++) {
			var nx = m.get(cur);
			if (nx === start) break;
			ring.push(nx);
			cur = nx;
		}
		rings[i2] = ring;
	}

	var rnd = Grid.mulberry32(seed);
	var OCT = 9;
	var dirs = [], freqs = [], phs = [], amps = [];
	for (var o = 0; o < OCT; o++) {
		var z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
		dirs.push([r * Math.cos(a), z, r * Math.sin(a)]);
		var fr = 1.3 * Math.pow(1.75, o);
		freqs.push(fr);
		phs.push(rnd() * 6.2831853);
		amps.push(1 / Math.pow(fr, 0.85));
	}
	var height = new Float32Array(V);
	for (var i3 = 0; i3 < V; i3++) {
		var h = 0;
		for (var o2 = 0; o2 < OCT; o2++) {
			h += amps[o2] * Math.sin(freqs[o2] * Grid.dot(dirs[o2], pos[i3]) + phs[o2]);
		}
		height[i3] = h;
	}
	var sorted = Float32Array.from(height).sort();
	var thr = sorted[Math.floor(sorted.length * 0.7)];
	var span = (sorted[sorted.length - 1] - sorted[0]) * 0.045 + 1e-6;
	var land = new Float32Array(V);
	var landCount = 0;
	for (var i4 = 0; i4 < V; i4++) {
		var x = (height[i4] - thr) / span;
		var sm = Math.min(1, Math.max(0, x));
		land[i4] = sm * sm * (3 - 2 * sm);
		if (land[i4] > 0.5) landCount++;
	}

	var W = 256;
	var H = Math.ceil(V / W);
	var cellA = new Float32Array(W * H * 4);
	var cellB = new Float32Array(W * H * 4);
	var nbrA = new Float32Array(W * H * 6 * 4);
	var nbrB = new Float32Array(W * H * 6 * 4);

	var AXIS = [0, 1, 0];
	var e1s = new Array(V), e2s = new Array(V);
	for (var i5 = 0; i5 < V; i5++) {
		var n = pos[i5];
		var e1 = Grid.cross(n, AXIS);
		if (Math.hypot(e1[0], e1[1], e1[2]) < 1e-7) e1 = [1, 0, 0];
		e1 = Grid.norm(e1);
		var e2 = Grid.cross(e1, n);
		e1s[i5] = e1;
		e2s[i5] = e2;
	}

	var neighbourIdx = rings;

	for (var i6 = 0; i6 < V; i6++) {
		var nn = pos[i6];
		var e1n = e1s[i6], e2n = e2s[i6];
		var ringn = neighbourIdx[i6];
		var mm = ringn.length;

		var duals = [];
		for (var k = 0; k < mm; k++) {
			var a0 = pos[ringn[k]], b0 = pos[ringn[(k + 1) % mm]];
			duals.push(Grid.norm([nn[0] + a0[0] + b0[0], nn[1] + a0[1] + b0[1], nn[2] + a0[2] + b0[2]]));
		}
		var area = 0;
		for (var k2 = 0; k2 < mm; k2++) {
			var p = Grid.sub(duals[k2], nn), q = Grid.sub(duals[(k2 + 1) % mm], nn);
			var c = Grid.cross(p, q);
			area += 0.5 * Math.hypot(c[0], c[1], c[2]);
		}
		area *= R * R;

		cellA[i6 * 4 + 0] = nn[0];
		cellA[i6 * 4 + 1] = nn[1];
		cellA[i6 * 4 + 2] = nn[2];
		cellA[i6 * 4 + 3] = area;
		cellB[i6 * 4 + 0] = e1n[0];
		cellB[i6 * 4 + 1] = e1n[1];
		cellB[i6 * 4 + 2] = e1n[2];
		cellB[i6 * 4 + 3] = land[i6];

		for (var k3 = 0; k3 < 6; k3++) {
			var base = (i6 + k3 * W * H) * 4;
			if (k3 >= mm) {
				nbrA[base + 3] = 0;
				continue;
			}
			var j = ringn[k3];
			var d0 = duals[(k3 - 1 + mm) % mm], d1 = duals[k3];
			var ev = Grid.sub(d1, d0);
			var len = Math.hypot(ev[0], ev[1], ev[2]) * R;
			var dist = Math.acos(Math.max(-1, Math.min(1, Grid.dot(nn, pos[j])))) * R;

			var pj = pos[j];
			var dp = Grid.dot(pj, nn);
			var tv = [pj[0] - nn[0] * dp, pj[1] - nn[1] * dp, pj[2] - nn[2] * dp];
			tv = Grid.norm(tv);
			var nx = Grid.dot(tv, e1n), ny = Grid.dot(tv, e2n);

			var ej = e1s[j];
			var dpe = Grid.dot(ej, nn);
			var te = [ej[0] - nn[0] * dpe, ej[1] - nn[1] * dpe, ej[2] - nn[2] * dpe];
			te = Grid.norm(te);
			var rotA = Grid.dot(te, e1n), rotB = Grid.dot(te, e2n);

			nbrA[base + 0] = j;
			nbrA[base + 1] = len;
			nbrA[base + 2] = Math.max(dist, 1.0);
			nbrA[base + 3] = 1;
			nbrB[base + 0] = nx;
			nbrB[base + 1] = ny;
			nbrB[base + 2] = rotA;
			nbrB[base + 3] = rotB;
		}
	}

	var indices = new Uint32Array(faces.length * 3);
	for (var f3 = 0; f3 < faces.length; f3++) {
		indices[f3 * 3 + 0] = faces[f3][0];
		indices[f3 * 3 + 1] = faces[f3][1];
		indices[f3 * 3 + 2] = faces[f3][2];
	}

	var lookupW = 1024, lookupH = 512;
	var lookup = new Float32Array(lookupW * lookupH);
	var guess = 0;
	for (var y = 0; y < lookupH; y++) {
		var lat = ((y + 0.5) / lookupH - 0.5) * Math.PI;
		var rowGuess = guess;
		for (var x2 = 0; x2 < lookupW; x2++) {
			var lon = ((x2 + 0.5) / lookupW - 0.5) * Math.PI * 2;
			var d3 = [
				Math.cos(lat) * Math.cos(lon),
				Math.sin(lat),
				Math.cos(lat) * Math.sin(lon),
			];
			var cur2 = rowGuess;
			var best = Grid.dot(pos[cur2], d3);
			for (var it = 0; it < 256; it++) {
				var moved = false;
				var ringc = neighbourIdx[cur2];
				for (var kk = 0; kk < ringc.length; kk++) {
					var cand = ringc[kk];
					var ss = Grid.dot(pos[cand], d3);
					if (ss > best) { best = ss; cur2 = cand; moved = true; }
				}
				if (!moved) break;
			}
			lookup[y * lookupW + x2] = cur2;
			rowGuess = cur2;
			if (x2 === 0) guess = cur2;
		}
	}

	var flatPos = new Float64Array(V * 3), A0 = new Float64Array(V);
	var flatRing = new Int32Array(V * 6).fill(-1), ringN = new Uint8Array(V);
	var nbrDist = new Float64Array(V), edgeLen = new Float64Array(V * 6);
	var faceN = new Float64Array(V * 18), faceT = new Float64Array(V * 18);
	var fluxN = new Float64Array(V * 18), collapseWeight = new Float64Array(V * 6);
	// Least-squares tangent gradient operator per cell: grad z = gradInv · Σ (z_j − z_i) r_j.
	// Exact for tangent-linear fields, so ridge push sees no grid-scale noise.
	var gradInv = new Float64Array(V * 9), mom = new Float64Array(9), inv = new Float64Array(9);
	for (var c = 0; c < V; c++) {
		flatPos.set(pos[c], c * 3);
		A0[c] = cellA[c * 4 + 3];
		ringN[c] = rings[c].length;
		mom.fill(0);
		for (var k = 0; k < ringN[c]; k++) {
			var e = c * 6 + k, packed = (c + k * W * H) * 4, j = rings[c][k];
			flatRing[e] = j;
			edgeLen[e] = nbrA[packed + 1];
			nbrDist[c] += nbrA[packed + 2] / ringN[c];
			var dot = Grid.dot(pos[c], pos[j]);
			var normal = Grid.norm([pos[j][0] - dot * pos[c][0], pos[j][1] - dot * pos[c][1], pos[j][2] - dot * pos[c][2]]);
			var eb = e * 3;
			faceN.set(normal, eb);
			faceT[eb] = pos[c][1] * normal[2] - pos[c][2] * normal[1];
			faceT[eb + 1] = pos[c][2] * normal[0] - pos[c][0] * normal[2];
			faceT[eb + 2] = pos[c][0] * normal[1] - pos[c][1] * normal[0];
			var fluxScale = 0.5 * edgeLen[e] / A0[c];
			fluxN[eb] = normal[0] * fluxScale;
			fluxN[eb + 1] = normal[1] * fluxScale;
			fluxN[eb + 2] = normal[2] * fluxScale;
			collapseWeight[e] = 0.5 * (1 / ringN[c] + 1 / rings[j].length);
			var dx = pos[j][0] - pos[c][0] - pos[c][0] * (dot - 1);
			var dy = pos[j][1] - pos[c][1] - pos[c][1] * (dot - 1);
			var dz = pos[j][2] - pos[c][2] - pos[c][2] * (dot - 1);
			mom[0] += dx * dx; mom[1] += dx * dy; mom[2] += dx * dz;
			mom[4] += dy * dy; mom[5] += dy * dz; mom[8] += dz * dz;
		}
		mom[3] = mom[1]; mom[6] = mom[2]; mom[7] = mom[5];
		// The moment matrix is rank 2 in the tangent plane; λ r rᵀ makes it invertible and its
		// inverse maps the radial part to r/λ, which the caller projects away.
		var lam = mom[0] + mom[4] + mom[8], rx = pos[c][0], ry = pos[c][1], rz = pos[c][2];
		mom[0] += lam * rx * rx; mom[1] += lam * rx * ry; mom[2] += lam * rx * rz;
		mom[3] += lam * ry * rx; mom[4] += lam * ry * ry; mom[5] += lam * ry * rz;
		mom[6] += lam * rz * rx; mom[7] += lam * rz * ry; mom[8] += lam * rz * rz;
		Grid.inv3(mom, inv);
		gradInv.set(inv, c * 9);
	}

	return {
		level: level, seed: seed, V: V, W: W, H: H, cellA: cellA, cellB: cellB,
		pos: flatPos, A0: A0, ring: flatRing, ringN: ringN, nbrDist: nbrDist, edgeLen: edgeLen,
		faceN: faceN, faceT: faceT, fluxN: fluxN, collapseWeight: collapseWeight,
		gradInv: gradInv, land: land,
		nbrA: nbrA, nbrB: nbrB, indices: indices,
		lookup: lookup, lookupW: lookupW, lookupH: lookupH,
		landFraction: landCount / V,
	};
};

if (typeof module !== "undefined" && module.exports) module.exports = Grid;

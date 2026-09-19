// js/rotations.js - real plate rotations from the PALEOMAP rotation model (0.4.6).
//
// The table is js/data/rot-paleomap.js, built by tools/earth/rot_ingest.js. Every entry is an
// ABSOLUTE RECONSTRUCTION rotation: a positive angle about the pole takes a present-day
// position to its position at that time. That sense is the opposite of what the sim integrates,
// and the two ways round are both useful, so both are spelled out here:
//
//   Rotations.at        R(t)              present -> past. Mode K reconstructs with this: a
//                                         modern pack placed at epoch t is rotated by R(t).
//   Rotations.relative  R(t) ∘ R(t0)^-1   epoch t0 -> epoch t. This is what s.q must hold, because
//                                         Columns.move does world = rotate(body, q) and body is the
//                                         pack's own geography at its start epoch.
//   Rotations.pole      ω in rad/Myr      the motion rate the sim integrates: Plates.integrate
//                                         left-multiplies the step into s.q, so ω has to be the
//                                         stage rotation read in the past->present direction,
//                                         which is the conjugate of the file's angles. Feeding
//                                         them un-conjugated moves every plate the wrong way -
//                                         tests/rotations.js pins the bearings against the known
//                                         present-day motions so a sign flip cannot land.
var RotationsQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var RotationsData = typeof module !== 'undefined' && module.exports
	? require('./data/rot-paleomap.js') : RotationModel;

var Rotations = {
	// km, the sphere every speed here is quoted on (the sim is dimensionless, 1 unit = R).
	radius: 6371,
	plates: [],
	byId: Object.create(null),
	byCode: Object.create(null),
	metadata: RotationsData.metadata,
	tMin: 0,
	tMax: 0,
	count: 0,
	// One scratch block for every method below, so no call allocates. The four regions never
	// overlap: V0 = 0..2, V1 = 3..5, Q0 = 8..11, Q1 = 12..15.
	TMP: new Float64Array(16),
	load: function (model) {
		var m = model || RotationsData, plates = m.plates;
		Rotations.metadata = m.metadata;
		Rotations.plates.length = 0;
		Rotations.byId = Object.create(null);
		Rotations.byCode = Object.create(null);
		Rotations.tMin = Infinity; Rotations.tMax = -Infinity;
		for (var i = 0; i < plates.length; i++) {
			var src = plates[i], n = src.t.length;
			if (!n) continue;
			var p = {
				id: src.id, code: src.code, n: n,
				t: new Float64Array(n), q: new Float64Array(n * 4)
			};
			for (var k = 0; k < n; k++) {
				p.t[k] = src.t[k];
				var b = src.pol[k * 3], lat = b * Math.PI / 180, lon = src.pol[k * 3 + 1] * Math.PI / 180;
				var ang = src.pol[k * 3 + 2] * Math.PI / 180, cl = Math.cos(lat);
				RotationsQuat.fromAxisAngle(p.q, k * 4, cl * Math.cos(lon), cl * Math.sin(lon),
					Math.sin(lat), ang);
			}
			Rotations.tMin = Math.min(Rotations.tMin, p.t[0]);
			Rotations.tMax = Math.max(Rotations.tMax, p.t[n - 1]);
			Rotations.byId[p.id] = p;
			if (p.code) Rotations.byCode[p.code] = p;
			Rotations.plates.push(p);
		}
		Rotations.count = Rotations.plates.length;
		return Rotations;
	},
	of: function (id) { return Rotations.byId[id] || null; },
	find: function (code) { return Rotations.byCode[code] || null; },
	// Index of the sample at or below t, or -1 when t precedes the model.
	bracket: function (p, t) {
		var ts = p.t, lo = 0, hi = p.n - 1;
		if (t < ts[0]) return -1;
		if (t >= ts[hi]) return hi;
		while (hi - lo > 1) {
			var mid = (lo + hi) >> 1;
			if (ts[mid] <= t) lo = mid; else hi = mid;
		}
		return lo;
	},
	// Reconstruction rotation R(t): present-day position -> position at time t. Slerped between
	// the model's samples, which is the same curve a fractional stage rotation traces.
	at: function (p, t, out, o) {
		var ts = p.t, i = Rotations.bracket(p, t);
		if (i < 0 || i >= p.n - 1) {
			var e = (i < 0 ? 0 : p.n - 1) * 4;
			out[o] = p.q[e]; out[o + 1] = p.q[e + 1]; out[o + 2] = p.q[e + 2]; out[o + 3] = p.q[e + 3];
			return out;
		}
		var f = (t - ts[i]) / (ts[i + 1] - ts[i]);
		if (f <= 0) {
			var b = i * 4;
			out[o] = p.q[b]; out[o + 1] = p.q[b + 1]; out[o + 2] = p.q[b + 2]; out[o + 3] = p.q[b + 3];
			return out;
		}
		return RotationsQuat.slerp(out, o, p.q, i * 4, p.q, (i + 1) * 4, f);
	},
	// Motion rotation from epoch t0 to epoch t, i.e. what s.q holds for a pack baked at t0.
	relative: function (p, t, t0, out, o) {
		var T = Rotations.TMP;
		Rotations.at(p, t, out, o);
		Rotations.at(p, t0, T, 12);
		T[8] = -T[12]; T[9] = -T[13]; T[10] = -T[14]; T[11] = T[15];
		RotationsQuat.mul(T, 8, out, o, T, 8);
		out[o] = T[8]; out[o + 1] = T[9]; out[o + 2] = T[10]; out[o + 3] = T[11];
		return out;
	},
	// Stage index holding t: the motion from t[i] to t[i + 1] is the rate a world crossing t
	// should integrate. Outside the table the end stages are held, which is what a constant-rate
	// extrapolation means here.
	// -1 when the plate has no history at all: 135 of the model's plates are present-day
	// microplates with a single 0 Ma row, and there is no rate to take from one sample.
	stage: function (p, t) {
		if (p.n < 2) return -1;
		var i = Rotations.bracket(p, t);
		if (i < 0) return 0;
		return Math.min(i, p.n - 2);
	},
	// Motion Euler pole as an angular-velocity vector in rad/Myr - the units s.omega uses, and
	// the same convention as the NNR poles js/earth.js loads.
	pole: function (p, t, out, o) {
		var i = Rotations.stage(p, t);
		if (i < 0 || p.t[i + 1] - p.t[i] <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; return out; }
		var dt = p.t[i + 1] - p.t[i], T = Rotations.TMP;
		// Times ascend, so sample i is the YOUNGER end of the stage and i + 1 the older one.
		// The motion rotation runs older -> younger, i.e. R(younger) ∘ R(older)^-1, which is the
		// inverse of the file's own sense - hence the conjugate on the older sample.
		var a = (i + 1) * 4;
		T[8] = -p.q[a]; T[9] = -p.q[a + 1]; T[10] = -p.q[a + 2]; T[11] = p.q[a + 3];
		RotationsQuat.mul(T, 8, p.q, i * 4, T, 8);
		var s = Math.hypot(T[8], T[9], T[10]);
		if (s < 1e-15) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; return out; }
		var rate = 2 * Math.atan2(s, Math.abs(T[11])) / dt / s;
		out[o] = T[8] * rate; out[o + 1] = T[9] * rate; out[o + 2] = T[10] * rate;
		return out;
	},
	toXYZ: function (lat, lon, out, o) {
		var la = lat * Math.PI / 180, lo = lon * Math.PI / 180, cl = Math.cos(la);
		out[o] = cl * Math.cos(lo); out[o + 1] = cl * Math.sin(lo); out[o + 2] = Math.sin(la);
		return out;
	},
	toLatLon: function (x, y, z, out, o) {
		out[o] = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
		out[o + 1] = Math.atan2(y, x) * 180 / Math.PI;
		return out;
	},
	// Where a present-day point on plate p sits at time t, in degrees.
	place: function (p, t, lat, lon, out, o) {
		var v = Rotations.TMP;
		Rotations.toXYZ(lat, lon, v, 3);
		Rotations.at(p, t, v, 8);
		RotationsQuat.rotate(v, 0, v, 8, v, 3);
		return Rotations.toLatLon(v[0], v[1], v[2], out, o);
	},
	// Surface speed in cm/yr at a point: |ω × r| with |r| = radius, then km/Myr -> cm/yr.
	speed: function (p, t, lat, lon) {
		var v = Rotations.TMP;
		Rotations.pole(p, t, v, 0);
		Rotations.toXYZ(lat, lon, v, 3);
		var cx = v[1] * v[5] - v[2] * v[4], cy = v[2] * v[3] - v[0] * v[5], cz = v[0] * v[4] - v[1] * v[3];
		return Math.hypot(cx, cy, cz) * Rotations.radius * 0.1;
	},
	// Compass bearing in degrees of the motion at a point, 0 = north, 90 = east. The gate in
	// tests/rotations.js reads this, because a sign error shows up as an antipodal bearing.
	bearing: function (p, t, lat, lon) {
		var v = Rotations.TMP;
		Rotations.pole(p, t, v, 0);
		Rotations.toXYZ(lat, lon, v, 3);
		var cx = v[1] * v[5] - v[2] * v[4], cy = v[2] * v[3] - v[0] * v[5], cz = v[0] * v[4] - v[1] * v[3];
		var m = Math.hypot(cx, cy, cz);
		if (m < 1e-18) return NaN;
		var la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
		var sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
		var ex = -so, ey = co, ez = 0;                       // east
		var nx = -sl * co, ny = -sl * so, nz = cl;           // north
		var e = (cx * ex + cy * ey + cz * ez) / m, n = (cx * nx + cy * ny + cz * nz) / m;
		return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
	}
};
Rotations.load();
if (typeof module !== 'undefined' && module.exports) module.exports = Rotations;

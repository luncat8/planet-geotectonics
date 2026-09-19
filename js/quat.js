var Quat = {
	integrate: function (q, offset, omega, w, dt) {
		var speed = Math.hypot(omega[w], omega[w + 1], omega[w + 2]);
		if (speed === 0) return;
		var half = speed * dt * 0.5, scale = Math.sin(half) / speed;
		var x = omega[w] * scale, y = omega[w + 1] * scale, z = omega[w + 2] * scale, a = Math.cos(half);
		var bx = q[offset], by = q[offset + 1], bz = q[offset + 2], b = q[offset + 3];
		var rx = a * bx + x * b + y * bz - z * by;
		var ry = a * by - x * bz + y * b + z * bx;
		var rz = a * bz + x * by - y * bx + z * b;
		var rw = a * b - x * bx - y * by - z * bz;
		var inv = 1 / Math.hypot(rx, ry, rz, rw);
		q[offset] = rx * inv; q[offset + 1] = ry * inv;
		q[offset + 2] = rz * inv; q[offset + 3] = rw * inv;
	},
	rotate: function (out, o, q, p, body, b) {
		var x = body[b], y = body[b + 1], z = body[b + 2];
		var qx = q[p], qy = q[p + 1], qz = q[p + 2], qw = q[p + 3];
		var tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
		out[o] = x + qw * tx + qy * tz - qz * ty;
		out[o + 1] = y + qw * ty + qz * tx - qx * tz;
		out[o + 2] = z + qw * tz + qx * ty - qy * tx;
	},
	// Hamilton product, out = a ⊗ b: apply b first, then a. Same convention integrate uses
	// when it left-multiplies the step rotation into the plate's orientation, so a chain of
	// these composes the way a chain of rotations does (0.4.6 rotation-history ingest).
	mul: function (out, o, a, p, b, q) {
		var ax = a[p], ay = a[p + 1], az = a[p + 2], aw = a[p + 3];
		var bx = b[q], by = b[q + 1], bz = b[q + 2], bw = b[q + 3];
		out[o] = aw * bx + ax * bw + ay * bz - az * by;
		out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
		out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
		out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
	},
	// Unit axis (already normalized) + angle in radians -> quaternion.
	fromAxisAngle: function (out, o, x, y, z, angle) {
		var half = angle * 0.5, s = Math.sin(half);
		out[o] = x * s; out[o + 1] = y * s; out[o + 2] = z * s; out[o + 3] = Math.cos(half);
	},
	// Shortest-arc interpolation between two orientations; t in [0, 1]. The dot sign flip is
	// what keeps a slerp from taking the long way round when the two quaternions differ by a
	// sign, and the linear branch covers the near-parallel case where the sine is ~0.
	slerp: function (out, o, a, p, b, q, t) {
		var ax = a[p], ay = a[p + 1], az = a[p + 2], aw = a[p + 3];
		var bx = b[q], by = b[q + 1], bz = b[q + 2], bw = b[q + 3];
		var dot = ax * bx + ay * by + az * bz + aw * bw;
		if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
		var s0, s1;
		if (dot > 0.9995) { s0 = 1 - t; s1 = t; }
		else {
			var th = Math.acos(Math.min(1, dot)), sn = Math.sin(th);
			s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn;
		}
		var ox = ax * s0 + bx * s1, oy = ay * s0 + by * s1, oz = az * s0 + bz * s1, ow = aw * s0 + bw * s1;
		var inv = 1 / Math.hypot(ox, oy, oz, ow);
		out[o] = ox * inv; out[o + 1] = oy * inv; out[o + 2] = oz * inv; out[o + 3] = ow * inv;
	},
	// Angle in radians between two orientations, sign-independent.
	angleBetween: function (a, p, b, q) {
		var dot = Math.abs(a[p] * b[q] + a[p + 1] * b[q + 1] + a[p + 2] * b[q + 2] + a[p + 3] * b[q + 3]);
		return 2 * Math.acos(Math.min(1, dot));
	},
	// world -> body, i.e. rotation by the conjugate. Used to rebase a column onto its plate.
	rotateInv: function (out, o, q, p, body, b) {
		var x = body[b], y = body[b + 1], z = body[b + 2];
		var qx = -q[p], qy = -q[p + 1], qz = -q[p + 2], qw = q[p + 3];
		var tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
		out[o] = x + qw * tx + qy * tz - qz * ty;
		out[o + 1] = y + qw * ty + qz * tx - qx * tz;
		out[o + 2] = z + qw * tz + qx * ty - qy * tx;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Quat;

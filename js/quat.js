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
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Quat;

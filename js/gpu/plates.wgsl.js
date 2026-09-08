/* gpu/plates.wgsl.js — K1 PLATES: one thread per plate integrates the quaternion exactly as
   Quat.integrate does (axis-angle from ω·dt, then Hamilton product and renormalisation). */
var PlatesWgsl = function () {
	return `@compute @workgroup_size(64)
fn kIntegrate(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= u32(ldFM(A_GPLATECOUNT))) { return; }
	let ox = ldFB(A_OMEGA + p * 4u);
	let oy = ldFB(A_OMEGA + p * 4u + 1u);
	let oz = ldFB(A_OMEGA + p * 4u + 2u);
	let speed = sqrt(ox * ox + oy * oy + oz * oz);
	if (speed == 0.0) { return; }
	let half = speed * ldFM(A_GDT) * 0.5;
	let sc = sin(half) / speed;
	let x = ox * sc; let y = oy * sc; let z = oz * sc;
	let a = cos(half);
	let bx = ldFB(A_Q + p * 4u);
	let by = ldFB(A_Q + p * 4u + 1u);
	let bz = ldFB(A_Q + p * 4u + 2u);
	let b = ldFB(A_Q + p * 4u + 3u);
	var rx = a * bx + x * b + y * bz - z * by;
	var ry = a * by - x * bz + y * b + z * bx;
	var rz = a * bz + x * by - y * bx + z * b;
	var rw = a * b - x * bx - y * by - z * bz;
	let inv = 1.0 / sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
	stFB(A_Q + p * 4u, rx * inv);
	stFB(A_Q + p * 4u + 1u, ry * inv);
	stFB(A_Q + p * 4u + 2u, rz * inv);
	stFB(A_Q + p * 4u + 3u, rw * inv);
}
`;
};
PlatesWgsl.entry = ['kIntegrate'];
if (typeof module !== 'undefined' && module.exports) module.exports = PlatesWgsl;

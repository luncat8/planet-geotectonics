/* gpu/columns.wgsl.js — K2 MOVE: rotate the body frame position onto the globe and hill-climb
   to the cell whose centre is nearest. The climb is the exact CPU loop (strict improvement,
   ring walk from the previous cell); iteration is bounded and overflow counted in diag. */
var ColumnsWgsl = function () {
	return `@compute @workgroup_size(256)
fn kMove(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= u32(ldFM(A_GCOLHIGH))) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let p = ldC(A_PLATE + i) * 4u;
	let bx = A_BODY + i * 4u;
	let x = ldFC(bx); let y = ldFC(bx + 1u); let z = ldFC(bx + 2u);
	let qx = ldFB(A_Q + p); let qy = ldFB(A_Q + p + 1u);
	let qz = ldFB(A_Q + p + 2u); let qw = ldFB(A_Q + p + 3u);
	let tx = 2.0 * (qy * z - qz * y);
	let ty = 2.0 * (qz * x - qx * z);
	let tz = 2.0 * (qx * y - qy * x);
	let wx = x + qw * tx + qy * tz - qz * ty;
	let wy = y + qw * ty + qz * tx - qx * tz;
	let wz = z + qw * tz + qx * ty - qy * tx;
	stFC(A_WORLD + i * 4u, wx);
	stFC(A_WORLD + i * 4u + 1u, wy);
	stFC(A_WORLD + i * 4u + 2u, wz);
	var c = u32(ldIC(A_CELL + i));
	var best = ldFS(A_POS + c * 4u) * wx + ldFS(A_POS + c * 4u + 1u) * wy + ldFS(A_POS + c * 4u + 2u) * wz;
	var steps = 0u;
	loop {
		if (steps > 255u) { addM(A_GCLIMBOVER, 1u); break; }
		var next = c;
		let rn = u32(ldS(A_RINGN + c));
		for (var k = 0u; k < rn; k++) {
			let j = ldIS(A_RING + c * 6u + k);
			let jb = u32(j) * 4u;
			let dt = ldFS(A_POS + jb) * wx + ldFS(A_POS + jb + 1u) * wy + ldFS(A_POS + jb + 2u) * wz;
			if (dt > best) { best = dt; next = u32(j); }
		}
		if (next == c) { break; }
		c = next;
		steps = steps + 1u;
	}
	stIC(A_CELL + i, i32(c));
	maxUM(A_GMAXCLIMB, steps);
}
`;
};
ColumnsWgsl.entry = ['kMove'];
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnsWgsl;

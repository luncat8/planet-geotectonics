/* gpu/diag.wgsl.js — K11: finite-value and invariant flags instead of the CPU's scalar tracking.
   gFinite bits: 1 non-finite field or plate id out of range, 2 quaternion norm off by >1e-5,
   4 column plate id outside the dense table, 8 a potential above 1 (impossible by construction,
   kept as the tripwire), 16 a spawn that found no free slot under colCap. */
var DiagWgsl = function () {
	return `@compute @workgroup_size(256)
fn kDiag(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	let nP = u32(ldFM(A_GPLATECOUNT));
	if (i < nP) {
		let qx = ldFB(A_Q + i * 4u); let qy = ldFB(A_Q + i * 4u + 1u);
		let qz = ldFB(A_Q + i * 4u + 2u); let qw = ldFB(A_Q + i * 4u + 3u);
		let nq = sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
		if (abs(nq - 1.0) > 1e-5) { addM(A_GFINITE, 2u); }
		if (ldFB(A_OMEGA + i * 4u) != ldFB(A_OMEGA + i * 4u)
			|| ldFB(A_OMEGA + i * 4u + 1u) != ldFB(A_OMEGA + i * 4u + 1u)
			|| ldFB(A_OMEGA + i * 4u + 2u) != ldFB(A_OMEGA + i * 4u + 2u)) { addM(A_GFINITE, 1u); }
	}
	if (i >= ldM(A_GCOLHIGH) || ldC(A_ALIVE + i) == 0u) { return; }
	if (ldC(A_PLATE + i) >= nP) { addM(A_GFINITE, 4u); }
	var bad = ldFC(A_WORLD + i * 4u) != ldFC(A_WORLD + i * 4u)
		|| ldFC(A_WORLD + i * 4u + 1u) != ldFC(A_WORLD + i * 4u + 1u)
		|| ldFC(A_WORLD + i * 4u + 2u) != ldFC(A_WORLD + i * 4u + 2u)
		|| ldFC(A_BODY + i * 4u) != ldFC(A_BODY + i * 4u)
		|| ldFC(A_AGE + i) != ldFC(A_AGE + i)
		|| ldFC(A_DAMAGE + i) != ldFC(A_DAMAGE + i);
	if (bad) { addM(A_GFINITE, 1u); }
	var over = false;
	for (var k = 0u; k < 6u; k++) {
		if (ldC(A_ORE + i * 6u + k) > OU + 1u) { over = true; }
	}
	if (over) { addM(A_GFINITE, 8u); }
}
`;
};
DiagWgsl.entry = ['kDiag'];
if (typeof module !== 'undefined' && module.exports) module.exports = DiagWgsl;

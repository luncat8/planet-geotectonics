/* gpu/forces.wgsl.js — K10. kForces writes the equivalent basal velocity per cell (ridge push on
   oceanic relief, slab pull and the collision barrier on convergent edges, all divided by the
   cooling drag). kReduceAccum atomic-adds the area-weighted normal matrix and rhs in fixed point
   (integer adds are exact and order-free — the deterministic replacement for ordered workgroup
   partial sums); kReduceSolve solves the 3×3 and relaxes ω per plate, one thread each. */
var ForcesWgsl = function () {
	return `const MU_M = 1e7;
const MU_R = 1e5;

@compute @workgroup_size(256)
fn kForces(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	stFX(A_WEQ + c * 4u, 0.0); stFX(A_WEQ + c * 4u + 1u, 0.0); stFX(A_WEQ + c * 4u + 2u, 0.0);
	let o = ldIX(A_OWNER + c);
	if (o < 0) { return; }
	let ob = u32(o);
	var wx = 0.0; var wy = 0.0; var wz = 0.0;
	if (fMm(ldC(A_FEL + ob)) < H_OCEANIC) {
		wx = wx - ldFM(A_GRIDGE) * ldFX(A_GRADZ + c * 4u);
		wy = wy - ldFM(A_GRIDGE) * ldFX(A_GRADZ + c * 4u + 1u);
		wz = wz - ldFM(A_GRIDGE) * ldFX(A_GRADZ + c * 4u + 2u);
	}
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let e = c * 6u + k;
		if (ldX(A_ETYPE + e) != 1u) { continue; }
		let j = ldIS(A_RING + e);
		let oj = ldIX(A_OWNER + u32(j));
		if (oj < 0) { continue; }
		let pol = ldIX(A_POL + e);
		var push = 0.0;
		if (pol == 2) {
			let closing = -ldFX(A_RELN + e);
			if (closing <= 0.0) { continue; }
			let felO = max(fMm(ldC(A_FEL + ob)), fMm(ldC(A_FEL + u32(oj))));
			let thick = 1.0 + COLL_THICK * max(0.0, felO - H_OCEANIC) / H_COLLAPSE;
			push = -ldFM(A_GCOLL) * min(4.0, thick) * closing;
		} else if (pol == -1) {
			push = ldFM(A_GSLAB) * min(AGE_SLAB, ldFC(A_AGE + ob));
		} else { continue; }
		let eb = e * 3u;
		wx = wx + push * ldFS(A_FACEN + eb);
		wy = wy + push * ldFS(A_FACEN + eb + 1u);
		wz = wz + push * ldFS(A_FACEN + eb + 2u);
	}
	stFX(A_WEQ + c * 4u, wx);
	stFX(A_WEQ + c * 4u + 1u, wy);
	stFX(A_WEQ + c * 4u + 2u, wz);
}

@compute @workgroup_size(256)
fn kReduceAccum(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let o = ldIX(A_OWNER + c);
	if (o < 0) { return; }
	let p = ldC(A_PLATE + u32(o));
	if (p >= u32(ldFM(A_GPLATECOUNT))) { return; }
	let a = ldFS(A_POS + c * 4u + 3u);
	let x = ldFS(A_POS + c * 4u);
	let y = ldFS(A_POS + c * 4u + 1u);
	let z = ldFS(A_POS + c * 4u + 2u);
	let pb = p * 6u;
	addIB(A_M6 + pb, i32(a * (1.0 - x * x) / MU_M));
	addIB(A_M6 + pb + 1u, i32(-a * x * y / MU_M));
	addIB(A_M6 + pb + 2u, i32(-a * x * z / MU_M));
	addIB(A_M6 + pb + 3u, i32(a * (1.0 - y * y) / MU_M));
	addIB(A_M6 + pb + 4u, i32(-a * y * z / MU_M));
	addIB(A_M6 + pb + 5u, i32(a * (1.0 - z * z) / MU_M));
	let f = a / ldFM(A_GRADIUS);
	let ux = ldFX(A_U + c * 4u) + ldFX(A_WEQ + c * 4u);
	let uy = ldFX(A_U + c * 4u + 1u) + ldFX(A_WEQ + c * 4u + 1u);
	let uz = ldFX(A_U + c * 4u + 2u) + ldFX(A_WEQ + c * 4u + 2u);
	let rb = p * 3u;
	addIB(A_RHS + rb, i32(f * (y * uz - z * uy) / MU_R));
	addIB(A_RHS + rb + 1u, i32(f * (z * ux - x * uz) / MU_R));
	addIB(A_RHS + rb + 2u, i32(f * (x * uy - y * ux) / MU_R));
}

@compute @workgroup_size(64)
fn kReduceSolve(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= u32(ldFM(A_GPLATECOUNT))) { return; }
	let pb = p * 6u;
	var a00 = f32(ldIB(A_M6 + pb)) * MU_M;
	let a01 = f32(ldIB(A_M6 + pb + 1u)) * MU_M;
	let a02 = f32(ldIB(A_M6 + pb + 2u)) * MU_M;
	var a11 = f32(ldIB(A_M6 + pb + 3u)) * MU_M;
	let a12 = f32(ldIB(A_M6 + pb + 4u)) * MU_M;
	var a22 = f32(ldIB(A_M6 + pb + 5u)) * MU_M;
	var eps = 1e-18;
	if (ldB(A_CELLS + p) < 3u) { eps = 1e-4 * ldFS(A_POS + 3u); }
	a00 = a00 + eps; a11 = a11 + eps; a22 = a22 + eps;
	let bx = f32(ldIB(A_RHS + p * 3u)) * MU_R;
	let by = f32(ldIB(A_RHS + p * 3u + 1u)) * MU_R;
	let bz = f32(ldIB(A_RHS + p * 3u + 2u)) * MU_R;
	let det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
	var wx = 0.0; var wy = 0.0; var wz = 0.0;
	if (abs(det) >= 1e-30) {
		let inv = 1.0 / det;
		wx = ((a11 * a22 - a12 * a12) * bx + (a02 * a12 - a01 * a22) * by + (a01 * a12 - a02 * a11) * bz) * inv;
		wy = ((a02 * a12 - a01 * a22) * bx + (a00 * a22 - a02 * a02) * by + (a02 * a01 - a00 * a12) * bz) * inv;
		wz = ((a01 * a12 - a11 * a02) * bx + (a02 * a01 - a00 * a12) * by + (a00 * a11 - a01 * a01) * bz) * inv;
	}
	stFB(A_OMEGAT + p * 4u, wx); stFB(A_OMEGAT + p * 4u + 1u, wy); stFB(A_OMEGAT + p * 4u + 2u, wz);
	let alpha = ldFM(A_GALPHA);
	var nx = ldFB(A_OMEGA + p * 4u) + (wx - ldFB(A_OMEGA + p * 4u)) * alpha;
	var ny = ldFB(A_OMEGA + p * 4u + 1u) + (wy - ldFB(A_OMEGA + p * 4u + 1u)) * alpha;
	var nz = ldFB(A_OMEGA + p * 4u + 2u) + (wz - ldFB(A_OMEGA + p * 4u + 2u)) * alpha;
	let mag = sqrt(nx * nx + ny * ny + nz * nz);
	let cap = ldFM(A_GCAP);
	if (mag > cap) { let k = cap / mag; nx = nx * k; ny = ny * k; nz = nz * k; }
	stFB(A_OMEGA + p * 4u, nx); stFB(A_OMEGA + p * 4u + 1u, ny); stFB(A_OMEGA + p * 4u + 2u, nz);
}
`;
};
ForcesWgsl.entry = ['kForces', 'kReduceAccum', 'kReduceSolve'];
if (typeof module !== 'undefined' && module.exports) module.exports = ForcesWgsl;

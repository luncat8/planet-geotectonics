/* wgsl-plates.js - K1 quaternion integrate, K10 equivalent basal forces (wEq) and the
   two-stage per-plate least-squares reduction (thread-per-plate partials, then solve). */
var PlatesWGSL = [
{
	name: 'integrate', groups: ['plateF', 'frameIn'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= fPlates()) { return; }
	let w = plateOmega(p);
	let speed = length(w);
	if (speed == 0.0) { return; }
	let half = speed * fDT() * 0.5;
	let dq = vec4<f32>(w * (sinx(half) / speed), cosx(half));
	let q = plateQ(p);
	// WGSL forbids swizzle assignment, so build the product vector in one constructor.
	var r = vec4<f32>(dq.w * q.xyz + q.w * dq.xyz + cross(dq.xyz, q.xyz),
		dq.w * q.w - dot(dq.xyz, q.xyz));
	let inv = 1.0 / length(r);
	setPlateQ(p, r * inv);
}
`
},
{
	name: 'forces', groups: ['gridF', 'gridI', 'colF', 'cellF', 'cellI', 'edges', 'frameIn'],
	code: `
// Design §6.3: every force except drag as an equivalent mantle speed, divided by the
// temperature-dependent asthenosphere drag so a cooling mantle locks the lid by itself.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var w = vec3<f32>(0.0);
	let owner = cellOwner(c);
	if (owner >= 0) {
		let i = u32(owner);
		let invCD = exp(-P_EA * (1.0 / fTM() - 1.0));
		if (colHFel(i) < P_HOCEANIC) {
			w = w - (P_KRIDGE * invCD) * cellGradZ(c);
		}
		let coll = (P_VCOLL / P_VREF) * invCD;
		let slab = P_VSLAB * invCD / P_AGESLAB;
		for (var k = 0u; k < ringN(c); k = k + 1u) {
			let e = c * 6u + k;
			let jo = cellOwner(u32(ringAt(e)));
			if (jo < 0 || edgeType(e) != E_CONV) { continue; }
			let pol = edgePol(e);
			var push = 0.0;
			if (pol == 2) {
				// Thick continental crust builds a stronger normal barrier.
				let closing = -edgeRelN(e);
				if (closing <= 0.0) { continue; }
				let thick = 1.0 + P_COLLTHICK * max(0.0, max(colHFel(i), colHFel(u32(jo))) - P_HOCEANIC) / P_HCOLLAPSE;
				push = -coll * min(4.0, thick) * closing;
			} else if (pol == -1) {
				push = slab * min(P_AGESLAB, colAge(i));
			} else { continue; }
			w = w + push * faceN(e);
		}
	}
	CELLF[c * 8u + 7u] = vec4<f32>(w, 0.0);
}
`
},
{
	name: 'reduceA', groups: ['gridF', 'colI', 'cellF', 'cellI', 'reduce', 'frameIn'],
	code: `
// Partial normal equations: thread = plate, workgroup = cell chunk.
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
	let p = li.x;
	if (p >= fPlates()) { return; }
	var m0 = vec3<f32>(0.0);
	var m1 = vec3<f32>(0.0);
	var m2 = vec3<f32>(0.0);
	var b = vec3<f32>(0.0);
	var c0 = vec3<f32>(0.0);
	var c1 = vec3<f32>(0.0);
	var c2 = vec3<f32>(0.0);
	var cb = vec3<f32>(0.0);
	let begin = wg.x * CHUNK10;
	let end = min(begin + CHUNK10, V);
	for (var c = begin; c < end; c = c + 1u) {
		let o = cellOwner(c);
		if (o < 0) { continue; }
		if (colPlate(u32(o)) != i32(p)) { continue; }
		let pos = cellPos(c);
		let A = cellArea(c);
		kAdd3(&m0, &c0, vec3<f32>(A * (1.0 - pos.x * pos.x), -A * pos.x * pos.y, -A * pos.x * pos.z));
		kAdd3(&m1, &c1, vec3<f32>(-A * pos.y * pos.x, A * (1.0 - pos.y * pos.y), -A * pos.y * pos.z));
		kAdd3(&m2, &c2, vec3<f32>(-A * pos.z * pos.x, -A * pos.z * pos.y, A * (1.0 - pos.z * pos.z)));
		let u = cellU(c) + cellWEq(c);
		kAdd3(&b, &cb, (A / R) * cross(pos, u));
	}
	let base = RED_K10 + (wg.x * PLATECAP + p) * 12u;
	RED[base] = m0.x; RED[base + 1u] = m0.y; RED[base + 2u] = m0.z;
	RED[base + 3u] = m1.x; RED[base + 4u] = m1.y; RED[base + 5u] = m1.z;
	RED[base + 6u] = m2.x; RED[base + 7u] = m2.y; RED[base + 8u] = m2.z;
	RED[base + 9u] = b.x; RED[base + 10u] = b.y; RED[base + 11u] = b.z;
}
`
},
{
	name: 'reduceB', groups: ['plateF', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Sum partials in workgroup order, solve, relax and cap. The plate sums, target and rhs
// are written back for the CPU mirror even though only omega feeds the next frame.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= fPlates()) { return; }
	var m0 = vec3<f32>(0.0);
	var m1 = vec3<f32>(0.0);
	var m2 = vec3<f32>(0.0);
	var b = vec3<f32>(0.0);
	var k0 = vec3<f32>(0.0);
	var k1 = vec3<f32>(0.0);
	var k2 = vec3<f32>(0.0);
	var kb = vec3<f32>(0.0);
	// The normal equations are ~A0*N (1e13): cofactor products overflow f32. Dividing
	// every entry by A0[0] leaves the solution unchanged and keeps the solve in range;
	// the eps regularizer divides with it (1e-4*A0[0] / A0[0]).
	let invA = 1.0 / fA00();
	for (var wg = 0u; wg < NWG10; wg = wg + 1u) {
		let base = RED_K10 + (wg * PLATECAP + p) * 12u;
		kAdd3(&m0, &k0, vec3<f32>(RED[base], RED[base + 1u], RED[base + 2u]) * invA);
		kAdd3(&m1, &k1, vec3<f32>(RED[base + 3u], RED[base + 4u], RED[base + 5u]) * invA);
		kAdd3(&m2, &k2, vec3<f32>(RED[base + 6u], RED[base + 7u], RED[base + 8u]) * invA);
		kAdd3(&b, &kb, vec3<f32>(RED[base + 9u], RED[base + 10u], RED[base + 11u]) * invA);
	}
	let eps = select(1e-4, 1e-18 * invA, plateCells(p) >= 3);
	m0 = m0 + vec3<f32>(eps, 0.0, 0.0);
	m1 = m1 + vec3<f32>(0.0, eps, 0.0);
	m2 = m2 + vec3<f32>(0.0, 0.0, eps);
	var fit = solve3(m0, m1, m2, b);
	// One fma-residual refinement step: the cofactor solve in f32 loses ~1e-5 relative,
	// which is exactly the parity budget, so polish against the original equations.
	var r = vec3<f32>(fma(-m0.z, fit.z, fma(-m0.y, fit.y, fma(-m0.x, fit.x, b.x))),
		fma(-m1.z, fit.z, fma(-m1.y, fit.y, fma(-m1.x, fit.x, b.y))),
		fma(-m2.z, fit.z, fma(-m2.y, fit.y, fma(-m2.x, fit.x, b.z))));
	fit = fit + solve3(m0, m1, m2, r);
	let alpha = min(1.0, fDT() / P_TAUOMEGA);
	let cap = P_VMAX / R;
	var w = plateOmega(p) + (fit - plateOmega(p)) * alpha;
	let mag = length(w);
	if (mag > cap) { w = w * (cap / mag); }
	PLATEF[p * 8u + 2u] = vec4<f32>(fit, 0.0);
	setPlateOmega(p, w);
	setPlateM(p, 0u, m0.x); setPlateM(p, 1u, m0.y); setPlateM(p, 2u, m0.z);
	setPlateM(p, 3u, m1.x); setPlateM(p, 4u, m1.y); setPlateM(p, 5u, m1.z);
	setPlateM(p, 6u, m2.x); setPlateM(p, 7u, m2.y); setPlateM(p, 8u, m2.z);
	setPlateRhs(p, 0u, b.x); setPlateRhs(p, 1u, b.y); setPlateRhs(p, 2u, b.z);
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = PlatesWGSL;

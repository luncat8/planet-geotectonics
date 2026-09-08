/* gpu/surface.wgsl.js — K9 SURFACE: dynamic topography (zDyn relaxes toward flexure and plume
   swell, ping-ponged through the gZdynA/gZdynB offsets), isostatic elevation, the tangent-plane
   gradient from the static least-squares operator, the basin potential, then routing: erosion
   per column (single writer, no double-spend when two cells share an owner), one-hop outflow
   with the under-water pass-through, deposition into owner columns with dose reduction for the
   basin and placer potentials. */
var SurfaceWgsl = function () {
	return `// zDyn keeps one address (A_ZDYN): arcs and elevation read it directly, dynamics writes
// the scratch and a copy dispatch publishes it — no offset swapping to keep in step with.
@compute @workgroup_size(256)
fn kDynamics(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let cell = ldIC(A_CELL + i);
	let self = fCm(ldIC(A_ZDYN + i));
	var lap = 0.0;
	if (cell >= 0) {
		let rn = u32(ldS(A_RINGN + u32(cell)));
		for (var k = 0u; k < rn; k++) {
			let j = u32(ldIS(A_RING + u32(cell) * 6u + k));
			let oj = ldIX(A_OWNER + j);
			if (oj >= 0 && oj != i) { lap = lap + fCm(ldIC(A_ZDYN + u32(oj))) - self; }
		}
	}
	var next = self * ldFM(A_GDYNDECAY) + K_FLEX * ldFM(A_GDT) * lap;
	var heat = 0.0;
	if (cell >= 0) { heat = ldFX(A_PLUMET + u32(cell)); }
	let target = Z_PLUME * clamp(heat, 0.0, 1.0);
	next = next + (target - next) * ldFM(A_GPLUMERELAX);
	stIC(A_ZDYNNEXT + i, toCm(next));
}

@compute @workgroup_size(256)
fn kZdynCopy(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	stIC(A_ZDYN + i, ldIC(A_ZDYNNEXT + i));
}

@compute @workgroup_size(256)
fn kElevation(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let o = ldIX(A_OWNER + c);
	if (o < 0) {
		stX(A_Z + c, 0x7FC00000u);
		stX(A_WET + c, 0u);
		return;
	}
	let ob = u32(o);
	let fel = fMm(ldC(A_FEL + ob));
	let ci = smooth01(fel, 5000.0, 20000.0);
	let thermal = (1.0 - ci) * 350.0 * sqrt(min(ldFC(A_AGE + ob), 80.0)) + ci * 2091.0;
	let z = -3342.0 + fel / 6.0 + (fMm(ldC(A_MAF + ob)) * 350.0 + fMm(ldC(A_SED + ob)) * 900.0) / 3300.0
		- thermal + fCm(ldIC(A_ZDYN + ob));
	stFX(A_Z + c, z);
	stX(A_WET + c, select(0u, 1u, z < 0.0));
}

// Least-squares tangent gradient; cells without elevation keep their previous gradient,
// matching the CPU's NaN skip.
@compute @workgroup_size(256)
fn kGradient(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let zi = ldFX(A_Z + c);
	if (zi != zi) { return; }
	let x = ldFS(A_POS + c * 4u); let y = ldFS(A_POS + c * 4u + 1u); let z = ldFS(A_POS + c * 4u + 2u);
	var bx = 0.0; var by = 0.0; var bz = 0.0;
	var low = -1i; var lowZ = 3.4e38;
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let j = u32(ldIS(A_RING + c * 6u + k));
		let zj = ldFX(A_Z + j);
		if (zj != zj) { continue; }
		let dz = zj - zi;
		bx = bx + dz * ldFS(A_POS + j * 4u);
		by = by + dz * ldFS(A_POS + j * 4u + 1u);
		bz = bz + dz * ldFS(A_POS + j * 4u + 2u);
		if (zj < lowZ || (zj == lowZ && j < u32(low))) { low = i32(j); lowZ = zj; }
	}
	let i9 = c * 9u;
	var gx = ldFS(A_GRADINV + i9) * bx + ldFS(A_GRADINV + i9 + 1u) * by + ldFS(A_GRADINV + i9 + 2u) * bz;
	var gy = ldFS(A_GRADINV + i9 + 3u) * bx + ldFS(A_GRADINV + i9 + 4u) * by + ldFS(A_GRADINV + i9 + 5u) * bz;
	var gz = ldFS(A_GRADINV + i9 + 6u) * bx + ldFS(A_GRADINV + i9 + 7u) * by + ldFS(A_GRADINV + i9 + 8u) * bz;
	let radial = gx * x + gy * y + gz * z;
	let r = ldFM(A_GRADIUS);
	gx = (gx - x * radial) / r; gy = (gy - y * radial) / r; gz = (gz - z * radial) / r;
	stFX(A_GRADZ + c * 4u, gx);
	stFX(A_GRADZ + c * 4u + 1u, gy);
	stFX(A_GRADZ + c * 4u + 2u, gz);
	stFX(A_SLOPE + c, sqrt(gx * gx + gy * gy + gz * gz));
	stIX(A_LOW + c, low);
}

@compute @workgroup_size(256)
fn kBasins(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	if (!(fMm(ldC(A_SED + i)) > H_BAS)) { return; }
	let cell = ldIC(A_CELL + i);
	if (cell < 0 || ldX(A_WET + u32(cell)) == 0u) { return; }
	let cur = fOre(ldC(A_ORE + i * 6u + 4u));
	stC(A_ORE + i * 6u + 4u, toOre(cur + (1.0 - cur) * K_B2 * ldFM(A_GDT) * ldFC(A_FERT + i)));
}

// Erosion in the order sediment, felsic, mafic — taken by the column that owns the crust,
// so takes can never double-spend. Mobile load lands on the column's own cell atomically.
@compute @workgroup_size(256)
fn kErode(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let c = ldIC(A_CELL + i);
	if (c < 0) { return; }
	let zv = ldFX(A_Z + u32(c));
	if (!(zv > 0.0)) { return; }
	let dt = ldFM(A_GDT);
	var want = K_ERO * zv * (1.0 + 2.0 * ldFX(A_SLOPE + u32(c)) / SLOPE_REF) * dt;
	let sedM = fMm(ldC(A_SED + i));
	let takeSed = min(want, sedM);
	want = want - takeSed;
	let felM = fMm(ldC(A_FEL + i));
	let takeFel = min(want, felM);
	want = want - takeFel;
	let mafM = fMm(ldC(A_MAF + i));
	let takeMaf = min(want, mafM);
	let eroded = takeSed + takeFel + takeMaf;
	stC(A_SED + i, toMm(sedM - takeSed));
	stC(A_FEL + i, toMm(felM - takeFel));
	stC(A_MAF + i, toMm(mafM - takeMaf));
	let pla = K_PLACER * eroded * 0.5 * (fOre(ldC(A_ORE + i * 6u + 3u)) + fOre(ldC(A_ORE + i * 6u + 2u)));
	addX(A_MOBILE + u32(c), toMm(eroded));
	addX(A_MOBILEFEL + u32(c), toMm(takeSed + takeFel));
	addX(A_MOBILEPLA + u32(c), toMm(pla));
	add64(A_GLEDEROFELLO, A_GLEDEROFELHI, u32(takeFel * CU));
	add64(A_GLEDEROMAFLO, A_GLEDEROMAFHI, u32(takeMaf * CU));
	add64I(A_GLEDPRODFELLO, A_GLEDPRODFELHI, -i32(takeFel * CU));
	add64I(A_GLEDPRODMAFLO, A_GLEDPRODMAFHI, -i32(takeMaf * CU));
}

@compute @workgroup_size(256)
fn kFlow(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let local = ldX(A_MOBILE + c);
	let localFel = ldX(A_MOBILEFEL + c);
	let localPla = ldX(A_MOBILEPLA + c);
	var fraction = 0.0;
	let low = ldIX(A_LOW + c);
	if (low >= 0) {
		let zl = ldFX(A_Z + u32(low));
		let zc = ldFX(A_Z + c);
		if (zl < zc - DELTA_Z) { fraction = select(1.0, 0.5, ldX(A_WET + c) != 0u); }
	}
	let out = u32(f32(local) * fraction);
	let outFel = u32(f32(localFel) * fraction);
	let outPla = u32(f32(localPla) * fraction);
	stX(A_OUTFLOW + c, out);
	stX(A_OUTFLOWFEL + c, outFel);
	stX(A_OUTFLOWPLA + c, outPla);
	subX(A_MOBILE + c, out);
	subX(A_MOBILEFEL + c, outFel);
	subX(A_MOBILEPLA + c, outPla);
	if (low >= 0 && out > 0u) {
		addX(A_INFLOW + u32(low), out);
		addX(A_INFLOWFEL + u32(low), outFel);
		addX(A_INFLOWPLA + u32(low), outPla);
	}
}

@compute @workgroup_size(256)
fn kDeposit(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let stay = ldX(A_MOBILE + c) + ldX(A_INFLOW + c);
	let stayFel = ldX(A_MOBILEFEL + c) + ldX(A_INFLOWFEL + c);
	let stayPla = ldX(A_MOBILEPLA + c) + ldX(A_INFLOWPLA + c);
	let o = ldIX(A_OWNER + c);
	if (o >= 0) {
		let ob = u32(o);
		addC(A_SED + ob, stay);
		let zv = ldFX(A_Z + c);
		if (stay > 0u && zv < Z_BASIN) {
			addX(A_DOSEBAS + ob, toOre(min(1.0, K_B * fMm(stayFel) * ldFC(A_FERT + ob))));
			if (stayPla > 0u) {
				addX(A_DOSEPLA + ob, toOre(min(1.0, K_B * fMm(stayPla) * ldFC(A_FERT + ob))));
			}
		}
		stX(A_MOBILE + c, 0u); stX(A_MOBILEFEL + c, 0u); stX(A_MOBILEPLA + c, 0u);
	} else {
		stX(A_MOBILE + c, stay); stX(A_MOBILEFEL + c, stayFel); stX(A_MOBILEPLA + c, stayPla);
	}
	stX(A_INFLOW + c, 0u); stX(A_INFLOWFEL + c, 0u); stX(A_INFLOWPLA + c, 0u);
	stX(A_OUTFLOW + c, 0u); stX(A_OUTFLOWFEL + c, 0u); stX(A_OUTFLOWPLA + c, 0u);
}

@compute @workgroup_size(256)
fn kDoseBas(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	let dBas = ldX(A_DOSEBAS + i);
	let dPla = ldX(A_DOSEPLA + i);
	if (dBas == 0u && dPla == 0u) { return; }
	if (ldC(A_ALIVE + i) != 0u) {
		if (dBas != 0u) {
			let cur = fOre(ldC(A_ORE + i * 6u + 4u));
			stC(A_ORE + i * 6u + 4u, toOre(cur + (1.0 - cur) * min(1.0, f32(dBas) / OU)));
		}
		if (dPla != 0u) {
			let cur = fOre(ldC(A_ORE + i * 6u + 5u));
			stC(A_ORE + i * 6u + 5u, toOre(cur + (1.0 - cur) * min(1.0, f32(dPla) / OU)));
		}
	}
	stX(A_DOSEBAS + i, 0u);
	stX(A_DOSEPLA + i, 0u);
}
`;
};
SurfaceWgsl.entry = ['kDynamics', 'kZdynCopy', 'kElevation', 'kGradient', 'kBasins', 'kErode', 'kFlow', 'kDeposit', 'kDoseBas'];
if (typeof module !== 'undefined' && module.exports) module.exports = SurfaceWgsl;

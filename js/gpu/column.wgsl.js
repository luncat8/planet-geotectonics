/* gpu/column.wgsl.js — K8 COLUMN. Collapse is a per-column gather over its own ring: because
   collapseWeight is symmetric, Σ_j (hFel[j]−hFel[i])·w equals the CPU's j>c pair split exactly.
   Belt is computed per cell from a two-hop edge scan (an endpoint within one ring — the same
   set the CPU's dilation marks) instead of writing shared flags. Then the column pass: age,
   damage, plume melt, and the column-local ore factories with saturating updates. */
var ColumnWgsl = function () {
	return `@compute @workgroup_size(256)
fn kCollapse(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let c = ldIC(A_CELL + i);
	if (c < 0) { return; }
	let felI = fMm(ldC(A_FEL + i));
	var delta = 0.0;
	let rn = u32(ldS(A_RINGN + u32(c)));
	for (var k = 0u; k < rn; k++) {
		let j = u32(ldIS(A_RING + u32(c) * 6u + k));
		let oj = ldIX(A_OWNER + j);
		if (oj < 0 || oj == i) { continue; }
		let felJ = fMm(ldC(A_FEL + u32(oj)));
		if (max(felI, felJ) <= H_COLLAPSE) { continue; }
		delta = delta + K_COLLAPSE * ldFM(A_GDT) * (felJ - felI) * ldFS(A_COLLAPSEW + u32(c) * 6u + k);
	}
	if (delta == 0.0) { return; }
	stC(A_FEL + i, toMm(max(0.0, felI + delta)));
}

// Does cell have a qualifying belt edge (C–C convergent, or a transform with both sides
// continental)? The caller walks the cell and its ring, so an endpoint within one ring of
// the tested cell is exactly the CPU's dilated set.
fn beltEdge(cell:u32, oc:u32) -> bool {
	let felO = fMm(ldC(A_FEL + oc));
	if (felO < H_OCEANIC) { return false; }
	let rn = u32(ldS(A_RINGN + cell));
	for (var k = 0u; k < rn; k++) {
		let e = cell * 6u + k;
		let t = ldX(A_ETYPE + e);
		if (t == 0u) { continue; }
		let j = ldIS(A_RING + e);
		if (j < 0) { continue; }
		let oj = ldIX(A_OWNER + u32(j));
		if (oj < 0) { continue; }
		if (t == 1u) {
			if (ldIX(A_POL + e) == 2) { return true; }
			continue;
		}
		if (t == 3u && fMm(ldC(A_FEL + u32(oj))) >= H_OCEANIC) { return true; }
	}
	return false;
}

@compute @workgroup_size(256)
fn kBelt(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	stX(A_BELT + c, 0u);
	let oc = ldIX(A_OWNER + c);
	if (oc < 0) { return; }
	if (beltEdge(c, u32(oc))) { stX(A_BELT + c, 1u); return; }
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let j = u32(ldIS(A_RING + c * 6u + k));
		let oj = ldIX(A_OWNER + j);
		if (oj < 0) { continue; }
		if (beltEdge(j, u32(oj))) { stX(A_BELT + c, 1u); return; }
	}
}

@compute @workgroup_size(256)
fn kColumn(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let dt = ldFM(A_GDT);
	let age = ldFC(A_AGE + i) + dt;
	stFC(A_AGE + i, age);
	let cell = ldIC(A_CELL + i);
	var ext = 0.0; var tangent = 0.0; var normal = 0.0; var spread = 0.0; var heat = 0.0;
	if (cell >= 0) {
		ext = max(0.0, ldFX(A_EXT + u32(cell)));
		heat = ldFX(A_PLUMET + u32(cell));
		let rn = u32(ldS(A_RINGN + u32(cell)));
		for (var k = 0u; k < rn; k++) {
			let e = u32(cell) * 6u + k;
			tangent = max(tangent, abs(ldFX(A_RELT + e)));
			let n = abs(ldFX(A_RELN + e));
			if (n > normal) { normal = n; }
			if (ldX(A_ETYPE + e) == 2u && ldFX(A_RELN + e) > spread) { spread = ldFX(A_RELN + e); }
		}
	}
	let felM = fMm(ldC(A_FEL + i));
	let cont = smooth01(felM, 10000.0, 35000.0);
	let old = smooth01(age, 20.0, 200.0);
	let strength = clamp(0.3 + 0.7 * cont + 0.3 * old, 0.3, 1.3) / max(0.35, ldFM(A_GTM));
	let growth = K_DAM * ext / EXT_REF / strength + K_DAM_T * tangent / V_REF;
	var dmg = ldFC(A_DAMAGE + i);
	dmg = clamp(dmg + dt * (growth - K_HEAL * dmg), 0.0, 1.0);
	stFC(A_DAMAGE + i, dmg);
	let lip = K_LIP * ldFM(A_GTM) * max(0.0, heat - 0.25) * dt;
	if (lip > 0.0) {
		addC(A_MAF + i, toMm(lip));
		add64(A_GLEDPRODMAFLO, A_GLEDPRODMAFHI, u32(lip * CU));
	}
	let fert = ldFC(A_FERT + i);
	var vms = fOre(ldC(A_ORE + i * 6u));
	if (felM < H_OCEANIC && spread > 0.0) {
		vms = vms + (1.0 - vms) * K_V * ldFM(A_GTM) * min(1.0, spread / V_REF) * fert * dt;
	}
	var mafO = fOre(ldC(A_ORE + i * 6u + 1u));
	if (heat > 0.0) { mafO = mafO + (1.0 - mafO) * K_M * heat * fert * dt; }
	var oro = fOre(ldC(A_ORE + i * 6u + 3u));
	if (felM > H_ORO || (felM >= H_OCEANIC && cell >= 0 && ldX(A_BELT + u32(cell)) == 1u)) {
		oro = oro + (1.0 - oro) * K_O * (normal + tangent) / V_REF * dmg * fert * dt;
	}
	let decay = 1.0 - K_DECAY * dt;
	stC(A_ORE + i * 6u, toOre(vms * decay));
	stC(A_ORE + i * 6u + 1u, toOre(mafO * decay));
	stC(A_ORE + i * 6u + 2u, u32(f32(ldC(A_ORE + i * 6u + 2u)) * decay));
	stC(A_ORE + i * 6u + 3u, toOre(oro * decay));
	stC(A_ORE + i * 6u + 4u, u32(f32(ldC(A_ORE + i * 6u + 4u)) * decay));
	stC(A_ORE + i * 6u + 5u, u32(f32(ldC(A_ORE + i * 6u + 5u)) * decay));
}
`;
};
ColumnWgsl.entry = ['kCollapse', 'kBelt', 'kColumn'];
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnWgsl;

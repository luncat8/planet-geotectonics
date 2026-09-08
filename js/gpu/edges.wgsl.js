/* gpu/edges.wgsl.js — K5 EDGES as five dispatches: velocities (per cell, with the plate-cell
   recount and speed diagnostics), relatives (per directed edge with hysteresis), polarity,
   trench distance (memset to 3, seed pass, two same-plate relaxation passes via atomicMin),
   and extension (neighbour-difference flux, which annihilates rigid Ω×r on this dual). */
var EdgesWgsl = function () {
	return `@compute @workgroup_size(256)
fn kVelocities(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let o = ldIX(A_OWNER + c);
	var plate = 65535u;
	if (o >= 0) { plate = ldC(A_PLATE + u32(o)); }
	stX(A_CELLPLATE + c, plate);
	if (plate >= u32(ldFM(A_GPLATECOUNT))) {
		stFX(A_VEL + c * 4u, 0.0); stFX(A_VEL + c * 4u + 1u, 0.0); stFX(A_VEL + c * 4u + 2u, 0.0);
		return;
	}
	addB(A_CELLS + plate, 1u);
	let x = ldFS(A_POS + c * 4u); let y = ldFS(A_POS + c * 4u + 1u); let z = ldFS(A_POS + c * 4u + 2u);
	let ox = ldFB(A_OMEGA + plate * 4u);
	let oy = ldFB(A_OMEGA + plate * 4u + 1u);
	let oz = ldFB(A_OMEGA + plate * 4u + 2u);
	let vx = ldFM(A_GRADIUS) * (oy * z - oz * y);
	let vy = ldFM(A_GRADIUS) * (oz * x - ox * z);
	let vz = ldFM(A_GRADIUS) * (ox * y - oy * x);
	stFX(A_VEL + c * 4u, vx); stFX(A_VEL + c * 4u + 1u, vy); stFX(A_VEL + c * 4u + 2u, vz);
	let speed = sqrt(vx * vx + vy * vy + vz * vz);
	addM(A_GSPEEDN, 1u);
	add64(A_GSPEEDSUMLO, A_GSPEEDSUMHI, u32(speed * 100.0));
	maxUM(A_GMAXSPEED, bitcast<u32>(speed));
}

@compute @workgroup_size(256)
fn kRelatives(@builtin(global_invocation_id) gid: vec3<u32>) {
	let e = gid.x;
	if (e >= CELL_N * 6u) { return; }
	let c = e / 6u;
	let j = ldIS(A_RING + e);
	let old = ldX(A_ETYPE + e);
	if (j < 0) {
		stFX(A_RELN + e, 0.0); stFX(A_RELT + e, 0.0);
		if (old != 0u) { addM(A_GTYPECHANGES, 1u); }
		stX(A_ETYPE + e, 0u);
		return;
	}
	let pi = ldX(A_CELLPLATE + c);
	let pj = ldX(A_CELLPLATE + u32(j));
	if (pi == 65535u || pj == 65535u || pi == pj) {
		stFX(A_RELN + e, 0.0); stFX(A_RELT + e, 0.0);
		if (old != 0u) { addM(A_GTYPECHANGES, 1u); }
		stX(A_ETYPE + e, 0u);
		return;
	}
	let jb = u32(j) * 4u; let cb = c * 4u;
	let dvx = ldFX(A_VEL + jb) - ldFX(A_VEL + cb);
	let dvy = ldFX(A_VEL + jb + 1u) - ldFX(A_VEL + cb + 1u);
	let dvz = ldFX(A_VEL + jb + 2u) - ldFX(A_VEL + cb + 2u);
	let eb = e * 3u;
	let relN = dvx * ldFS(A_FACEN + eb) + dvy * ldFS(A_FACEN + eb + 1u) + dvz * ldFS(A_FACEN + eb + 2u);
	stFX(A_RELN + e, relN);
	stFX(A_RELT + e, dvx * ldFS(A_FACET + eb) + dvy * ldFS(A_FACET + eb + 1u) + dvz * ldFS(A_FACET + eb + 2u));
	var kind = 3u;
	if (relN < -EPS_HI) { kind = 1u; } else if (relN > EPS_HI) { kind = 2u; }
	else if (abs(relN) > EPS_LO && (old == 1u || old == 2u)) { kind = old; }
	if (kind != old) { addM(A_GTYPECHANGES, 1u); }
	stX(A_ETYPE + e, kind);
}

// polarity is memset to 0 from the queue each frame; only convergent edges write.
@compute @workgroup_size(256)
fn kPolarity(@builtin(global_invocation_id) gid: vec3<u32>) {
	let e = gid.x;
	if (e >= CELL_N * 6u) { return; }
	if (ldX(A_ETYPE + e) != 1u) { return; }
	let c = e / 6u;
	let j = ldIS(A_RING + e);
	let oi = ldIX(A_OWNER + c);
	let oj = ldIX(A_OWNER + u32(j));
	if (oi < 0 || oj < 0) { return; }
	let ocI = fMm(ldC(A_FEL + u32(oi))) < H_OCEANIC;
	let ocJ = fMm(ldC(A_FEL + u32(oj))) < H_OCEANIC;
	if (!ocI && !ocJ) { stIX(A_POL + e, 2); return; }
	var iSubducts = ocI;
	if (ocI && ocJ) {
		let ai = ldFC(A_AGE + u32(oi)); let aj = ldFC(A_AGE + u32(oj));
		iSubducts = ai > aj || (ai == aj && u32(oi) < u32(oj));
	}
	stIX(A_POL + e, iSubducts ? -1 : 1);
}

fn trenchRelax(c:u32, from:u32, to:u32) {
	if (ldX(A_TRENCH + c) != from) { return; }
	let plate = ldX(A_CELLPLATE + c);
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let j = ldIS(A_RING + c * 6u + k);
		if (ldX(A_CELLPLATE + u32(j)) != plate) { continue; }
		minUX(A_TRENCH + u32(j), to);
	}
}

// Seed pass: the overriding cell (polarity 1) and the subducting cell (polarity -1) sit at 0.
@compute @workgroup_size(256)
fn kTrenchA(@builtin(global_invocation_id) gid: vec3<u32>) {
	let e = gid.x;
	if (e >= CELL_N * 6u) { return; }
	let pol = ldIX(A_POL + e);
	if (pol == 1) { minUX(A_TRENCH + e / 6u, 0u); }
	else if (pol == -1) { minUX(A_TRENCH + u32(ldIS(A_RING + e)), 0u); }
}

@compute @workgroup_size(256)
fn kTrenchB0(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	trenchRelax(c, 0u, 1u);
}

@compute @workgroup_size(256)
fn kTrenchB1(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	trenchRelax(c, 1u, 2u);
}

@compute @workgroup_size(256)
fn kExtension(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let cb = c * 4u;
	var flux = 0.0;
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let e = c * 6u + k;
		let jb = u32(ldIS(A_RING + e)) * 4u;
		let eb = e * 3u;
		let ux = ldFX(A_U + jb) - ldFX(A_VEL + jb) - (ldFX(A_U + cb) - ldFX(A_VEL + cb));
		let uy = ldFX(A_U + jb + 1u) - ldFX(A_VEL + jb + 1u) - (ldFX(A_U + cb + 1u) - ldFX(A_VEL + cb + 1u));
		let uz = ldFX(A_U + jb + 2u) - ldFX(A_VEL + jb + 2u) - (ldFX(A_U + cb + 2u) - ldFX(A_VEL + cb + 2u));
		flux = flux + ux * ldFS(A_FLUXN + eb) + uy * ldFS(A_FLUXN + eb + 1u) + uz * ldFS(A_FLUXN + eb + 2u);
	}
	stFX(A_EXT + c, flux + K_PLUME * ldFX(A_PLUMET + c));
}
`;
};
EdgesWgsl.entry = ['kVelocities', 'kRelatives', 'kPolarity', 'kTrenchA', 'kTrenchB0', 'kTrenchB1', 'kExtension'];
if (typeof module !== 'undefined' && module.exports) module.exports = EdgesWgsl;

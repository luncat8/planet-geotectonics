/* gpu/contact.wgsl.js — K6 CONTACT scan and K7 APPLY.
   Every cross-column transfer is mark-then-gather exactly as on the CPU; the gather sorts each
   winner's loser list by column index so the sequential merge semantics match the CPU order
   (the winner's own crust test is re-read per loser, as there it can cross the ocean threshold
   mid-loop). Spawn slots come from a prefix-sum scan over gap flags plus a lowest-free-index
   list the CPU rebuilds each event cycle, so column indices stay deterministic without
   compaction. Rift donors shared by two spawning cells lose one share to each concurrently —
   the CPU serialises them; the difference is bounded by one share and booked exactly. */
var ContactWgsl = function () {
	return `// Total order on columns, ported from Contact.loser: continental beats oceanic, younger
// oceanic beats older, thicker continental beats thinner, smaller plate beats bigger.
fn contactLoser(i:u32, j:u32) -> u32 {
	let oi = fMm(ldC(A_FEL + i)) < H_OCEANIC;
	let oj = fMm(ldC(A_FEL + j)) < H_OCEANIC;
	if (oi != oj) { return select(j, i, oi); }
	if (oi) {
		let ai = ldFC(A_AGE + i); let aj = ldFC(A_AGE + j);
		if (ai != aj) { return select(j, i, ai > aj); }
		return min(i, j);
	}
	let fi = ldC(A_FEL + i); let fj = ldC(A_FEL + j);
	if (fi != fj) { return select(j, i, fi < fj); }
	let ci = ldB(A_CELLS + ldC(A_PLATE + i)); let cj = ldB(A_CELLS + ldC(A_PLATE + j));
	if (ci != cj) { return select(j, i, ci < cj); }
	return min(i, j);
}
const OCEAN_MM = u32(H_OCEANIC * CU);

// Nearest foreign column inside rContact·d that is closing in, tested on the pair's own
// relative velocity rather than the cell-edge type.
@compute @workgroup_size(256)
fn kOverlaps(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let c = ldIC(A_CELL + i);
	if (c < 0) { return; }
	let wx = ldFC(A_WORLD + i * 4u); let wy = ldFC(A_WORLD + i * 4u + 1u); let wz = ldFC(A_WORLD + i * 4u + 2u);
	var best = ldFS(A_CONTACTLIMIT2 + u32(c));
	var other = -1i;
	var bx = 0.0; var by = 0.0; var bz = 0.0;
	let own = ldC(A_PLATE + i);
	let ob = own * 4u;
	let rn = u32(ldS(A_RINGN + u32(c)));
	for (var k = 0u; k <= rn; k++) {
		var bin = u32(c);
		if (k > 0u) { bin = u32(ldIS(A_RING + u32(c) * 6u + k - 1u)); }
		let st = ldB(A_BINOFFSET + bin);
		let en = ldB(A_BINOFFSET + bin + 1u);
		for (var at = st; at < en; at++) {
			let j = ldB(A_BINENTRIES + at);
			if (j == i || ldC(A_PLATE + j) == own) { continue; }
			let ex = ldFC(A_WORLD + j * 4u) - wx;
			let ey = ldFC(A_WORLD + j * 4u + 1u) - wy;
			let ez = ldFC(A_WORLD + j * 4u + 2u) - wz;
			let d = ex * ex + ey * ey + ez * ez;
			if (d >= best || d <= 0.0) { continue; }
			let invD = 1.0 / sqrt(d);
			let p = ldC(A_PLATE + j) * 4u;
			let close = ((ldFB(A_OMEGA + p + 1u) * (wy + ey) - ldFB(A_OMEGA + p + 2u) * (wz + ez)
				- ldFB(A_OMEGA + ob + 1u) * wz + ldFB(A_OMEGA + ob + 2u) * wy) * ex
				+ (ldFB(A_OMEGA + p + 2u) * (wx + ex) - ldFB(A_OMEGA + p) * (wz + ez)
				- ldFB(A_OMEGA + ob + 2u) * wx + ldFB(A_OMEGA + ob) * wz) * ey
				+ (ldFB(A_OMEGA + p) * (wy + ey) - ldFB(A_OMEGA + p + 1u) * (wx + ex)
				- ldFB(A_OMEGA + ob) * wy + ldFB(A_OMEGA + ob + 1u) * wx) * ez) * invD;
			if (close * ldFM(A_GRADIUS) > -EPS_HI) { continue; }
			best = d; other = i32(j); bx = ex; by = ey; bz = ez;
		}
	}
	if (other < 0) { return; }
	let inv = 1.0 / sqrt(best);
	let p = ldC(A_PLATE + u32(other)) * 4u;
	let closing = ((ldFB(A_OMEGA + p + 1u) * (wy + by) - ldFB(A_OMEGA + p + 2u) * (wz + bz)
		- ldFB(A_OMEGA + ob + 1u) * wz + ldFB(A_OMEGA + ob + 2u) * wy) * bx
		+ (ldFB(A_OMEGA + p + 2u) * (wx + bx) - ldFB(A_OMEGA + p) * (wz + bz)
		- ldFB(A_OMEGA + ob + 2u) * wx + ldFB(A_OMEGA + ob) * wz) * by
		+ (ldFB(A_OMEGA + p) * (wy + by) - ldFB(A_OMEGA + p + 1u) * (wx + bx)
		- ldFB(A_OMEGA + ob) * wy + ldFB(A_OMEGA + ob + 1u) * wx) * bz) * inv;
	if (closing * ldFM(A_GRADIUS) > -EPS_HI) { return; }
	if (contactLoser(i, u32(other)) != i) { return; }
	stIC(A_CONSUMED + i, other);
	addM(A_GOVERLAPS, 1u);
}

// Gap scan: a cell empty past gapPersist that is outside rSpawn·d (or has stayed empty
// longer than fillDelay) spawns at its centre, unless a foreign plate is already in contact.
@compute @workgroup_size(256)
fn kGapScan(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	if (ldIX(A_OWNER + c) >= 0) { stX(A_GAPFRAMES + c, 0u); stFX(A_GAPTIME + c, 0.0); return; }
	var gf = ldX(A_GAPFRAMES + c);
	if (gf < 65535u) { gf = gf + 1u; }
	let gt = ldFX(A_GAPTIME + c) + ldFM(A_GDT);
	stX(A_GAPFRAMES + c, gf);
	stFX(A_GAPTIME + c, gt);
	if (gf < u32(GAP_PERSIST)) { return; }
	if (ldFX(A_DIST + c) <= ldFS(A_SPAWNLIMIT + c) && gt < FILL_DELAY) { return; }
	let px = ldFS(A_POS + c * 4u); let py = ldFS(A_POS + c * 4u + 1u); let pz = ldFS(A_POS + c * 4u + 2u);
	let h = colHash(c, u32(ldFM(A_GFRAME)));
	var best = 3.4e38;
	var near = 4294967295u;
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k <= rn; k++) {
		var bin = c;
		if (k > 0u) { bin = u32(ldIS(A_RING + c * 6u + k - 1u)); }
		let rn2 = u32(ldS(A_RINGN + bin));
		for (var k2 = 0u; k2 <= rn2; k2++) {
			var bin2 = bin;
			if (k2 > 0u) { bin2 = u32(ldIS(A_RING + bin * 6u + k2 - 1u)); }
			let st = ldB(A_BINOFFSET + bin2);
			let en = ldB(A_BINOFFSET + bin2 + 1u);
			for (var at = st; at < en; at++) {
				let j = ldB(A_BINENTRIES + at);
				let ex = ldFC(A_WORLD + j * 4u) - px;
				let ey = ldFC(A_WORLD + j * 4u + 1u) - py;
				let ez = ldFC(A_WORLD + j * 4u + 2u) - pz;
				let d = ex * ex + ey * ey + ez * ez;
				if (d > best || (d == best && (j ^ h) > (near ^ h))) { continue; }
				best = d; near = j;
			}
		}
	}
	if (near == 4294967295u) { return; }
	let plate = ldC(A_PLATE + near);
	var d0 = 3.4e38; var d1 = 3.4e38; var d2 = 3.4e38; var foreign = 3.4e38;
	var i0 = -1i; var i1 = -1i; var i2 = -1i;
	for (var k = 0u; k <= rn; k++) {
		var bin = c;
		if (k > 0u) { bin = u32(ldIS(A_RING + c * 6u + k - 1u)); }
		let rn2 = u32(ldS(A_RINGN + bin));
		for (var k2 = 0u; k2 <= rn2; k2++) {
			var bin2 = bin;
			if (k2 > 0u) { bin2 = u32(ldIS(A_RING + bin * 6u + k2 - 1u)); }
			let st = ldB(A_BINOFFSET + bin2);
			let en = ldB(A_BINOFFSET + bin2 + 1u);
			for (var at = st; at < en; at++) {
				let j = ldB(A_BINENTRIES + at);
				let ex = ldFC(A_WORLD + j * 4u) - px;
				let ey = ldFC(A_WORLD + j * 4u + 1u) - py;
				let ez = ldFC(A_WORLD + j * 4u + 2u) - pz;
				let d = ex * ex + ey * ey + ez * ez;
				if (ldC(A_PLATE + j) != plate) { foreign = min(foreign, d); continue; }
				if (d < d0) { d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = i32(j); }
				else if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i32(j); }
				else if (d < d2) { d2 = d; i2 = i32(j); }
			}
		}
	}
	if (i0 < 0 || foreign <= ldFS(A_CONTACTLIMIT2 + c)) { return; }
	stB(A_SPAWNFLAG + c, 1u);
	stX(A_GAPPLATE + c, plate);
	stIX(A_GAPDONOR + c * 3u, i0);
	stIX(A_GAPDONOR + c * 3u + 1u, i1);
	stIX(A_GAPDONOR + c * 3u + 2u, i2);
	stX(A_GAPDONORN + c, u32(i0 >= 0) + u32(i1 >= 0) + u32(i2 >= 0));
}

// A winner may itself be a loser: redirect to the root winner.
@compute @workgroup_size(256)
fn kResolve(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	var w = ldIC(A_CONSUMED + i);
	if (w < 0) { return; }
	var guard = 0u;
	loop {
		if (guard > 64u) { break; }
		let nxt = ldIC(A_CONSUMED + u32(w));
		if (nxt < 0) { break; }
		w = nxt; guard = guard + 1u;
	}
	stIC(A_CONSUMED + i, w);
}

// Losers bucketed by winner with a counting sort: count (memset from the queue), scan,
// scatter, then a per-winner insertion sort by loser index.
@compute @workgroup_size(256)
fn kGatherPrep(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	let w = ldIC(A_CONSUMED + i);
	if (w < 0) { return; }
	addB(A_GLCOUNT + u32(w), 1u);
}

@compute @workgroup_size(256)
fn kGatherScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	let w = ldIC(A_CONSUMED + i);
	if (w < 0) { return; }
	let slot = ldB(A_GLCURSOR + u32(w)) + addB(A_GLCOUNT + u32(w), 1u);
	stB(A_GLLIST + slot, i);
}

@compute @workgroup_size(64)
fn kGatherSort(@builtin(global_invocation_id) gid: vec3<u32>) {
	let w = gid.x;
	if (w >= ldM(A_GCOLHIGH)) { return; }
	let off = ldB(A_GLCURSOR + w);
	let end = off + ldB(A_GLCOUNT + w);
	var a = off + 1u;
	loop {
		if (a >= end) { break; }
		let v = ldB(A_GLLIST + a);
		var b = a;
		loop {
			if (b <= off) { break; }
			let prev = ldB(A_GLLIST + b - 1u);
			if (prev > v) { stB(A_GLLIST + b, prev); b = b - 1u; continue; }
			break;
		}
		stB(A_GLLIST + b, v);
		a = a + 1u;
	}
}

fn meanOre(w:u32, l:u32) {
	for (var k = 0u; k < 6u; k++) {
		let a = ldC(A_ORE + w * 6u + k);
		let b = ldC(A_ORE + l * 6u + k);
		stC(A_ORE + w * 6u + k, (a + b + 1u) >> 1u);
	}
}

// One thread per winner runs the CPU gather body: continental collisions preserve crust and
// delaminate the mafic root, subduction accretes felsic, scrapes the sediment share, feeds
// arcFeed, and retires the loser with its fields zeroed so a dead slot reads as empty.
@compute @workgroup_size(64)
fn kGather(@builtin(global_invocation_id) gid: vec3<u32>) {
	let w = gid.x;
	if (w >= ldM(A_GCOLHIGH)) { return; }
	let off = ldB(A_GLCURSOR + w);
	let end = off + ldB(A_GLCOUNT + w);
	if (off == end) { return; }
	for (var at = off; at < end; at++) {
		let l = ldB(A_GLLIST + at);
		let felL = ldC(A_FEL + l);
		let felW = ldC(A_FEL + w);
		if (felW >= OCEAN_MM && felL >= OCEAN_MM) {
			addC(A_FEL + w, felL);
			addC(A_SED + w, ldC(A_SED + l));
			add64(A_GLEDSUBMAFLO, A_GLEDSUBMAFHI, ldC(A_MAF + l));
			let ageW = ldFC(A_AGE + w); let ageL = ldFC(A_AGE + l);
			if (ageL > ageW) { stFC(A_AGE + w, ageL); }
			meanOre(w, l);
		} else {
			addC(A_FEL + w, felL);
			let sedL = ldC(A_SED + l);
			let keep = sedL - u32(f32(sedL) * SED_CUT);
			addC(A_SED + w, keep);
			add64(A_GLEDSUBSEDLO, A_GLEDSUBSEDHI, sedL - keep);
			add64(A_GLEDSUBMAFLO, A_GLEDSUBMAFHI, ldC(A_MAF + l));
			addM(A_GLEDSUBAREALO, 1u);
			let q = ldC(A_PLATE + w);
			// arcFeed keeps 1e-2 units: (oVms + oBas + sediment in km)·1e2 = words/1e4.
			addB(A_ARCFEED + q, (ldC(A_ORE + l * 6u) + ldC(A_ORE + l * 6u + 4u) + ldC(A_SED + l)) / 10000u);
			addB(A_ARCFEEDN + q, 1u);
		}
		stC(A_ALIVE + l, 0u);
		stIC(A_CELL + l, -1);
		stC(A_FEL + l, 0u); stC(A_MAF + l, 0u); stC(A_SED + l, 0u);
		stFC(A_DAMAGE + l, 0.0); stFC(A_FERT + l, 0.0);
		for (var k = 0u; k < 6u; k++) { stC(A_ORE + l * 6u + k, 0u); }
		addM(A_GDEATHS, 1u);
		addB(A_LOST + ldC(A_PLATE + l), 1u);
	}
}

// Cells of a deleted column are gaps for the rest of this frame.
@compute @workgroup_size(256)
fn kGatherAfter(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let o = ldIX(A_OWNER + c);
	if (o >= 0 && ldC(A_ALIVE + u32(o)) == 0u) { stIX(A_OWNER + c, -1); addM(A_GGAPS, 1u); }
}

@compute @workgroup_size(256)
fn kArcsRate(@builtin(global_invocation_id) gid: vec3<u32>) {
	let e = gid.x;
	if (e >= CELL_N * 6u) { return; }
	if (ldX(A_ETYPE + e) != 1u || ldIX(A_POL + e) != 1) { return; }
	let over = ldX(A_CELLPLATE + e / 6u);
	if (over >= u32(ldFM(A_GPLATECOUNT))) { return; }
	addIB(A_SUBRATE + over, -i32(ldFX(A_RELN + e)));
	addB(A_SUBCOUNT + over, 1u);
}

// Trench load on the boundary cells, arc crust on the cells one and two rings behind it.
@compute @workgroup_size(256)
fn kArcs(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let o = ldIX(A_OWNER + c);
	if (o < 0) { return; }
	let ob = u32(o);
	let q = ldC(A_PLATE + ob);
	var rate = 0.0;
	if (q < u32(ldFM(A_GPLATECOUNT))) {
		let n = ldB(A_SUBCOUNT + q);
		if (n > 0u) { rate = f32(ldIB(A_SUBRATE + q)) / f32(n) / V_REF; }
	}
	if (rate <= 0.0) { return; }
	let dist = ldX(A_TRENCH + c);
	let relax = ldFM(A_GRELAXDYN);
	if (dist == 0u) { addIC(A_ZDYN + ob, -toCm(Z_TRENCH * relax)); return; }
	if (dist > 2u) { return; }
	let tm = ldFM(A_GTM);
	let dh = K_ARC * tm * rate * ldFM(A_GDT);
	addC(A_FEL + ob, toMm(dh));
	addC(A_MAF + ob, toMm(ARC_MAF_SHARE * dh));
	add64(A_GLEDPRODFELLO, A_GLEDPRODFELHI, u32(dh * CU));
	add64(A_GLEDPRODMAFLO, A_GLEDPRODMAFHI, u32(ARC_MAF_SHARE * dh * CU));
	let n = ldB(A_ARCFEEDN + q);
	var feed = 0.0;
	if (n > 0u) { feed = K_REC * f32(ldIB(A_ARCFEED + q)) / 100.0 / f32(n); }
	let dose = min(1.0, K_A * tm * rate * (1.0 + feed) * ldFC(A_FERT + ob) * ldFM(A_GDT));
	addX(A_DOSEARC + ob, toOre(dose));
}

// Dose application: one read-modify-write of the potential per column per frame, so the
// saturating update stays order-free under fixed-point rounding.
@compute @workgroup_size(256)
fn kDoseArc(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= ldM(A_GCOLHIGH)) { return; }
	let d = ldX(A_DOSEARC + i);
	if (d == 0u) { return; }
	if (ldC(A_ALIVE + i) != 0u) {
		let cur = fOre(ldC(A_ORE + i * 6u + 2u));
		stC(A_ORE + i * 6u + 2u, toOre(cur + (1.0 - cur) * min(1.0, f32(d) / OU)));
	}
	stX(A_DOSEARC + i, 0u);
}

// Spawning cells allocate slots from the scan rank: the free list (lowest index first) or,
// once it runs dry mid-cycle, a bump allocator guarded by COL_CAP.
@compute @workgroup_size(256)
fn kSpawnApply(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	if (ldB(A_SPAWNFLAG + c) == 0u) { return; }
	let rank = ldB(A_SPAWNSLOT + c);
	var slot = 0u;
	if (rank < ldM(A_GFREECOUNT)) { slot = ldM(A_FREELIST + rank); }
	else { slot = addM(A_GSPAWNBUMP, 1u); }
	if (slot >= COL_CAP) { addM(A_GFINITE, 16u); return; }
	let plate = ldX(A_GAPPLATE + c);
	var K = 0u; var meanFel = 0.0;
	var dl: array<i32, 3> = array<i32, 3>(-1, -1, -1);
	let dn = ldX(A_GAPDONORN + c);
	for (var k = 0u; k < dn; k++) {
		let d = ldIX(A_GAPDONOR + c * 3u + k);
		if (d < 0 || ldC(A_ALIVE + u32(d)) == 0u) { stIX(A_GAPDONOR + c * 3u + k, -1); continue; }
		meanFel = meanFel + fMm(ldC(A_FEL + u32(d)));
		dl[K] = d;
		K = K + 1u;
	}
	let px = ldFS(A_POS + c * 4u); let py = ldFS(A_POS + c * 4u + 1u); let pz = ldFS(A_POS + c * 4u + 2u);
	let p4 = plate * 4u;
	let qx = -ldFB(A_Q + p4); let qy = -ldFB(A_Q + p4 + 1u); let qz = -ldFB(A_Q + p4 + 2u); let qw = ldFB(A_Q + p4 + 3u);
	let tx = 2.0 * (qy * pz - qz * py);
	let ty = 2.0 * (qz * px - qx * pz);
	let tz = 2.0 * (qx * py - qy * px);
	stFC(A_BODY + slot * 4u, px + qw * tx + qy * tz - qz * ty);
	stFC(A_BODY + slot * 4u + 1u, py + qw * ty + qz * tx - qx * tz);
	stFC(A_BODY + slot * 4u + 2u, pz + qw * tz + qx * ty - qy * tx);
	stFC(A_WORLD + slot * 4u, px);
	stFC(A_WORLD + slot * 4u + 1u, py);
	stFC(A_WORLD + slot * 4u + 2u, pz);
	stC(A_PLATE + slot, plate);
	stIC(A_CELL + slot, i32(c));
	stFC(A_AREA + slot, ldFS(A_POS + c * 4u + 3u));
	addB(A_SPAWNED + plate, 1u);
	stFC(A_AGE + slot, 0.0);
	stIC(A_ZDYN + slot, 0);
	stC(A_ALIVE + slot, 1u);
	stIC(A_CONSUMED + slot, -1);
	let fert = FERT_LO + (1.0 - FERT_LO) * f32(colHash(c, u32(ldFM(A_GFRAME))) >> 8u) / 16777215.0;
	stFC(A_FERT + slot, fert);
	for (var k = 0u; k < 6u; k++) { stC(A_ORE + slot * 6u + k, 0u); }
	if (K == 0u || meanFel / f32(K) < H_RIFT_BREAKUP) {
		// Oceanic crust from the mantle; donors keep their crust untouched.
		stC(A_FEL + slot, 0u);
		stC(A_SED + slot, 0u);
		let mafU = toMm(7000.0 * (1.0 + 1.5 * max(0.0, ldFM(A_GTM) - 1.0)));
		stC(A_MAF + slot, mafU);
		stFC(A_DAMAGE + slot, 0.0);
		add64(A_GLEDPRODMAFLO, A_GLEDPRODMAFHI, mafU);
		var spread = 0.0;
		let rn = u32(ldS(A_RINGN + c));
		for (var k = 0u; k <= rn; k++) {
			var bin = c;
			if (k > 0u) { bin = u32(ldIS(A_RING + c * 6u + k - 1u)); }
			let rn2 = u32(ldS(A_RINGN + bin));
			for (var j = 0u; j < rn2; j++) {
				let e = bin * 6u + j;
				if (ldX(A_ETYPE + e) == 2u) { spread = max(spread, ldFX(A_RELN + e)); }
			}
		}
		stC(A_ORE + slot * 6u, toOre(K_V * ldFM(A_GTM) * min(1.0, spread / V_REF) * fert));
	} else {
		// Rifting stretches existing crust: the newborn takes 1/(K+1) of each donor.
		let share = 1.0 / (f32(K) + 1.0);
		var newFel = 0.0; var newSed = 0.0;
		for (var k = 0u; k < K; k++) {
			let d = u32(dl[k]);
			let giveFel = share * fMm(ldC(A_FEL + d));
			let giveSed = share * fMm(ldC(A_SED + d));
			newFel = newFel + giveFel; newSed = newSed + giveSed;
			subC(A_FEL + d, toMm(giveFel));
			subC(A_SED + d, toMm(giveSed));
		}
		stC(A_FEL + slot, toMm(newFel));
		stC(A_SED + slot, toMm(newSed));
		stC(A_MAF + slot, 0u);
		stFC(A_DAMAGE + slot, RIFT_DAMAGE);
		stC(A_ORE + slot * 6u + 1u, toOre(K_M2 * fert));
	}
	addM(A_GSPAWNS, 1u);
	maxUM(A_GCOLHIGH, slot + 1u);
	stB(A_SPAWNSLOT + c, slot);
}
`;
};
ContactWgsl.entry = ['kOverlaps', 'kGapScan', 'kResolve', 'kGatherPrep', 'kGatherScatter', 'kGatherSort', 'kGather', 'kGatherAfter', 'kArcsRate', 'kArcs', 'kDoseArc', 'kSpawnApply'];
if (typeof module !== 'undefined' && module.exports) module.exports = ContactWgsl;

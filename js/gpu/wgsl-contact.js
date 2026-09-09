/* wgsl-contact.js - K6 scan (overlaps, gaps) and K7 apply (resolve, counting-sort gather,
   arcs, spawn, donor thinning). Every cross-column transfer is a per-writer mark plus a
   per-owner pull, so no state-path write races and no atomics are needed on the columns.
   Rift-zone and belt marks ride in spare bits of the scan input region (cleared each
   frame by zeroFrame): bit 31 rift, bit 30 belt. */
var ContactWGSL = [
{
	name: 'overlaps', groups: ['gridF', 'gridI', 'colF', 'colI', 'plateF', 'bins', 'frameOut'],
	code: `
// The nearest foreign column inside rContact·d that is closing in. The pair's own relative
// velocity is the test, not the cell-edge type.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	COLI[i * 4u + 2u] = -1;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let c = colCell(i);
	if (c < 0) { return; }
	let wi = colWorld(i);
	var best = contactLimit2(u32(c));
	var other = -1;
	var dvec = vec3<f32>(0.0);
	let own = colPlate(i);
	for (var k = 0u; k <= ringN(u32(c)); k = k + 1u) {
		var bin = u32(c);
		if (k > 0u) { bin = u32(ringAt(u32(c) * 6u + k - 1u)); }
		let begin = binOffset(bin);
		let end = binEnd(bin);
		for (var at = begin; at < end; at = at + 1) {
			let j = u32(binEntry(u32(at)));
			if (j == i || colPlate(j) == own) { continue; }
			let ex = colWorld(j) - wi;
			let d = dot(ex, ex);
			// Total order (d, index): exact distance ties must go to the lower column index,
			// matching the CPU's index-ordered bin fill - otherwise the atomic bin order
			// decides who consumes whom and repeat runs diverge.
			if (d <= 0.0 || d > best || (d == best && (other < 0 || j > u32(other)))) { continue; }
			let invD = 1.0 / sqrt(d);
			let n = ex * invD;
			let closing = dot(cross(plateOmega(u32(colPlate(j))), colWorld(j))
				- cross(plateOmega(u32(own)), wi), n);
			if (R * closing > -P_EPSHI) { continue; }
			best = d;
			other = i32(j);
			dvec = ex;
		}
	}
	if (other < 0) { return; }
	let inv = 1.0 / sqrt(best);
	// The exact CPU expression: (ω_j × w_j − ω_i × w_i) · n, n = (w_j − w_i)/|w_j − w_i|.
	let rel = cross(plateOmega(u32(colPlate(u32(other)))), colWorld(u32(other))) - cross(plateOmega(u32(own)), wi);
	let closing = dot(rel, dvec * inv);
	if (R * closing > -P_EPSHI) { return; }
	if (loserIdx(i, u32(other)) != i) { return; }
	COLI[i * 4u + 2u] = other;
	addOverlap();
}

// Total order on columns so "loses to" is transitive and chains cannot cycle.
fn loserIdx(i: u32, j: u32) -> u32 {
	let oi = colHFel(i) < P_HOCEANIC;
	let oj = colHFel(j) < P_HOCEANIC;
	if (oi != oj) { return select(j, i, oi); }
	if (oi) {
		if (colAge(i) != colAge(j)) { return select(j, i, colAge(i) > colAge(j)); }
		return select(j, i, i < j);
	}
	if (colHFel(i) != colHFel(j)) { return select(j, i, colHFel(i) < colHFel(j)); }
	let ci = plateCells(u32(colPlate(i)));
	let cj = plateCells(u32(colPlate(j)));
	if (ci != cj) { return select(j, i, ci < cj); }
	return select(j, i, i < j);
}
`
},
{
	name: 'gaps', groups: ['gridF', 'gridI', 'colF', 'colI', 'cellI', 'bins', 'frameIn'],
	code: `
// A cell uncovered for gapPersist frames spawns one column at its centre once it is
// empty by rSpawn (or far beyond fillDelay: a packing hole in fresh crust gets filled).
// Two-hop candidates are collected unique, in the same first-occurrence order as the CPU.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	setCellSpawnSlot(c, -1);
	if (cellOwner(c) >= 0) {
		setCellPacked(c, packCell(cellTrenchDist(c), 0u));
		setCellGapTime(c, 0.0);
		return;
	}
	let frames = min(cellGapFrames(c) + 1u, 65535u);
	setCellGapTime(c, cellGapTime(c) + fDT());
	if (frames < P_GAPFRAMES) { setCellPacked(c, packCell(cellTrenchDist(c), frames)); return; }
	setCellPacked(c, packCell(cellTrenchDist(c), frames));
	let distFP = CELLI[c * CS + 9u];
	if (distFP <= spawnLimitFP(c) && cellGapTime(c) < P_FILLDELAY) { return; }
	let p3 = cellPos(c);
	let h = hashCell(c, fFrame());
	var list: array<i32, 48>;
	var n = 0u;
	collectTwoHop(c, &list, &n);
	// Nearest column overall with the frame hash as tie-break.
	var best = 3.0e38;
	var near = -1;
	for (var q = 0u; q < n; q = q + 1u) {
		let bin = u32(list[q]);
		let begin = binOffset(bin);
		let end = binEnd(bin);
		for (var at = begin; at < end; at = at + 1) {
			let j = u32(binEntry(u32(at)));
			let dv = colWorld(j) - p3;
			let d = dot(dv, dv);
			if (d > best || (d == best && (j ^ h) > (u32(max(near, 0)) ^ h))) { continue; }
			best = d;
			near = i32(j);
		}
	}
	if (near < 0) { return; }
	let plate = colPlate(u32(near));
	// Nearest three same-plate donors and the nearest foreign column.
	var d0 = 3.0e38; var i0 = -1;
	var d1 = 3.0e38; var i1 = -1;
	var d2 = 3.0e38; var i2 = -1;
	var foreign = 3.0e38;
	for (var q2 = 0u; q2 < n; q2 = q2 + 1u) {
		let bin2 = u32(list[q2]);
		let begin2 = binOffset(bin2);
		let end2 = binEnd(bin2);
		for (var at2 = begin2; at2 < end2; at2 = at2 + 1) {
			let j2 = u32(binEntry(u32(at2)));
			let dv2 = colWorld(j2) - p3;
			let d = dot(dv2, dv2);
			if (colPlate(j2) != plate) {
				if (d < foreign) { foreign = d; }
				continue;
			}
			if (d < d0 || (d == d0 && i32(j2) < i0)) {
				d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = i32(j2);
			} else if (d < d1 || (d == d1 && i32(j2) < i1)) {
				d2 = d1; i2 = i1; d1 = d; i1 = i32(j2);
			} else if (d < d2 || (d == d2 && i32(j2) < i2)) {
				d2 = d; i2 = i32(j2);
			}
		}
	}
	if (i0 < 0 || foreign <= contactLimit2(c)) { return; }
	setCellSpawnSlot(c, -2);
	setCellGapPlate(c, plate);
	setCellGapDonor(c, 0u, i0);
	setCellGapDonor(c, 1u, i1);
	setCellGapDonor(c, 2u, i2);
	setCellGapDonorN(c, 0);
}

// Cells within two hops, unique, first-occurrence order (matches Contact.ringCells).
fn collectTwoHop(c: u32, out: ptr<function, array<i32, 48>>, n: ptr<function, u32>) {
	var m = 0u;
	(*out)[m] = i32(c);
	m = m + 1u;
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let j = ringAt(c * 6u + k);
		addUnique(out, &m, j);
		for (var k2 = 0u; k2 < ringN(u32(j)); k2 = k2 + 1u) {
			addUnique(out, &m, ringAt(u32(j) * 6u + k2));
		}
	}
	*n = m;
}

fn addUnique(out: ptr<function, array<i32, 48>>, m: ptr<function, u32>, v: i32) {
	if (v < 0) { return; }
	for (var q = 0u; q < *m; q = q + 1u) {
		if ((*out)[q] == v) { return; }
	}
	if (*m < 48u) {
		(*out)[*m] = v;
		*m = *m + 1u;
	}
}
`
},
{
	name: 'resolve', groups: ['colI', 'frameOut'],
	code: `
// A winner may itself be a loser: redirect to the root winner. One pass of pointer
// jumping; the dispatcher runs it enough times for the longest chain (2^6).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN()) { return; }
	let w = colConsumed(i);
	if (w < 0) { return; }
	let ww = colConsumed(u32(w));
	if (ww >= 0) { COLI[i * 4u + 2u] = ww; }
}
`
},
{
	name: 'loserZero', groups: ['scanAlone'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (gid.x < COLCAP) { atomicStore(&SCAN[gid.x], 0); }
}
`
},
{
	name: 'loserCount', groups: ['colI', 'scanAlone', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN()) { return; }
	let w = colConsumed(i);
	if (w >= 0) { atomicAdd(&SCAN[u32(w)], 1); }
}
`
},
{
	name: 'loserRank', groups: ['colI', 'scanAlone', 'lose', 'frameOut'],
	code: `
// Rank a loser among its winner's losers by index: the counting-sort position the CPU
// gets from a cursor, computed here as a sum (integers, order-free).
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN()) { return; }
	let w = colConsumed(i);
	if (w < 0) { return; }
	var rank = 0;
	let n = aliveN();
	for (var j = 0u; j < n; j = j + 1u) {
		if (j < i && colConsumed(j) == w) { rank = rank + 1; }
	}
	setLoseList(u32(scanOut(u32(w)) + rank), i32(i));
}
`
},
{
	name: 'gather', groups: ['colF', 'colI', 'scanAlone', 'lose', 'reduce', 'frameOut'],
	code: `
// Winners pull from their losers in list order. The sequential ore averaging and the
// per-winner arc feed are exactly the CPU loop; losers are zeroed so a dead slot reads
// empty to spawn and diagnostics.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let w = gid.x;
	if (w >= aliveN()) { return; }
	let begin = scanOut(w);
	let end = scanOut(w + 1u);
	if (end <= begin) { setLoseWFeed(w, 0.0); setLoseWCount(w, 0); return; }
	var hFel = colHFel(w);
	var hSed = colHSed(w);
	var age = colAge(w);
	var oVms = colOVms(w);
	var oMaf = colOMaf(w);
	var oArc = colOArc(w);
	var oOro = colOOro(w);
	var oBas = colOBas(w);
	var oPla = colOPla(w);
	var feed = 0.0;
	var fcount = 0;
	for (var at = begin; at < end; at = at + 1) {
		let l = u32(loseList(u32(at)));
		if (hFel >= P_HOCEANIC && colHFel(l) >= P_HOCEANIC) {
			// Continental collision: crust is preserved, the mafic root delaminates.
			hFel = hFel + colHFel(l);
			hSed = hSed + colHSed(l);
			addLedger(4u, l, colHMaf(l) * A0REF);
			if (colAge(l) > age) { age = colAge(l); }
			oVms = 0.5 * (oVms + colOVms(l));
			oMaf = 0.5 * (oMaf + colOMaf(l));
			oArc = 0.5 * (oArc + colOArc(l));
			oOro = 0.5 * (oOro + colOOro(l));
			oBas = 0.5 * (oBas + colOBas(l));
			oPla = 0.5 * (oPla + colOPla(l));
		} else {
			// Felsic crust accretes onto the overriding plate; the rest goes down the trench
			// and is booked as that plate's arc feed (design §8 recycling enrichment).
			hFel = hFel + colHFel(l);
			hSed = hSed + P_SEDSCRAPE * colHSed(l);
			addLedger(5u, l, (1.0 - P_SEDSCRAPE) * colHSed(l) * A0REF);
			addLedger(4u, l, colHMaf(l) * A0REF);
			addLedger(6u, l, A0REF);
			feed = feed + colOVms(l) + colOBas(l) + colHSed(l) / 1000.0;
			fcount = fcount + 1;
		}
		COLI[l * 4u + 3u] = 0;
		COLI[l * 4u + 1u] = -1;
		COLF[l * 6u + 1u].w = 0.0;
		COLF[l * 6u + 2u] = vec4<f32>(0.0, 0.0, colAge(l), 0.0);
		COLF[l * 6u + 3u] = vec4<f32>(0.0);
		COLF[l * 6u + 4u] = vec4<f32>(0.0, 0.0, 0.0, colZDyn(l));
		addDeath();
		addLost(u32(colPlate(l)));
	}
	setColHFel(w, hFel);
	COLF[w * 6u + 2u].y = hSed;
	COLF[w * 6u + 2u].z = age;
	COLF[w * 6u + 3u].y = oVms;
	COLF[w * 6u + 3u].z = oMaf;
	COLF[w * 6u + 3u].w = oArc;
	COLF[w * 6u + 4u].x = oOro;
	COLF[w * 6u + 4u].y = oBas;
	COLF[w * 6u + 4u].z = oPla;
	setLoseWFeed(w, feed);
	setLoseWCount(w, fcount);
}
`
},
{
	name: 'ownerClear', groups: ['cellI', 'colI', 'frameOut'],
	code: `
// Cells of a deleted column are gaps for the rest of this frame; the next raster gives
// them to the winner. A one-frame gap never reaches the spawn threshold.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let o = cellOwner(c);
	if (o >= 0 && colAlive(u32(o)) == 0) { setCellOwner(c, -1); }
}
`
},
{
	name: 'winners', groups: ['plateF', 'colI', 'lose', 'frameIn', 'frameOut'],
	code: `
// Per-plate arc feed: sum the winners' feeds (ascending column order) into the plate.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= fPlates()) { return; }
	var feed = 0.0;
	var count = 0;
	let n = aliveN();
	for (var w = 0u; w < n; w = w + 1u) {
		if (colPlate(w) != i32(p)) { continue; }
		if (loseWCount(w) <= 0) { continue; }
		feed = feed + loseWFeed(w);
		count = count + loseWCount(w);
	}
	setPlateArcFeed(p, feed);
	if (count > 0) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u + 2u], count); }
}
`
},
{
	name: 'subRateA', groups: ['cellI', 'edges', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Mean closing speed per overriding plate: partial sums per workgroup over edge chunks.
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
	let p = li.x;
	if (p >= fPlates()) { return; }
	var sum = 0.0;
	let begin = wg.x * CHUNK10E;
	let end = min(begin + CHUNK10E, V * 6u);
	for (var e = begin; e < end; e = e + 1u) {
		if (edgeType(e) != E_CONV || edgePol(e) != 1) { continue; }
		let c = e / 6u;
		if (cellPlateOf(c) != i32(p)) { continue; }
		sum = sum - edgeRelN(e);
		addSubCount(p);
	}
	RED[RED_SUB + (wg.x * PLATECAP + p)] = sum;
}
`
},
{
	name: 'subRateB', groups: ['plateF', 'reduce', 'frameIn', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let p = gid.x;
	if (p >= fPlates()) { return; }
	var sum = 0.0;
	for (var wg = 0u; wg < NWG10; wg = wg + 1u) {
		sum = sum + RED[RED_SUB + (wg * PLATECAP + p)];
	}
	let cnt = subCount(p);
	setPlateSubRate(p, select(0.0, sum / f32(cnt), cnt > 0));
}
`
},
{
	name: 'arcs', groups: ['gridI', 'colF', 'colI', 'cellI', 'plateF', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Subduction feeds the overriding plate: trench load on boundary cells, arc crust one
// and two rings behind, per-column gather over the cells raster can own.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let q = colPlate(i);
	if (q >= i32(fPlates())) { return; }
	let rate = plateSubRate(u32(q)) / P_VREF;
	if (rate <= 0.0) { return; }
	let cell = colCell(i);
	if (cell < 0) { return; }
	let fed = arcFeedN(u32(q));
	let feed = select(0.0, P_KREC * plateArcFeed(u32(q)) / f32(fed), fed > 0);
	let relax = min(1.0, fDT() / P_TAUDYN);
	var hFel = colHFel(i);
	var hMaf = colHMaf(i);
	var zDyn = colZDyn(i);
	var oArc = colOArc(i);
	for (var k = 0u; k <= ringN(u32(cell)); k = k + 1u) {
		var c = u32(cell);
		if (k > 0u) { c = u32(ringAt(u32(cell) * 6u + k - 1u)); }
		if (cellOwner(c) != i32(i)) { continue; }
		let dist = cellTrenchDist(c);
		if (dist == 0) { zDyn = zDyn - P_ZTRENCH * relax; continue; }
		if (dist > 2) { continue; }
		let dh = P_KARC * fTM() * rate * fDT();
		hFel = hFel + dh;
		hMaf = hMaf + P_ARCMAF * dh;
		addLedger(0u, i, dh * A0REF);
		addLedger(1u, i, P_ARCMAF * dh * A0REF);
		oArc = oArc + (1.0 - oArc) * min(1.0, P_KA * fTM() * rate * (1.0 + feed) * colFert(i) * fDT());
	}
	setColHFel(i, hFel);
	COLF[i * 6u + 2u].x = hMaf;
	COLF[i * 6u + 4u].w = zDyn;
	COLF[i * 6u + 3u].w = oArc;
}
`
},
{
	name: 'spawnFlags', groups: ['cellI', 'scanAlone'],
	code: `
// Spawn intents (marked -2 by gaps) become scan flags. This runs after the bins scan
// regions are dead, so the input region is reused sequentially within the frame.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	atomicStore(&SCAN[c], select(0, 1, cellSpawnSlot(c) == -2));
}
`
},
{
	name: 'riftMark', groups: ['gridI', 'cellI', 'scanAlone'],
	code: `
// Mark the two-hop reach of every spawn intent in scan bit 31, so the donor-side
// thinning gather only walks columns near an open rift (all intents: oceanic ones are
// filtered later by their gapDonorN sentinel).
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	if (cellSpawnSlot(c) < 0) { return; }
	var list: array<i32, 48>;
	var n = 0u;
	collectTwoHop(c, &list, &n);
	for (var q = 0u; q < n; q = q + 1u) {
		atomicOr(&SCAN[u32(list[q])], bitcast<i32>(0x80000000u));
	}
}

fn collectTwoHop(c: u32, out: ptr<function, array<i32, 48>>, n: ptr<function, u32>) {
	var m = 0u;
	(*out)[m] = i32(c);
	m = m + 1u;
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let j = ringAt(c * 6u + k);
		addUnique(out, &m, j);
		for (var k2 = 0u; k2 < ringN(u32(j)); k2 = k2 + 1u) {
			addUnique(out, &m, ringAt(u32(j) * 6u + k2));
		}
	}
	*n = m;
}

fn addUnique(out: ptr<function, array<i32, 48>>, m: ptr<function, u32>, v: i32) {
	if (v < 0) { return; }
	for (var q = 0u; q < *m; q = q + 1u) {
		if ((*out)[q] == v) { return; }
	}
	if (*m < 48u) {
		(*out)[*m] = v;
		*m = *m + 1u;
	}
}
`
},
{
	name: 'spawn', groups: ['gridF', 'gridI', 'colF', 'colI', 'cellI', 'plateF', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Newborn columns: oceanic crust from the mantle, or a 1/(K+1) share of each surviving
// donor's pre-thinning stock. The donors' losses are a separate gather (thinning), so
// no newborn writes a donor and the rift ledger stays exact.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let slot = cellSpawnSlot(c);
	if (slot < 0) { return; }
	var donors: array<i32, 3>;
	var K = 0;
	var meanFel = 0.0;
	for (var k = 0u; k < 3u; k = k + 1u) {
		let d = cellGapDonor(c, k);
		if (d < 0 || colAlive(u32(d)) == 0) { continue; }
		donors[K] = d;
		K = K + 1;
		meanFel = meanFel + colHFel(u32(d));
	}
	let plate = cellGapPlate(c);
	let i = u32(slot);
	let pos = cellPos(c);
	let hsh = hashCell(c, fFrame());
	let fert = P_FERTLO + (1.0 - P_FERTLO) * f32(hsh >> 8) / 0xffffff;
	COLF[i * 6u] = vec4<f32>(qrotInv(plateQ(u32(plate)), pos), cellArea(c));
	COLF[i * 6u + 1u] = vec4<f32>(pos, 0.0);
	COLI[i * 4u] = plate;
	COLI[i * 4u + 1u] = i32(c);
	COLI[i * 4u + 2u] = -1;
	COLI[i * 4u + 3u] = 1;
	COLF[i * 6u + 2u] = vec4<f32>(0.0);
	COLF[i * 6u + 4u] = vec4<f32>(0.0);
	COLF[i * 6u + 3u] = vec4<f32>(fert, 0.0, 0.0, 0.0);
	addSpawned(u32(plate));
	if (K == 0 || meanFel / f32(K) < P_HRIFT) {
		// Oceanic crust from the mantle; donors keep their crust. VMS is a one-shot at
		// birth scaled by the spreading rate the ridge flanks are opening at.
		setCellGapDonorN(c, 255);
		let hMaf = 7000.0 * (1.0 + 1.5 * max(0.0, fTM() - 1.0));
		COLF[i * 6u + 2u].x = hMaf;
		addLedger(1u, i, hMaf * A0REF);
		COLF[i * 6u + 3u].y = P_KV * fTM() * min(1.0, cellSpread(c) / P_VREF) * fert;
		return;
	}
	setCellGapDonorN(c, K);
	var newFel = 0.0;
	var newSed = 0.0;
	let share = 1.0 / f32(K + 1);
	for (var k2 = 0; k2 < K; k2 = k2 + 1) {
		let d2 = u32(donors[k2]);
		newFel = newFel + share * colHFel(d2);
		newSed = newSed + share * colHSed(d2);
	}
	COLF[i * 6u + 1u].w = newFel;
	COLF[i * 6u + 2u].y = newSed;
	COLF[i * 6u + 2u].w = P_RIFTDAMAGE;
	COLF[i * 6u + 3u].z = P_KM2 * fert;
}
`
},
{
	name: 'thinning', groups: ['gridI', 'colF', 'colI', 'cellI', 'scanAlone', 'frameOut'],
	code: `
// Donor side of rifting: a donor gives a share to every newborn request that picked it,
// gathered over the two-hop candidate set (unique cells, so one request is charged once).
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let cell = colCell(i);
	if (cell < 0) { return; }
	if ((atomicLoad(&SCAN[u32(cell)]) & bitcast<i32>(0x80000000u)) == 0) { return; }
	var list: array<i32, 48>;
	var n = 0u;
	collectTwoHop(u32(cell), &list, &n);
	var lossFel = 0.0;
	var lossSed = 0.0;
	for (var q = 0u; q < n; q = q + 1u) {
		let c = u32(list[q]);
		let gn = cellGapDonorN(c);
		if (cellSpawnSlot(c) < 0 || gn == 255 || gn <= 0) { continue; }
		var gives = false;
		for (var k = 0u; k < 3u; k = k + 1u) {
			if (cellGapDonor(c, k) == i32(i)) { gives = true; }
		}
		if (!gives) { continue; }
		let share = 1.0 / f32(gn + 1);
		lossFel = lossFel + colHFel(i) * share;
		lossSed = lossSed + colHSed(i) * share;
	}
	if (lossFel > 0.0) {
		setColHFel(i, colHFel(i) - lossFel);
		COLF[i * 6u + 2u].y = colHSed(i) - lossSed;
	}
}

fn collectTwoHop(c: u32, out: ptr<function, array<i32, 48>>, n: ptr<function, u32>) {
	var m = 0u;
	(*out)[m] = i32(c);
	m = m + 1u;
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let j = ringAt(c * 6u + k);
		addUnique(out, &m, j);
		for (var k2 = 0u; k2 < ringN(u32(j)); k2 = k2 + 1u) {
			addUnique(out, &m, ringAt(u32(j) * 6u + k2));
		}
	}
	*n = m;
}

fn addUnique(out: ptr<function, array<i32, 48>>, m: ptr<function, u32>, v: i32) {
	if (v < 0) { return; }
	for (var q = 0u; q < *m; q = q + 1u) {
		if ((*out)[q] == v) { return; }
	}
	if (*m < 48u) {
		(*out)[*m] = v;
		*m = *m + 1u;
	}
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = ContactWGSL;

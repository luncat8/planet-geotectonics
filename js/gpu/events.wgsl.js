/* gpu/events.wgsl.js — the GPU half of the event cycle (the decisions stay on the CPU).
   kCensus recounts plateCells and fills the fixed-point pair tables from this frame's boundary
   state; kSums reduces the mass and ore diagnostics into u64 pairs for the event readback.
   A_CELLS and A_PAIROK are memset from the queue before these run (fill(0)/fill(1) on CPU). */
var EventsWgsl = function () {
	return `fn suturing(e:u32, speed:f32) -> bool {
	let t = ldX(A_ETYPE + e);
	if (t == 1u) { return ldIX(A_POL + e) == 2; }
	if (t == 3u) { return speed < V_SUTURE; }
	return false;
}

@compute @workgroup_size(256)
fn kCensus(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let nP = u32(ldFM(A_GPLATECOUNT));
	let pi = ldX(A_CELLPLATE + c);
	if (pi >= nP) { return; }
	addB(A_CELLS + pi, 1u);
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k < rn; k++) {
		let e = c * 6u + k;
		let j = ldIS(A_RING + e);
		let pj = ldX(A_CELLPLATE + u32(j));
		if (pj >= nP || pj == pi) { continue; }
		let slot = min(pi, pj) * PLATE_CAP + max(pi, pj);
		let len = ldFS(A_EDGELEN + e);
		let relN = ldFX(A_RELN + e);
		let relT = ldFX(A_RELT + e);
		let v = sqrt(relN * relN + relT * relT);
		addB(A_PAIRLEN + slot, u32(len + 0.5));
		addB(A_PAIRVEL + slot, u32(v * len / 1000.0 + 0.5));
		if (!suturing(e, v)) { stB(A_PAIROK + slot, 0u); }
	}
}

@compute @workgroup_size(256)
fn kSums(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i < CELL_N) { add64(A_GMASSSEDLO, A_GMASSSEDHI, ldX(A_MOBILE + i)); }
	if (i >= ldM(A_GCOLHIGH) || ldC(A_ALIVE + i) == 0u) { return; }
	add64(A_GMASSFELLO, A_GMASSFELHI, ldC(A_FEL + i));
	add64(A_GMASSMAFLO, A_GMASSMAFHI, ldC(A_MAF + i));
	add64(A_GMASSSEDLO, A_GMASSSEDHI, ldC(A_SED + i));
	for (var k = 0u; k < 6u; k++) {
		add64(A_GORESUMLO0 + k * 2u, A_GORESUMHI0 + k * 2u, ldC(A_ORE + i * 6u + k));
	}
}
`;
};
EventsWgsl.entry = ['kCensus', 'kSums'];
if (typeof module !== 'undefined' && module.exports) module.exports = EventsWgsl;

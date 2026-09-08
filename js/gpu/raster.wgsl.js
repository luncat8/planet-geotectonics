/* gpu/raster.wgsl.js — K4 RASTER: one thread per cell walks its own bin plus the ring bins and
   picks the nearest column by the CPU's total order (distance, then smaller column index), so
   ties resolve identically. Distance is stored in metres; gap cells report the background. */
var RasterWgsl = function () {
	return `@compute @workgroup_size(256)
fn kRaster(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let px = ldFS(A_POS + c * 4u);
	let py = ldFS(A_POS + c * 4u + 1u);
	let pz = ldFS(A_POS + c * 4u + 2u);
	var best = 3.4e38;
	var owner = -1i;
	let rn = u32(ldS(A_RINGN + c));
	for (var k = 0u; k <= rn; k++) {
		var bin = c;
		if (k > 0u) { bin = u32(ldIS(A_RING + c * 6u + k - 1u)); }
		let st = ldB(A_BINOFFSET + bin);
		let en = ldB(A_BINOFFSET + bin + 1u);
		for (var at = st; at < en; at++) {
			let i = ldB(A_BINENTRIES + at);
			let ex = ldFC(A_WORLD + i * 4u) - px;
			let ey = ldFC(A_WORLD + i * 4u + 1u) - py;
			let ez = ldFC(A_WORLD + i * 4u + 2u) - pz;
			let d = ex * ex + ey * ey + ez * ez;
			if (d > best || (d == best && owner >= 0 && i > u32(owner))) { continue; }
			best = d;
			owner = i32(i);
		}
	}
	if (best > ldFS(A_GAPLIMIT2 + c)) { owner = -1i; }
	stIX(A_OWNER + c, owner);
	stFX(A_DIST + c, sqrt(best) * ldFM(A_GRADIUS));
	if (owner < 0) {
		stX(A_CELLPLATE + c, 65535u);
		addM(A_GGAPS, 1u);
	} else {
		stX(A_CELLPLATE + c, ldC(A_PLATE + u32(owner)));
	}
}
`;
};
RasterWgsl.entry = ['kRaster'];
if (typeof module !== 'undefined' && module.exports) module.exports = RasterWgsl;

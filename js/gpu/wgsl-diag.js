/* wgsl-diag.js - K11 plus the per-frame atomics reset. diagA/diagC write one partial row
   per workgroup (thread 0 walks its chunk sequentially, so partials are deterministic by
   construction); diagB folds them in order. ledgerCommit folds the frame's exact
   fixed-point deltas into 64-bit lo/hi pairs and clears them for the next frame. */
var DiagWGSL = [
{
	name: 'zeroFrame', groups: ['scanAlone', 'reduce', 'frameOut'],
	code: `
// Runs first every frame: per-frame counters, the per-plate cells/subCount/arcFeedN
// atomics, and the scan input region (which also clears the belt and rift mark bits —
// spawnFlags overwrites the region again before the spawn scan).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let t = gid.x;
	if (t < 6u) {
		atomicStore(&FOUT[t + 1u], 0);
	} else if (t < 6u + PLATECAP * 3u) {
		let u = t - 6u;
		atomicStore(&FOUT[FO_PLATE0 + (u / 3u) * 5u + u % 3u], 0);
	} else if (t < 6u + PLATECAP * 3u + COLCAP) {
		let c = t - 6u - PLATECAP * 3u;
		atomicStore(&SCAN[c], 0);
	} else {
		let d = t - 6u - PLATECAP * 3u - COLCAP;
		if (d < 7u * COLCAP) { RED[RED_LEDGER + d] = 0.0; }
	}
}
`
},
{
	name: 'diagA', groups: ['plateF', 'colF', 'colI', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Column partials: quat/rigid error, finite flag, mass and ore sums, alive count.
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let wg = gid.x;
	var qErr = 0.0;
	var rigid2 = 0.0;
	var fel = 0.0;
	var maf = 0.0;
	var sed = 0.0;
	var o0 = 0.0; var o1 = 0.0; var o2 = 0.0;
	var o3 = 0.0; var o4 = 0.0; var o5 = 0.0;
	var count = 0.0;
	let begin = wg * CHUNKD;
	let end = min(begin + CHUNKD, COLCAP);
	for (var i = begin; i < end; i = i + 1u) {
		if (colAlive(i) == 0) { continue; }
		let plate = colPlate(i);
		if (plate >= i32(fPlates())) { markBad(); }
		let q = plateQ(u32(plate));
		let nq = length(q);
		qErr = max(qErr, abs(nq - 1.0));
		let om = plateOmega(u32(plate));
		if (isNanF(nq) || isNanF(om.x) || isNanF(om.y) || isNanF(om.z)) { markBad(); }
		let d = qrot(q, colBody(i)) - colWorld(i);
		rigid2 = max(rigid2, dot(d, d));
		fel = fel + colHFel(i);
		maf = maf + colHMaf(i);
		sed = sed + colHSed(i);
		o0 = o0 + colOVms(i); o1 = o1 + colOMaf(i); o2 = o2 + colOArc(i);
		o3 = o3 + colOOro(i); o4 = o4 + colOBas(i); o5 = o5 + colOPla(i);
		count = count + 1.0;
		if (colOVms(i) > 1.0 || colOMaf(i) > 1.0 || colOArc(i) > 1.0
			|| colOOro(i) > 1.0 || colOBas(i) > 1.0 || colOPla(i) > 1.0) { markBad(); }
	}
	let base = RED_DIAGCOL + wg * 12u;
	RED[base] = qErr; RED[base + 1u] = rigid2;
	RED[base + 2u] = fel; RED[base + 3u] = maf; RED[base + 4u] = sed;
	RED[base + 5u] = o0; RED[base + 6u] = o1; RED[base + 7u] = o2;
	RED[base + 8u] = o3; RED[base + 9u] = o4; RED[base + 10u] = o5;
	RED[base + 11u] = count;
}
`
},
{
	name: 'diagC', groups: ['cellF', 'cellI', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Cell partials: mean plate speed, gap count, mobile sediment mass, finite flags.
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let wg = gid.x;
	var speed = 0.0;
	var covered = 0.0;
	var gaps = 0.0;
	var mobile = 0.0;
	let begin = wg * CHUNKD;
	let end = min(begin + CHUNKD, V);
	for (var c = begin; c < end; c = c + 1u) {
		mobile = mobile + cellMobile(c);
		if ((cellMobile(c) != cellMobile(c)) || (cellMobileFel(c) != cellMobileFel(c)) || (cellMobilePla(c) != cellMobilePla(c))) { markBad(); }
		if (cellOwner(c) < 0) {
			gaps = gaps + 1.0;
			continue;
		}
		if (cellPlateOf(c) < i32(fPlates())) {
			speed = speed + length(cellVel(c));
			covered = covered + 1.0;
		}
		let u = cellU(c);
		if (isNanF(cellZ(c)) || isNanF(u.x) || isNanF(cellGradZ(c).x) || isNanF(cellSlope(c)) || isNanF(cellExt(c))) { markBad(); }
	}
	let base = RED_DIAGCELL + wg * 4u;
	RED[base] = speed;
	RED[base + 1u] = covered;
	RED[base + 2u] = gaps;
	RED[base + 3u] = mobile;
}
`
},
{
	name: 'diagB', groups: ['reduce', 'diag'],
	code: `
// Fold partials into the diagnostics block (single invocation, fixed order).
@compute @workgroup_size(1)
fn main() {
	var qErr = 0.0;
	var rigid2 = 0.0;
	var fel = 0.0;
	var maf = 0.0;
	var sed = 0.0;
	var o0 = 0.0; var o1 = 0.0; var o2 = 0.0; var o3 = 0.0; var o4 = 0.0; var o5 = 0.0;
	var cols = 0.0;
	for (var w = 0u; w < NWGD; w = w + 1u) {
		let base = RED_DIAGCOL + w * 12u;
		qErr = max(qErr, RED[base]);
		rigid2 = max(rigid2, RED[base + 1u]);
		fel = fel + RED[base + 2u];
		maf = maf + RED[base + 3u];
		sed = sed + RED[base + 4u];
		o0 = o0 + RED[base + 5u]; o1 = o1 + RED[base + 6u]; o2 = o2 + RED[base + 7u];
		o3 = o3 + RED[base + 8u]; o4 = o4 + RED[base + 9u]; o5 = o5 + RED[base + 10u];
		cols = cols + RED[base + 11u];
	}
	var speed = 0.0;
	var covered = 0.0;
	var gaps = 0.0;
	var mobile = 0.0;
	for (var w2 = 0u; w2 < NWGD; w2 = w2 + 1u) {
		let base2 = RED_DIAGCELL + w2 * 4u;
		speed = speed + RED[base2];
		covered = covered + RED[base2 + 1u];
		gaps = gaps + RED[base2 + 2u];
		mobile = mobile + RED[base2 + 3u];
	}
	DIAG[D_MEANV] = select(0.0, speed / covered, covered > 0.0);
	DIAG[D_MASSFEL] = fel * A0REF;
	DIAG[D_MASSMAF] = maf * A0REF;
	DIAG[D_MASSSED] = (sed + mobile) * A0REF;
	DIAG[D_ORE0 + 0u] = o0; DIAG[D_ORE0 + 1u] = o1; DIAG[D_ORE0 + 2u] = o2;
	DIAG[D_ORE0 + 3u] = o3; DIAG[D_ORE0 + 4u] = o4; DIAG[D_ORE0 + 5u] = o5;
	DIAG[D_GAPS] = gaps;
	DIAG[D_COLS] = cols;
	DIAG[12u] = qErr;
	DIAG[13u] = rigid2;
}
`
},
{
	name: 'ledgerReduceA', groups: ['reduce', 'frameOut'],
	code: `
// Per-chunk Kahan sums of the per-column ledger deltas, in fixed column order.
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
	let k = li.x;
	if (k >= 7u) { return; }
	var acc = 0.0;
	var comp = 0.0;
	let begin = wg.x * CHUNKL;
	let end = min(begin + CHUNKL, COLCAP);
	for (var i = begin; i < end; i = i + 1u) {
		kAdd(&acc, &comp, RED[RED_LEDGER + k * COLCAP + i]);
	}
	RED[RED_LPART + wg.x * 7u + k] = acc + comp;
}
`
},
{
	name: 'ledgerReduceB', groups: ['reduce', 'frameOut'],
	code: `
// Fold the chunk partials into the running total, kept as an f64-like hi/lo pair via
// twoSum so a 4500 Myr history loses nothing to f32 accumulation.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let k = gid.x;
	if (k >= 7u) { return; }
	var acc = 0.0;
	var comp = 0.0;
	for (var w = 0u; w < NWGL; w = w + 1u) {
		kAdd(&acc, &comp, RED[RED_LPART + w * 7u + k]);
	}
	let delta = acc + comp;
	let hi = bitcast<f32>(atomicLoad(&FOUT[FO_L0 + k * 2u]));
	let lo = bitcast<f32>(atomicLoad(&FOUT[FO_L0 + k * 2u + 1u]));
	var s = delta + hi;
	var e = (delta - s) + hi;
	var r = lo + e;
	var s2 = s + r;
	var e2 = (s - s2) + r;
	atomicStore(&FOUT[FO_L0 + k * 2u], bitcast<i32>(s2));
	atomicStore(&FOUT[FO_L0 + k * 2u + 1u], bitcast<i32>(e2));
}
`

}
];
if (typeof module !== 'undefined' && module.exports) module.exports = DiagWGSL;

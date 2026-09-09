/* wgsl-surface.js - K9: dynamic topography relaxation, elevation + graph gradient,
   basin potential, and one-hop sediment routing in gather form (erode → outflow →
   stay → deposit), matching the refactored CPU kernels pass for pass. */
var SurfaceWGSL = [
{
	name: 'dynamics', groups: ['gridI', 'colF', 'colI', 'cellF', 'cellI', 'frameIn', 'frameOut'],
	code: `
// Ring Laplacian flexure plus plume uplift target, written to zDynNext then committed.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let cell = colCell(i);
	var lap = 0.0;
	if (cell >= 0) {
		for (var k = 0u; k < ringN(u32(cell)); k = k + 1u) {
			let j = u32(ringAt(u32(cell) * 6u + k));
			let oj = cellOwner(j);
			if (oj >= 0 && oj != i32(i)) { lap = lap + colZDyn(u32(oj)) - colZDyn(i); }
		}
	}
	var next = colZDyn(i) * exp(-fDT() / P_TAUDYN) + P_KFLEX * fDT() * lap;
	let heat = select(0.0, cellPlumeT(u32(cell)), cell >= 0);
	let uplift = P_ZPLUME * clamp(heat, 0.0, 1.0);
	next = next + (uplift - next) * min(1.0, fDT() / P_TAUPLUME);
	COLF[i * 6u + 5u].x = next;
}
`
},
{
	name: 'zdynCommit', groups: ['colF', 'colI', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	COLF[i * 6u + 4u].w = COLF[i * 6u + 5u].x;
}
`
},
{
	name: 'elevationZ', groups: ['colF', 'colI', 'cellF', 'cellI'],
	code: `
// Pass 1: elevation only. Gap cells get NaN z and cleared gradient state, exactly like
// the CPU's first loop. Also zeroes the erosion scratch for the routing passes.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	CELLF[c * 8u + 6u] = vec4<f32>(0.0);
	let o = cellOwner(c);
	if (o < 0) {
		setCellZ(c, nanF32());
		CELLF[c * 8u + 1u] = vec4<f32>(0.0);
		setCellLow(c, -1);
		return;
	}
	let i = u32(o);
	let ci = smoothstep01(colHFel(i), 5000.0, 20000.0);
	let thermal = (1.0 - ci) * 350.0 * sqrt(min(colAge(i), 80.0)) + ci * 2091.0;
	setCellZ(c, -3342.0 + colHFel(i) / 6.0 + (colHMaf(i) * 350.0 + colHSed(i) * 900.0) / 3300.0 - thermal + colZDyn(i));
}
`
},
{
	name: 'elevationG', groups: ['gridF', 'gridI', 'cellF', 'cellI'],
	code: `
// Pass 2: graph gradient, slope and drainage neighbour, reading the finished z field.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let zi = cellZ(c);
	if (isNanF(zi)) { return; }
	var bx = 0.0;
	var by = 0.0;
	var bz = 0.0;
	var low = -1;
	var lowZ = 3.0e38;
	let pos = cellPos(c);
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let j = u32(ringAt(c * 6u + k));
		let zj = cellZ(j);
		if (isNanF(zj)) { continue; }
		let dz = zj - zi;
		let pj = cellPos(j);
		bx = bx + dz * pj.x;
		by = by + dz * pj.y;
		bz = bz + dz * pj.z;
		if (zj < lowZ || (zj == lowZ && i32(j) < low)) { low = i32(j); lowZ = zj; }
	}
	var gx = gradInv(c, 0u) * bx + gradInv(c, 1u) * by + gradInv(c, 2u) * bz;
	var gy = gradInv(c, 3u) * bx + gradInv(c, 4u) * by + gradInv(c, 5u) * bz;
	var gz = gradInv(c, 6u) * bx + gradInv(c, 7u) * by + gradInv(c, 8u) * bz;
	let radial = gx * pos.x + gy * pos.y + gz * pos.z;
	gx = (gx - pos.x * radial) / R;
	gy = (gy - pos.y * radial) / R;
	gz = (gz - pos.z * radial) / R;
	CELLF[c * 8u + 1u] = vec4<f32>(gx, gy, gz, sqrt(gx * gx + gy * gy + gz * gz));
	setCellLow(c, low);
}
`
},
{
	name: 'basins', groups: ['colF', 'colI', 'cellF', 'frameIn', 'frameOut'],
	code: `
// Basin potential for sediment that is thick and under water.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	if (colHSed(i) <= P_HBAS) { return; }
	let cell = colCell(i);
	if (cell < 0 || cellZ(u32(cell)) >= 0.0) { return; }
	COLF[i * 6u + 4u].y = colOBas(i) + (1.0 - colOBas(i)) * P_KB2 * fDT() * colFert(i);
}
`
},
{
	name: 'erode', groups: ['gridI', 'colF', 'colI', 'cellF', 'cellI', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Per-column erosion over the cells raster can give it, in the fixed order own cell
// then ring: sediment first, then felsic, then mafic. What was taken stays on the cell
// for the routing passes; the signed production ledgers book fel and maf removal.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let cell = colCell(i);
	if (cell < 0) { return; }
	var hSed = colHSed(i);
	var hFel = colHFel(i);
	var hMaf = colHMaf(i);
	for (var k = 0u; k <= ringN(u32(cell)); k = k + 1u) {
		var c = u32(cell);
		if (k > 0u) { c = u32(ringAt(u32(cell) * 6u + k - 1u)); }
		if (cellOwner(c) != i32(i)) { continue; }
		let zc = cellZ(c);
		if (zc <= 0.0) { continue; }
		var want = P_KERO * zc * (1.0 + 2.0 * cellSlope(c) / P_SLOPEREF) * fDT();
		let takeSed = min(want, hSed);
		hSed = hSed - takeSed;
		want = want - takeSed;
		let takeFel = min(want, hFel);
		hFel = hFel - takeFel;
		want = want - takeFel;
		let takeMaf = min(want, hMaf);
		hMaf = hMaf - takeMaf;
		let eroded = takeSed + takeFel + takeMaf;
		CELLF[c * 8u + 6u] = vec4<f32>(eroded, takeSed + takeFel,
			P_KPLACER * eroded * 0.5 * (colOOro(i) + colOArc(i)), 0.0);
		addLedger(2u, i, takeFel * A0REF);
		addLedger(3u, i, takeMaf * A0REF);
		addLedger(0u, i, -takeFel * A0REF);
		addLedger(1u, i, -takeMaf * A0REF);
	}
	setColHFel(i, hFel);
	COLF[i * 6u + 2u].x = hMaf;
	COLF[i * 6u + 2u].y = hSed;
}
`
},
{
	name: 'routeOut', groups: ['cellF', 'cellI'],
	code: `
// Per cell: what leaves downhill and what stays. The wet halving needs no stored flag.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let local = cellMobile(c) + cellEroSed(c);
	let localFel = cellMobileFel(c) + cellEroFel(c);
	let localPla = cellMobilePla(c) + cellEroPla(c);
	let low = cellLow(c);
	var fraction = 0.0;
	if (low >= 0 && cellZ(u32(low)) < cellZ(c) - P_DELTAZ) {
		fraction = select(1.0, 0.5, cellZ(c) < 0.0);
	}
	let out = local * fraction;
	let outFel = localFel * fraction;
	let outPla = localPla * fraction;
	CELLF[c * 8u + 4u] = vec4<f32>(out, outFel, outPla, 0.0);
	CELLF[c * 8u + 3u] = vec4<f32>(local - out, localFel - outFel, localPla - outPla, cellExt(c));
}
`
},
{
	name: 'stay', groups: ['gridI', 'cellF', 'cellI'],
	code: `
// Inflow gather: routing is one hop, so a cell can only receive from its ring.
// Uncovered cells keep their load in mobile.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var stay = cellMobile(c);
	var stayFel = cellMobileFel(c);
	var stayPla = cellMobilePla(c);
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let src = u32(ringAt(c * 6u + k));
		if (cellLow(src) != i32(c)) { continue; }
		stay = stay + cellOutflow(src);
		stayFel = stayFel + cellOutflowFel(src);
		stayPla = stayPla + cellOutflowPla(src);
	}
	CELLF[c * 8u + 5u] = vec4<f32>(stay, stayFel, stayPla, 0.0);
	if (cellOwner(c) < 0) {
		CELLF[c * 8u + 3u] = vec4<f32>(stay, stayFel, stayPla, cellExt(c));
	}
}
`
},
{
	name: 'deposit', groups: ['gridI', 'colF', 'colI', 'cellF', 'cellI', 'frameIn', 'frameOut'],
	code: `
// Deposit pulls the stayed load of each owned cell into its column, in the same fixed
// candidate order erosion used. Basin and placer potentials dose from what lands.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let cell = colCell(i);
	if (cell < 0) { return; }
	var hSed = colHSed(i);
	var oBas = colOBas(i);
	var oPla = colOPla(i);
	for (var k = 0u; k <= ringN(u32(cell)); k = k + 1u) {
		var c = u32(cell);
		if (k > 0u) { c = u32(ringAt(u32(cell) * 6u + k - 1u)); }
		if (cellOwner(c) != i32(i)) { continue; }
		let stay = cellStay(c);
		let stayFel = cellStayFel(c);
		let stayPla = cellStayPla(c);
		hSed = hSed + stay;
		if (stay > 0.0 && cellZ(c) < P_ZBASIN) {
			oBas = oBas + (1.0 - oBas) * min(1.0, P_KB * stayFel * colFert(i));
			if (stayPla > 0.0) {
				oPla = oPla + (1.0 - oPla) * min(1.0, P_KB * stayPla * colFert(i));
			}
		}
		CELLF[c * 8u + 3u] = vec4<f32>(0.0, 0.0, 0.0, cellExt(c));
	}
	COLF[i * 6u + 2u].y = hSed;
	COLF[i * 6u + 4u].y = oBas;
	COLF[i * 6u + 4u].z = oPla;
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = SurfaceWGSL;

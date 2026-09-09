/* wgsl-column.js - K8: gravitational collapse (gather form), orogenic belt marks, and the
   per-column step (age, weakening, plume melt, metallogeny). Belt marks are scatter-OR'd
   into scan bit 30 by a per-edge kernel; every mark writes the same value, so the order
   of concurrent marks cannot matter. */
var ColumnWGSL = [
{
	name: 'collapseDelta', groups: ['gridF', 'gridI', 'colF', 'colI', 'cellI', 'frameIn', 'frameOut'],
	code: `
// Each column gathers ±k(hFel_other − hFel_i)·w over the edges of every cell it owns
// (its own cell and that cell's ring), the same candidate set erosion deposits from.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	var delta = 0.0;
	let cell = colCell(i);
	if (cell >= 0) {
		let k = P_KCOLLAPSE * fDT();
		var d = 0.0;
		let fel = colHFel(i);
		for (var q = 0u; q <= ringN(u32(cell)); q = q + 1u) {
			var c = u32(cell);
			if (q > 0u) { c = u32(ringAt(u32(cell) * 6u + q - 1u)); }
			if (cellOwner(c) != i32(i)) { continue; }
			for (var e = 0u; e < ringN(c); e = e + 1u) {
				let edge = c * 6u + e;
				let j = u32(ringAt(edge));
				let oj = cellOwner(j);
				if (oj < 0 || oj == i32(i)) { continue; }
				if (max(fel, colHFel(u32(oj))) <= P_HCOLLAPSE) { continue; }
				d = d + (colHFel(u32(oj)) - fel) * collapseW(edge);
			}
		}
		delta = k * d;
	}
	COLF[i * 6u + 5u].y = delta;
}
`
},
{
	name: 'collapseApply', groups: ['colF', 'colI', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	setColHFel(i, max(0.0, colHFel(i) + colCollapse(i)));
}
`
},
{
	name: 'belt', groups: ['gridI', 'colF', 'cellI', 'edges', 'scanAlone'],
	code: `
// One ring around a continent-continent convergent or a continental transform edge.
// Runs per edge and marks both endpoints plus their rings (idempotent OR into bit 30).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let e = gid.x;
	if (e >= V * 6u) { return; }
	let t = edgeType(e);
	if (t == E_INTERIOR) { return; }
	let c = e / 6u;
	let j = ringAt(e);
	let oc = cellOwner(c);
	if (oc < 0 || j < 0) { return; }
	let oj = cellOwner(u32(j));
	if (oj < 0) { return; }
	if (t == E_CONV) {
		if (edgePol(e) != 2) { return; }
	} else if (t != E_TRANS || colHFel(u32(oc)) < P_HOCEANIC || colHFel(u32(oj)) < P_HOCEANIC) {
		return;
	}
	dilate(c);
	dilate(u32(j));
}

fn dilate(c: u32) {
	atomicOr(&SCAN[c], bitcast<i32>(0x40000000u));
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		atomicOr(&SCAN[u32(ringAt(c * 6u + k))], bitcast<i32>(0x40000000u));
	}
}
`
},
{
	name: 'columnStep', groups: ['gridI', 'colF', 'colI', 'cellF', 'edges', 'scanAlone', 'reduce', 'frameIn', 'frameOut'],
	code: `
// Age, damage growth/healing, plume LIP melt and the ore factories. The belt flag is
// read from the belt bit the per-edge kernel just set on this column's cell.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	var age = colAge(i) + fDT();
	let cell = colCell(i);
	var ext = 0.0;
	var tangent = 0.0;
	var normal = 0.0;
	var spread = 0.0;
	var heat = 0.0;
	if (cell >= 0) {
		ext = max(0.0, cellExt(u32(cell)));
		heat = cellPlumeT(u32(cell));
		for (var k = 0u; k < ringN(u32(cell)); k = k + 1u) {
			let e = u32(cell) * 6u + k;
			let rel = abs(edgeRelT(e));
			let n = abs(edgeRelN(e));
			if (rel > tangent) { tangent = rel; }
			if (n > normal) { normal = n; }
			if (edgeType(e) == E_DIV && edgeRelN(e) > spread) { spread = edgeRelN(e); }
		}
	}
	let continental = smoothstep01(colHFel(i), 10000.0, 35000.0);
	let old = smoothstep01(age, 20.0, 200.0);
	let strength = clamp(0.3 + 0.7 * continental + 0.3 * old, 0.3, 1.3) / max(0.35, fTM());
	let growth = P_KDAM * ext / P_EXTREF / strength + P_KDAMT * tangent / P_VREF;
	var damage = clamp(colDamage(i) + fDT() * (growth - P_KHEAL * colDamage(i)), 0.0, 1.0);
	var hMaf = colHMaf(i);
	let lip = P_KLIP * fTM() * max(0.0, heat - 0.25) * fDT();
	if (lip > 0.0) {
		hMaf = hMaf + lip;
		addLedger(1u, i, lip * A0REF);
	}
	let fert = colFert(i);
	var oVms = colOVms(i);
	var oMaf = colOMaf(i);
	var oArc = colOArc(i);
	var oOro = colOOro(i);
	var oBas = colOBas(i);
	var oPla = colOPla(i);
	if (colHFel(i) < P_HOCEANIC && spread > 0.0) {
		oVms = oVms + (1.0 - oVms) * P_KV * fTM() * min(1.0, spread / P_VREF) * fert * fDT();
	}
	if (heat > 0.0) {
		oMaf = oMaf + (1.0 - oMaf) * P_KM * heat * fert * fDT();
	}
	let orogenic = colHFel(i) > P_HORO
		|| (colHFel(i) >= P_HOCEANIC && cell >= 0 && (atomicLoad(&SCAN[u32(cell)]) & bitcast<i32>(0x40000000u)) != 0);
	if (orogenic) {
		oOro = oOro + (1.0 - oOro) * P_KO * (normal + tangent) / P_VREF * damage * fert * fDT();
	}
	let decay = 1.0 - P_KDECAY * fDT();
	oVms = oVms * decay; oMaf = oMaf * decay; oArc = oArc * decay;
	oOro = oOro * decay; oBas = oBas * decay; oPla = oPla * decay;
	COLF[i * 6u + 2u] = vec4<f32>(hMaf, colHSed(i), age, damage);
	COLF[i * 6u + 3u] = vec4<f32>(fert, oVms, oMaf, oArc);
	COLF[i * 6u + 4u] = vec4<f32>(oOro, oBas, oPla, colZDyn(i));
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnWGSL;

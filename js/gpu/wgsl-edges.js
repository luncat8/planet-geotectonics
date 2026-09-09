/* wgsl-edges.js - K5: plate velocities, relative edge motion with hysteresis, subduction
   polarity, trench distance (mark + two dilations) and dynamic extension + spreading rate. */
var EdgesWGSL = [
{
	name: 'velocities', groups: ['gridF', 'colI', 'plateF', 'cellF', 'cellI', 'frameIn', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var plate = 65535;
	let owner = cellOwner(c);
	if (owner >= 0) { plate = colPlate(u32(owner)); }
	setCellPlateOf(c, plate);
	if (plate >= i32(fPlates())) { setCellVel(c, vec3<f32>(0.0)); return; }
	let v = R * cross(plateOmega(u32(plate)), cellPos(c));
	setCellVel(c, v);
	maxSpeed(length(v));
	addPlateCells(u32(plate));
}
`
},
{
	name: 'relatives', groups: ['gridF', 'gridI', 'cellF', 'cellI', 'edges', 'frameOut'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let pi = cellPlateOf(c);
	for (var k = 0u; k < 6u; k = k + 1u) {
		let e = c * 6u + k;
		let j = ringAt(e);
		if (j < 0) {
			setEdgeRel(e, 0.0, 0.0);
			setEdgeType(e, E_INTERIOR);
			setEdgePol(e, 0);
			continue;
		}
		let pj = cellPlateOf(u32(j));
		let old = edgeType(e);
		if (pi == 65535 || pj == 65535 || pi == pj) {
			setEdgeRel(e, 0.0, 0.0);
			if (old != E_INTERIOR) { addChange(); }
			setEdgeType(e, E_INTERIOR);
			continue;
		}
		let dv = cellVel(u32(j)) - cellVel(c);
		let relN = dot(dv, faceN(e));
		setEdgeRel(e, relN, dot(dv, faceT(e)));
		var t = E_TRANS;
		if (relN < -P_EPSHI) {
			t = E_CONV;
		} else if (relN > P_EPSHI) {
			t = E_DIV;
		} else if (abs(relN) > P_EPSLO && (old == E_CONV || old == E_DIV)) {
			t = old;
		}
		if (t != old) { addChange(); }
		setEdgeType(e, t);
	}
}
`
},
{
	name: 'polarity', groups: ['gridI', 'colF', 'cellI', 'edges'],
	code: `
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let e = c * 6u + k;
		setEdgePol(e, 0);
		if (edgeType(e) != E_CONV) { continue; }
		let oi = cellOwner(c);
		let oj = cellOwner(u32(ringAt(e)));
		if (oi < 0 || oj < 0) { continue; }
		let ocI = colHFel(u32(oi)) < P_HOCEANIC;
		let ocJ = colHFel(u32(oj)) < P_HOCEANIC;
		if (!ocI && !ocJ) { setEdgePol(e, 2); continue; }
		var iSub = false;
		if (ocI && ocJ) {
			iSub = colAge(u32(oi)) > colAge(u32(oj)) || (colAge(u32(oi)) == colAge(u32(oj)) && oi < oj);
		} else {
			iSub = ocI;
		}
		setEdgePol(e, select(1, -1, iSub));
	}
}
`
},
{
	name: 'trenchA', groups: ['gridI', 'cellI', 'edges'],
	code: `
// A cell is a trench if one of its own edges has polarity +1, or if a ring cell's edge
// pointing back at it has polarity -1 (the far side of the same subduction).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var d = 3;
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		if (edgePol(c * 6u + k) == 1) { d = 0; break; }
	}
	if (d != 0) {
		for (var k2 = 0u; k2 < ringN(c); k2 = k2 + 1u) {
			let j = u32(ringAt(c * 6u + k2));
			for (var k3 = 0u; k3 < ringN(j); k3 = k3 + 1u) {
				let e = j * 6u + k3;
				if (ringAt(e) == i32(c) && edgePol(e) == -1) { d = 0; break; }
			}
			if (d == 0) { break; }
		}
	}
	CELLI[c * CS + 8u] = (CELLI[c * CS + 8u] & ~3) | (d & 3);
}
`
},
{
	name: 'trenchDilate', groups: ['gridI', 'cellI'], variants: [0, 1],
	code: function (pass) {
		return `
// One dilation pass (invoked twice). Readers only read cells at distance 'pass' this
// pass and writers only write cells further out, so there is no same-pass interference.
const PASS: i32 = ${pass};
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var d = cellTrenchDist(c);
	if (d > PASS + 1) {
		let plate = cellPlateOf(c);
		for (var k = 0u; k < ringN(c); k = k + 1u) {
			let j = u32(ringAt(c * 6u + k));
			if (cellPlateOf(j) == plate && cellTrenchDist(j) == PASS) { d = PASS + 1; break; }
		}
	}
	if (d != cellTrenchDist(c)) { CELLI[c * CS + 8u] = (CELLI[c * CS + 8u] & ~3) | (d & 3); }
}
`;
	}
},
{
	name: 'extension', groups: ['gridF', 'gridI', 'cellF', 'cellI', 'edges'],
	code: `
// Midpoint flux is polluted on this dual, so differences of (uMantle - vel) annihilate
// rigid rotation. Also gathers this cell's spreading rate (max divergent relN over the
// cell and its ring edges) that spawn uses for VMS at birth.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var flux = 0.0;
	for (var k = 0u; k < ringN(c); k = k + 1u) {
		let e = c * 6u + k;
		let j = u32(ringAt(e));
		let du = (cellU(j) - cellVel(j)) - (cellU(c) - cellVel(c));
		flux = flux + dot(du, fluxN(e));
	}
	var spread = 0.0;
	for (var k2 = 0u; k2 <= ringN(c); k2 = k2 + 1u) {
		var bin = c;
		if (k2 > 0u) { bin = u32(ringAt(c * 6u + k2 - 1u)); }
		for (var j2 = 0u; j2 < ringN(bin); j2 = j2 + 1u) {
			let e2 = bin * 6u + j2;
			if (edgeType(e2) == E_DIV && edgeRelN(e2) > spread) { spread = edgeRelN(e2); }
		}
	}
	CELLF[c * 8u + 3u].w = flux + P_KPLUME * cellPlumeT(c);
	setCellSpread(c, spread);
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = EdgesWGSL;

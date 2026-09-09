/* wgsl-columns.js - K2 MOVE, K3 BIN, K4 RASTER. Each entry point is its own module with
   only the buffer groups it needs, because the 8-storage-buffer-per-shader limit forces
   the union of a shared module to be split. */
var ColumnsWGSL = [
{
	name: 'move', groups: ['gridF', 'gridI', 'colF', 'colI', 'plateF', 'frameOut'],
	code: `
// K2: world = q·body, then the exact hill-climb from the cached cell. 'best' carries
// across iterations exactly like the CPU loop, so ties keep the current cell.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	setColWorld(i, qrot(plateQ(u32(colPlate(i))), colBody(i)));
	var c = colCell(i);
	if (c < 0 || u32(c) >= V) { return; }
	let w = colWorld(i);
	var best = dot(cellPos(u32(c)), w);
	loop {
		var next = u32(c);
		for (var k = 0u; k < ringN(u32(c)); k = k + 1u) {
			let j = u32(ringAt(u32(c) * 6u + k));
			let d = dot(cellPos(j), w);
			if (d > best) { best = d; next = j; }
		}
		if (next == u32(c)) { break; }
		c = i32(next);
	}
	COLI[i * 4u + 1u] = c;
}
`
},
{
	name: 'binCount', groups: ['colI', 'bins', 'frameOut'],
	code: `
// K3a: per-cell counts into the scan input region (atomic integer, order-free).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let c = colCell(i);
	if (c < 0) { return; }
	atomicAdd(&SCAN[u32(c)], 1);
}
`
},
{
	name: 'binScatter', groups: ['colI', 'bins', 'frameOut'],
	code: `
// K3c: scatter with an atomic cursor. Entry order within a cell is arbitrary, but every
// consumer resolves through a total order (distance, index), so the result is deterministic.
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= aliveN() || colAlive(i) == 0) { return; }
	let c = colCell(i);
	if (c < 0) { return; }
	let at = atomicAdd(&BINS[u32(c)], 1);
	atomicStore(&BINS[V + u32(at)], i32(i));
}
`
},
{
	name: 'raster', groups: ['gridF', 'gridI', 'colF', 'colI', 'cellF', 'cellI', 'bins'],
	code: `
// K4: nearest column over the cell and its ring bins by the total order (distance, index).
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	var best = 3.0e38;
	var owner = -1;
	for (var k = 0u; k <= ringN(c); k = k + 1u) {
		var j = c;
		if (k > 0u) { j = u32(ringAt(c * 6u + k - 1u)); }
		let begin = binOffset(j);
		let end = binEnd(j);
		for (var at = begin; at < end; at = at + 1) {
			let i = u32(binEntry(u32(at)));
			let dv = colWorld(i) - cellPos(c);
			let d = dot(dv, dv);
			if (d > best || (d == best && owner >= 0 && i > u32(owner))) { continue; }
			best = d;
			owner = i32(i);
		}
	}
	if (best > gapLimit2(c)) { owner = -1; }
	setCellOwner(c, owner);
	if (best > 1.0e30) {
		CELLI[c * 13u + 9u] = 0x7fffffff;
	} else {
		setCellDistance(c, sqrt(best) * R);
	}
	setCellPlateOf(c, select(65535, colPlate(u32(max(owner, 0))), owner >= 0));
	if (owner < 0) { setCellZ(c, nanF32()); }
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = ColumnsWGSL;

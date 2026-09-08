/* gpu/bin.wgsl.js — K3 BIN: memset of binCount happens on the queue; count via atomicAdd,
   prefix sum via the generic scan, scatter with binOffset + atomicAdd(cursor-in-count), then
   an insertion sort per cell by column index. Ascending index is exactly the CPU's traversal
   order, so bin structure is bit-identical and every later nearest/tie test matches. */
var BinWgsl = function () {
	return `@compute @workgroup_size(256)
fn kBinCount(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= u32(ldFM(A_GCOLHIGH))) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	addB(A_BINCOUNT + u32(ldIC(A_CELL + i)), 1u);
}

@compute @workgroup_size(256)
fn kBinScatter(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= u32(ldFM(A_GCOLHIGH))) { return; }
	if (ldC(A_ALIVE + i) == 0u) { return; }
	let c = u32(ldIC(A_CELL + i));
	let slot = ldB(A_BINOFFSET + c) + addB(A_BINCOUNT + c, 1u);
	stB(A_BINENTRIES + slot, i);
}

// Insertion sort of one cell's entries ascending by column index. Bins hold a handful of
// columns, so the quadratic worst case is a few compares.
@compute @workgroup_size(256)
fn kBinSort(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let off = ldB(A_BINOFFSET + c);
	let end = ldB(A_BINOFFSET + c + 1u);
	var a = off + 1u;
	loop {
		if (a >= end) { break; }
		let v = ldB(A_BINENTRIES + a);
		var b = a;
		loop {
			if (b <= off) { break; }
			let prev = ldB(A_BINENTRIES + b - 1u);
			if (prev > v) { stB(A_BINENTRIES + b, prev); b = b - 1u; continue; }
			break;
		}
		stB(A_BINENTRIES + b, v);
		a = a + 1u;
	}
}
`;
};
BinWgsl.entry = ['kBinCount', 'kBinScatter', 'kBinSort'];
if (typeof module !== 'undefined' && module.exports) module.exports = BinWgsl;

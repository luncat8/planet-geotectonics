/* wgsl-scan.js - generic exclusive scan over the shared scratch buffer, instantiated per
   N (V for bins and spawn ranks, colCap for loser offsets). Layout: in[N], out[N + 1]
   (out[N] = grand total), blocks[nBlocks] at BLOCKBASE. Workgroups cover 1024 elements
   (256 threads x 4, Hillis-Steele in shared memory); one extra pass adds block offsets.
   scanCBins also initialises the bins cursors; scanCRank turns spawn flags into slots. */
var ScanWGSL = {
	// N is substituted per instance by sim-gpu.js.
	groups: ['bins', 'cellI', 'frameOut'],
	code: function (N) {
		return `
const N: u32 = ${N}u;
const ELEMS: u32 = 1024u;
const NBLOCKS: u32 = (N + ELEMS - 1u) / ELEMS;
const BLOCKBASE: u32 = 2u * NMAX + 1u;
var<workgroup> sh: array<i32, 256>;

@compute @workgroup_size(256)
fn scanA(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
	var vals: array<i32, 4>;
	var total: i32 = 0;
	for (var q = 0u; q < 4u; q = q + 1u) {
		let idx = wg.x * ELEMS + li.x * 4u + q;
		var v = 0;
		if (idx < N) { v = atomicLoad(&SCAN[idx]); }
		vals[q] = v;
		total = total + v;
	}
	sh[li.x] = total;
	workgroupBarrier();
	var stride = 1u;
	loop {
		if (stride >= 256u) { break; }
		var add = 0;
		if (li.x >= stride) { add = sh[li.x - stride]; }
		workgroupBarrier();
		if (li.x >= stride) { sh[li.x] = sh[li.x] + add; }
		workgroupBarrier();
		stride = stride * 2u;
	}
	var excl = 0;
	if (li.x > 0u) { excl = sh[li.x - 1u]; }
	var run = excl;
	for (var q2 = 0u; q2 < 4u; q2 = q2 + 1u) {
		let idx2 = wg.x * ELEMS + li.x * 4u + q2;
		if (idx2 < N) { atomicStore(&SCAN[NMAX + idx2], run); }
		run = run + vals[q2];
	}
	if (li.x == 255u) { atomicStore(&SCAN[BLOCKBASE + wg.x], sh[255]); }
}

@compute @workgroup_size(256)
fn scanB(@builtin(local_invocation_id) li: vec3<u32>) {
	var v = 0;
	if (li.x < NBLOCKS) { v = atomicLoad(&SCAN[BLOCKBASE + li.x]); }
	sh[li.x] = v;
	workgroupBarrier();
	var stride = 1u;
	loop {
		if (stride >= 256u) { break; }
		var add = 0;
		if (li.x >= stride) { add = sh[li.x - stride]; }
		workgroupBarrier();
		if (li.x >= stride) { sh[li.x] = sh[li.x] + add; }
		workgroupBarrier();
		stride = stride * 2u;
	}
	if (li.x < NBLOCKS) {
		var excl = 0;
		if (li.x > 0u) { excl = sh[li.x - 1u]; }
		atomicStore(&SCAN[BLOCKBASE + li.x], excl);
	}
	if (li.x == NBLOCKS - 1u) { atomicStore(&SCAN[NMAX + N], sh[NBLOCKS - 1u]); }
}

@compute @workgroup_size(128)
fn scanC(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= N) { return; }
	let off = atomicLoad(&SCAN[BLOCKBASE + i / ELEMS]);
	atomicStore(&SCAN[NMAX + i], atomicLoad(&SCAN[NMAX + i]) + off);
}

@compute @workgroup_size(128)
fn scanCBins(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= N) { return; }
	let off = atomicLoad(&SCAN[BLOCKBASE + i / ELEMS]);
	let v = atomicLoad(&SCAN[NMAX + i]) + off;
	atomicStore(&SCAN[NMAX + i], v);
	atomicStore(&BINS[i], v);
}

@compute @workgroup_size(128)
fn scanCRank(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= N) { return; }
	if (atomicLoad(&SCAN[c]) == 1) {
		// scanOut alone is the block-local prefix (scanA); the block offset from scanB
		// must be added here or ranks restart at zero every 1024 cells and spawn slots
		// collide across blocks.
		let off = atomicLoad(&SCAN[BLOCKBASE + c / ELEMS]);
		let slot = i32(atomicLoad(&FOUT[FO_N])) + scanOut(c) + off;
		if (slot >= i32(COLCAP) || slot < 0) {
			setCellSpawnSlot(c, -1);
		} else {
			setCellSpawnSlot(c, slot);
		}
	} else {
		setCellSpawnSlot(c, -1);
	}
}

@compute @workgroup_size(1)
fn spawnCount() {
	let total = atomicLoad(&SCAN[NMAX + N]);
	let room = i32(COLCAP) - i32(atomicLoad(&FOUT[FO_N]));
	let alloc = min(max(total, 0), max(room, 0));
	atomicStore(&FOUT[FO_SPAWNS], alloc);
	atomicAdd(&FOUT[FO_N], alloc);
}
`;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = ScanWGSL;

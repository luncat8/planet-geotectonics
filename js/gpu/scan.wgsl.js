/* gpu/scan.wgsl.js — generic exclusive prefix sum. Three fixed jobs, baked at shader-build
   time because queue writes cannot change parameters between dispatches inside one submit:
     bins   binCount   -> binOffset   (CELL_N)
     spawn  spawnFlag  -> spawnSlot   (CELL_N)
     gather glCount    -> glCursor    (COL_CAP)
   dst gets n+1 words: dst[i] = Σ src[0..i), dst[n] = the total. Three dispatches per job:
   per-block scan, serial block-prefix pass, block-offset add. Integer sums stay exact and
   order-free. scanPart is shared scratch; each job's tops pass rewrites it. */
var ScanWgsl = function () {
	var jobs = [
		['Bins', 'A_BINCOUNT', 'A_BINOFFSET', 'CELL_N'],
		['Spawn', 'A_SPAWNFLAG', 'A_SPAWNSLOT', 'CELL_N'],
		['Gather', 'A_GLCOUNT', 'A_GLCURSOR', 'COL_CAP']
	];
	var out = `var<workgroup> scanTmp: array<u32, 256>;

fn scanRun(src:u32, dst:u32, n:u32, gid:vec3<u32>, t:u32) {
	var v = 0u;
	if (gid.x < n) { v = ldB(src + gid.x); }
	scanTmp[t] = v;
	var off = 1u;
	loop {
		if (off >= 256u) { break; }
		workgroupBarrier();
		var add = 0u;
		if (t >= off) { add = scanTmp[t - off]; }
		workgroupBarrier();
		scanTmp[t] = scanTmp[t] + add;
		off = off << 1u;
	}
	workgroupBarrier();
	if (gid.x < n) { stB(dst + gid.x, scanTmp[t] - v); }
	if (t == 255u) { stM(A_SCANPART + (gid.x >> 8u), scanTmp[255]); }
}

fn scanTops(n:u32) {
	let blocks = (n + 255u) >> 8u;
	var run = 0u;
	for (var b = 0u; b < blocks; b++) {
		let v = ldM(A_SCANPART + b);
		stM(A_SCANPART + b, run);
		run = run + v;
	}
	stM(A_SCANPART + blocks, run);
}

fn scanApply(dst:u32, n:u32, gid:vec3<u32>) {
	if (gid.x > n) { return; }
	if (gid.x == n) { stB(dst + n, ldM(A_SCANPART + ((n + 255u) >> 8u))); return; }
	stB(dst + gid.x, ldB(dst + gid.x) + ldM(A_SCANPART + (gid.x >> 8u)));
}

`;
	for (var i = 0; i < jobs.length; i++) {
		var j = jobs[i];
		out += `@compute @workgroup_size(256)
fn kScanBlocks${j[0]}(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
	scanRun(${j[1]}, ${j[2]}, ${j[3]}, gid, lid.x);
}
@compute @workgroup_size(1)
fn kScanTops${j[0]}() {
	scanTops(${j[3]});
}
@compute @workgroup_size(256)
fn kScanApply${j[0]}(@builtin(global_invocation_id) gid: vec3<u32>) {
	scanApply(${j[2]}, ${j[3]}, gid);
}

`;
	}
	return out;
};
ScanWgsl.entry = ['kScanBlocksBins', 'kScanTopsBins', 'kScanApplyBins',
	'kScanBlocksSpawn', 'kScanTopsSpawn', 'kScanApplySpawn',
	'kScanBlocksGather', 'kScanTopsGather', 'kScanApplyGather'];
if (typeof module !== 'undefined' && module.exports) module.exports = ScanWgsl;

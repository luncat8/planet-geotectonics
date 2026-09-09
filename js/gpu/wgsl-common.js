/* wgsl-common.js - shared WGSL prelude for every compute kernel.
   One generator per buffer group so a kernel module only declares (and only pays the
   binding limit for) the buffers it touches. Binding numbers are global and stable:
   a kernel's bind group is the subset its groups name, in these slots.
   Scan buffer layout (i32): in[NMAX], out[NMAX + c] (exclusive prefix, out[N] = total),
   blocks[2*NMAX + 1 + wg]. NMAX = colCap >= V, so the bins scan (N = V) and the loser
   scan (N = colCap) reuse the same regions sequentially within a frame. */
var CommonParams = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;

var CommonWGSL = {
	// Global binding slots. A kernel may bind at most 8 (WebGPU default limit).
	B: { gridF: 0, gridI: 1, colF: 2, colI: 3, plateF: 4, plateI: 5, cellF: 6, cellI: 7,
		edges: 8, bins: 9, lose: 10, reduceF: 11, scan: 12, frameIn: 13, frameOut: 14, diagOut: 15 },
	params: function (p, l) {
		return 'const R: f32 = ' + p.radius + ';\n' +
			'const V: u32 = ' + l.V + 'u;\n' +
			'const COLCAP: u32 = ' + l.colCap + 'u;\n' +
			'const PLATECAP: u32 = ' + l.plateCap + 'u;\n' +
			'const A0REF: f32 = ' + l.A0ref + ';\n' +
			'const NMAX: u32 = ' + l.colCap + 'u;\n' +
			'const P_RGAP: f32 = ' + p.rGap + ';\n' +
			'const P_RCONTACT: f32 = ' + p.rContact + ';\n' +
			'const P_EPSHI: f32 = ' + p.epsHi + ';\n' +
			'const P_EPSLO: f32 = ' + p.epsLo + ';\n' +
			'const P_VREF: f32 = ' + p.vRef + ';\n' +
			'const P_VMAX: f32 = ' + p.vMax + ';\n' +
			'const P_TAUOMEGA: f32 = ' + p.tauOmega + ';\n' +
			'const P_TAUDYN: f32 = ' + p.tauDyn + ';\n' +
			'const P_TAUPLUME: f32 = ' + p.tauPlume + ';\n' +
			'const P_KFLEX: f32 = ' + p.kFlex + ';\n' +
			'const P_KERO: f32 = ' + p.kEro + ';\n' +
			'const P_SLOPEREF: f32 = ' + p.slopeRef + ';\n' +
			'const P_DELTAZ: f32 = ' + p.deltaZ + ';\n' +
			'const P_KPLACER: f32 = ' + p.kPlacer + ';\n' +
			'const P_ZBASIN: f32 = ' + p.zBasin + ';\n' +
			'const P_HBAS: f32 = ' + p.hBas + ';\n' +
			'const P_KB: f32 = ' + p.kB + ';\n' +
			'const P_KB2: f32 = ' + p.kB2 + ';\n' +
			'const P_KV: f32 = ' + p.kV + ';\n' +
			'const P_KM: f32 = ' + p.kM + ';\n' +
			'const P_KM2: f32 = ' + p.kM2 + ';\n' +
			'const P_KA: f32 = ' + p.kA + ';\n' +
			'const P_KREC: f32 = ' + p.kRec + ';\n' +
			'const P_KO: f32 = ' + p.kO + ';\n' +
			'const P_KDECAY: f32 = ' + p.kDecay + ';\n' +
			'const P_HOCEANIC: f32 = ' + p.hOceanic + ';\n' +
			'const P_HORO: f32 = ' + p.hOro + ';\n' +
			'const P_HRIFT: f32 = ' + p.hRiftBreakup + ';\n' +
			'const P_HCOLLAPSE: f32 = ' + p.hCollapse + ';\n' +
			'const P_COLLTHICK: f32 = ' + p.collThickness + ';\n' +
			'const P_ZPLUME: f32 = ' + p.zPlume + ';\n' +
			'const P_KCOLLAPSE: f32 = ' + p.kCollapse + ';\n' +
			'const P_KARC: f32 = ' + p.kArc + ';\n' +
			'const P_ARCMAF: f32 = ' + p.arcMafShare + ';\n' +
			'const P_ZTRENCH: f32 = ' + p.zTrench + ';\n' +
			'const P_SEDSCRAPE: f32 = ' + p.sedScrape + ';\n' +
			'const P_GAPFRAMES: u32 = ' + p.gapPersist + 'u;\n' +
			'const P_FILLDELAY: f32 = ' + p.fillDelay + ';\n' +
			'const P_RIFTDAMAGE: f32 = ' + p.riftDamage + ';\n' +
			'const P_KDAM: f32 = ' + p.kDam + ';\n' +
			'const P_KDAMT: f32 = ' + p.kDamT + ';\n' +
			'const P_KHEAL: f32 = ' + p.kHeal + ';\n' +
			'const P_EXTREF: f32 = ' + p.extRef + ';\n' +
			'const P_KPLUME: f32 = ' + p.kPlume + ';\n' +
			'const P_KLIP: f32 = ' + p.kLip + ';\n' +
			'const P_KRIDGE: f32 = ' + p.kRidge + ';\n' +
			'const P_VSLAB: f32 = ' + p.vSlab + ';\n' +
			'const P_AGESLAB: f32 = ' + p.ageSlab + ';\n' +
			'const P_VCOLL: f32 = ' + p.vColl + ';\n' +
			'const P_EA: f32 = ' + p.Ea + ';\n' +
			'const P_BETA: f32 = ' + p.beta + ';\n' +
			'const P_FERTLO: f32 = ' + p.fertLo + ';\n' +
			'const P_NWAVE: u32 = ' + p.nWave + 'u;\n' +
			'const P_NPHI: u32 = ' + p.nPhi + 'u;\n' +
			'const E_INTERIOR: i32 = 0;\n' +
			'const E_CONV: i32 = 1;\n' +
			'const E_DIV: i32 = 2;\n' +
			'const E_TRANS: i32 = 3;\n' +
			'const MAXSPEEDSCALE: f32 = 4096.0;\n';
	},
	gridF: function (b) {
		return '@group(0) @binding(' + b.gridF + ') var<storage, read> GRIDF: array<f32>;\n' +
			'fn cellPos(c: u32) -> vec3<f32> { return vec3<f32>(GRIDF[c * 4u], GRIDF[c * 4u + 1u], GRIDF[c * 4u + 2u]); }\n' +
			'fn cellArea(c: u32) -> f32 { return GRIDF[c * 4u + 3u]; }\n' +
			'fn faceN(e: u32) -> vec3<f32> { let o = V * 4u + e * 3u; return vec3<f32>(GRIDF[o], GRIDF[o + 1u], GRIDF[o + 2u]); }\n' +
			'fn faceT(e: u32) -> vec3<f32> { let o = V * 22u + e * 3u; return vec3<f32>(GRIDF[o], GRIDF[o + 1u], GRIDF[o + 2u]); }\n' +
			'fn fluxN(e: u32) -> vec3<f32> { let o = V * 40u + e * 3u; return vec3<f32>(GRIDF[o], GRIDF[o + 1u], GRIDF[o + 2u]); }\n' +
			'fn collapseW(e: u32) -> f32 { return GRIDF[V * 64u + e]; }\n' +
			'fn gradInv(c: u32, i: u32) -> f32 { return GRIDF[V * 70u + c * 9u + i]; }\n' +
			'fn nbrDist(c: u32) -> f32 { return GRIDF[V * 79u + c * 4u]; }\n' +
			'fn gapLimit2(c: u32) -> f32 { return GRIDF[V * 79u + c * 4u + 1u]; }\n' +
			'fn contactLimit2(c: u32) -> f32 { return GRIDF[V * 79u + c * 4u + 2u]; }\n' +
			'fn spawnLimitFP(c: u32) -> i32 { return i32(GRIDF[V * 79u + c * 4u + 3u]); }\n';
	},
	gridI: function (b) {
		return '@group(0) @binding(' + b.gridI + ') var<storage, read> GRIDI: array<i32>;\n' +
			'fn ringAt(e: u32) -> i32 { return GRIDI[e]; }\n' +
			'fn ringN(c: u32) -> u32 { return u32(GRIDI[6u * V + c]); }\n';
	},
	grid: function (b) {
		return CommonWGSL.gridF(b) + CommonWGSL.gridI(b);
	},
	colF: function (b) {
		return '@group(0) @binding(' + b.colF + ') var<storage, read_write> COLF: array<vec4<f32>>;\n' +
			'fn colBody(i: u32) -> vec3<f32> { return COLF[i * 6u].xyz; }\n' +
			'fn colWorld(i: u32) -> vec3<f32> { return COLF[i * 6u + 1u].xyz; }\n' +
			'fn colArea(i: u32) -> f32 { return COLF[i * 6u].w; }\n' +
			'fn colHFel(i: u32) -> f32 { return COLF[i * 6u + 1u].w; }\n' +
			'fn colHMaf(i: u32) -> f32 { return COLF[i * 6u + 2u].x; }\n' +
			'fn colHSed(i: u32) -> f32 { return COLF[i * 6u + 2u].y; }\n' +
			'fn colAge(i: u32) -> f32 { return COLF[i * 6u + 2u].z; }\n' +
			'fn colDamage(i: u32) -> f32 { return COLF[i * 6u + 2u].w; }\n' +
			'fn colFert(i: u32) -> f32 { return COLF[i * 6u + 3u].x; }\n' +
			'fn colOVms(i: u32) -> f32 { return COLF[i * 6u + 3u].y; }\n' +
			'fn colOMaf(i: u32) -> f32 { return COLF[i * 6u + 3u].z; }\n' +
			'fn colOArc(i: u32) -> f32 { return COLF[i * 6u + 3u].w; }\n' +
			'fn colOOro(i: u32) -> f32 { return COLF[i * 6u + 4u].x; }\n' +
			'fn colOBas(i: u32) -> f32 { return COLF[i * 6u + 4u].y; }\n' +
			'fn colOPla(i: u32) -> f32 { return COLF[i * 6u + 4u].z; }\n' +
			'fn colZDyn(i: u32) -> f32 { return COLF[i * 6u + 4u].w; }\n' +
			'fn colCollapse(i: u32) -> f32 { return COLF[i * 6u + 5u].y; }\n' +
			'fn setColWorld(i: u32, v: vec3<f32>) { COLF[i * 6u + 1u] = vec4<f32>(v, COLF[i * 6u + 1u].w); }\n' +
			'fn setColHFel(i: u32, v: f32) { COLF[i * 6u + 1u].w = v; }\n';
	},
	colI: function (b) {
		return '@group(0) @binding(' + b.colI + ') var<storage, read_write> COLI: array<i32>;\n' +
			'fn colPlate(i: u32) -> i32 { return COLI[i * 4u]; }\n' +
			'fn colCell(i: u32) -> i32 { return COLI[i * 4u + 1u]; }\n' +
			'fn colConsumed(i: u32) -> i32 { return COLI[i * 4u + 2u]; }\n' +
			'fn colAlive(i: u32) -> i32 { return COLI[i * 4u + 3u]; }\n';
	},
	col: function (b) {
		return CommonWGSL.colF(b) + CommonWGSL.colI(b);
	},
	plateF: function (b) {
		return '@group(0) @binding(' + b.plateF + ') var<storage, read_write> PLATEF: array<vec4<f32>>;\n' +
			'fn plateQ(p: u32) -> vec4<f32> { return PLATEF[p * 8u]; }\n' +
			'fn plateOmega(p: u32) -> vec3<f32> { return PLATEF[p * 8u + 1u].xyz; }\n' +
			'fn plateOmegaTarget(p: u32) -> vec3<f32> { return PLATEF[p * 8u + 2u].xyz; }\n' +
			'fn plateSubRate(p: u32) -> f32 { return PLATEF[p * 8u + 7u].x; }\n' +
			'fn plateArcFeed(p: u32) -> f32 { return PLATEF[p * 8u + 6u].w; }\n' +
			'fn plateM(p: u32, i: u32) -> f32 { return PLATEF[p * 8u + 3u + i / 3u][i % 3u]; }\n' +
			'fn setPlateQ(p: u32, v: vec4<f32>) { PLATEF[p * 8u] = v; }\n' +
			'fn setPlateOmega(p: u32, v: vec3<f32>) { PLATEF[p * 8u + 1u] = vec4<f32>(v, PLATEF[p * 8u + 1u].w); }\n' +
			'fn setPlateSubRate(p: u32, v: f32) { PLATEF[p * 8u + 7u].x = v; }\n' +
			'fn setPlateArcFeed(p: u32, v: f32) { PLATEF[p * 8u + 6u].w = v; }\n' +
			'fn setPlateM(p: u32, i: u32, v: f32) { PLATEF[p * 8u + 3u + i / 3u][i % 3u] = v; }\n' +
			'fn setPlateRhs(p: u32, i: u32, v: f32) { PLATEF[p * 8u + 6u][i] = v; }\n';
	},
	plate: function (b) {
		return CommonWGSL.plateF(b);
	},
	cellF: function (b) {
		return '@group(0) @binding(' + b.cellF + ') var<storage, read_write> CELLF: array<vec4<f32>>;\n' +
			'fn cellVel(c: u32) -> vec3<f32> { return CELLF[c * 8u].xyz; }\n' +
			'fn cellZ(c: u32) -> f32 { return CELLF[c * 8u].w; }\n' +
			'fn setCellVel(c: u32, v: vec3<f32>) { CELLF[c * 8u] = vec4<f32>(v, CELLF[c * 8u].w); }\n' +
			'fn setCellZ(c: u32, v: f32) { CELLF[c * 8u].w = v; }\n' +
			'fn cellGradZ(c: u32) -> vec3<f32> { return CELLF[c * 8u + 1u].xyz; }\n' +
			'fn cellSlope(c: u32) -> f32 { return CELLF[c * 8u + 1u].w; }\n' +
			'fn cellU(c: u32) -> vec3<f32> { return CELLF[c * 8u + 2u].xyz; }\n' +
			'fn cellPlumeT(c: u32) -> f32 { return CELLF[c * 8u + 2u].w; }\n' +
			'fn cellMobile(c: u32) -> f32 { return CELLF[c * 8u + 3u].x; }\n' +
			'fn cellMobileFel(c: u32) -> f32 { return CELLF[c * 8u + 3u].y; }\n' +
			'fn cellMobilePla(c: u32) -> f32 { return CELLF[c * 8u + 3u].z; }\n' +
			'fn cellExt(c: u32) -> f32 { return CELLF[c * 8u + 3u].w; }\n' +
			'fn cellOutflow(c: u32) -> f32 { return CELLF[c * 8u + 4u].x; }\n' +
			'fn cellOutflowFel(c: u32) -> f32 { return CELLF[c * 8u + 4u].y; }\n' +
			'fn cellOutflowPla(c: u32) -> f32 { return CELLF[c * 8u + 4u].z; }\n' +
			'fn cellStay(c: u32) -> f32 { return CELLF[c * 8u + 5u].x; }\n' +
			'fn cellStayFel(c: u32) -> f32 { return CELLF[c * 8u + 5u].y; }\n' +
			'fn cellStayPla(c: u32) -> f32 { return CELLF[c * 8u + 5u].z; }\n' +
			'fn cellEroSed(c: u32) -> f32 { return CELLF[c * 8u + 6u].x; }\n' +
			'fn cellEroFel(c: u32) -> f32 { return CELLF[c * 8u + 6u].y; }\n' +
			'fn cellEroPla(c: u32) -> f32 { return CELLF[c * 8u + 6u].z; }\n' +
			'fn cellWEq(c: u32) -> vec3<f32> { return CELLF[c * 8u + 7u].xyz; }\n';
	},
	cellI: function (b) {
		return '@group(0) @binding(' + b.cellI + ') var<storage, read_write> CELLI: array<i32>;\n' +
			'const CS: u32 = 13u;\n' +
			'fn cellOwner(c: u32) -> i32 { return CELLI[c * CS]; }\n' +
			'fn cellPlateOf(c: u32) -> i32 { return CELLI[c * CS + 1u]; }\n' +
			'fn cellLow(c: u32) -> i32 { return CELLI[c * CS + 2u]; }\n' +
			'fn cellSpawnSlot(c: u32) -> i32 { return CELLI[c * CS + 3u]; }\n' +
			'fn cellGapPlate(c: u32) -> i32 { return CELLI[c * CS + 4u]; }\n' +
			'fn cellGapDonor(c: u32, k: u32) -> i32 { return CELLI[c * CS + 5u + k]; }\n' +
			'fn cellTrenchDist(c: u32) -> i32 { return CELLI[c * CS + 8u] & 3; }\n' +
			'fn cellGapFrames(c: u32) -> u32 { return u32(CELLI[c * CS + 8u] >> 4) & 0xffffu; }\n' +
			'fn cellDistance(c: u32) -> f32 { return f32(CELLI[c * CS + 9u]) / 256.0; }\n' +
			'fn cellGapTime(c: u32) -> f32 { return f32(CELLI[c * CS + 10u]) / 100000.0; }\n' +
			'fn cellSpread(c: u32) -> f32 { return f32(CELLI[c * CS + 11u]) / 256.0; }\n' +
			'fn cellGapDonorN(c: u32) -> i32 { return CELLI[c * CS + 12u]; }\n' +
			'fn setCellPlateOf(c: u32, v: i32) { CELLI[c * CS + 1u] = v; }\n' +
			'fn setCellLow(c: u32, v: i32) { CELLI[c * CS + 2u] = v; }\n' +
			'fn setCellOwner(c: u32, v: i32) { CELLI[c * CS] = v; }\n' +
			'fn setCellSpawnSlot(c: u32, v: i32) { CELLI[c * CS + 3u] = v; }\n' +
			'fn setCellGapPlate(c: u32, v: i32) { CELLI[c * CS + 4u] = v; }\n' +
			'fn setCellGapDonor(c: u32, k: u32, v: i32) { CELLI[c * CS + 5u + k] = v; }\n' +
			'fn setCellPacked(c: u32, v: i32) { CELLI[c * CS + 8u] = v; }\n' +
			'fn setCellDistance(c: u32, v: f32) { CELLI[c * CS + 9u] = i32(v * 256.0); }\n' +
			'fn setCellGapTime(c: u32, v: f32) { CELLI[c * CS + 10u] = i32(v * 100000.0); }\n' +
			'fn setCellSpread(c: u32, v: f32) { CELLI[c * CS + 11u] = i32(v * 256.0); }\n' +
			'fn setCellGapDonorN(c: u32, v: i32) { CELLI[c * CS + 12u] = v; }\n' +
			'fn packCell(dist: i32, frames: u32) -> i32 {\n' +
			'	return (dist & 3) | (i32(min(frames, 0xffffu)) << 4);\n' +
			'}\n';
	},
	cell: function (b) {
		return CommonWGSL.cellF(b) + CommonWGSL.cellI(b);
	},
	edges: function (b) {
		return '@group(0) @binding(' + b.edges + ') var<storage, read_write> EDGES: array<i32>;\n' +
			'fn edgeRelN(e: u32) -> f32 { return bitcast<f32>(EDGES[e * 4u]); }\n' +
			'fn edgeRelT(e: u32) -> f32 { return bitcast<f32>(EDGES[e * 4u + 1u]); }\n' +
			'fn edgeType(e: u32) -> i32 { return EDGES[e * 4u + 2u] & 0xff; }\n' +
			'fn edgePol(e: u32) -> i32 { return (EDGES[e * 4u + 2u] >> 8) - 1; }\n' +
			'fn setEdgeRel(e: u32, n: f32, t: f32) { EDGES[e * 4u] = bitcast<i32>(n); EDGES[e * 4u + 1u] = bitcast<i32>(t); }\n' +
			'fn setEdgeType(e: u32, t: i32) { EDGES[e * 4u + 2u] = (EDGES[e * 4u + 2u] & bitcast<i32>(0xffffff00u)) | (t & 0xff); }\n' +
			'fn setEdgePol(e: u32, p: i32) { EDGES[e * 4u + 2u] = (EDGES[e * 4u + 2u] & bitcast<i32>(0xffff00ffu)) | (((p + 1) & 0xff) << 8); }\n';
	},
	// bin/scan accessors. Both live behind atomics: counts and cursors are incremented
	// concurrently, and the belt/rift mark bits are OR-ed in from per-edge kernels.
	bins: function (b) {
		return '@group(0) @binding(' + b.bins + ') var<storage, read_write> BINS: array<atomic<i32>>;\n' +
			'@group(0) @binding(' + b.scan + ') var<storage, read_write> SCAN: array<atomic<i32>>;\n' +
			'fn scanIn(i: u32) -> i32 { return atomicLoad(&SCAN[i]); }\n' +
			'fn scanOut(i: u32) -> i32 { return atomicLoad(&SCAN[NMAX + i]); }\n' +
			'fn binOffset(c: u32) -> i32 { return atomicLoad(&SCAN[NMAX + c]); }\n' +
			'fn binEnd(c: u32) -> i32 { return atomicLoad(&SCAN[NMAX + c + 1u]); }\n' +
			'fn binEntry(at: u32) -> i32 { return atomicLoad(&BINS[V + at]); }\n' +
			'fn setBinEntry(at: u32, v: i32) { atomicStore(&BINS[V + at], v); }\n';
	},
	scanAlone: function (b) {
		return '@group(0) @binding(' + b.scan + ') var<storage, read_write> SCAN: array<atomic<i32>>;\n' +
			'fn scanIn(i: u32) -> i32 { return atomicLoad(&SCAN[i]); }\n' +
			'fn scanOut(i: u32) -> i32 { return atomicLoad(&SCAN[NMAX + i]); }\n';
	},
	lose: function (b) {
		return '@group(0) @binding(' + b.lose + ') var<storage, read_write> LOSE: array<i32>;\n' +
			'fn loseList(at: u32) -> i32 { return LOSE[at]; }\n' +
			'fn setLoseList(at: u32, v: i32) { LOSE[at] = v; }\n' +
			'fn loseWFeed(w: u32) -> f32 { return bitcast<f32>(LOSE[COLCAP + w]); }\n' +
			'fn setLoseWFeed(w: u32, v: f32) { LOSE[COLCAP + w] = bitcast<i32>(v); }\n' +
			'fn loseWCount(w: u32) -> i32 { return LOSE[COLCAP * 2u + w]; }\n' +
			'fn setLoseWCount(w: u32, v: i32) { LOSE[COLCAP * 2u + w] = v; }\n';
	},
	reduce: function (b, l) {
		return '@group(0) @binding(' + b.reduceF + ') var<storage, read_write> RED: array<f32>;\n' +
			'const NWG10: u32 = ' + l.nwg10 + 'u;\n' +
			'const CHUNK10: u32 = ' + l.chunk10 + 'u;\n' +
			'const CHUNK10E: u32 = ' + l.chunk10e + 'u;\n' +
			'const NWGD: u32 = ' + l.nwgD + 'u;\n' +
			'const CHUNKD: u32 = ' + l.chunkD + 'u;\n' +
			'const RED_K10: u32 = 0u;\n' +
			'const RED_SUB: u32 = NWG10 * PLATECAP * 12u;\n' +
			'const RED_DIAGCOL: u32 = RED_SUB + NWG10 * PLATECAP;\n' +
			'const RED_DIAGCELL: u32 = RED_DIAGCOL + NWGD * 12u;\n\n' +
			'const NWGL: u32 = ' + l.nwgL + 'u;\n' +
			'const CHUNKL: u32 = ' + l.chunkL + 'u;\n' +
			'const RED_LEDGER: u32 = RED_DIAGCELL + NWGD * 4u;\n' +
			'const RED_LPART: u32 = RED_LEDGER + 7u * COLCAP;\n' +
			'// Mass ledgers run ~1e14-1e15: fixed point overflows even i64, so each\n' +
			'// column accumulates an f32 delta here (one writer per column per kernel)\n' +
			'// and ledgerReduce folds them, in fixed order, into an f64-like hi/lo total.\n' +
			'fn addLedger(k: u32, i: u32, v: f32) { let a = RED_LEDGER + k * COLCAP + i; RED[a] = RED[a] + v; }\n';
	},
	frameIn: function (b) {
		return '@group(0) @binding(' + b.frameIn + ') var<storage, read> FIN: array<f32>;\n' +
			'const F_T: u32 = 0u;\n' +
			'const F_DT: u32 = 1u;\n' +
			'const F_TM: u32 = 2u;\n' +
			'const F_SCALE: u32 = 3u;\n' +
			'const F_SPEED: u32 = 4u;\n' +
			'const F_INVSIG: u32 = 5u;\n' +
			'const F_WAVEDIR: u32 = 8u;\n' +
			'const F_WAVEFREQ: u32 = 32u;\n' +
			'const F_WAVEPHASE: u32 = 40u;\n' +
			'const F_WAVEAMP: u32 = 48u;\n' +
			'const F_PLUME: u32 = 56u;\n' +
			'const F_PLUMEN: u32 = 72u;\n' +
			'const F_A00: u32 = 73u;\n' +
			'fn fT() -> f32 { return FIN[0u]; }\n' +
			'fn fDT() -> f32 { return FIN[1u]; }\n' +
			'fn fTM() -> f32 { return FIN[2u]; }\n' +
			'fn fScale() -> f32 { return FIN[3u]; }\n' +
			'fn fSpeed() -> f32 { return FIN[4u]; }\n' +
			'fn fInvSig() -> f32 { return FIN[5u]; }\n' +
			'fn fPlates() -> u32 { return u32(FIN[6u]); }\n' +
			'fn fFrame() -> u32 { return u32(FIN[7u]); }\n' +
			'fn plumeCount() -> u32 { return u32(FIN[72u]); }\n' +
			'fn fA00() -> f32 { return FIN[F_A00]; }\n';
	},
	frameOut: function (b, l) {
		return '@group(0) @binding(' + b.frameOut + ') var<storage, read_write> FOUT: array<atomic<i32>>;\n' +
			'const FO_N: u32 = 0u;\n' +
			'const FO_OVERLAPS: u32 = 1u;\n' +
			'const FO_DEATHS: u32 = 2u;\n' +
			'const FO_CHANGES: u32 = 3u;\n' +
			'const FO_SPAWNS: u32 = 4u;\n' +
			'const FO_MAXSPD: u32 = 5u;\n' +
			'const FO_FINITE: u32 = 6u;\n' +
			'const FO_L0: u32 = ' + l.foLedger0 + 'u;\n' +
			'const FO_PLATE0: u32 = ' + l.foPlate0 + 'u;\n' +
			'fn aliveN() -> u32 { return u32(atomicLoad(&FOUT[FO_N])); }\n' +
			'fn plateCells(p: u32) -> i32 { return atomicLoad(&FOUT[FO_PLATE0 + p * 5u]); }\n' +
			'fn addPlateCells(p: u32) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u], 1); }\n' +
			'fn subCount(p: u32) -> i32 { return atomicLoad(&FOUT[FO_PLATE0 + p * 5u + 1u]); }\n' +
			'fn addSubCount(p: u32) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u + 1u], 1); }\n' +
			'fn arcFeedN(p: u32) -> i32 { return atomicLoad(&FOUT[FO_PLATE0 + p * 5u + 2u]); }\n' +
			'fn addArcFeedN(p: u32) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u + 2u], 1); }\n' +
			'fn addDeath() { atomicAdd(&FOUT[FO_DEATHS], 1); }\n' +
			'fn addOverlap() { atomicAdd(&FOUT[FO_OVERLAPS], 1); }\n' +
			'fn addChange() { atomicAdd(&FOUT[FO_CHANGES], 1); }\n' +
			'fn maxSpeed(speed: f32) { atomicMax(&FOUT[FO_MAXSPD], i32(speed * MAXSPEEDSCALE)); }\n' +
			'fn markBad() { atomicOr(&FOUT[FO_FINITE], 1); }\n' +
			'fn addLost(p: u32) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u + 3u], 1); }\n' +
			'fn addSpawned(p: u32) { atomicAdd(&FOUT[FO_PLATE0 + p * 5u + 4u], 1); }\n';
	},
	diag: function (b) {
		return '@group(0) @binding(' + b.diagOut + ') var<storage, read_write> DIAG: array<f32>;\n' +
			'const D_MEANV: u32 = 0u;\n' +
			'const D_MASSFEL: u32 = 1u;\n' +
			'const D_MASSMAF: u32 = 2u;\n' +
			'const D_MASSSED: u32 = 3u;\n' +
			'const D_ORE0: u32 = 4u;\n' +
			'const D_GAPS: u32 = 10u;\n' +
			'const D_COLS: u32 = 11u;\n';
	},
	// Shared math that needs no buffer declarations.
	math: function () {
		return 'fn qrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {\n' +
			'	let t = 2.0 * cross(q.xyz, v);\n' +
			'	return v + q.w * t + cross(q.xyz, t);\n' +
			'}\n' +
			'fn qrotInv(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {\n' +
			'	let t = 2.0 * cross(-q.xyz, v);\n' +
			'	return v + q.w * t + cross(-q.xyz, t);\n' +
			'}\n' +
			'fn smoothstep01(x: f32, lo: f32, hi: f32) -> f32 {\n' +
			'	let t = clamp((x - lo) / (hi - lo), 0.0, 1.0);\n' +
			'	return t * t * (3.0 - 2.0 * t);\n' +
			'}\n' +
			'fn hashCell(cell: u32, frame: u32) -> u32 {\n' +
			'	let h = ((cell ^ 0x9E3779B1u) * 0x85EBCA6Bu) ^ ((frame + 1u) * 0xC2B2AE35u);\n' +
			'	return h ^ (h >> 15);\n' +
			'}\n' +
			'fn nanF32() -> f32 { var u: u32 = 0x7fc00000u; return bitcast<f32>(u); }\n' +
			// Tint/SwiftShader fold `x != x` to false under a no-NaN assumption (measured:
			// n != n is false while n == n is also false), so NaN guards must go through the
			// bit pattern - integer compares have no fast-math escape hatch.
			'fn isNanF(x: f32) -> bool { let u = bitcast<u32>(x); return (u & 0x7f800000u) == 0x7f800000u && (u & 0x007fffffu) != 0u; }\n' +
			// WebGPU only promises ~2^-11 accuracy for sin/cos (measured 1.9e-4 worst on
			// SwiftShader, 2.6e-5 even near zero), so kernels that must track the f64 CPU
			// reference use these instead. cosx: Cody-Waite reduction with a two-word 2pi
			// (callers keep |x| <= 16), then an even Taylor series in y = t*t whose
			// truncation is < 1e-12 on [-pi/2, pi/2]. sinx: callers pass |x| <= 0.02
			// (quaternion increments), where the plain series is exact to < 1e-16.
			'fn cosx(x: f32) -> f32 {\n' +
			'\tvar t = x;\n' +
			'\tif (abs(x) > 1.5707963267948966) {\n' +
			'\t\tlet r = round(x * 0.15915494309189535);\n' +
			'\t\tt = fma(-r, 6.2831854820251465, x);\n' +
			'\t\tt = fma(-r, -1.7484555e-07, t);\n' +
			'\t}\n' +
			'\tvar s = 1.0;\n' +
			'\tif (abs(t) > 1.5707963267948966) {\n' +
			'\t\tt = t - sign(t) * 3.141592653589793;\n' +
			'\t\ts = -1.0;\n' +
			'\t}\n' +
			'\tlet y = t * t;\n' +
			'\treturn s * (1.0 + y * (-0.5 + y * (0.041666666666666664 + y * (-0.001388888888888889 + y * (2.48015873015873e-05 + y * (-2.7557319223985893e-07 + y * (2.0876756987868099e-09 - y * 1.1470745597729725e-11)))))));\n' +
			'}\n' +
			'fn sinx(x: f32) -> f32 {\n' +
			'\tlet y = x * x;\n' +
			'\treturn x * (1.0 + y * (-0.16666666666666666 + y * (0.008333333333333333 + y * (-0.0001984126984126984 + y * 2.755731922398589e-06))));\n' +
			'}\n' +
			// Kahan compensated sum for vec3 accumulators: chunk partials stay at ~1 ulp
			// so the f32 K10 solve can track the f64 reference.
			'fn kAdd(acc: ptr<function, f32>, comp: ptr<function, f32>, v: f32) {\n' +
			'	let y = v - (*comp);\n' +
			'	let t = (*acc) + y;\n' +
			'	*comp = (t - (*acc)) - y;\n' +
			'	*acc = t;\n' +
			'}\n' +
			'fn kAdd3(acc: ptr<function, vec3<f32>>, comp: ptr<function, vec3<f32>>, v: vec3<f32>) {\n' +
			'\tlet y = v - (*comp);\n' +
			'\tlet t = (*acc) + y;\n' +
			'\t*comp = (t - (*acc)) - y;\n' +
			'\t*acc = t;\n' +
			'}\n' +
			'fn solve3(m0: vec3<f32>, m1: vec3<f32>, m2: vec3<f32>, b: vec3<f32>) -> vec3<f32> {\n' +
			'	let det = m0.x * (m1.y * m2.z - m1.z * m2.y) - m0.y * (m1.x * m2.z - m1.z * m2.x) + m0.z * (m1.x * m2.y - m1.y * m2.x);\n' +
			'	if (abs(det) < 1e-30) { return vec3<f32>(0.0); }\n' +
			'	let inv = 1.0 / det;\n' +
			'	let x = ((m1.y * m2.z - m1.z * m2.y) * b.x + (m0.z * m2.y - m0.y * m2.z) * b.y + (m0.y * m1.z - m0.z * m1.y) * b.z) * inv;\n' +
			'	let y = ((m1.z * m2.x - m1.x * m2.z) * b.x + (m0.x * m2.z - m0.z * m2.x) * b.y + (m0.z * m1.x - m0.x * m1.z) * b.z) * inv;\n' +
			'	let z = ((m1.x * m2.y - m1.y * m2.x) * b.x + (m0.y * m2.x - m0.x * m2.y) * b.y + (m0.x * m1.y - m0.y * m1.x) * b.z) * inv;\n' +
			'	return vec3<f32>(x, y, z);\n' +
			'}\n';
	},
	// Assemble a kernel module: params + math + the buffer groups named in `groups`.
	module: function (groups, p, l) {
		var b = CommonWGSL.B, out = CommonWGSL.params(p, l) + CommonWGSL.math();
		for (var i = 0; i < groups.length; i++) out += CommonWGSL[groups[i]](b, l);
		return out;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = CommonWGSL;

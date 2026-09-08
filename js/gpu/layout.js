/* gpu/layout.js — one table describing every GPU field, from which all buffer sizes, JS
   offsets and the WGSL constant block are derived. JS and WGSL cannot drift apart because
   neither names a byte offset twice.

   WebGPU guarantees only 8 storage buffers per shader stage and 128 MiB per binding, so the
   state lives in five u32 arenas addressed by word offset:
     S  static grid coefficients (built once per level/seed)
     C  columns (Lagrangian crust)
     X  cells (Eulerian grid fields)
     B  plates, bins and gather scratch
     M  misc: mantle tables, free list, scan scratch, globals

   Cross-thread accumulations use integer atomics with fixed units so results are exact and
   order-free: crust and mobile in millimetres (u32), zDyn in centimetres (i32), potentials in
   1e-6 (u32), plate M in 1e7 m², rhs in 1e5, pair length in 1 m, pair velocity in 1e3,
   subRate in 1 m/Myr, arcFeed in 1e-2. Ledgers and diagnostic sums are u32 lo/hi pairs. */
var LayoutParams = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;

var ARENA_NAMES = ['S', 'C', 'X', 'B', 'M'];
var SCAN_WG = 256;

function GpuLayout(grid) {
	this.V = grid.V;
	this.colCap = Math.ceil(grid.V * 1.5);
	this.plateCap = LayoutParams.plateCap;
	this.lookupW = grid.lookupW;
	this.lookupH = grid.lookupH;
	this.arenaWords = [0, 0, 0, 0, 0];
	this.field = {};
	var V = this.V, C = this.colCap, P = this.plateCap, W = this.lookupW * this.lookupH;
	// Static grid. spawnLimit is rSpawn·nbrDist in metres so the gap scan compares distances.
	this.add('pos', 0, 4, V); this.add('ring', 0, 6, V); this.add('ringN', 0, 1, V);
	this.add('nbrDist', 0, 1, V); this.add('edgeLen', 0, 6, V);
	this.add('faceN', 0, 18, V); this.add('faceT', 0, 18, V); this.add('fluxN', 0, 18, V);
	this.add('collapseW', 0, 6, V); this.add('gradInv', 0, 9, V);
	this.add('gapLimit2', 0, 1, V); this.add('contactLimit2', 0, 1, V); this.add('spawnLimit', 0, 1, V);
	this.add('lookup', 0, 1, W);
	// Columns.
	this.add('body', 1, 4, C); this.add('world', 1, 4, C); this.add('area', 1, 1, C);
	this.add('fel', 1, 1, C); this.add('maf', 1, 1, C); this.add('sed', 1, 1, C);
	this.add('age', 1, 1, C); this.add('damage', 1, 1, C); this.add('fert', 1, 1, C);
	this.add('ore', 1, 6, C); this.add('zdyn', 1, 1, C); this.add('zdynNext', 1, 1, C);
	this.add('alive', 1, 1, C); this.add('plate', 1, 1, C); this.add('cell', 1, 1, C);
	this.add('consumed', 1, 1, C);
	// Cells.
	this.add('owner', 2, 1, V); this.add('dist', 2, 1, V); this.add('cellPlate', 2, 1, V);
	this.add('relN', 2, 6, V); this.add('relT', 2, 6, V); this.add('eType', 2, 6, V);
	this.add('pol', 2, 6, V); this.add('trench', 2, 1, V); this.add('ext', 2, 1, V);
	this.add('plumeT', 2, 1, V); this.add('u', 2, 4, V); this.add('vel', 2, 4, V);
	this.add('wEq', 2, 4, V); this.add('z', 2, 1, V); this.add('wet', 2, 1, V);
	this.add('gradZ', 2, 4, V); this.add('slope', 2, 1, V); this.add('low', 2, 1, V);
	this.add('belt', 2, 1, V);
	this.add('mobile', 2, 1, V); this.add('mobileFel', 2, 1, V); this.add('mobilePla', 2, 1, V);
	this.add('inflow', 2, 1, V); this.add('inflowFel', 2, 1, V); this.add('inflowPla', 2, 1, V);
	this.add('outflow', 2, 1, V); this.add('outflowFel', 2, 1, V); this.add('outflowPla', 2, 1, V);
	this.add('gapFrames', 2, 1, V); this.add('gapTime', 2, 1, V);
	this.add('gapPlate', 2, 1, V); this.add('gapDonor', 2, 3, V); this.add('gapDonorN', 2, 1, V);
	this.add('doseArc', 2, 1, V); this.add('doseBas', 2, 1, V); this.add('dosePla', 2, 1, V);
	// Plates, bins, gather lists.
	this.add('q', 3, 4, P); this.add('omega', 3, 4, P); this.add('omegaT', 3, 4, P);
	this.add('m6', 3, 6, P); this.add('rhs', 3, 3, P);
	this.add('cells', 3, 1, P); this.add('spawned', 3, 1, P); this.add('lost', 3, 1, P);
	this.add('birth', 3, 1, P); this.add('parent', 3, 1, P); this.add('dead', 3, 1, P);
	this.add('subRate', 3, 1, P); this.add('subCount', 3, 1, P);
	this.add('arcFeed', 3, 1, P); this.add('arcFeedN', 3, 1, P);
	this.add('pairLen', 3, 1, P * P); this.add('pairVel', 3, 1, P * P); this.add('pairOk', 3, 1, P * P);
	this.add('binCount', 3, 1, V); this.add('binOffset', 3, 1, V + 1); this.add('binEntries', 3, 1, C);
	this.add('glCount', 3, 1, C); this.add('glCursor', 3, 1, C + 1); this.add('glList', 3, 1, C);
	this.add('spawnFlag', 3, 1, V); this.add('spawnSlot', 3, 1, V + 1);
	// Misc. The scan runs on bins (V+1), spawn flags (V) and gather lists (C): size for the longest.
	var scanLen = Math.max(V + 1, C + 1);
	this.scanBlocks = Math.ceil(scanLen / SCAN_WG);
	this.add('waveDir', 4, 4, 8); this.add('waveFreq', 4, 1, 8);
	this.add('wavePhase', 4, 1, 8); this.add('waveAmp', 4, 1, 8);
	this.add('plume', 4, 4, 8); this.add('plumeCount', 4, 1, 1);
	this.add('freeList', 4, 1, C); this.add('scanPart', 4, 1, this.scanBlocks);
	this.addGlobals();
	this.arenaBytes = this.arenaWords.map(function (w) { return w * 4; });
}

GpuLayout.prototype.add = function (name, arena, stride, count) {
	if (this.field[name] !== undefined) throw new Error('duplicate gpu field ' + name);
	if (!(stride > 0) || !(count > 0)) throw new Error('bad gpu field ' + name);
	this.field[name] = { arena: arena, offset: this.arenaWords[arena], stride: stride, count: count };
	this.arenaWords[arena] += stride * count;
};

GpuLayout.prototype.addGlobals = function () {
	var names = ['gT', 'gDt', 'gTm', 'gTm0', 'gSpeed', 'gRidge', 'gColl', 'gSlab', 'gAlpha',
		'gRelaxDyn', 'gPlumeRelax', 'gDynDecay', 'gInvSig', 'gMantleScale', 'gRadius', 'gCap',
		'gColHigh', 'gPlumeCount', 'gPlateCount', 'gFrame', 'gFreeCount',
		'gFinite', 'gClimbOver', 'gGaps', 'gSpawns', 'gDeaths',
		'gOverlaps', 'gTypeChanges', 'gSpeedSumLo', 'gSpeedSumHi', 'gSpeedN', 'gMaxSpeed',
		'gMaxClimb', 'gSpawnBump', 'gSedCut',
		'gLedProdFelLo', 'gLedProdFelHi', 'gLedProdMafLo', 'gLedProdMafHi',
		'gLedEroFelLo', 'gLedEroFelHi', 'gLedEroMafLo', 'gLedEroMafHi',
		'gLedSubMafLo', 'gLedSubMafHi', 'gLedSubSedLo', 'gLedSubSedHi',
		'gLedSubAreaLo', 'gLedSubAreaHi',
		'gMassFelLo', 'gMassFelHi', 'gMassMafLo', 'gMassMafHi', 'gMassSedLo', 'gMassSedHi'];
	// Ore sums: Lo/Hi interleaved so the shader indexes base + 2k / base + 2k + 1.
	for (var k = 0; k < 6; k++) names.push('gOreSumLo' + k, 'gOreSumHi' + k);
	for (var n = 0; n < names.length; n++) this.add(names[n], 4, 1, 1);
	this.globals = names;
};

// Word address helpers shared by upload/readback plans and patch-free event uploads.
GpuLayout.prototype.at = function (name, index) {
	var f = this.field[name];
	return { arena: f.arena, word: f.offset + (index || 0) * f.stride, words: f.stride * (index === undefined ? f.count : 1) };
};

GpuLayout.prototype.wgsl = function () {
	var out = '', a, f, name;
	for (a = 0; a < 5; a++) {
		out += 'const ' + ARENA_NAMES[a] + 'V = ' + this.arenaWords[a] + 'u;\n';
	}
	for (name in this.field) {
		f = this.field[name];
		out += 'const A_' + name.toUpperCase() + ' = ' + f.offset + 'u;\n';
		if (f.stride !== 1 || f.count !== 1) out += 'const N_' + name.toUpperCase() + ' = ' + f.stride + 'u;\n';
	}
	return out;
};

GpuLayout.prototype.report = function () {
	var lines = [], total = 0, a;
	for (a = 0; a < 5; a++) {
		total += this.arenaBytes[a];
		lines.push(ARENA_NAMES[a] + ' ' + (this.arenaBytes[a] / 1048576).toFixed(1) + ' MiB');
	}
	lines.push('total ' + (total / 1048576).toFixed(1) + ' MiB');
	return lines.join(' · ');
};

if (typeof module !== 'undefined' && module.exports) module.exports = { GpuLayout: GpuLayout, ARENA_NAMES: ARENA_NAMES, SCAN_WG: SCAN_WG };

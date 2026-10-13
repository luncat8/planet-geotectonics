var ResolutionQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var ResolutionParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var ResolutionColumns = typeof module !== 'undefined' && module.exports ? require('./columns.js') : Columns;
var ResolutionMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var ResolutionEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var ResolutionSurface = typeof module !== 'undefined' && module.exports ? require('./surface.js') : Surface;
var ResolutionDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var ResolutionState = typeof module !== 'undefined' && module.exports ? require('./state.js') : State;

// Live resolution transfer (0.7.0). A level change moves the FRAME, not the crust: columns are
// Lagrangian and carry their own area and plate-frame direction, so a coarser level aggregates
// several columns into one cell and a finer level splits one column's footprint over several
// cells. Both directions are one rule - the shard map - and both conserve `A0ref x thickness`
// exactly, because that is the volume the sim's own mass ledgers count (js/diag.js). Nothing
// here interpolates a thickness, advects a grid-indexed field or advances the clock: a transfer
// is a re-partition, and the caller commits it as a swap (0.7.0-plan-live-resolution.md).
var Resolution = (function () {
	// Deposit identity is the plate-frame direction quantized at this scale (Deposits
	// BODY_SCALE). The transfer never re-quantizes an anchor; it reports how far one moved, and
	// tests/resolution.js pins this constant against the catalogue's own anchor.
	var ANCHOR_SCALE = 32768;
	// Every State field belongs to exactly one class, so a new field cannot be added without a
	// decision about it. `inventory` reports this table and lists the fields it does not know.
	var GROUPS = [
		{ group: 'crust', cls: 'material', note: 'volume conserved per family', fields: ['hFel', 'hMaf', 'hSed'] },
		{ group: 'mobile', cls: 'material', note: 'grid-indexed load, conserved', fields: ['mobile', 'mobileFel', 'mobilePla'] },
		{ group: 'column', cls: 'derived', note: 'placed on the target frame', fields: ['body', 'world', 'plate', 'cell', 'area', 'alive'] },
		{ group: 'columnScalar', cls: 'per-column', note: 'a shard carries the parent value', fields: ['age', 'fert', 'damage', 'zDyn', 'oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'] },
		{ group: 'plateTable', cls: 'plate', note: 'same plates, same quaternions', fields: ['plateCount', 'q', 'omega', 'omegaTarget', 'seeds', 'plateBirth', 'plateParent', 'plateDead', 'plateSpawned', 'plateLost', 'plateCells', 'subRate', 'subCount', 'arcFeed', 'arcFeedN', 'sutureTime', 'pairLen', 'pairVel', 'pairOk', 'rotRec', 'rotRemap', 'plateRemap'] },
		{ group: 'clock', cls: 'world', note: 'never stepped by a transfer', fields: ['t', 'frame', 'rng', 'seed', 'lastEvent', 'ckptDue', 'ckptCap', 'ckptBytes'] },
		{ group: 'thermal', cls: 'world', fields: ['Tm', 'Tm0', 'cooling', 'hotStart', 'mantleScale', 'prescribedOmega', 'rotationHistory', 'fixedOmega', 'epoch0', 'reconEpoch'] },
		{ group: 'mantle', cls: 'world', note: 'the mantle field is the same field', fields: ['plumeCount', 'plumePos', 'plumeBirth', 'plumeLife', 'plumeStr', 'waveDir0', 'waveAxis', 'waveDir', 'wavePeriod', 'waveFreq', 'wavePhase', 'waveAmp'] },
		{ group: 'counters', cls: 'world', fields: ['spawns', 'deaths', 'overlaps', 'splits', 'merges', 'typeChanges', 'meanSpeed', 'maxSpeed', 'gaps', 'maxClimb', 'finite', 'rigidError', 'quatError'] },
		{ group: 'history', cls: 'world', note: 'per-frame scalars, level-independent', fields: ['histT', 'histMeanV', 'histMaxV', 'histGaps', 'histPlates', 'histChanges', 'histCols', 'histI', 'histN'] },
		{ group: 'ledger', cls: 'world', note: 'volumes, carried then re-checked', fields: ['producedFel', 'producedMaf', 'erodedFel', 'erodedMaf', 'subductedMaf', 'subductedSed', 'subductedArea', 'massFel', 'massMaf', 'massSed', 'massFel0', 'massMaf0', 'massSed0', 'regridFel', 'regridMaf', 'regridSed'] },
		{ group: 'elevationFrame', cls: 're-derived', note: 'from the columns, never carried', fields: ['z', 'wet', 'gradZ', 'slope', 'low'] },
		{ group: 'coverageFrame', cls: 're-derived', fields: ['owner', 'distance', 'cellPlate', 'gapFrames', 'gapTime'] },
		{ group: 'boundaryFrame', cls: 're-derived', fields: ['edgeType', 'polarity', 'trenchDist', 'vel', 'uMantle', 'wEq', 'relN', 'relT', 'ext', 'plumeT', 'belt'] },
		{ group: 'limiter', cls: 're-derived', note: 'grid function', fields: ['gapLimit2', 'contactLimit2'] },
		{ group: 'geometry', cls: 're-derived', note: 'from the target grid', fields: ['n', 'grid', 'A0ref', 'colCap', 'plateCap'] },
		{ group: 'viewRing', cls: 'view', note: 'level-stamped blobs, restarted', fields: ['ckpt', 'ckptT', 'ckptI', 'ckptN', 'ckptSlots', 'oreSum'] },
		{ group: 'erosionScratch', cls: 'scratch', fields: ['eroSed', 'eroFel', 'eroPla', 'stay', 'stayFel', 'stayPla', 'outflow', 'outflowFel', 'outflowPla', 'zDynNext', 'collapseDelta', 'collapseDeltaSed'] },
		{ group: 'eventScratch', cls: 'scratch', fields: ['riftZone', 'gapScan', 'gapPlate', 'gapDonor', 'gapDonorN', 'spawnSlot', 'corridor', 'compLabel', 'compSize', 'compPlate', 'queue', 'count', 'offset', 'cursor', 'entries', 'climbHistogram', 'plateCellList', 'plateCellStart', 'plateCellCursor', 'plateCellFrame', 'orphanTally', 'orphanIndex', 'pairScratch', 'fitM', 'fitRhs', 'fitOmega', 'openSum', 'openLen', 'openFitted', 'consumedBy', 'loserList', 'loserStart', 'loserCursor', 'colRemap', 'scratch'] },
		{ group: 'solveScratch', cls: 'scratch', fields: ['M', 'rhs'] }
	];
	var FIELD_CLASS = {}, FIELD_GROUP = {};
	for (var gi = 0; gi < GROUPS.length; gi++) {
		for (var fi = 0; fi < GROUPS[gi].fields.length; fi++) {
			FIELD_CLASS[GROUPS[gi].fields[fi]] = GROUPS[gi].cls;
			FIELD_GROUP[GROUPS[gi].fields[fi]] = GROUPS[gi].group;
		}
	}
	var MATERIAL = ['hFel', 'hMaf', 'hSed'];
	var MOBILE = ['mobile', 'mobileFel', 'mobilePla'];
	var COLUMN_SCALAR = ['age', 'fert', 'damage', 'zDyn', 'oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];
	// Plate-table entries copied verbatim. plateCells is recomputed by the coverage pass; the
	// pair and solver scratch is per-cycle working memory and starts zeroed.
	var PLATE_VERBATIM = ['q', 'omega', 'omegaTarget', 'seeds', 'plateBirth', 'plateParent', 'plateDead',
		'plateSpawned', 'plateLost', 'subRate', 'subCount', 'arcFeed', 'arcFeedN', 'sutureTime',
		'pairLen', 'pairVel', 'pairOk', 'rotRemap', 'plateRemap'];
	var PLATE_OBJECTS = ['rotRec'];
	var WORLD_SCALAR = ['t', 'frame', 'rng', 'seed', 'lastEvent', 'ckptDue', 'ckptCap', 'ckptBytes',
		'Tm', 'Tm0', 'cooling', 'hotStart', 'mantleScale', 'prescribedOmega', 'rotationHistory',
		'fixedOmega', 'epoch0', 'reconEpoch', 'plateCount',
		'spawns', 'deaths', 'overlaps', 'splits', 'merges', 'typeChanges', 'meanSpeed', 'maxSpeed',
		'producedFel', 'producedMaf', 'erodedFel', 'erodedMaf', 'subductedMaf', 'subductedSed',
		'subductedArea', 'massFel', 'massMaf', 'massSed', 'massFel0', 'massMaf0', 'massSed0',
		'regridFel', 'regridMaf', 'regridSed', 'plumeCount'];
	var WORLD_ARRAYS = ['plumePos', 'plumeBirth', 'plumeLife', 'plumeStr', 'waveDir0', 'waveAxis',
		'waveDir', 'wavePeriod', 'waveFreq', 'wavePhase', 'waveAmp', 'histT', 'histMeanV', 'histMaxV',
		'histGaps', 'histPlates', 'histChanges', 'histCols'];

	// The grid's own nearest-cell raster is the seed, read as the best of the four texels around
	// the direction: at the pole corner its chained search can land a whole cap away, and one
	// extra texel read is cheaper than a long climb from a bad seed (the heightfield builder's
	// own fix, 0.5.6).
	function lookupSeed(grid, x, y, z) {
		var lon = Math.atan2(z, x), lat = Math.asin(Math.max(-1, Math.min(1, y)));
		var lw = grid.lookupW, lh = grid.lookupH, pos = grid.pos;
		var sx = Math.floor((lon / (Math.PI * 2) + 0.5) * lw), sy = Math.floor((lat / Math.PI + 0.5) * lh);
		sx = sx < 0 ? 0 : sx >= lw - 1 ? lw - 2 : sx;
		sy = sy < 0 ? 0 : sy >= lh - 1 ? lh - 2 : sy;
		var best = -2, cell = 0;
		for (var j = 0; j < 2; j++) {
			for (var i = 0; i < 2; i++) {
				var cand = grid.lookup[(sy + j) * lw + sx + i];
				var b = cand * 3, dot = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
				if (dot > best) { best = dot; cell = cand; }
			}
		}
		return cell;
	}
	function climb(grid, x, y, z, seed) {
		var pos = grid.pos, ring = grid.ring, ringN = grid.ringN;
		var cell = seed, b = cell * 3;
		var best = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
		for (var it = 0; it < 64; it++) {
			var moved = false, m = ringN[cell], rb = cell * 6;
			for (var k = 0; k < m; k++) {
				var cand = ring[rb + k];
				if (cand < 0) continue;
				var c = cand * 3, dot = pos[c] * x + pos[c + 1] * y + pos[c + 2] * z;
				if (dot > best) { best = dot; cell = cand; moved = true; }
			}
			if (!moved) break;
		}
		return cell;
	}
	// Nearest cell of `grid` to a unit direction. Setup-time only: the page calls it once per
	// cell of the smaller world, not per frame.
	function nearestCell(grid, x, y, z) {
		var n = Math.hypot(x, y, z) || 1;
		return climb(grid, x / n, y / n, z / n, lookupSeed(grid, x / n, y / n, z / n));
	}
	// Nearest alive column of `s` to a direction: the owner cell's bin and its two rings, which
	// is the widest neighbourhood a column can own, so three bin walks instead of a scan.
	function bestColumn(s, x, y, z, seedCell, list) {
		var g = s.grid, pos = s.world, ring = g.ring, ringN = g.ringN;
		var cells = list.list, n = 0, best = -2, owner = -1;
		cells[n++] = seedCell;
		var m0 = ringN[seedCell], base = seedCell * 6;
		for (var k = 0; k < m0; k++) {
			var near = ring[base + k];
			if (near < 0) continue;
			cells[n++] = near;
			var m1 = ringN[near], nb = near * 6;
			for (var l = 0; l < m1; l++) {
				var far = ring[nb + l];
				if (far >= 0) cells[n++] = far;
			}
		}
		for (var at = 0; at < n; at++) {
			var cell = cells[at], end = s.offset[cell + 1];
			for (var e = s.offset[cell]; e < end; e++) {
				var i = s.entries[e], b = i * 3;
				var dot = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
				if (dot > best) { best = dot; owner = i; }
			}
		}
		return owner;
	}
	// The guard for a target cell whose two-ring neighbourhood holds no column at all (a gap
	// wider than two cells). The transfer owes every target cell a source and every source a
	// target, so the question is answered rather than left as a hole.
	function nearestColumnGlobal(s, x, y, z) {
		var pos = s.world, best = -2, owner = -1;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var b = i * 3, dot = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
			if (dot > best) { best = dot; owner = i; }
		}
		return owner;
	}
	// Nearest covered target cell to a direction, searched in the two-ring neighbourhood of the
	// nearest cell. -1 when that whole neighbourhood is uncovered.
	function nearestCoveredCell(grid, covered, x, y, z) {
		var seed = nearestCell(grid, x, y, z);
		if (covered[seed]) return seed;
		var ring = grid.ring, ringN = grid.ringN, pos = grid.pos;
		var best = -2, owner = -1;
		var m0 = ringN[seed], base = seed * 6;
		for (var k = 0; k < m0; k++) {
			var cells = [ring[base + k]];
			if (cells[0] >= 0) {
				var m1 = ringN[cells[0]], b1 = cells[0] * 6;
				for (var l = 0; l < m1; l++) cells.push(ring[b1 + l]);
			}
			for (var at = 0; at < cells.length; at++) {
				var cell = cells[at];
				if (cell < 0 || !covered[cell]) continue;
				var b = cell * 3, dot = pos[b] * x + pos[b + 1] * y + pos[b + 2] * z;
				if (dot > best) { best = dot; owner = cell; }
			}
		}
		return owner;
	}
	function massOf(s) {
		var fel = 0, maf = 0, sed = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			fel += s.hFel[i]; maf += s.hMaf[i]; sed += s.hSed[i];
		}
		for (var c = 0; c < s.grid.V; c++) sed += s.mobile[c];
		return { fel: fel * s.A0ref, maf: maf * s.A0ref, sed: sed * s.A0ref };
	}
	function coverageCount(s) {
		var n = 0;
		for (var c = 0; c < s.grid.V; c++) if (s.owner[c] >= 0) n++;
		return n;
	}
	// Guarded first: a page-level transfer must never leave a half-written world behind, so a
	// target that cannot hold the source throws before anything is allocated.
	function checkTarget(src, grid) {
		if (!src || !src.grid || !src.alive) throw new TypeError('Resolution: source state required');
		if (!grid || !grid.pos || !Number.isInteger(grid.V) || grid.V < 1) throw new TypeError('Resolution: built target grid required');
		if (grid.level === src.grid.level) throw new RangeError('Resolution: source and target are both L' + grid.level);
	}
	// The shard maps. srcOf[c] is the source column that owns target cell c's own centre
	// direction; scOf[c] is the nearest source cell, for coverage and the grid-indexed load.
	// `share` counts the target cells an entry feeds, and `forced` carries the two cases the map
	// cannot name on its own - a source entry no target cell picked (aggregation) and a target
	// cell no column reached (the guard) - with the same weight rule, so both are placed rather
	// than dropped or double-counted.
	//
	// Coverage is a mask and moves like one: the finer frame inherits the source cell a target
	// cell sits in, and the coarser frame unions the source cells inside it. So a hole in the
	// source stays a hole and does not get filled with material borrowed from its rim, and a
	// covered region does not vanish because its target cell's own centre fell in a hole.
	function shard(src, grid) {
		var Vt = grid.V, Vs = src.grid.V, n = src.n, finer = Vt > Vs;
		var srcOf = new Int32Array(Vt).fill(-1);
		var scOf = new Int32Array(Vt).fill(-1);
		var covered = new Uint8Array(Vt);
		var shareCol = new Int32Array(n);
		var shareCell = new Int32Array(Vs);
		var forcedCell = new Int32Array(Vt + n), forcedCol = new Int32Array(Vt + n), forcedN = 0;
		var list = { list: new Int32Array(43) };
		// The source bins are the search structure for both maps. Rebuilding them touches only
		// per-step scratch (count/offset/cursor/entries), never a column field, and the next
		// step's MOVE/BIN rebuilds them anyway.
		ResolutionColumns.bin(src);
		var c, i;
		for (c = 0; c < Vt; c++) {
			var b = c * 3;
			var sc = nearestCell(src.grid, grid.pos[b], grid.pos[b + 1], grid.pos[b + 2]);
			scOf[c] = sc; shareCell[sc]++;
			var si = bestColumn(src, grid.pos[b], grid.pos[b + 1], grid.pos[b + 2], sc, list);
			covered[c] = finer ? (src.owner[sc] >= 0 ? 1 : 0) : (si >= 0 ? 1 : 0);
			// A cell that stays a hole takes no share: the shard count is the divisor of a
			// column's volume, so a hole that still counted would quietly delete that fraction
			// of it.
			if (si < 0 || !covered[c]) continue;
			srcOf[c] = si;
			shareCol[si]++;
		}
		for (c = 0; c < Vt; c++) {
			if (!covered[c] || srcOf[c] >= 0) continue;
			// A covered target cell always has a primary: its source cell is covered, so that
			// cell's bin holds at least the column that owns it. This is the guard for a state
			// whose bins and owner map disagree (a hand-edited test world, not a stepped one).
			var cb = c * 3;
			i = nearestColumnGlobal(src, grid.pos[cb], grid.pos[cb + 1], grid.pos[cb + 2]);
			if (i < 0) throw new Error('Resolution: no column to place in covered target cell ' + c);
			srcOf[c] = i;
			shareCol[i]++;
		}
		for (i = 0; i < n; i++) {
			if (!src.alive[i] || shareCol[i]) continue;
			var wb = i * 3;
			c = nearestCell(grid, src.world[wb], src.world[wb + 1], src.world[wb + 2]);
			// The material lands in a covered cell: an uncovered target cell is a hole, not a
			// destination. A column usually sits in a covered cell already; when a frame
			// mismatch leaves it on a rim, the nearest covered cell in the ring neighbourhood
			// takes it, and only a fully uncovered neighbourhood opens coverage rather than
			// dropping the column.
			if (!covered[c]) {
				var near = nearestCoveredCell(grid, covered, src.world[wb], src.world[wb + 1], src.world[wb + 2]);
				if (near < 0) { covered[c] = 1; } else { c = near; }
			}
			shareCol[i] = 1;
			forcedCell[forcedN] = c; forcedCol[forcedN] = i; forcedN++;
		}
		var cellForcedAt = new Int32Array(Vs), cellForcedFrom = new Int32Array(Vs), cellForcedN = 0;
		for (var s = 0; s < Vs; s++) {
			if (shareCell[s]) continue;
			if (!src.mobile[s] && !src.mobileFel[s] && !src.mobilePla[s]) continue;
			var sb = s * 3;
			cellForcedAt[cellForcedN] = nearestCell(grid, src.grid.pos[sb], src.grid.pos[sb + 1], src.grid.pos[sb + 2]);
			cellForcedFrom[cellForcedN] = s;
			cellForcedN++;
		}
		return { srcOf: srcOf, scOf: scOf, covered: covered, shareCol: shareCol, shareCell: shareCell,
			forcedCell: forcedCell, forcedCol: forcedCol, forcedN: forcedN,
			cellForcedAt: cellForcedAt, cellForcedFrom: cellForcedFrom, cellForcedN: cellForcedN };
	}
	// A fresh target state. Its procedural fill and RNG draws are overwritten rather than reused;
	// allocating it here is what makes the build side-effect free, because nothing below writes
	// to `src`.
	function blankState(src, grid) {
		var dst = new ResolutionState(grid, src.seed);
		dst.plateCount = Math.min(src.plateCount, dst.plateCap);
		dst.n = grid.V;
		return dst;
	}
	// The target column is the area-weighted mean of its contributors: the weight of a source
	// column is the area it brings to this cell, `A0ref / share`. The nominal footprint is the
	// sim's own unit - Diag.mass counts every column with A0ref - so the attribution is in the
	// same book as the ledger it has to agree with. A shard of a split column carries the
	// parent's thickness and scalars exactly (its own weight cancels), and an aggregate is the
	// mean of the material that landed there.
	//
	// A mean rather than a summed volume is the whole point: the two lattices are independent
	// tessellations, so a coarse region holds two to seven fine cell centres, not exactly four. A
	// sum would conserve the nominal ledger exactly and stripe the map by up to +-50 %, which is
	// an artifact of the tessellation rather than a property of the crust. The volume the mean
	// does not account for is measured and booked to regrid* (see transfer), so the sim's mass
	// identity stays exact while the field stays the field.
	function transferColumns(src, dst, map) {
		var grid = dst.grid, Vt = grid.V;
		var attr = new Float64Array(Vt), slotOf = new Int32Array(Vt).fill(-1), mixed = new Uint8Array(Vt);
		var srcOf = map.srcOf, share = map.shareCol, covered = map.covered, k, c;
		for (k = 0; k < MATERIAL.length; k++) dst[MATERIAL[k]].fill(0);
		for (k = 0; k < COLUMN_SCALAR.length; k++) dst[COLUMN_SCALAR[k]].fill(0);
		dst.plate.fill(65535);
		dst.n = 0;
		for (c = 0; c < Vt; c++) {
			if (!covered[c]) continue;
			slotOf[c] = dst.n++;
			var i = srcOf[c];
			if (i >= 0 && i < src.n && src.alive[i]) {
				attr[c] += src.A0ref / share[i];
				continue;
			}
			// The guard above always lands a primary in a covered cell; a state that disagrees
			// is a test fixture, and the transfer says so rather than writing a hole's worth of
			// zero-thickness crust.
			var cb = c * 3;
			i = nearestColumnGlobal(src, grid.pos[cb], grid.pos[cb + 1], grid.pos[cb + 2]);
			if (i < 0) throw new Error('Resolution: covered target cell ' + c + ' has no source');
			srcOf[c] = i;
			share[i]++;
			attr[c] += src.A0ref / share[i];
		}
		for (c = 0; c < Vt; c++) {
			if (slotOf[c] < 0) continue;
			var at = slotOf[c], p = srcOf[c], w = src.A0ref / share[p];
			for (k = 0; k < MATERIAL.length; k++) dst[MATERIAL[k]][at] += src[MATERIAL[k]][p] * w;
			for (k = 0; k < COLUMN_SCALAR.length; k++) dst[COLUMN_SCALAR[k]][at] += src[COLUMN_SCALAR[k]][p] * w;
			dst.plate[at] = src.plate[p];
		}
		for (var f = 0; f < map.forcedN; f++) {
			var fc = map.forcedCell[f], fi = map.forcedCol[f], fat = slotOf[fc];
			if (fat < 0) throw new Error('Resolution: forced column lands in an uncovered cell ' + fc);
			var fw = src.A0ref / share[fi];
			attr[fc] += fw; mixed[fc] = 1;
			for (k = 0; k < MATERIAL.length; k++) dst[MATERIAL[k]][fat] += src[MATERIAL[k]][fi] * fw;
			for (k = 0; k < COLUMN_SCALAR.length; k++) dst[COLUMN_SCALAR[k]][fat] += src[COLUMN_SCALAR[k]][fi] * fw;
			if (dst.plate[fat] === 65535) dst.plate[fat] = src.plate[fi];
		}
		for (var c2 = 0; c2 < Vt; c2++) {
			var slot = slotOf[c2];
			if (slot < 0) continue;
			if (dst.plate[slot] === 65535) throw new Error('Resolution: target cell ' + c2 + ' has no plate');
			// One contributor means the weighted mean IS that contributor's value: copying it
			// keeps a split child bit-identical to its parent instead of x*(w)*(1/w).
			if (!mixed[c2]) {
				var p2 = srcOf[c2];
				for (k = 0; k < MATERIAL.length; k++) dst[MATERIAL[k]][slot] = src[MATERIAL[k]][p2];
				for (k = 0; k < COLUMN_SCALAR.length; k++) dst[COLUMN_SCALAR[k]][slot] = src[COLUMN_SCALAR[k]][p2];
				continue;
			}
			var inv = 1 / attr[c2];
			for (k = 0; k < MATERIAL.length; k++) dst[MATERIAL[k]][slot] *= inv;
			for (k = 0; k < COLUMN_SCALAR.length; k++) dst[COLUMN_SCALAR[k]][slot] *= inv;
		}
		return slotOf;
	}
	// Mobile sediment is material too, and follows the same area-weighted rule on the cell shard
	// map. A hole keeps its load: the load is what is being routed, and it is not crust.
	function transferMobile(src, dst, map) {
		var grid = dst.grid, Vt = grid.V, weight;
		var scOf = map.scOf, share = map.shareCell;
		var attr = new Float64Array(Vt), mixed = new Uint8Array(Vt), k, c;
		dst.mobile.fill(0); dst.mobileFel.fill(0); dst.mobilePla.fill(0);
		for (c = 0; c < Vt; c++) {
			var s = scOf[c];
			if (s < 0 || !share[s]) continue;
			weight = src.A0ref / share[s];
			attr[c] += weight;
			for (k = 0; k < MOBILE.length; k++) dst[MOBILE[k]][c] += src[MOBILE[k]][s] * weight;
		}
		for (var f = 0; f < map.cellForcedN; f++) {
			var from = map.cellForcedFrom[f], at = map.cellForcedAt[f];
			weight = src.A0ref;
			attr[at] += weight; mixed[at] = 1;
			for (k = 0; k < MOBILE.length; k++) dst[MOBILE[k]][at] += src[MOBILE[k]][from] * weight;
		}
		for (c = 0; c < Vt; c++) {
			var sc2 = scOf[c];
			if (sc2 >= 0 && share[sc2] && !mixed[c]) {
				for (k = 0; k < MOBILE.length; k++) dst[MOBILE[k]][c] = src[MOBILE[k]][sc2];
				continue;
			}
			if (attr[c] <= 0) continue;
			var inv = 1 / attr[c];
			for (k = 0; k < MOBILE.length; k++) dst[MOBILE[k]][c] *= inv;
		}
	}
	// The crust does not move at the switch instant: world is the target cell's own direction and
	// body is that direction pulled back into the plate frame the column already rode, so
	// rigidError is 0 by construction and the next step applies the same rigid motion.
	function placeColumns(dst, slotOf) {
		var grid = dst.grid, d3 = new Float64Array(3);
		dst.alive.fill(0);
		for (var c = 0; c < grid.V; c++) {
			var slot = slotOf[c];
			if (slot < 0) continue;
			var b = c * 3, w = slot * 3, p = dst.plate[slot] * 4;
			dst.world[w] = grid.pos[b]; dst.world[w + 1] = grid.pos[b + 1]; dst.world[w + 2] = grid.pos[b + 2];
			ResolutionQuat.rotateInv(d3, 0, dst.q, p, grid.pos, b);
			dst.body[w] = d3[0]; dst.body[w + 1] = d3[1]; dst.body[w + 2] = d3[2];
			dst.cell[slot] = c; dst.area[slot] = grid.A0[c]; dst.alive[slot] = 1;
		}
	}
	function copyWorld(src, dst) {
		var i, key, p;
		for (i = 0; i < WORLD_SCALAR.length; i++) dst[WORLD_SCALAR[i]] = src[WORLD_SCALAR[i]];
		for (i = 0; i < WORLD_ARRAYS.length; i++) { key = WORLD_ARRAYS[i]; dst[key].set(src[key]); }
		for (i = 0; i < PLATE_VERBATIM.length; i++) { key = PLATE_VERBATIM[i]; dst[key].set(src[key]); }
		for (i = 0; i < PLATE_OBJECTS.length; i++) {
			key = PLATE_OBJECTS[i];
			for (p = 0; p < dst.plateCap; p++) dst[key][p] = p < src.plateCap ? src[key][p] : null;
		}
	}
	// Re-derive the frame the sim would have: mantle field, coverage, elevation, boundary
	// classification. No force solve and no step - omega is the world's own, already carried.
	function derive(dst) {
		ResolutionMantle.update(dst);
		ResolutionColumns.bin(dst);
		ResolutionColumns.raster(dst);
		ResolutionSurface.elevation(dst);
		ResolutionEdges.velocities(dst);
		ResolutionEdges.classify(dst);
		ResolutionDiag.check(dst);
	}
	function anchorKey(body, b) {
		return [Math.round(body[b] * ANCHOR_SCALE), Math.round(body[b + 1] * ANCHOR_SCALE), Math.round(body[b + 2] * ANCHOR_SCALE)];
	}
	function relError(a, b) {
		var scale = Math.max(Math.abs(a), Math.abs(b));
		return scale > 0 ? Math.abs(a - b) / scale : 0;
	}
	// What the page prints before asking, and what the test gates: volumes, coverage, the plate
	// frame, clock and RNG identity, and how far the re-lattice moved the deposit anchors.
	function measure(src, dst, map) {
		var srcMass = massOf(src), dstMass = massOf(dst);
		var maxD = 0, maxCells = 0, sumD = 0, kept = 0, counted = 0;
		for (var c = 0; c < dst.grid.V; c++) {
			var i = map.srcOf[c], slot = map.slotOf[c];
			if (i < 0 || slot < 0) continue;
			var wb = i * 3, bb = slot * 3;
			var dot = Math.max(-1, Math.min(1, src.world[wb] * dst.world[bb] + src.world[wb + 1] * dst.world[bb + 1] + src.world[wb + 2] * dst.world[bb + 2]));
			var angle = Math.acos(dot);
			if (angle > maxD) maxD = angle;
			// The same angle in the source lattice's own units: a column that drifted to its
			// cell's edge can be claimed by a target cell over the boundary, so the honest
			// bound is stated in neighbour distances rather than in metres.
			var units = angle * ResolutionParams.radius / src.grid.nbrDist[i];
			if (units > maxCells) maxCells = units;
			sumD += angle; counted++;
			var a = anchorKey(src.body, wb), b2 = anchorKey(dst.body, bb);
			if (a[0] === b2[0] && a[1] === b2[1] && a[2] === b2[2]) kept++;
		}
		var holes = 0;
		for (var h = 0; h < dst.grid.V; h++) if (!map.covered[h]) holes++;
		var hist = new Array(src.n + 1).fill(0);
		for (var i2 = 0; i2 < src.n; i2++) if (src.alive[i2]) hist[map.shareCol[i2]]++;
		var shards = [];
		for (var s = 0; s < hist.length; s++) shards.push(hist[s]);
		return {
			levelFrom: src.grid.level, levelTo: dst.grid.level,
			columnsIn: src.n, columnsOut: dst.n, cellsOut: dst.grid.V,
			shardHistogram: shards, forced: map.forcedN,
			volume: { fel: srcMass.fel, maf: srcMass.maf, sed: srcMass.sed },
			volumeOut: { fel: dstMass.fel, maf: dstMass.maf, sed: dstMass.sed },
			volumeError: { fel: relError(srcMass.fel, dstMass.fel), maf: relError(srcMass.maf, dstMass.maf), sed: relError(srcMass.sed, dstMass.sed) },
			gaps: dst.gaps, covered: coverageCount(dst), columns: dst.n, holes: holes,
			regrid: { fel: dst.regridFel, maf: dst.regridMaf, sed: dst.regridSed },
			rigidError: dst.rigidError,
			anchorDrift: { max: maxD, maxCells: maxCells, mean: counted ? sumD / counted : 0, kept: kept, counted: counted },
			time: dst.t, frames: dst.frame, rng: dst.rng, plateCount: dst.plateCount,
			bytes: (dst.colCap * 3 * 8) + (dst.colCap * 8 * 7)
		};
	}
	function addIndex(index, cell, entry) {
		var key = String(cell), list = index[key];
		if (!list) index[key] = list = [];
		list.push(entry);
	}
	function clearObject(object) {
		for (var key in object) delete object[key];
	}
	return {
		ANCHOR_SCALE: ANCHOR_SCALE,
		GROUPS: GROUPS,
		MATERIAL: MATERIAL,
		MOBILE: MOBILE,
		COLUMN_SCALAR: COLUMN_SCALAR,
		nearestCell: nearestCell,
		// The inventory contract: every own field of a State is classified, and the report
		// carries each group's class so a caller can print or assert it.
		inventory: function (s) {
			var groups = [], unknown = [], total = 0, i;
			for (i = 0; i < GROUPS.length; i++) {
				var g = GROUPS[i], fields = [], bytes = 0;
				for (var k = 0; k < g.fields.length; k++) {
					var key = g.fields[k], value = s[key];
					var count = value && typeof value !== 'number' && value.length !== undefined ? value.length : 1;
					var size = count * (value && value.BYTES_PER_ELEMENT ? value.BYTES_PER_ELEMENT : 8);
					bytes += size;
					fields.push({ name: key, bytes: size });
				}
				total += bytes;
				groups.push({ group: g.group, cls: g.cls, note: g.note, fields: fields, bytes: bytes });
			}
			var keys = Object.keys(s);
			for (i = 0; i < keys.length; i++) if (!FIELD_CLASS[keys[i]]) unknown.push(keys[i]);
			return { groups: groups, unknown: unknown, bytes: total,
				columns: { alive: s.n, cap: s.colCap, V: s.grid.V, A0ref: s.A0ref },
				plates: { count: s.plateCount, cap: s.plateCap } };
		},
		classOf: function (field) { return FIELD_CLASS[field] || null; },
		groupOf: function (field) { return FIELD_GROUP[field] || null; },
		// Build a target world off to the side. Never writes to `src`; the caller commits the
		// returned state by swapping its own grid/state variables (plan §6).
		transfer: function (src, grid, opts) {
			checkTarget(src, grid);
			opts = opts || {};
			var map = shard(src, grid);
			var dst = blankState(src, grid);
			copyWorld(src, dst);
			var srcMass = massOf(src);
			map.slotOf = transferColumns(src, dst, map);
			transferMobile(src, dst, map);
			placeColumns(dst, map.slotOf);
			// A re-lattice is not free: the mean leaves a residual volume, and the sim's own
			// identity `mass0 + produced - losses = mass` has to hold after the switch as it did
			// before it. The residual is a source, it is reported, and it is zero on a level
			// change that does not change the number of columns per unit area.
			var dstMass0 = massOf(dst);
			dst.regridFel += dstMass0.fel - srcMass.fel;
			dst.regridMaf += dstMass0.maf - srcMass.maf;
			dst.regridSed += dstMass0.sed - srcMass.sed;
			if (opts.derive !== false) derive(dst);
			// The re-derivation runs Diag.check, which appends its own sample to the history
			// ring; the ring is a record of steps, and a transfer is not a step, so it is
			// restored. The recomputed mass ledgers stay: they are the conservation check.
			for (var i = 0; i < WORLD_ARRAYS.length; i++) dst[WORLD_ARRAYS[i]].set(src[WORLD_ARRAYS[i]]);
			dst.histI = src.histI; dst.histN = src.histN;
			return { state: dst, report: measure(src, dst, map) };
		},
		// Slice 2: re-lay a session ledger onto another frame. Entries keep their ids, anchor
		// keys, directions, serials and found order; the grid indices and the coverage mask move,
		// because those are frame coordinates rather than identity. Coverage can only grow: a
		// target cell inherits the mask of the source cell it sits in, and every surveyed source
		// cell also ORs its own mask into its target cell, so a finer source never loses a claim
		// and a coarser one grants it to the cells inside it. The added cells are reported.
		ledger: function (ledger, srcGrid, grid) {
			if (!ledger || !srcGrid || !grid || !Number.isInteger(grid.V)) throw new TypeError('Resolution: ledger and built grids required');
			if (!ledger.coverage || ledger.coverage.length !== srcGrid.V) throw new RangeError('Resolution: ledger coverage is not the source frame');
			var Vt = grid.V, Vs = srcGrid.V;
			var coverage = new Uint8Array(Vt), inherited = new Uint8Array(Vt), moved = 0, c;
			for (c = 0; c < Vt; c++) {
				var b = c * 3;
				inherited[c] = ledger.coverage[nearestCell(srcGrid, grid.pos[b], grid.pos[b + 1], grid.pos[b + 2])];
				coverage[c] = inherited[c];
			}
			for (var s = 0; s < Vs; s++) {
				if (!ledger.coverage[s]) continue;
				var sb = s * 3;
				coverage[nearestCell(grid, srcGrid.pos[sb], srcGrid.pos[sb + 1], srcGrid.pos[sb + 2])] |= ledger.coverage[s];
			}
			clearObject(ledger.byRecordCell);
			clearObject(ledger.bySurveyCell);
			var found = ledger.found || [], fallback = new Float64Array(3);
			// The source frame's own re-anchor tolerance, stamped on every surviving entry: the
			// re-lattice displaces an anchor by less than this, and a record found again on the
			// new frame must match the entry that already names it rather than becoming a second
			// discovery (Instruments.findEntry consumes the stamp on a re-anchor).
			var priorTolerance = Math.cos(Math.min(Math.PI, 1.5 * srcGrid.nbrDist[0] / ResolutionParams.radius));
			for (var e = 0; e < found.length; e++) {
				var entry = found[e], dir = entry.direction;
				if (entry.priorTolerance === undefined || priorTolerance < entry.priorTolerance) entry.priorTolerance = priorTolerance;
				if (!dir) {
					// No stored direction is impossible for an entry this module's own survey
					// path created; a hand-built one falls back to the old frame's cell centre,
					// which keeps the entry rather than dropping it.
					var ob = (entry.cell | 0) * 3;
					fallback[0] = srcGrid.pos[ob]; fallback[1] = srcGrid.pos[ob + 1]; fallback[2] = srcGrid.pos[ob + 2];
					dir = fallback;
				}
				var cell = nearestCell(grid, dir[0], dir[1], dir[2]);
				// A record sits on a cell that was surveyed by definition, and the anchor projection
				// can land just outside the image of the mask's own cell on a rim. The mask absorbs
				// the entry rather than the entry moving off its own direction.
				coverage[cell] = 1;
				if (cell !== entry.cell) moved++;
				entry.cell = cell;
				entry.surveyCell = cell;
				if (entry.record) entry.record.cell = cell;
				addIndex(ledger.byRecordCell, entry.cell, entry);
				addIndex(ledger.bySurveyCell, entry.surveyCell, entry);
			}
			var gain = 0;
			for (c = 0; c < Vt; c++) if (coverage[c] !== inherited[c]) gain++;
			ledger.coverage = coverage;
			ledger.cells = new Uint32Array(Vt);
			ledger.cellsN = 0;
			for (c = 0; c < Vt; c++) if (coverage[c]) ledger.cells[ledger.cellsN++] = c;
			ledger.sampleSeen = new Uint32Array(Vt);
			return { entries: found.length, moved: moved, cells: ledger.cellsN, coverageGain: gain };
		}
	};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Resolution;

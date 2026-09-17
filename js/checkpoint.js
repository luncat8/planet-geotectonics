/* checkpoint.js - binary snapshot of everything that has to survive between frames.

   Layout (little endian, offsets in bytes from the buffer start):
     0   u32 magic 'PGT1'      4  u32 version
     8   u32 level            12  u32 seed
    16   u32 V                20  u32 colCap
    24   u32 plateCap         28  u32 scalar count
    32   u32 array count      36  u32 data bytes (sum of the padded blocks)
    64   f64[scalar count]
    ...  u32[array count * 4] records: id, dtype, length, byteLength
    ...  the array blocks in record order, each padded up to 8 bytes

   Everything is validated before live state is touched, so a bad blob cannot leave a
   half-restored world behind. Derived fields (owner, z, vel, ...) are not stored: the next
   Sim.raster rebuilds them, and world is recomputed here from q and body. */
var CheckpointQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var Checkpoint = {
	MAGIC: 0x31544750, VERSION: 2, HEAD: 64, RECORD: 16, WORDS: 10,
	F64: 1, F32: 2, I32: 3, U32: 4, U16: 5, U8: 6, I8: 7,
	// Version 2 (0.3.3) adds `cooling`; the version word is the only compatibility contract,
	// so a v1 blob is rejected by the check in peek rather than read with a shifted table.
	SCALARS: ['t', 'frame', 'n', 'plateCount', 'seed', 'rng', 'Tm', 'Tm0', 'hotStart', 'cooling', 'mantleScale',
		'plumeCount', 'spawns', 'deaths', 'overlaps', 'splits', 'merges', 'lastEvent', 'gaps', 'maxClimb',
		'histI', 'histN', 'producedFel', 'producedMaf', 'erodedFel', 'erodedMaf', 'subductedMaf',
		'subductedSed', 'subductedArea', 'massFel', 'massMaf', 'massSed', 'massFel0', 'massMaf0', 'massSed0'],
	ARRAYS: ['body', 'area', 'hFel', 'hMaf', 'hSed', 'age', 'damage', 'zDyn', 'alive', 'plate', 'cell',
		'q', 'omega', 'seeds', 'plateCells', 'plateSpawned', 'plateLost', 'plateBirth', 'plateParent',
		'gapFrames', 'gapTime', 'edgeType', 'mobile', 'mobileFel', 'mobilePla', 'sutureTime',
		'fert', 'oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla',
		'histT', 'histMeanV', 'histMaxV', 'histGaps', 'histPlates', 'histChanges', 'histCols',
		'waveDir0', 'waveAxis', 'wavePeriod', 'waveFreq', 'wavePhase', 'waveAmp',
		'plumePos', 'plumeBirth', 'plumeLife', 'plumeStr'],
	code: function (array) {
		if (array instanceof Float64Array) return Checkpoint.F64;
		if (array instanceof Float32Array) return Checkpoint.F32;
		if (array instanceof Int32Array) return Checkpoint.I32;
		if (array instanceof Uint32Array) return Checkpoint.U32;
		if (array instanceof Uint16Array) return Checkpoint.U16;
		if (array instanceof Int8Array) return Checkpoint.I8;
		if (array instanceof Uint8Array) return Checkpoint.U8;
		throw new TypeError('unsupported checkpoint array');
	},
	bodyBytes: function (s) {
		var arrays = Checkpoint.ARRAYS, total = 0;
		for (var i = 0; i < arrays.length; i++) total += (s[arrays[i]].byteLength + 7) & ~7;
		return total;
	},
	size: function (s) {
		return Checkpoint.HEAD + Checkpoint.SCALARS.length * 8
			+ Checkpoint.ARRAYS.length * Checkpoint.RECORD + Checkpoint.bodyBytes(s);
	},
	tableAt: function () {
		return Checkpoint.HEAD + Checkpoint.SCALARS.length * 8;
	},
	dataAt: function () {
		return Checkpoint.tableAt() + Checkpoint.ARRAYS.length * Checkpoint.RECORD;
	},
	save: function (s) {
		var scalars = Checkpoint.SCALARS, arrays = Checkpoint.ARRAYS, i;
		var buffer = new ArrayBuffer(Checkpoint.size(s));
		var head = new Uint32Array(buffer, 0, Checkpoint.WORDS);
		head[0] = Checkpoint.MAGIC; head[1] = Checkpoint.VERSION;
		head[2] = s.grid.level; head[3] = s.seed >>> 0;
		head[4] = s.grid.V; head[5] = s.colCap; head[6] = s.plateCap;
		head[7] = scalars.length; head[8] = arrays.length;
		head[9] = Checkpoint.bodyBytes(s);
		var values = new Float64Array(buffer, Checkpoint.HEAD, scalars.length);
		for (i = 0; i < scalars.length; i++) values[i] = s[scalars[i]];
		var records = new Uint32Array(buffer, Checkpoint.tableAt(), arrays.length * 4);
		var at = Checkpoint.dataAt();
		for (i = 0; i < arrays.length; i++) {
			var array = s[arrays[i]];
			records[i * 4] = i; records[i * 4 + 1] = Checkpoint.code(array);
			records[i * 4 + 2] = array.length; records[i * 4 + 3] = array.byteLength;
			new array.constructor(buffer, at, array.length).set(array);
			at += (array.byteLength + 7) & ~7;
		}
		return new Uint8Array(buffer);
	},
	// The header on its own, for a GUI that has to rebuild the world before it can load into
	// it: a checkpoint carries the level and seed it was written at, and since the page can
	// switch levels a mismatch is the normal case rather than a corrupt blob.
	peek: function (bytes) {
		var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		if (view.byteLength < Checkpoint.HEAD) throw new RangeError('checkpoint truncated in the header');
		if (view.byteOffset % 8) throw new RangeError('checkpoint view is not 8-byte aligned');
		var head = new Uint32Array(view.buffer, view.byteOffset, Checkpoint.WORDS);
		if (head[0] !== Checkpoint.MAGIC) throw new RangeError('not a planet-geotectonics checkpoint');
		if (head[1] !== Checkpoint.VERSION) throw new RangeError('checkpoint version ' + head[1]);
		return { level: head[2], seed: head[3], V: head[4] };
	},
	// Throws on any inconsistency; the live state is untouched until every check has passed.
	load: function (s, bytes) {
		var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		var scalars = Checkpoint.SCALARS, arrays = Checkpoint.ARRAYS, i;
		Checkpoint.peek(view);
		var buffer = view.buffer, at0 = view.byteOffset;
		var head = new Uint32Array(buffer, at0, Checkpoint.WORDS);
		if (head[2] !== s.grid.level) throw new RangeError('checkpoint level ' + head[2]);
		if (head[3] !== (s.grid.seed >>> 0)) throw new RangeError('checkpoint seed ' + head[3]);
		if (head[4] !== s.grid.V || head[5] !== s.colCap || head[6] !== s.plateCap) {
			throw new RangeError('checkpoint capacity mismatch');
		}
		if (head[7] !== scalars.length || head[8] !== arrays.length) throw new RangeError('checkpoint table mismatch');
		if (view.byteLength !== Checkpoint.dataAt() + head[9]) throw new RangeError('checkpoint data length');
		var records = new Uint32Array(buffer, at0 + Checkpoint.tableAt(), arrays.length * 4);
		var total = 0;
		for (i = 0; i < arrays.length; i++) {
			var live = s[arrays[i]];
			if (records[i * 4] !== i) throw new RangeError('checkpoint record order');
			if (records[i * 4 + 1] !== Checkpoint.code(live)) throw new RangeError('checkpoint dtype ' + arrays[i]);
			if (records[i * 4 + 2] !== live.length || records[i * 4 + 3] !== live.byteLength) {
				throw new RangeError('checkpoint length ' + arrays[i]);
			}
			total += (live.byteLength + 7) & ~7;
		}
		if (total !== head[9]) throw new RangeError('checkpoint block table');
		var values = new Float64Array(buffer, at0 + Checkpoint.HEAD, scalars.length);
		for (i = 0; i < scalars.length; i++) {
			if (!Number.isFinite(values[i]) && values[i] !== -Infinity) {
				throw new RangeError('checkpoint scalar ' + scalars[i]);
			}
		}
		for (i = 0; i < scalars.length; i++) s[scalars[i]] = values[i];
		var at = Checkpoint.dataAt();
		for (i = 0; i < arrays.length; i++) {
			var target = s[arrays[i]];
			target.set(new target.constructor(buffer, at0 + at, target.length));
			at += (target.byteLength + 7) & ~7;
		}
		Checkpoint.rebuild(s);
		return s;
	},
	// world follows q and body by definition; everything else is scratch the next raster fills.
	rebuild: function (s) {
		s.world.fill(0);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var b = i * 3;
			CheckpointQuat.rotate(s.world, b, s.q, s.plate[i] * 4, s.body, b);
		}
	},
	push: function (s) {
		if (!(s.ckptCap > 0)) return -1;
		var ring = s.ckpt;
		if (!ring) {
			// First snapshot: the ring is allocated here because only now is the blob size
			// known. ckptBytes bounds what a full-mirror blob may retain: 96 MB keeps all
			// 16 slots at L5/L6 (2.7/9.9 MB) and 2 at L7 (41 MB), instead of 630 MB.
			var slots = s.ckptCap;
			if (s.ckptBytes > 0) slots = Math.max(1, Math.min(slots, Math.floor(s.ckptBytes / Checkpoint.size(s))));
			s.ckptSlots = slots;
			ring = s.ckpt = new Array(slots);
			s.ckptT = new Float64Array(slots);
		}
		var slot = s.ckptI % ring.length;
		s.ckpt[slot] = Checkpoint.save(s);
		s.ckptT[slot] = s.t;
		s.ckptI++;
		if (s.ckptN < ring.length) s.ckptN++;
		return slot;
	},
	// age 0 is the newest; null once the ring does not reach that far back.
	entry: function (s, age) {
		if (!s.ckpt || !(s.ckptN > age)) return null;
		var slot = (s.ckptI - 1 - age) % s.ckpt.length;
		return { blob: s.ckpt[slot], t: s.ckptT[slot] };
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Checkpoint;

// The GPU play path on the stub device (tests/gpu-stub.js): no kernel runs here, so this
// covers the JS side the browser rigs cannot see cheaply - the event round trip's partial
// mirror transfer and the scheduling of frames around it. Level 3 keeps it under a second.
//   1. play() and N step() calls leave the mirror identical and the cadence intact, and a
//      batch stopped by the drag gate resumes into the same run;
//   2. the event round trip ships only what Events.cycle touches: the cell and edge
//      buffers on the device survive it untouched, so no stale cell state is ever pushed
//      back over what the kernels computed;
//   3. what it does ship is faithful, and the rows past aliveN carry alive = 0;
//   4. a full sync followed by an event round trip - the app's real sequence - reads only
//      the buffers that transfer mapped, never the wider set left in the staging cache;
//   8. a batched encoder's frameIn bind group names its per-block size (Dawn rejects a
//      nonzero dynamic offset on an unspecified whole-buffer range);
//  10. a play that opens on a due event submits the render tail before the round trip
//      awaits, and acquires the canvas once.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const Events = require('../js/events.js');
const GpuSim = require('../js/gpu/sim-gpu.js');
const { makeDevice } = require('./gpu-stub.js');

const LEVEL = 3, DT = 0.1, FRAMES = 25;

function world(seed) {
	const s = new State(new Grid(LEVEL, seed).build(), seed);
	s.reset(seed);
	s.ckptCap = 0;
	Sim.raster(s);
	return s;
}
function bytesOf(name) {
	return new Uint8Array(GpuSim.S.buf[name].bytes);
}

(async () => {
	// 1. play() vs step(): same cadence, same mirror. GpuSim.S is a singleton, so the two
	// runs are sequential, not concurrent.
	const a = world(7);
	let cycles = 0;
	const realCycle = Events.cycle;
	Events.cycle = function (s, span) { cycles++; return realCycle(s, span); };
	await GpuSim.init(a, { device: makeDevice() });
	const played = await GpuSim.play(a, DT, FRAMES);
	const cyclesPlayed = cycles;
	const b = world(7);
	await GpuSim.init(b, { device: makeDevice() });
	for (let i = 0; i < FRAMES; i++) await GpuSim.step(b, DT, Events, GpuSim.Checkpoint, Params);
	Events.cycle = realCycle;
	const cyclesStepped = cycles - cyclesPlayed;
	const due = Math.floor((FRAMES - 1) * DT / Params.eventCadence);
	assert.equal(played, FRAMES, 'play reports the frames it submitted');
	assert.equal(cyclesPlayed, due, 'play: one event cycle per ' + Params.eventCadence + ' Myr, none skipped or doubled');
	assert.equal(cyclesStepped, cyclesPlayed, 'step() and play() fire the same cycles');
	assert.equal(a.t, b.t, 't');
	assert.equal(a.frame, b.frame, 'frame');
	assert.equal(a.lastEvent, b.lastEvent, 'lastEvent');
	assert.equal(a.n, b.n, 'alive columns');
	assert.equal(a.plateCount, b.plateCount, 'plates');
	assert.deepEqual(Array.from(a.plate), Array.from(b.plate), 'column to plate map');
	assert.deepEqual(Array.from(a.hFel.subarray(0, a.n)), Array.from(b.hFel.subarray(0, b.n)), 'hFel');

	// 1b. the defect-D1 witnesses arrive in the mirror at the slots the WGSL writes. The
	// stub runs no kernel, so this is a plumbing check: whatever the device puts in
	// DIAG[14..16] must come out as gpuDt/gpuAlpha/gpuRelaxErr. tests/wgsl-struct.js pins
	// the same slots against the generated `const D_*` declarations.
	const diagSlot = GpuSim.DIAG;
	const c = world(13);
	await GpuSim.init(c, { device: makeDevice() });
	const diagF32 = new Float32Array(bytesOf('diagOut').buffer);
	diagF32[diagSlot.MEANV] = 1234;
	diagF32[diagSlot.DT] = 0.1;
	diagF32[diagSlot.ALPHA] = 0.2;
	diagF32[diagSlot.RELAXERR] = 1.5e-7;
	await GpuSim.download(c);
	assert.equal(c.meanSpeed, 1234, 'meanSpeed still comes from slot 0');
	assert.equal(c.gpuDt, Math.fround(0.1), 'DIAG[D_DT] mirrors to state.gpuDt (f32 on the device)');
	assert.equal(c.gpuAlpha, Math.fround(Math.min(1, 0.1 / Params.tauOmega)), 'DIAG[D_ALPHA] mirrors to state.gpuAlpha');
	assert.equal(c.gpuRelaxErr, Math.fround(1.5e-7), 'DIAG[D_RELAXERR] mirrors to state.gpuRelaxErr');

	// 1c. the drag gate. Phase V batches run between round-trip boundaries, so an
	// encoder is the atomic unit: `play` polls the hold predicate only at a segment
	// boundary (an encoder already submitted cannot be un-submitted). The page's view
	// gate stops a batch starting at all, so a drag that starts mid-encoder catches at
	// the end of the current one - at dt 0.1 the first segment is 11 frames (frames
	// 1..11; the event cycle is due before frame 12). What the stop must not do is
	// change the run: the frames it did not submit are the next batch's, and the world
	// that stopped and resumed has to match the world that ran straight through,
	// cadence included.
	const held = world(23), plain = world(23);
	await GpuSim.init(held, { device: makeDevice() });
	let polls = 0;
	const stopped = await GpuSim.play(held, DT, 13, function () { return ++polls >= 1; });
	assert.equal(stopped, 11, 'the batch reports the frames it submitted, not the ones it was asked for');
	assert.equal(held.frame, 11, 'and stops at the segment boundary, the only pollable point');
	assert.equal(polls, 1, 'the predicate is polled once per segment boundary after the first segment');
	assert.ok(!held.lastEvent, 'no cycle was deferred: the segment ended before its due frame');
	const resumed = await GpuSim.play(held, DT, 2);
	await GpuSim.init(plain, { device: makeDevice() });
	await GpuSim.play(plain, DT, 13);
	assert.equal(resumed, 2, 'the rest of the batch is the next batch\'s work');
	assert.equal(held.t, plain.t, 't');
	assert.equal(held.frame, plain.frame, 'frame');
	assert.equal(held.lastEvent, plain.lastEvent, 'lastEvent: the stop skipped no cycle and doubled none');
	assert.deepEqual(Array.from(held.plate), Array.from(plain.plate), 'column to plate map');
	assert.deepEqual(Array.from(held.hFel.subarray(0, held.n)), Array.from(plain.hFel.subarray(0, plain.n)), 'hFel');

	// 2. the event round trip leaves the cell and edge buffers alone.
	const s = world(11);
	await GpuSim.init(s, { device: makeDevice() });
	await GpuSim.play(s, DT, 12);
	await GpuSim.download(s);
	// A marker no kernel would produce, so "untouched" is unambiguous.
	for (const name of ['cellF', 'cellI', 'edges']) bytesOf(name).fill(0x5a);
	await GpuSim.roundTrip(s, true, false);
	for (const name of ['cellF', 'cellI', 'edges']) {
		assert.ok(bytesOf(name).every(v => v === 0x5a), name + ' must survive the event round trip untouched');
	}

	// 3. the app's own sequence: a full sync (probe click, save, deposit extract) and then
	// the event round trip. The event set is narrower, so the unpack has to test what this
	// transfer mapped; testing the staging cache instead reads a buffer that is not mapped
	// and the device raises OperationError, which wedges the play loop - the GPU run stops
	// dead until play is pressed again.
	await GpuSim.download(s);
	await GpuSim.roundTrip(s, true, false);
	await GpuSim.play(s, DT, 6);
	await GpuSim.download(s);
	assert.ok(s.n > 0 && Number.isFinite(s.t) && Number.isFinite(s.meanSpeed),
		'full sync -> event round trip -> play keeps the mirror sane');

	// 4. faithful for the rows it ships, dead rows marked dead.
	const full = world(11);
	await GpuSim.init(full, { device: makeDevice() });
	await GpuSim.play(full, DT, 12);
	await GpuSim.download(full);
	await GpuSim.uploadState(full);
	const refColF = bytesOf('colF').slice(), refColI = bytesOf('colI').slice();
	for (let i = full.n; i < full.colCap; i++) full.alive[i] = 1;
	await GpuSim.uploadEvents(full);
	const colF = bytesOf('colF'), colI = bytesOf('colI'), colI32 = new Int32Array(colI.buffer);
	const rowF = 24 * 4, rowI = 4 * 4;
	for (let i = 0; i < full.n; i++) {
		for (let k = 0; k < rowF; k++) assert.equal(colF[i * rowF + k], refColF[i * rowF + k], 'colF row ' + i);
		for (let k = 0; k < rowI; k++) assert.equal(colI[i * rowI + k], refColI[i * rowI + k], 'colI row ' + i);
	}
	for (let i = full.n; i < full.colCap; i++) {
		assert.equal(colI32[i * 4 + 3], 0, 'alive flag past n, row ' + i);
	}
	assert.ok(full.colCap > full.n, 'the rig has dead rows to check');

	// 5. the buffers the K10 relaxation witnesses (defect D1) travel in are the size the
	// kernels and the unpack agree on: diagB writes DIAG[14..16], reduceB writes one reduce
	// scratch slot per plate. No dispatch runs on the stub, so a size drift here would only
	// show up on a device as a validation error.
	const L = GpuSim.S.l;
	assert.ok(L.diagOut > GpuSim.DIAG.RELAXERR, 'diagOut covers the last witness slot');
	assert.equal(bytesOf('diagOut').byteLength, L.diagOut * 4, 'diagOut buffer matches the layout');
	assert.ok(L.reduceF >= L.nwgL * 7 + L.plateCap, 'reduceF covers RED_RELAX + plateCap');
	assert.equal(GpuSim.zeroThreads(L), 6 + L.plateCap * 4 + L.colCap * 8,
		'zeroFrame is dispatched with the thread count its branch layout needs');
	// 6. Re-init releases the world it replaces. The app's Resolution select and the bench's
	// one planet per level both re-init on a live device, and at L7 a set of arenas is ~120 MB
	// of device memory: what a level switch must not do is leave the previous level's buffers -
	// including the staging cache of its last transfer - waiting on a GC that is free to hold
	// them. No dispatch runs here, so this is the bookkeeping half; the device half is that
	// destroy() on a buffer nobody has mapped is legal, which js/ui.js guarantees by waiting
	// for the in-flight transfer before it rebuilds (tests/gui.js pins that ordering).
	{
		const next = world(17);
		await GpuSim.init(next, { device: makeDevice() });
		await GpuSim.play(next, DT, 12);
		await GpuSim.download(next);
		const oldS = GpuSim.S, oldBuf = GpuSim.S.buf, oldStage = GpuSim.S.stage, device = GpuSim.S.device;
		assert.ok(oldStage && Object.keys(oldStage).length > 0, 'the rig has a staging cache to release');
		await GpuSim.init(world(19), { device: device });
		assert.notEqual(GpuSim.S, oldS, 'the session is a new one');
		assert.equal(GpuSim.S.device, device, 'on the device it was given');
		for (const name in oldBuf) assert.equal(oldBuf[name].destroyed, true, 'replaced arena ' + name);
		for (const name in oldStage) assert.equal(oldStage[name].destroyed, true, 'replaced staging buffer ' + name);
		for (const name in GpuSim.S.buf) {
			assert.equal(GpuSim.S.buf[name].destroyed, false, 'the new arena ' + name + ' is live');
		}
	}
	// 7. Phase IV: the K11 diagnostic passes (diagA/diagC/diagB) are on demand. The
	// parity path (step/frame default) keeps them every frame; play runs them only
	// on a frame the HUD asked for (wantDiag), and a full download folds the
	// current frame's numbers with a diag-only submit. A light event round trip
	// must not.
	{
		const d = world(29);
		await GpuSim.init(d, { device: makeDevice() });
		const counts = {};
		const realRun = GpuSim.run;
		GpuSim.run = function (s0, enc, name) { counts[name] = (counts[name] || 0) + 1; return realRun.apply(GpuSim, arguments); };

		await GpuSim.frame(d, DT, false);
		assert.equal(counts.diagA || 0, 0, 'frame(dt, false) skips diagA');
		assert.equal(counts.diagC || 0, 0, 'frame(dt, false) skips diagC');
		assert.equal(counts.diagB || 0, 0, 'frame(dt, false) skips diagB');

		await GpuSim.frame(d, DT);
		assert.equal(counts.diagA, 1, 'frame(dt) keeps diagA - the parity harness is untouched');
		assert.equal(counts.diagC, 1, 'frame(dt) keeps diagC');
		assert.equal(counts.diagB, 1, 'frame(dt) keeps diagB');

		await GpuSim.play(d, DT, 12);
		assert.equal(counts.diagA, 1, 'play runs no K11 pass while the HUD has not asked');
		GpuSim.wantDiag();
		await GpuSim.play(d, DT, 12);
		assert.equal(counts.diagA, 2, 'wantDiag enables K11 on the first batch frame');
		assert.equal(counts.diagB, 2, 'diagB runs on that same frame');
		GpuSim.wantDiag();
		GpuSim.wantDiag();
		await GpuSim.play(d, DT, 12);
		assert.equal(counts.diagA, 3, 'repeated wants coalesce into one diagnostic frame');

		const before = counts.diagB;
		await GpuSim.download(d);
		assert.equal(counts.diagB, before + 1, 'a full download folds one diag-only submit first');
		await GpuSim.roundTrip(d, true, false);
		assert.equal(counts.diagB, before + 1, 'a light event round trip runs no diagnostics');

		GpuSim.run = realRun;
	}

	// 8. Phase V: one encoder for n frames. The n frameIn blocks have to be bit-for-bit
	// what n uploadFrame calls would have produced - same t and frame per block, same
	// sequential mantle bookkeeping - with padding only between blocks; each frameIn-
	// binding kernel rebinds at its frame's aligned offset; the state clock is restored
	// after precomputing; and a batch of n produces the same mirror as n step() calls.
	{
		const dev = makeDevice();
		const s = world(31);
		await GpuSim.init(s, { device: dev });
		const ref = world(31);
		await GpuSim.init(ref, { device: makeDevice() });
		const blocks = [];
		for (let i = 0; i < 8; i++) {
			GpuSim.uploadFrame(ref, DT);
			blocks.push(Array.from(GpuSim.S.finSingle));
			ref.t += DT; ref.frame++;
		}
		// back onto s's singleton before the batch assertions
		await GpuSim.init(s, { device: dev });
		const l = GpuSim.S.l;
		const strideBytes = l.finStride * 4;
		assert.equal(strideBytes % 32, 0, 'the per-frame block stride is a multiple of minStorageBufferOffsetAlignment');
		assert.ok(strideBytes >= 74 * 4, 'and holds all 74 fields');
		// Dawn rejects a dynamic offset when the bind group range is the whole
		// buffer: offset 512 on a 20-block frameIn is out of bounds. The entry
		// must name the per-frame block size.
		let frameInBinds = 0;
		for (const g of dev.bindGroups) {
			for (const e of g.entries) {
				if (e.resource && e.resource.buffer === GpuSim.S.buf.frameIn) {
					assert.equal(e.resource.size, strideBytes, 'frameIn bind group names its block size');
					assert.equal(e.resource.offset || 0, 0, 'the dynamic offset is applied at setBindGroup, not createBindGroup');
					frameInBinds++;
				}
			}
		}
		assert.ok(frameInBinds > 0, 'at least one kernel binds frameIn');
		let frameInLayouts = 0;
		for (const lay of dev.bindGroupLayouts) {
			for (const e of lay.entries) {
				if (e.buffer && e.buffer.hasDynamicOffset) {
					assert.equal(e.buffer.minBindingSize, GpuSim.FIN_FIELDS * 4, 'dynamic frameIn layout has minBindingSize');
					frameInLayouts++;
				}
			}
		}
		assert.ok(frameInLayouts > 0, 'the frameIn layout is marked hasDynamicOffset');
		const t0 = s.t, f0 = s.frame;
		GpuSim.frameBlocks(s, DT, 8);
		assert.equal(s.t, t0, 'frameBlocks precomputes ahead but restores state.t');
		assert.equal(s.frame, f0, 'and state.frame');
		for (let i = 0; i < 8; i++) {
			const got = Array.from(GpuSim.S.finBlocks.subarray(i * l.finStride, i * l.finStride + 74));
			assert.deepEqual(got, blocks[i], 'batched block ' + i + " is frame " + i + "'s single-step upload");
			assert.equal(got[7], i, 'block ' + i + ' carries its frame number (field 7, the contact hash salt)');
			for (let p = 74; p < l.finStride; p++) {
				assert.equal(GpuSim.S.finBlocks[i * l.finStride + p], 0, 'padding word ' + p + ' of block ' + i + ' is zero');
			}
		}
		// the upload covers exactly the n blocks; the tail blocks stay untouched
		const tailView = new Float32Array(GpuSim.S.buf.frameIn.bytes, 8 * strideBytes, 74);
		for (let i = 0; i < 74; i++) assert.equal(tailView[i], 0, 'no bytes past the nth block are uploaded');

		dev.dynamicOffsets.length = 0;
		GpuSim.batch(s, DT, 8, -1);
		const perFrame = {};
		for (const off of dev.dynamicOffsets) {
			assert.equal(off % strideBytes, 0, 'dynamic offset ' + off + ' is block-aligned');
			perFrame[off] = (perFrame[off] || 0) + 1;
		}
		assert.equal(Object.keys(perFrame).length, 8, 'the encoder visits 8 distinct frame blocks');
		let bindsPerFrame = -1;
		for (let i = 0; i < 8; i++) {
			const c = perFrame[i * strideBytes];
			assert.ok(c > 0, 'block ' + i + " is bound");
			if (bindsPerFrame < 0) bindsPerFrame = c;
			assert.equal(c, bindsPerFrame, 'block ' + i + ' binds the same kernel set as block 0');
		}
		// FIN_MAX frames in one encoder: 20 distinct block offsets, each fully aligned
		const before20 = dev.dynamicOffsets.length;
		GpuSim.batch(s, DT, GpuSim.FIN_MAX, -1);
		const offs20 = dev.dynamicOffsets.slice(before20);
		const distinct = new Set(offs20);
		assert.equal(distinct.size, GpuSim.FIN_MAX, 'a FIN_MAX batch binds all 20 blocks');
		for (const o of distinct) assert.equal(o % strideBytes, 0, 'FIN_MAX offset ' + o + ' aligned');
		assert.throws(() => GpuSim.frameBlocks(s, DT, GpuSim.FIN_MAX + 1), /FIN_MAX/, 'oversized batches are refused, not silently truncated');
		// the encoder ends with the bind offset back at 0, so a following frame() reads block 0
		GpuSim.batch(s, DT, 3, 2);
		assert.equal(GpuSim.S.finOffset || 0, 0, 'batch resets its dynamic offset');
		// the tail copy leaves block 0 holding the LAST frame's scalars, the single-frame
		// invariant an on-demand diagFrame relies on for fPlates() after a mid-batch spawn
		const devView = new Float32Array(GpuSim.S.buf.frameIn.bytes);
		for (let i = 0; i < 74; i++) {
			assert.equal(devView[i], GpuSim.S.finBlocks[2 * l.finStride + i],
				'batch tail copies the final block over block 0, word ' + i);
		}
	}

	// 9. Phase VI: the loserScatter/loserRank algorithm cannot run on the stub (no WGSL), so
	// this is a faithful JS port of the kernels: an atomic-cursor scatter into per-winner
	// bins in arbitrary thread order, then per-entry ranking (one rank per target entry
	// = count of smaller bin indices, the WGSL's barrier-free per-lane sweep). Its output
	// must equal the old per-column scan's definition: positions sorted by ascending loser
	// column index, including bins larger than a workgroup and a synthetic mega-bin.
	{
		function binAndSort(consumed, aliveN) {
			const colCap = consumed.length;
			const counts = new Int32Array(colCap);
			for (let i = 0; i < aliveN; i++) if (consumed[i] >= 0) counts[consumed[i]]++;
			const offsets = new Int32Array(colCap + 1);
			for (let w = 0; w < colCap; w++) offsets[w + 1] = offsets[w] + counts[w];
			// loserScatter: visit losers in a deliberately shuffled order, atomicAdd cursor
			const cursor = new Int32Array(colCap);
			const bin = new Int32Array(aliveN).fill(-1);
			const order = [];
			for (let i = 0; i < aliveN; i++) if (consumed[i] >= 0) order.push(i);
			for (let k = order.length - 1; k >= 0; k--) {   // reverse is as arbitrary as any
				const i = order[k], w = consumed[i];
				bin[offsets[w] + cursor[w]++] = i;
			}
			// loserRank: one workgroup per winner; each entry is ranked against the whole bin
			const loseList = new Int32Array(aliveN).fill(-1);
			for (let w = 0; w < colCap; w++) {
				const begin = offsets[w], n = offsets[w + 1] - begin;
				if (n <= 0) continue;
				const nTiles = Math.ceil(n / 64);
				for (let tq = 0; tq < nTiles; tq++) {
					for (let lane = 0; lane < 64; lane++) {
						const e = tq * 64 + lane;
						if (e >= n) continue;
						const x = bin[begin + e];
						let rank = 0;
						for (let ck = 0; ck < nTiles; ck++) {
							for (let k2 = 0; k2 < 64; k2++) {
								const ke = ck * 64 + k2;
								if (ke < n && bin[begin + ke] < x) rank++;
							}
						}
						loseList[begin + rank] = x;
					}
				}
			}
			return loseList;
		}
		const rng = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }(12345));
		for (const trial of [0, 1, 2, 3]) {
			const aliveN = 300 + Math.floor(rng() * 500);
			const winners = [1, 17, 42, 200, 257, 299, 301].filter(w => w < aliveN);
			const consumed = new Int32Array(aliveN).fill(-1);
			for (let i = 0; i < aliveN; i++) {
				if (rng() < 0.35 && !winners.includes(i)) consumed[i] = winners[Math.floor(rng() * winners.length)];
			}
			const got = binAndSort(consumed, aliveN);
			// reference: the CPU counting-sort cursor fills each winner's bin while walking
			// columns up, so each bin is ascending; bins live at their scanned offsets.
			const counts = new Int32Array(consumed.length);
			let total = 0;
			for (let i = 0; i < aliveN; i++) if (consumed[i] >= 0) { counts[consumed[i]]++; total++; }
			let off = 0;
			for (const w of winners) {
				const expected = [];
				for (let i = 0; i < aliveN; i++) if (consumed[i] === w) expected.push(i);
				assert.deepEqual(Array.from(got.slice(off, off + counts[w])), expected,
					"winner " + w + "'s bin is column-index sorted under arbitrary scatter order, trial " + trial);
				off += counts[w];
			}
			assert.equal(off, total, 'every loser sits in exactly one bin');
		}
		// mega-bin: 400 losers under one winner, spanning seven tiles
		const mega = new Int32Array(410).fill(-1);
		for (let i = 10; i < 410; i++) mega[i] = 3;
		const out = binAndSort(mega, 410);
		const want = [];
		for (let i = 10; i < 410; i++) want.push(i);
		assert.deepEqual(Array.from(out.slice(0, 400)), want, 'the tile sweep ranks a >64-entry bin');
		assert.equal(out[400], -1, 'no loser spills past the bin');
	}

	// 10. A play that opens on a due event must submit the render tail BEFORE the
	// round trip awaits: getCurrentTexture after a yield presents black (L6 flash
	// per cadence, L7 blank until pause). The tail is consumed once, so later
	// segments of the same call do not acquire the canvas again.
	{
		const due = world(41);
		due.lastEvent = due.t - Params.eventCadence;
		await GpuSim.init(due, { device: makeDevice() });
		const order = [];
		const realRT = GpuSim.roundTrip;
		GpuSim.roundTrip = async function () {
			order.push('roundTrip');
			return realRT.apply(GpuSim, arguments);
		};
		await GpuSim.play(due, DT, 2, null, { render: function () { order.push('render'); } });
		GpuSim.roundTrip = realRT;
		assert.equal(order[0], 'render', 'the visible frame is submitted before the round trip yields');
		assert.ok(order.indexOf('roundTrip') > 0, 'the due event still runs');
		assert.equal(order.filter(function (x) { return x === 'render'; }).length, 1,
			'the canvas is acquired once per play call');
	}
	console.log('PASS gpu-play: ' + FRAMES + ' frames, ' + cyclesPlayed + ' event cycles both paths, event round trip ships '
		+ full.n + '/' + full.colCap + ' columns and no cell or edge buffer, a batch the drag gate stopped resumes '
		+ 'into the same run, re-init releases the replaced arenas, K11 is on demand');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

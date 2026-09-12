// The GPU play path on the stub device (tests/gpu-stub.js): no kernel runs here, so this
// covers the JS side the browser rigs cannot see cheaply - the event round trip's partial
// mirror transfer and the scheduling of frames around it. Level 3 keeps it under a second.
//   1. play() and N step() calls leave the mirror identical and the cadence intact;
//   2. the event round trip ships only what Events.cycle touches: the cell and edge
//      buffers on the device survive it untouched, so no stale cell state is ever pushed
//      back over what the kernels computed;
//   3. what it does ship is faithful, and the rows past aliveN carry alive = 0;
//   4. a full sync followed by an event round trip - the app's real sequence - reads only
//      the buffers that transfer mapped, never the wider set left in the staging cache.
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
	console.log('PASS gpu-play: ' + FRAMES + ' frames, ' + cyclesPlayed + ' event cycles both paths, event round trip ships '
		+ full.n + '/' + full.colCap + ' columns and no cell or edge buffer');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

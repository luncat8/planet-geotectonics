// Phase E checkpoints: a save/load round trip must be invisible to the simulation, and a
// damaged blob must be rejected before it touches the live state.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Checkpoint = require('../js/checkpoint.js');
const g = new Grid(3, 7).build();
const dt = 0.1;

function run(seed, frames, blob) {
	const s = new State(g, seed);
	s.ckptCap = 0;
	if (blob) Checkpoint.load(s, blob); else Sim.raster(s);
	Sim.advance(s, dt, frames);
	return s;
}
// What the blob promises: every stored array, every scalar, and world over the alive columns.
// Dead slots are scratch, so their stale contents are not part of the state.
function sameState(a, b) {
	for (const key of Checkpoint.ARRAYS) {
		assert.equal(Buffer.compare(Buffer.from(a[key].buffer), Buffer.from(b[key].buffer)), 0, key);
	}
	for (const key of Checkpoint.SCALARS) assert.equal(a[key], b[key], key);
	assert.equal(a.n, b.n);
	for (let i = 0; i < a.n; i++) {
		if (!a.alive[i]) continue;
		const o = i * 3;
		assert.equal(a.world[o], b.world[o], 'world x of column ' + i);
		assert.equal(a.world[o + 1], b.world[o + 1], 'world y of column ' + i);
		assert.equal(a.world[o + 2], b.world[o + 2], 'world z of column ' + i);
	}
}

// --- round trip ----------------------------------------------------------------------------
{
	const s = new State(g, 7);
	s.ckptCap = 0;
	Sim.raster(s);
	Sim.advance(s, dt, 300);
	const blob = Checkpoint.save(s);
	Sim.advance(s, dt, 300);

	const restored = run(7, 300, blob);
	sameState(s, restored);
	assert.equal(restored.t, s.t);
	assert.equal(restored.plateCount, s.plateCount);
	assert.equal(restored.splits, s.splits);
	console.log('PASS checkpoint: a 300 frame round trip is bit-identical,', blob.byteLength, 'bytes');
}

// --- the ring -------------------------------------------------------------------------------
{
	const s = new State(g, 7);
	s.ckptCap = 4;
	Sim.raster(s);
	Sim.advance(s, dt, 1000);                // 100 Myr at ckptEvery 20 fills the ring
	assert.equal(s.ckptN, 4, 'ring depth ' + s.ckptN);
	const newest = Checkpoint.entry(s, 0), oldest = Checkpoint.entry(s, 3);
	assert.ok(newest && oldest, 'the ring holds its entries');
	assert.ok(newest.t > oldest.t, 'entry 0 is the newest');
	assert.ok(newest.t <= s.t && oldest.t > 0, 'snapshots are stamped with their own time');
	assert.equal(Checkpoint.entry(s, 4), null, 'the ring does not reach past its depth');
	const before = newest.t;
	Sim.advance(s, dt, 400);
	assert.equal(s.ckptN, 4, 'the ring wraps instead of growing');
	assert.ok(Checkpoint.entry(s, 0).t > before, 'the newest snapshot moved forward');
	// Rewinding to a snapshot restores that moment exactly, and it can be stepped again.
	const back = Checkpoint.entry(s, 2);
	const replay = run(7, 0, back.blob);
	assert.equal(replay.t, back.t);
	Sim.advance(replay, dt, 40);
	assert.equal(replay.finite, 1);
	assert.ok(replay.t > back.t);
	console.log('PASS checkpoint: the ring wraps and a snapshot replays', { oldest: oldest.t, newest: before });
}

// --- rejected blobs -------------------------------------------------------------------------
{
	const s = new State(g, 7);
	s.ckptCap = 0;
	Sim.raster(s);
	Sim.advance(s, dt, 200);
	const good = Checkpoint.save(s);
	const frozen = new State(g, 7);
	frozen.ckptCap = 0;
	Sim.raster(frozen);
	const before = Checkpoint.save(frozen);

	function corrupt(name, edit) {
		const copy = Uint8Array.from(good);
		edit(copy);
		assert.throws(function () { Checkpoint.load(frozen, copy); }, RangeError, name);
	}
	const words = new Uint32Array(good.buffer, 0, Checkpoint.WORDS);
	corrupt('bad magic', b => { new Uint32Array(b.buffer, 0, 1)[0] = 0; });
	corrupt('unknown version', b => { new Uint32Array(b.buffer, 4, 1)[0] = 99; });
	corrupt('wrong level', b => { new Uint32Array(b.buffer, 8, 1)[0] = words[2] + 1; });
	corrupt('wrong seed', b => { new Uint32Array(b.buffer, 12, 1)[0] = words[3] + 1; });
	corrupt('wrong capacity', b => { new Uint32Array(b.buffer, 24, 1)[0] = words[6] + 1; });
	corrupt('wrong table', b => { new Uint32Array(b.buffer, 32, 1)[0] = words[8] - 1; });
	corrupt('truncated data', b => { new Uint32Array(b.buffer, 36, 1)[0] = words[9] + 8; });
	corrupt('trailing data', b => { new Uint32Array(b.buffer, 36, 1)[0] = words[9] - 8; });
	corrupt('block table', b => {
		const at = Checkpoint.HEAD + Checkpoint.SCALARS.length * 8 + 4 * 3;
		new Uint32Array(b.buffer, at, 1)[0] += 1;
	});
	assert.throws(function () { Checkpoint.load(frozen, good.subarray(0, 32)); }, RangeError, 'short header');
	// Every rejection left the live state exactly as it was.
	const after = Checkpoint.save(frozen);
	assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(after)), 0, 'a rejected blob must not mutate state');
	console.log('PASS checkpoint: nine malformed blobs rejected, live state untouched');
}

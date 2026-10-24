'use strict';
const { assert, Grid, State, Sim } = require('./helpers.js');
const Checkpoint = require('../js/checkpoint.js');
const Surface = require('../js/climate-surface.js');
const Session = require('../js/session.js');

const grid = new Grid(2, 7).build();
const world = new State(grid, 7);
world.ckptCap = 0;
Sim.raster(world);
Sim.advance(world, 0.1, 20);
const worldBytes = Checkpoint.save(world);

function surfacePacket() {
	const elevation = new Float64Array(grid.V);
	for (let i = 0; i < grid.V; i++) elevation[i] = i * 10 - 100;
	return {
		format: Surface.FORMAT, version: 1, level: 2, targetLevel: 2, V: grid.V,
		lookupW: grid.lookupW, lookupH: grid.lookupH,
		lookup: grid.lookup, elevation: elevation, seaLevel: 0, tMyr: 2
	};
}
function climatePayload() {
	const textures = [];
	for (let a = 0; a < 8; a++) {
		const data = new Float32Array(256 * Math.ceil(grid.V / 256) * 4);
		for (let i = 0; i < data.length; i++) data[i] = a * 1000 + i;
		textures.push(Buffer.from(data.buffer).toString('base64'));
	}
	return {
		format: 'pgt-climate-state', version: 1,
		state: {
			version: 1, level: 2, W: 256, H: 1,
			simTime: 98765.5, stepCount: 123,
			params: { running: true, substeps: 1 }, bounds: {}, A: textures
		},
		surface: Surface.encode(surfacePacket())
	};
}

// Plain checkpoints keep the old path; a PGTS carries the exact checkpoint bytes plus both
// climate textures and the held geometry that standalone planet-climate saves do not own.
{
	const plain = Session.read(worldBytes);
	assert.equal(plain.climate, null);
	assert.deepEqual(plain.head, { level: 2, seed: 7, V: grid.V });
	assert.deepEqual(plain.world, worldBytes);

	const payload = climatePayload();
	const bytes = Session.encode(worldBytes, payload);
	assert.ok(Session.is(bytes));
	assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'PGTS');
	const decoded = Session.decode(bytes);
	assert.deepEqual(decoded.world, worldBytes);
	assert.deepEqual(decoded.climate, payload);
	assert.deepEqual(decoded.head, plain.head);
	const restoredSurface = Surface.decode(decoded.climate.surface);
	assert.deepEqual(restoredSurface.elevation, surfacePacket().elevation);
	assert.equal(restoredSurface.targetLevel, 2);

	// File views need not be naturally aligned. The wrapper uses DataView and returns an
	// aligned checkpoint copy, so Checkpoint.peek/load never inherit the outer byte offset.
	const padded = new Uint8Array(bytes.length + 5);
	padded.set(bytes, 3);
	const unaligned = padded.subarray(3, 3 + bytes.length);
	assert.equal(unaligned.byteOffset % 8, 3);
	const fromOdd = Session.read(unaligned);
	assert.equal(fromOdd.world.byteOffset % 8, 0);
	assert.deepEqual(fromOdd.world, worldBytes);
	console.log('PASS session: plain .pgt compatibility, PGTS dual-state round trip and unaligned input');
}

// Every structural refusal happens before the page attempts a rebuild or touches live state.
{
	const payload = climatePayload();
	const good = Session.encode(worldBytes, payload);
	function corrupt(name, edit, pattern) {
		const bytes = Uint8Array.from(good);
		edit(bytes);
		assert.throws(() => Session.decode(bytes), pattern || Error, name);
	}
	corrupt('magic', (b) => { b[0] = 0; }, /not a planet session/);
	corrupt('version', (b) => { new DataView(b.buffer).setUint32(4, 99, true); }, /session version 99/);
	corrupt('world length', (b) => { new DataView(b.buffer).setUint32(8, 10, true); }, /session data length/);
	corrupt('reserved flags', (b) => { new DataView(b.buffer).setUint32(20, 1, true); }, /session header flags/);
	corrupt('world magic', (b) => { b[Session.HEAD] = 0; }, /not a planet-geotectonics checkpoint/);
	corrupt('climate JSON', (b) => { b[b.length - 1] = 32; }, /climate JSON|held surface|state/);
	assert.throws(() => Session.validateClimate(null), /pgt-climate-state/);
	const wrongSurface = climatePayload();
	wrongSurface.surface = Object.assign({}, wrongSurface.surface, { targetLevel: 3 });
	assert.throws(() => Session.encode(worldBytes, wrongSurface), /held surface/);
	const wrongDimensions = climatePayload();
	wrongDimensions.state.H = 2;
	assert.throws(() => Session.encode(worldBytes, wrongDimensions), /texture dimensions/);
	assert.throws(() => Session.read(new Uint8Array(12)), /truncated|checkpoint/);
	console.log('PASS session: magic, versions, lengths, flags, world and climate schema refusals');
}

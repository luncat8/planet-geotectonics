'use strict';
const { assert, Grid } = require('./helpers.js');
const Surface = require('../js/climate-surface.js');
const Frame = require('../js/climate-frame.js');

const outbound = [];
let nextRaf = 0;
const cancelledRafs = [];
global.requestAnimationFrame = () => ++nextRaf;
global.cancelAnimationFrame = (id) => cancelledRafs.push(id);
global.window = { parent: { postMessage: (message) => outbound.push(message) } };
global.assertSaveParamsCurrent = function (params) {
	if (!params || typeof params !== 'object') throw new Error('params required');
};
function decodeTexture(text) {
	return new Float32Array(Uint8Array.from(Buffer.from(text, 'base64')).buffer);
}
function encodeTexture(array) {
	return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
}
global.decodePlanetState = function (encoded) {
	return Object.assign({}, encoded, { A: encoded.A.map(decodeTexture) });
};
global.encodePlanetState = function (state) {
	return Object.assign({}, state, { A: state.A.map(encodeTexture) });
};

function geometry(level) {
	const source = new Grid(level, 7).build();
	const grid = {
		level: level, V: source.V,
		cellA: new Float32Array(source.V * 4), cellB: new Float32Array(source.V * 4), cellC: new Float32Array(source.V * 4)
	};
	for (let i = 0; i < source.V; i++) {
		grid.cellA[i * 4] = source.pos[i * 3];
		grid.cellA[i * 4 + 1] = source.pos[i * 3 + 1];
		grid.cellA[i * 4 + 2] = source.pos[i * 3 + 2];
		grid.cellA[i * 4 + 3] = source.A0[i];
	}
	return { source: source, grid: grid };
}
function makePlanet(level) {
	const built = geometry(level);
	const planet = {
		grid: built.grid, params: { hTop: 60, dShelf: 200, running: false, mode: 0 },
		texCellB: {}, texCellC: {}, simTime: 0, stepCount: 0,
		writes: 0, resets: 0, loops: 0, builds: 0, disposes: 0,
		writeTex: function () { this.writes++; },
		reset: function () { this.resets++; this.simTime = 0; this.stepCount = 0; },
		loop: function () { this.raf = requestAnimationFrame(function () {}); this.loops++; },
		dispose: function () { this.disposes++; },
		build: function (nextLevel) {
			const next = geometry(nextLevel);
			this.grid = next.grid;
			this.builds++;
			this.reset();
		},
		applyState: function (state) {
			this.params = Object.assign({}, state.params);
			this.simTime = state.simTime;
			this.stepCount = state.stepCount;
			this.A = state.A;
		},
		serializeState: function () {
			const A = [];
			for (let a = 0; a < 8; a++) A.push(new Float32Array(256 * Math.ceil(this.grid.V / 256) * 4));
			return {
				version: 1, level: this.grid.level, W: 256, H: Math.ceil(this.grid.V / 256),
				simTime: this.simTime, stepCount: this.stepCount,
				params: Object.assign({}, this.params), bounds: {}, A: A
			};
		}
	};
	return planet;
}
function packet(level, t) {
	const source = new Grid(level, 7).build();
	const elevation = new Float64Array(source.V);
	for (let i = 0; i < source.V; i++) elevation[i] = (i % 7 - 3) * 1000;
	return {
		format: Surface.FORMAT, version: 1, level: level, V: source.V,
		lookupW: source.lookupW, lookupH: source.lookupH,
		lookup: source.lookup, elevation: elevation, seaLevel: 0, tMyr: t
	};
}
function encodedState(level, running) {
	const V = Surface.cellsAt(level), A = [];
	const textureLength = 256 * Math.ceil(V / 256) * 4;
	for (let a = 0; a < 8; a++) A.push(encodeTexture(new Float32Array(textureLength)));
	return {
		version: 1, level: level, W: 256, H: Math.ceil(V / 256),
		simTime: 500, stepCount: 5, params: { running: running, mode: 0, substeps: 1 }, bounds: {}, A: A
	};
}

assert.deepEqual(Frame.SCRIPTS, ['geodesics.js', 'shader.js', 'params.js', 'engine.js']);
Frame.channel = 'test';
Frame.level = 2;
Frame.planet = makePlanet(2);
Frame.state = 'ready';
let requestId = 0;
function request(type, body) {
	const message = Object.assign({ source: 'pgt-climate-v1', channel: 'test', type: type, id: ++requestId }, body);
	Frame.receive(message);
	const result = outbound[outbound.length - 1];
	assert.equal(result.type, 'result');
	assert.equal(result.id, message.id);
	return result;
}

// Wrong channels are ignored; a bad view refuses without mutating the current view.
{
	const before = outbound.length;
	Frame.receive({ source: 'pgt-climate-v1', channel: 'other', type: 'capture', id: 99 });
	assert.equal(outbound.length, before);
	const bad = request('configure', { mode: 99 });
	assert.equal(bad.ok, false);
	assert.equal(Frame.planet.params.mode, 0);
}

// The first surface initializes against the transferred geometry and draws one manual frame.
// Same-level refresh preserves simTime; a level change explicitly reports its clock reset.
{
	const first = request('surface', { surface: packet(2, 2), reset: true });
	assert.equal(first.ok, true);
	assert.equal(first.surfaceTMyr, 2);
	assert.equal(first.clockReset, false);
	assert.equal(Frame.planet.resets, 1);
	assert.equal(Frame.planet.loops, 1);
	assert.equal(Frame.planet.grid.cellC[3], 0, 'old coast distance is cleared');
	Frame.planet.simTime = 8000;
	const second = request('surface', { surface: packet(2, 4), reset: false });
	assert.equal(second.ok, true);
	assert.equal(second.days, 8000 / 86400);
	assert.equal(Frame.planet.simTime, 8000, 'same-grid weather clock survives a manual surface refresh');
	assert.equal(Frame.planet.resets, 1);
	const third = request('surface', { surface: packet(3, 6), reset: false });
	assert.equal(third.ok, true);
	assert.equal(third.clockReset, true);
	assert.equal(Frame.planet.grid.level, 3);
	assert.equal(Frame.planet.simTime, 0);
	assert.equal(Frame.planet.loops, 3, 'each surface operation draws exactly one pumped frame');
	assert.equal(cancelledRafs.length, 3, 'every engine successor rAF is cancelled');
}

// Restore decodes and validates first, re-applies the saved held geometry, and resumes the
// saved weather clock. Capture then returns both the fluid state and that geometry.
{
	const held = packet(2, 6);
	held.targetLevel = 2;
	const payload = { format: 'pgt-climate-state', version: 1, state: encodedState(2, false), surface: Surface.encode(held) };
	const restored = request('restore', { payload: payload });
	assert.equal(restored.ok, true);
	assert.equal(restored.days, 500 / 86400);
	assert.equal(restored.running, false);
	assert.equal(Frame.planet.grid.level, 2);
	assert.equal(Frame.planet.simTime, 500);
	assert.equal(Frame.planet.params.running, false);
	assert.equal(Frame.planet.loops, 4);
	const ticked = request('tick');
	assert.equal(ticked.ok, true);
	assert.equal(ticked.days, 500 / 86400);
	assert.equal(Frame.planet.loops, 5);
	assert.equal(cancelledRafs.length, 5);
	const captured = request('capture');
	assert.equal(captured.ok, true);
	assert.equal(captured.payload.format, 'pgt-climate-state');
	assert.equal(captured.payload.state.simTime, 500);
	assert.equal(captured.payload.surface.targetLevel, 2);
	assert.deepEqual(Surface.decode(captured.payload.surface).elevation, held.elevation);

	const oldTime = Frame.planet.simTime;
	const oldGeometry = Uint8Array.from(new Uint8Array(Frame.planet.grid.cellC.buffer));
	const invalid = encodedState(2, true);
	invalid.A[0] = invalid.A[0].slice(0, -8);
	const refused = request('restore', { payload: { format: 'pgt-climate-state', version: 1, state: invalid, surface: payload.surface } });
	assert.equal(refused.ok, false);
	assert.match(refused.error, /texture 0 length/);
	assert.equal(Frame.planet.simTime, oldTime);
	assert.deepEqual(Uint8Array.from(new Uint8Array(Frame.planet.grid.cellC.buffer)), oldGeometry,
		'a malformed restore does not rebuild or apply its surface first');
}

Frame.close();
assert.equal(Frame.planet, null);
console.log('PASS climate frame: protocol refusals, cancelled successor rAFs, pumped frames, held surface cadence, clocks and dual-state capture/restore');

// Joint geology + weather session container (0.9.1). Checkpoint remains the authoritative
// geology codec; PGTS wraps its bytes and a versioned climate payload without changing the
// checkpoint ring or the plain .pgt path used while the climate panel is closed.
var SessionCheckpoint = typeof module !== 'undefined' && module.exports ? require('./checkpoint.js') : Checkpoint;
var Session = (function () {
	'use strict';
	var MAGIC = 0x53544750, VERSION = 1, HEAD = 32; // bytes: PGTS

	function viewOf(bytes) {
		return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	}
	function aligned(bytes) { return Uint8Array.from(viewOf(bytes)); }
	function is(bytes) {
		var view = viewOf(bytes);
		return view.byteLength >= 8 && new DataView(view.buffer, view.byteOffset, 8).getUint32(0, true) === MAGIC;
	}
	function levelCells(level) { return 10 * Math.pow(4, level) + 2; }

	function validateClimate(payload) {
		if (!payload || payload.format !== 'pgt-climate-state' || payload.version !== 1)
			throw new RangeError('not a pgt-climate-state v1 payload');
		var state = payload.state, surface = payload.surface;
		if (!state || state.version !== 1 || !Number.isInteger(state.level)
			|| state.level < 0 || state.level > 7 || !Number.isInteger(state.W) || !Number.isInteger(state.H))
			throw new RangeError('climate state header');
		var V = levelCells(state.level);
		if (state.W !== 256 || state.H !== Math.ceil(V / state.W))
			throw new RangeError('climate state texture dimensions');
		if (!Number.isFinite(state.simTime) || state.simTime < 0
			|| !Number.isFinite(state.stepCount) || state.stepCount < 0
			|| !state.params || typeof state.params !== 'object' || !Array.isArray(state.A) || state.A.length !== 8)
			throw new RangeError('climate state clock/texture table');
		for (var i = 0; i < 8; i++)
			if (typeof state.A[i] !== 'string' || !state.A[i].length) throw new RangeError('climate state texture ' + i);
		if (!surface || surface.format !== 'pgt-climate-surface' || surface.version !== 1
			|| surface.targetLevel !== state.level
			|| typeof surface.lookup !== 'string' || typeof surface.elevation !== 'string')
			throw new RangeError('climate state held surface');
		return payload;
	}

	function encode(worldBytes, climate) {
		var world = aligned(worldBytes);
		SessionCheckpoint.peek(world);
		validateClimate(climate);
		var json = new TextEncoder().encode(JSON.stringify(climate));
		var out = new Uint8Array(HEAD + world.byteLength + json.byteLength);
		var head = new DataView(out.buffer);
		head.setUint32(0, MAGIC, true);
		head.setUint32(4, VERSION, true);
		head.setUint32(8, world.byteLength, true);
		head.setUint32(12, json.byteLength, true);
		head.setUint32(16, climate.version, true);
		out.set(world, HEAD);
		out.set(json, HEAD + world.byteLength);
		return out;
	}

	function decode(bytes) {
		var view = viewOf(bytes);
		if (view.byteLength < HEAD || !is(view)) throw new RangeError('not a planet session');
		var head = new DataView(view.buffer, view.byteOffset, view.byteLength);
		if (head.getUint32(4, true) !== VERSION) throw new RangeError('session version ' + head.getUint32(4, true));
		var worldLength = head.getUint32(8, true), jsonLength = head.getUint32(12, true);
		if (head.getUint32(16, true) !== 1 || head.getUint32(20, true) || head.getUint32(24, true)
			|| head.getUint32(28, true)) throw new RangeError('session header flags');
		if (worldLength < SessionCheckpoint.HEAD || jsonLength < 2
			|| worldLength + jsonLength + HEAD !== view.byteLength) throw new RangeError('session data length');
		var world = new Uint8Array(worldLength);
		world.set(view.subarray(HEAD, HEAD + worldLength));
		var climate;
		try {
			var json = new TextDecoder('utf-8', { fatal: true }).decode(
				view.subarray(HEAD + worldLength, HEAD + worldLength + jsonLength));
			climate = JSON.parse(json);
		} catch (error) {
			throw new RangeError('session climate JSON: ' + error.message);
		}
		validateClimate(climate);
		return { world: world, climate: climate, head: SessionCheckpoint.peek(world) };
	}

	// One entry for the page's Load control: plain .pgt and joint .pgts share the geology
	// preflight, while only the latter carries a climate payload to restore afterwards.
	function read(bytes) {
		if (is(bytes)) return decode(bytes);
		var world = aligned(bytes);
		return { world: world, climate: null, head: SessionCheckpoint.peek(world) };
	}

	return {
		MAGIC: MAGIC, VERSION: VERSION, HEAD: HEAD,
		is: is, validateClimate: validateClimate,
		encode: encode, decode: decode, read: read
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Session;

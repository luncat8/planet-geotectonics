// Engine side of the isolated climate iframe (0.9.1). climate-host.html loads this file and
// ClimateSurface from the globe tree, then this loader walks the counterpart's four classic
// scripts. No counterpart global enters the geology page. The parent pumps individual
// Planet.loop frames; messages also change pause/view, exchange surfaces, or save/restore.
var ClimateFrameSurface = typeof module !== 'undefined' && module.exports ? require('./climate-surface.js') : ClimateSurface;
var ClimateFrame = (function () {
	'use strict';
	var SOURCE = 'pgt-climate-v1';
	var SCRIPTS = ['geodesics.js', 'shader.js', 'params.js', 'engine.js'];
	var api = {
		state: 'closed', reason: '', base: '', channel: '', level: 5,
		planet: null, canvas: null, SCRIPTS: SCRIPTS,
		onChange: null
	};
	var started = false, surface = null;
	var requestedRunning = true, requestedMode = 0;

	function notify() { if (typeof api.onChange === 'function') api.onChange(); }
	function text(value) {
		var node = document.getElementById('climate-frame-status');
		if (node) node.textContent = value;
	}
	function send(type, body) {
		if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
		var message = body || {};
		message.source = SOURCE;
		message.channel = api.channel;
		message.type = type;
		window.parent.postMessage(message, '*');
	}
	function result(id, ok, body) {
		var message = body || {};
		message.id = id;
		message.ok = ok;
		send('result', message);
	}
	function refuse(reason) {
		api.state = 'refused';
		api.reason = reason;
		text(reason);
		send('refused', { reason: reason });
		notify();
	}
	function withSlash(base) { return base.charAt(base.length - 1) === '/' ? base : base + '/'; }
	function cellsAt(level) { return 10 * Math.pow(4, level) + 2; }

	function decodeState(encoded) {
		if (!encoded || encoded.version !== 1 || !Number.isInteger(encoded.level)
			|| encoded.level < 0 || encoded.level > 7 || !Array.isArray(encoded.A) || encoded.A.length !== 8)
			throw new RangeError('invalid climate state header');
		var V = cellsAt(encoded.level);
		if (encoded.W !== 256 || encoded.H !== Math.ceil(V / 256))
			throw new RangeError('invalid climate state texture dimensions');
		if (!Number.isFinite(encoded.simTime) || encoded.simTime < 0
			|| !Number.isFinite(encoded.stepCount) || encoded.stepCount < 0)
			throw new RangeError('invalid climate state clock');
		assertSaveParamsCurrent(encoded.params);
		var state = decodePlanetState(encoded);
		for (var i = 0; i < 8; i++) {
			if (!(state.A[i] instanceof Float32Array) || state.A[i].length !== encoded.W * encoded.H * 4)
				throw new RangeError('climate state texture ' + i + ' length');
		}
		return state;
	}
	function stats() {
		var planet = api.planet;
		return {
			days: planet.simTime / 86400, fps: planet.fps || 0, level: planet.grid.level,
			running: !!planet.params.running, mode: planet.params.mode | 0,
			meanT: planet.globals ? planet.globals.meanT : null
		};
	}
	function configure(message) {
		if (!api.planet) throw new Error('the climate engine is not ready');
		if (message.running !== undefined) requestedRunning = !!message.running;
		if (message.mode !== undefined) {
			if (!Number.isInteger(message.mode) || message.mode < 0 || message.mode > 23)
				throw new RangeError('unknown climate view ' + message.mode);
			requestedMode = message.mode;
		}
		api.planet.params.running = requestedRunning;
		api.planet.params.mode = requestedMode;
		api.planet.params.equirect = 1;
		api.planet.params.streamline = 0;
		frameOnce();
		return { running: requestedRunning, mode: requestedMode };
	}
	// Chromium can suspend rAF in an offscreen file:// iframe. The visible parent therefore
	// pumps one frame at a time over postMessage. Planet.loop schedules its own successor, so
	// cancel exactly that successor after every manual frame: no hidden loop and no backlog.
	function frameOnce() {
		if (!api.planet) throw new Error('the climate engine is not ready');
		try { api.planet.loop(); }
		finally {
			if (typeof cancelAnimationFrame === 'function' && api.planet.raf !== null
				&& api.planet.raf !== undefined) cancelAnimationFrame(api.planet.raf);
		}
		return stats();
	}
	function applySurface(packet, reset) {
		if (!api.planet) throw new Error('the climate engine is not ready');
		ClimateFrameSurface.validate(packet);
		var clockReset = api.planet.grid.level !== packet.level;
		if (clockReset) {
			api.planet.build(packet.level);
			api.planet.stepCount = 0;
		}
		var stats = ClimateFrameSurface.apply(api.planet, packet);
		if (reset || clockReset) {
			api.planet.reset();
			api.planet.stepCount = 0;
		}
		surface = packet;
		api.level = api.planet.grid.level;
		api.planet.params.running = requestedRunning;
		api.planet.params.mode = requestedMode;
		api.planet.params.equirect = 1;
		api.planet.params.streamline = 0;
		frameOnce();
		stats.clockReset = !!clockReset;
		stats.days = api.planet.simTime / 86400;
		return stats;
	}
	function restore(payload) {
		if (!payload || payload.format !== 'pgt-climate-state' || payload.version !== 1)
			throw new RangeError('not a pgt-climate-state v1 payload');
		// Everything that can be validated or decoded is done before touching the live engine.
		var state = decodeState(payload.state);
		var held = ClimateFrameSurface.decode(payload.surface);
		if (held.targetLevel !== state.level) throw new RangeError('climate state/surface level mismatch');
		if (!api.planet) throw new Error('the climate engine is not ready');
		if (api.planet.grid.level !== state.level) api.planet.build(state.level);
		var stats = ClimateFrameSurface.apply(api.planet, held);
		api.planet.applyState(state);
		surface = held;
		api.level = state.level;
		requestedRunning = !!api.planet.params.running;
		requestedMode = api.planet.params.mode | 0;
		api.planet.params.equirect = 1;
		api.planet.params.streamline = 0;
		frameOnce();
		stats.days = api.planet.simTime / 86400;
		stats.running = requestedRunning;
		stats.mode = requestedMode;
		return stats;
	}
	function capture() {
		if (!api.planet || !surface) throw new Error('no climate surface has been applied');
		return {
			format: 'pgt-climate-state', version: 1,
			state: encodePlanetState(api.planet.serializeState()),
			surface: ClimateFrameSurface.encode(surface)
		};
	}
	function receive(message) {
		if (!message || message.source !== SOURCE || message.channel !== api.channel) return;
		if (message.type === 'capture' || message.type === 'restore' || message.type === 'surface'
			|| message.type === 'configure' || message.type === 'tick') {
			try {
				var body;
				if (message.type === 'capture') body = { payload: capture() };
				else if (message.type === 'restore') body = restore(message.payload);
				else if (message.type === 'surface') body = applySurface(message.surface, !!message.reset);
				else if (message.type === 'tick') body = frameOnce();
				else body = configure(message);
				result(message.id, true, body);
			} catch (error) {
				result(message.id, false, { error: error && error.message ? error.message : String(error) });
			}
			notify();
		}
	}
	function loadTree() {
		var at = 0;
		function next() {
			if (at >= SCRIPTS.length) {
				try {
					if (typeof Planet !== 'function' || typeof encodePlanetState !== 'function'
						|| typeof decodePlanetState !== 'function') throw new Error('the loaded tree is not planet-climate');
					api.canvas = document.getElementById('climate-canvas');
					api.planet = new Planet(api.canvas, api.level, { autoStart: false });
					api.planet.params.running = false;
					api.planet.params.substeps = 1;
					api.planet.params.substepsAutoDown = 1;
					api.planet.params.substepsAutoUp = 0;
					api.planet.params.equirect = 1;
					api.planet.params.streamline = 0;
					api.planet.onStats = function (stats) {
						send('stats', {
							days: stats.days, fps: stats.fps, level: stats.level,
							running: api.planet && !!api.planet.params.running,
							meanT: stats.meanT, steps: stats.effN
						});
					};
					api.state = 'ready';
					text('Climate engine ready; waiting for a globe surface.');
					send('ready', { level: api.level });
					notify();
				} catch (error) {
					refuse('Climate engine failed: ' + (error && error.message ? error.message : String(error)));
				}
				return;
			}
			var url = api.base + SCRIPTS[at++];
			var script = document.createElement('script');
			script.addEventListener('load', next);
			script.addEventListener('error', function () {
				refuse('Climate tree did not load: ' + url + ' · check the sibling checkout or ?climate=<base>.');
			});
			script.setAttribute('src', url);
			document.head.appendChild(script);
		}
		next();
	}
	api.receive = receive;
	api.start = function () {
		if (started) return;
		started = true;
		var query = new URLSearchParams(location.search);
		api.channel = query.get('channel') || '';
		api.base = withSlash(query.get('base') || '../planet-climate/planet/');
		api.level = Number(query.get('level') || 5);
		if (!api.channel || !Number.isInteger(api.level) || api.level < 0 || api.level > 7) {
			refuse('Climate frame needs a channel and a level from 0 to 7.');
			return;
		}
		api.state = 'loading';
		text('Loading planet-climate from ' + api.base + ' …');
		if (typeof window !== 'undefined' && window.addEventListener) {
			window.addEventListener('message', function (event) { receive(event.data); });
		}
		loadTree();
	};
	api.close = function () {
		if (api.planet) api.planet.dispose();
		api.planet = null;
		api.state = 'closed';
	};
	return api;
}());
if (typeof module !== 'undefined' && module.exports) module.exports = ClimateFrame;

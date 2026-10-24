// Page side of the two-clock climate host (0.9.1). Only this adapter enters the globe realm;
// planet-climate itself runs in climate-host.html's iframe because both repositories still
// own a classic-script Grid global. Messages are explicit and manual: no weather field ever
// enters the geology kernels at this stage.
var ClimateHost = (function () {
	'use strict';
	var SOURCE = 'pgt-climate-v1', DEFAULT_BASE = '../planet-climate/planet/';
	var api = {
		climateBase: DEFAULT_BASE, state: 'closed', reason: '',
		level: 5, weatherDays: 0, weatherRunning: true, weatherFps: 0,
		surfaceTMyr: null, currentTMyr: 0, meanT: null,
		onChange: null
	};
	var panel, frame, toggle, play, refresh, view, status, clock;
	var provider = null, wired = false, serial = 0, requestSerial = 0;
	var channel = '', pendingSurface = null, pendingRestore = null;
	var boot = null, bootTimer = 0, refreshing = false;
	var pumpWaiting = false, pumpGeneration = 0, lastPumpPaint = 0;
	var pending = new Map();

	function byId(id) { return document.getElementById(id); }
	function notify() { if (typeof api.onChange === 'function') api.onChange(); }
	function withSlash(base) { return base.charAt(base.length - 1) === '/' ? base : base + '/'; }
	function deferred() {
		var resolve, reject;
		var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
		return { promise: promise, resolve: resolve, reject: reject };
	}
	function clearBootTimer() {
		if (bootTimer) clearTimeout(bootTimer);
		bootTimer = 0;
	}
	function statusText() {
		if (api.state === 'closed') return 'Closed. Open climate to run weather independently on a held globe surface.';
		if (api.state === 'loading') return 'Loading the isolated climate engine from ' + api.climateBase + ' …';
		if (api.state === 'refused') return api.reason;
		var text = (api.weatherRunning ? 'weather running' : 'weather paused') + ' · L' + api.level;
		if (api.surfaceTMyr !== null) {
			text += ' · surface from t ' + api.surfaceTMyr.toFixed(1) + ' Myr';
			if (Math.abs(api.currentTMyr - api.surfaceTMyr) > 1e-9)
				text += ' · globe now ' + api.currentTMyr.toFixed(1) + ' Myr; Refresh surface to update';
		}
		if (api.reason) text += ' · ' + api.reason;
		return text;
	}
	api.statusText = statusText;
	function paint() {
		if (!panel) return;
		panel.hidden = api.state === 'closed';
		toggle.setAttribute('aria-pressed', api.state === 'closed' ? 'false' : 'true');
		toggle.textContent = api.state === 'closed' ? 'Open climate' : 'Close climate';
		play.disabled = api.state !== 'running';
		play.textContent = api.weatherRunning ? 'Pause weather' : 'Run weather';
		play.setAttribute('aria-pressed', api.state === 'running' && api.weatherRunning ? 'true' : 'false');
		refresh.disabled = api.state !== 'running' || refreshing;
		refresh.textContent = refreshing ? 'Refreshing…' : 'Refresh surface';
		view.disabled = api.state !== 'running';
		status.textContent = statusText();
		clock.hidden = api.state === 'closed';
		if (api.state === 'running') clock.textContent = 'weather day ' + api.weatherDays.toFixed(1)
			+ (api.weatherRunning ? '' : ' · paused');
		else if (api.state === 'loading') clock.textContent = 'weather loading';
		else if (api.state === 'refused') clock.textContent = 'weather unavailable';
		else clock.textContent = 'weather off';
		notify();
	}
	function fail(error) {
		var message = error && error.message ? error.message : String(error);
		if (boot) {
			var current = boot;
			boot = null;
			clearBootTimer();
			current.reject(error instanceof Error ? error : new Error(message));
		}
		api.state = 'refused';
		api.reason = message;
		paint();
	}
	function rejectPending(error) {
		var list = Array.from(pending.values());
		pending.clear();
		for (var i = 0; i < list.length; i++) list[i].reject(error);
	}
	function request(type, body) {
		return new Promise(function (resolve, reject) {
			if (!frame || !frame.contentWindow || !channel) {
				reject(new Error('the climate frame is not available'));
				return;
			}
			var id = ++requestSerial;
			pending.set(id, { resolve: resolve, reject: reject });
			var message = body || {};
			message.source = SOURCE;
			message.channel = channel;
			message.type = type;
			message.id = id;
			try { frame.contentWindow.postMessage(message, '*'); }
			catch (error) { pending.delete(id); reject(error); }
		});
	}
	function applyRunning(data) {
		api.state = 'running';
		api.reason = '';
		if (Number.isFinite(data.level)) api.level = data.level;
		if (Number.isFinite(data.days)) api.weatherDays = data.days;
		if (Number.isFinite(data.surfaceTMyr)) api.surfaceTMyr = data.surfaceTMyr;
		if (data.running !== undefined) api.weatherRunning = !!data.running;
		if (Number.isInteger(data.mode) && view) view.value = String(data.mode);
		paint();
		return data;
	}
	function ready() {
		clearBootTimer();
		var operation;
		if (pendingRestore) operation = request('restore', { payload: pendingRestore });
		else if (pendingSurface) operation = request('surface', { surface: pendingSurface, reset: true });
		else {
			fail(new Error('the climate frame is ready but no surface or saved state was supplied'));
			return;
		}
		operation.then(function (data) {
			applyRunning(data);
			pendingSurface = null;
			pendingRestore = null;
			if (boot) {
				var current = boot;
				boot = null;
				current.resolve(data);
			}
		})['catch'](fail);
	}
	function receive(event) {
		var data = event && event.data;
		if (!data || data.source !== SOURCE || data.channel !== channel) return;
		if (frame && frame.contentWindow && event.source && event.source !== frame.contentWindow) return;
		if (data.type === 'result') {
			var entry = pending.get(data.id);
			if (!entry) return;
			pending.delete(data.id);
			if (data.ok) entry.resolve(data);
			else entry.reject(new Error(data.error || 'climate request refused'));
			return;
		}
		if (data.type === 'ready') { ready(); return; }
		if (data.type === 'refused') { fail(new Error(data.reason || 'the climate tree refused to load')); return; }
		if (data.type === 'stats') {
			if (Number.isFinite(data.days)) api.weatherDays = data.days;
			if (Number.isFinite(data.fps)) api.weatherFps = data.fps;
			if (Number.isFinite(data.level)) api.level = data.level;
			if (data.running !== undefined) api.weatherRunning = !!data.running;
			if (data.meanT !== undefined) api.meanT = data.meanT;
			paint();
		}
	}
	function startFrame(level) {
		rejectPending(new Error('climate frame replaced'));
		channel = 'climate-' + (++serial) + '-' + Date.now().toString(36);
		var query = '?channel=' + encodeURIComponent(channel)
			+ '&base=' + encodeURIComponent(api.climateBase)
			+ '&level=' + encodeURIComponent(level);
		frame.setAttribute('src', 'climate-host.html' + query);
		clearBootTimer();
		bootTimer = setTimeout(function () {
			if (api.state === 'loading') fail(new Error('climate-host.html did not answer; check the local frame and ' + api.climateBase));
		}, 15000);
	}
	function beginBoot() {
		if (boot) {
			boot.reject(new Error('climate boot replaced'));
			boot = null;
		}
		boot = deferred();
		pumpGeneration++;
		pumpWaiting = false;
		api.state = 'loading';
		api.reason = '';
		paint();
		return boot;
	}
	function provide(done, failed) {
		var onFail = failed || fail;
		if (!provider) { done(null); return; }
		try {
			provider(function (surface) { done(surface); }, function (error) {
				onFail(error instanceof Error ? error : new Error(String(error || 'could not capture the globe surface')));
			});
		} catch (error) { onFail(error); }
	}
	api.open = function () {
		if (api.state === 'running') { panel.hidden = false; return Promise.resolve(); }
		if (api.state === 'loading' && boot) return boot.promise;
		var current = beginBoot();
		pendingRestore = null;
		provide(function (surface) {
			if (boot !== current) return;
			if (!surface) { fail(new Error('no globe surface was supplied')); return; }
			pendingSurface = surface;
			startFrame(surface.level);
		});
		return current.promise;
	};
	api.close = function () {
		clearBootTimer();
		if (boot) { boot.reject(new Error('climate closed')); boot = null; }
		pumpGeneration++;
		pumpWaiting = false;
		rejectPending(new Error('climate closed'));
		channel = '';
		pendingSurface = null;
		pendingRestore = null;
		refreshing = false;
		api.state = 'closed';
		api.reason = '';
		api.surfaceTMyr = null;
		api.weatherDays = 0;
		if (frame) frame.setAttribute('src', 'about:blank');
		paint();
	};
	api.refresh = function () {
		if (api.state !== 'running') return Promise.reject(new Error('climate is not running'));
		if (refreshing) return Promise.reject(new Error('a surface refresh is already in flight'));
		refreshing = true;
		api.reason = '';
		paint();
		return new Promise(function (resolve, reject) {
			provide(function (surface) {
				if (!surface) { reject(new Error('no globe surface was supplied')); return; }
				request('surface', { surface: surface, reset: false }).then(function (data) {
					applyRunning(data);
					resolve(data);
				})['catch'](reject);
			}, reject);
		})['catch'](function (error) {
			api.reason = error.message;
			throw error;
		}).then(function (data) {
			refreshing = false;
			paint();
			return data;
		}, function (error) {
			refreshing = false;
			paint();
			throw error;
		});
	};
	api.capture = function () {
		if (api.state === 'closed') return Promise.resolve(null);
		if (api.state !== 'running') return Promise.reject(new Error('climate is not ready; save again after it opens'));
		return request('capture').then(function (data) { return data.payload; });
	};
	api.restore = function (payload) {
		if (!payload || payload.format !== 'pgt-climate-state' || payload.version !== 1)
			return Promise.reject(new RangeError('not a pgt-climate-state v1 payload'));
		if (api.state === 'running') return request('restore', { payload: payload }).then(applyRunning);
		if (api.state === 'loading' && boot) {
			var loading = boot;
			// The current ready/surface handshake owns this frame. Replacing it here would
			// reject that handshake and let its late failure cancel the newer restore.
			return loading.promise.then(function () { return api.restore(payload); });
		}
		var current = beginBoot();
		pendingSurface = null;
		pendingRestore = payload;
		startFrame(payload.state.level);
		return current.promise;
	};
	api.setRunning = function (running) {
		if (api.state !== 'running') return Promise.reject(new Error('climate is not running'));
		return request('configure', { running: !!running }).then(function (data) {
			api.weatherRunning = !!data.running;
			paint();
			return data;
		});
	};
	api.setMode = function (mode) {
		if (api.state !== 'running') return Promise.reject(new Error('climate is not running'));
		return request('configure', { mode: mode }).then(applyRunning);
	};
	// The globe page's visible rAF pumps weather even when the iframe is below the fold.
	// One outstanding request bounds the queue on slow GPUs; responses never resume a weather
	// pause by themselves, and an old frame cannot write into a replacement boot.
	api.pump = function () {
		if (api.state !== 'running' || !api.weatherRunning || pumpWaiting) return;
		var generation = pumpGeneration;
		pumpWaiting = true;
		request('tick').then(function (data) {
			if (generation !== pumpGeneration) return;
			pumpWaiting = false;
			if (api.state !== 'running') return;
			if (Number.isFinite(data.days)) api.weatherDays = data.days;
			if (Number.isFinite(data.level)) api.level = data.level;
			if (Number.isFinite(data.fps)) api.weatherFps = data.fps;
			var now = performance.now();
			if (now - lastPumpPaint >= 150) { lastPumpPaint = now; paint(); }
		}, function (error) {
			if (generation !== pumpGeneration) return;
			pumpWaiting = false;
			if (api.state === 'running') fail(error);
		});
	};
	api.tick = function (tMyr) {
		api.currentTMyr = tMyr;
		if (api.state !== 'closed' && status) status.textContent = statusText();
	};
	api.bind = function (surfaceProvider) {
		provider = surfaceProvider;
		if (wired) return;
		wired = true;
		panel = byId('climate-panel'); frame = byId('climate-frame'); toggle = byId('climate-toggle');
		play = byId('climate-play'); refresh = byId('climate-refresh'); view = byId('climate-view');
		status = byId('climate-status'); clock = byId('climate-time');
		var override = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('climate') : null;
		if (override) api.climateBase = withSlash(override);
		toggle.addEventListener('click', function () {
			if (api.state === 'closed') api.open()['catch'](function () {});
			else api.close();
		});
		play.addEventListener('click', function () {
			api.setRunning(!api.weatherRunning)['catch'](function (error) { api.reason = error.message; paint(); });
		});
		refresh.addEventListener('click', function () { api.refresh()['catch'](function () {}); });
		view.addEventListener('change', function () {
			api.setMode(+view.value)['catch'](function (error) { api.reason = error.message; paint(); });
		});
		if (typeof window !== 'undefined' && window.addEventListener)
			window.addEventListener('message', receive);
		paint();
	};
	api.receive = receive;
	return api;
}());
if (typeof module !== 'undefined' && module.exports) module.exports = ClimateHost;

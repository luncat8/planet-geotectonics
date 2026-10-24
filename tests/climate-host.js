'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert } = require('./helpers.js');
const { makeDom, installGlobals } = require('./dom-stub.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const indexHtml = read('index.html');
const hostSource = read('js/climate-host.js');

assert.match(indexHtml, /id="climate-toggle"[^>]*aria-pressed="false"/);
assert.match(indexHtml, /id="climate-panel"[^>]*hidden/);
assert.match(indexHtml, /id="climate-frame"[^>]*src="about:blank"/);
assert.ok(indexHtml.indexOf('js/checkpoint.js') < indexHtml.indexOf('js/session.js')
	&& indexHtml.indexOf('js/session.js') < indexHtml.indexOf('js/climate-host.js')
	&& indexHtml.indexOf('js/climate-host.js') < indexHtml.indexOf('js/ui.js'),
	'checkpoint -> session -> climate host -> page order');
assert.ok(!/src="(?:\.\.\/)?planet-climate/.test(indexHtml), 'the parent page injects no counterpart global');
const frameHtml = read('climate-host.html');
assert.ok(frameHtml.indexOf('js/climate-surface.js') < frameHtml.indexOf('js/climate-frame.js')
	&& frameHtml.indexOf('js/climate-frame.js') < frameHtml.indexOf('ClimateFrame.start()'),
	'the isolated frame loads the surface codec, adapter, then boot');
assert.ok(!/src="js\/climate-(?:surface|frame)\.js"/.test(indexHtml), 'frame-only modules stay out of the globe realm');
assert.ok(!/setPlaying|Sim\.advance|GpuSim/.test(hostSource), 'the weather adapter cannot pause or step geology');

let realmBefore = null;
function newPage(search) {
	const api = makeDom(indexHtml);
	api.location.search = search || '';
	const listeners = {};
	const window = {
		addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
	};
	const timers = new Map();
	let timerId = 0;
	installGlobals(api, {
		window: window,
		setTimeout: function (fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
		clearTimeout: function (id) { timers.delete(id); }
	});
	if (!realmBefore) realmBefore = new Set(Object.keys(globalThis));
	vm.runInThisContext(hostSource, { filename: 'js/climate-host.js' });
	const host = globalThis.ClimateHost;
	const surfaces = [];
	let serial = 0;
	function surface() {
		const t = 2 + serial++;
		return {
			format: 'pgt-climate-surface', version: 1, level: 2, V: 42,
			lookupW: 2, lookupH: 2, lookup: new Float32Array(4), elevation: new Float64Array(42),
			seaLevel: 0, tMyr: t
		};
	}
	host.bind(function (done) { done(surface()); });
	const frame = api.document.getElementById('climate-frame');
	const outbound = [];
	const child = { postMessage: function (message) { outbound.push(message); } };
	function channel() {
		const src = frame.getAttribute('src');
		return new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('channel');
	}
	function emit(data) {
		const message = Object.assign({ source: 'pgt-climate-v1', channel: channel() }, data);
		for (const fn of listeners.message || []) fn({ data: message, source: child });
	}
	function attach() { frame.contentWindow = child; }
	function last(type) {
		for (let i = outbound.length - 1; i >= 0; i--) if (outbound[i].type === type) return outbound[i];
		throw new Error('no outbound ' + type);
	}
	function result(request, body) { emit(Object.assign({ type: 'result', id: request.id, ok: true }, body)); }
	return { api, host, frame, outbound, surfaces, timers, attach, emit, last, result,
		el: (id) => api.document.getElementById(id),
		added: Object.keys(globalThis).filter((name) => !realmBefore.has(name)) };
}

(async () => {
	const page = newPage('');
	const { host, el } = page;
	assert.ok(page.added.includes('ClimateHost'), 'the adapter registers its one page global');
	assert.equal(host.state, 'closed');
	assert.equal(el('climate-panel').hidden, true);
	assert.equal(el('climate-play').disabled, true);
	assert.equal(el('climate-time').hidden, true);
	assert.equal(page.outbound.length, 0, 'binding does not boot or message an engine');

	// Open waits for the provider, boots the local frame, then does not advance either clock
	// until the initial surface has been acknowledged.
	const opened = host.open();
	page.attach();
	assert.equal(host.state, 'loading');
	assert.match(page.frame.getAttribute('src'), /^climate-host\.html\?channel=/);
	assert.match(page.frame.getAttribute('src'), /level=2/);
	assert.equal(page.timers.size, 1, 'a missing local frame has one bounded load timeout');
	page.emit({ type: 'ready', level: 2 });
	const initial = page.last('surface');
	assert.equal(initial.reset, true);
	assert.equal(initial.surface.tMyr, 2);
	page.result(initial, { level: 2, days: 0, surfaceTMyr: 2 });
	await opened;
	assert.equal(host.state, 'running');
	assert.equal(host.surfaceTMyr, 2);
	assert.equal(el('climate-panel').hidden, false);
	assert.equal(el('climate-play').disabled, false);
	assert.equal(page.timers.size, 0, 'ready cancelled the load timeout');

	// The visible globe rAF pumps at most one offscreen frame. A second pump cannot queue
	// behind it, and its reply updates weather without owning or pausing the geological clock.
	host.pump();
	host.pump();
	const tickMessage = page.last('tick');
	assert.equal(page.outbound.filter((message) => message.type === 'tick').length, 1);
	page.result(tickMessage, { level: 2, days: 1.5, running: true, fps: 60 });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(host.weatherDays, 1.5);

	// Pause is a weather message only. There is no geological control in this adapter's API.
	const paused = host.setRunning(false);
	const pauseMessage = page.last('configure');
	assert.equal(pauseMessage.running, false);
	page.result(pauseMessage, { running: false, mode: 0 });
	await paused;
	assert.equal(host.weatherRunning, false);
	assert.equal(el('climate-play').textContent, 'Run weather');
	const pausedMessages = page.outbound.length;
	host.pump();
	assert.equal(page.outbound.length, pausedMessages, 'a paused weather clock schedules no frame');
	page.emit({ type: 'stats', days: 12.5, fps: 59, level: 2, running: false, meanT: 288 });
	assert.equal(el('climate-time').textContent, 'weather day 12.5 · paused');
	host.tick(4);
	assert.match(el('climate-status').textContent, /surface from t 2\.0 Myr · globe now 4\.0 Myr; Refresh surface/);

	// Manual refresh is the only repeated globe -> climate path. It carries a new held t and
	// leaves the weather day counter alone unless the child reports a grid rebuild.
	const refreshed = host.refresh();
	const refreshMessage = page.last('surface');
	assert.equal(refreshMessage.reset, false);
	assert.equal(refreshMessage.surface.tMyr, 3);
	page.result(refreshMessage, { level: 2, days: 12.75, surfaceTMyr: 3 });
	await refreshed;
	host.tick(3);
	assert.equal(host.weatherDays, 12.75);
	assert.doesNotMatch(el('climate-status').textContent, /Refresh surface to update/);

	const viewChange = host.setMode(22);
	const modeMessage = page.last('configure');
	assert.equal(modeMessage.mode, 22);
	page.result(modeMessage, { running: false, mode: 22 });
	await viewChange;
	assert.equal(el('climate-view').value, '22');

	const payload = {
		format: 'pgt-climate-state', version: 1,
		state: { version: 1, level: 2 }, surface: { format: 'pgt-climate-surface', version: 1 }
	};
	const captured = host.capture();
	const captureMessage = page.last('capture');
	page.result(captureMessage, { payload: payload });
	assert.strictEqual(await captured, payload);

	// A joint load restores weather even when the geology pause remains untouched, and the
	// child's saved mode/running values flow back into the parent controls.
	const restored = host.restore(payload);
	const restoreMessage = page.last('restore');
	assert.strictEqual(restoreMessage.payload, payload);
	page.result(restoreMessage, { level: 2, days: 99.25, surfaceTMyr: 3, running: true, mode: 5 });
	await restored;
	assert.equal(host.weatherDays, 99.25);
	assert.equal(host.weatherRunning, true);
	assert.equal(el('climate-view').value, '5');

	host.close();
	assert.equal(host.state, 'closed');
	assert.equal(page.frame.getAttribute('src'), 'about:blank');
	assert.equal(el('climate-time').hidden, true);

	// A refused external tree names the actual reason, rejects the pending open and leaves a
	// clean close/retry path. No partially loaded counterpart global can enter this realm.
	const missing = host.open();
	page.attach();
	page.emit({ type: 'refused', reason: 'Climate tree did not load: ../planet-climate/planet/geodesics.js' });
	await assert.rejects(missing, /geodesics\.js/);
	assert.equal(host.state, 'refused');
	assert.match(el('climate-status').textContent, /geodesics\.js/);
	host.close();

	// Restore from a cold panel boots directly at the saved climate level and sends the saved
	// held surface, not a fresh procedural world or a second frame loop.
	const cold = host.restore(payload);
	page.attach();
	assert.match(page.frame.getAttribute('src'), /level=2/);
	page.emit({ type: 'ready', level: 2 });
	const coldRestore = page.last('restore');
	page.result(coldRestore, { level: 2, days: 101, surfaceTMyr: 3, running: false, mode: 0 });
	await cold;
	assert.equal(host.state, 'running');
	assert.equal(host.weatherDays, 101);
	host.close();

	// A joint Load during the initial boot queues behind its ready/surface handshake rather
	// than replacing the iframe and letting the old request's rejection cancel the restore.
	const queuedPage = newPage('');
	const queuedOpen = queuedPage.host.open();
	queuedPage.attach();
	const queuedRestore = queuedPage.host.restore(payload);
	queuedPage.emit({ type: 'ready', level: 2 });
	const queuedSurface = queuedPage.last('surface');
	queuedPage.result(queuedSurface, { level: 2, days: 0, surfaceTMyr: 2 });
	await queuedOpen;
	await Promise.resolve();
	const queuedMessage = queuedPage.last('restore');
	queuedPage.result(queuedMessage, { level: 2, days: 7, surfaceTMyr: 3, running: false, mode: 0 });
	await queuedRestore;
	assert.equal(queuedPage.host.weatherDays, 7);
	assert.equal(queuedPage.host.state, 'running');
	queuedPage.host.close();

	const override = newPage('?climate=../../elsewhere');
	assert.equal(override.host.climateBase, '../../elsewhere/');
	override.host.close();
	console.log('PASS climate host: lazy isolated boot, bounded pump, independent pause/view, manual surface, stats, capture/restore (including queued boot), refusal and base override');
})().catch((error) => { console.error(error); process.exitCode = 1; });

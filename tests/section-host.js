// The hosted-section adapter (0.8.5 A2): js/section-host.js against tests/dom-stub.js and a
// fake slice tree served through the stub's script seam. What is pinned here:
//   1. the module is lazy and single-global: index.html carries no static script tag for it,
//      loading it adds exactly SectionHost to the realm, and loading it does nothing - the
//      config object sits at its defaults until open();
//   2. the loader walks the slice's canonical classic-script set in columns.html order, and
//      the two shared port files are injected only when the page lacks their globals - one
//      load per page, never a second copy (contract §8);
//   3. a wrong tree (scripts load, engine entries absent) refuses naming the missing
//      entries, marks itself loaded and never re-injects - the page reload is the remedy;
//   4. a missing tree refuses by name (base + failed url + the sibling/`?slice=` remedy),
//      leaves the realm free of every COL* global, stays retryable, and a retry with the
//      tree present mounts;
//   5. the mount is the contract's: an open ShadowRoot with the host-local chrome CSS, one
//      mount div carrying data-start="section" + data-pack, COLUI.build then COLSIM.start
//      on it, one frame loop, the banner fields driving the status line, and standalone as
//      its first word while no live rung has answered;
//   6. dispose and restart: close is COLSIM.stop + removing the mount, a bundle switch or
//      Restart remounts fresh (old mount gone, ids never doubled), and a later open after
//      close restarts cleanly;
//   7. ?slice= overrides the base once, with the trailing slash normalised;
//   8. with a slice checkout reachable (argv path or the sibling default), the hardcoded
//      SCRIPTS list is re-pinned against that tree's columns.html - drift is a red there,
//      a SKIP when no tree is present.
// The fake engine models the contract surface SectionHost codes against (0.9.0-contract.md
// §1-§4/§7): named refusals, element hosts, dataset start bits, banner fields. The real
// engine's own behaviour is the slice's harness's job; the cross-check against real bytes
// is experiments/host-rehearsal.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert } = require('./helpers.js');
const { makeDom, installGlobals } = require('./dom-stub.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const indexHtml = read('index.html');
const hostSource = read('js/section-host.js');
const DEFAULT_BASE = '../planet-tectonics-2d-slice/';

// --- 1. static pins: the module stays out of the boot list, the page CSS stays clean -----
assert.ok(!/src="js\/section-host\.js"/.test(indexHtml),
	'index.html carries no static tag for the host module: it is injected on first open');
assert.match(indexHtml, /id="section-host"[^>]*aria-pressed="false"/, 'the host toggle ships unpressed');
assert.match(indexHtml, /id="host-panel"[^>]*hidden/, 'the host panel ships hidden');
for (const id of ['host-pack', 'host-load-cut', 'host-pull-log', 'host-restart', 'host-close', 'host-status', 'host-shell'])
	assert.ok(indexHtml.indexOf('id="' + id + '"') >= 0, 'the host panel carries #' + id);
assert.ok(indexHtml.indexOf('id="section-snap"') >= 0, 'the section fieldset carries #section-snap');
const css = read('style.css');
for (const sectionId of ['#sGeo', '#sVZoom', '#sHZoom', '#sMsg', '#orePanel', '#orePick', '#hud', '#wrap'])
	assert.ok(css.indexOf(sectionId + ' ') < 0 && css.indexOf(sectionId + '{') < 0 && css.indexOf(sectionId + ',') < 0,
		'the globe stylesheet names no section chrome id (' + sectionId + ')');
assert.ok(/\.host-shell \{ overflow-x: auto; \}/.test(css), 'the shell scrolls the 1310px chrome');

// --- the fake slice tree ---------------------------------------------------------------
// One recorder per group; the sources read it off globalThis at call time.
function freshRec() {
	globalThis.hostRec = {
		builds: [], starts: [], stops: 0, steps: 0, frames: 0,
		loadedPacks: [], clocks: [], notes: 0, dueLog: null, overlayData: null
	};
	return globalThis.hostRec;
}
const ENGINE_GLOBALS = {
	'js/params.js': 'COLP', 'js/rng.js': 'COLRNG', 'js/geom.js': 'COLGEO', 'js/state.js': 'COLS',
	'js/surface.js': 'COLSURF', 'js/columns.js': 'COLCOLUMNS', 'js/mantle.js': 'COLMANTLE',
	'js/slab.js': 'COLSLAB', 'js/plates.js': 'COLPLATES', 'js/magma.js': 'COLMAGMA',
	'js/erupt.js': 'COLERUPT', 'js/crust.js': 'COLCRUST', 'js/ore.js': 'COLORE',
	'js/perf.js': 'COLPERF', 'js/data/deposit-models.js': 'COLDEPOSITMODELS',
	'js/data/deposit-economics.js': 'COLDEPOSITECONOMICS', 'js/deposit-core.js': 'COLDEPOSITCORE',
	'js/deposits.js': 'COLDEPOSITS', 'js/section-seed.js': 'COLSEED',
	'js/checkpoint.js': 'COLCHECKPOINT', 'js/coupling.js': 'COLCOUPLING',
	'js/coupling-link.js': 'COLLINK', 'js/core-log.js': 'COLCORELOG', 'js/render.js': 'COLRENDER'
};
const COLUI_SRC = `
var COLUI = (function () {
	'use strict';
	return {
		build: function (host) {
			var rec = globalThis.hostRec;
			rec.builds.push(host);
			if (!host || host.nodeType !== 1) throw new Error('COLUI.build needs a host element');
			if (host.byId('c')) throw new Error('COLUI.build: the host already carries the chrome');
			var doc = host.ownerDocument;
			function add(tag, id) {
				var el = doc.createElement(tag);
				el.setAttribute('id', id);
				host.appendChild(el);
				return el;
			}
			add('div', 'bar');
			var canvas = add('canvas', 'c');
			canvas.width = 1282; canvas.height = 562;
			add('div', 'hud');
			add('div', 'slice');
			add('div', 'sMsg');
			add('input', 'sGeo');
		}
	};
}());`;
const SECTION_PACK_SRC = `
var COLSECTION = {
	mode: false, syncLive: false, syncStale: false, syncPaused: false,
	pack: null, world: false, bad: false, msg: '', couplingMsg: null,
	loadPack: function (pack, origin) {
		var rec = globalThis.hostRec;
		if (!pack || typeof pack !== 'object' || pack.format !== 'pgt-slice-pack' || pack.version !== 2)
			throw new Error('not a pgt-slice-pack v2');
		if (pack.refuseSeed) throw new Error(pack.refuseSeed);
		this.pack = pack;
		this.world = true;
		this.bad = false;
		this.msg = 'loaded ' + (origin || 'cut');
		this.syncLive = false;
		this.syncPaused = false;
		this.syncStale = false;
		if (rec) rec.loadedPacks.push({ pack: pack, origin: origin });
		return pack;
	},
	applyClock: function (clock, rung) {
		var rec = globalThis.hostRec;
		if (rec) rec.clocks.push({ clock: clock, rung: rung });
		if (!this.pack || !this.world) {
			this.bad = true; this.msg = 'clock refused: no reconstructed section is ready'; return;
		}
		var wantPath = this.pack.pathChecksum || '4a90d62b21f7b0f4';
		if (!clock || clock.pathChecksum !== wantPath) {
			this.bad = true; this.msg = 'clock refused: pathChecksum does not match the active cut'; return;
		}
		if (typeof clock.tMyr !== 'number' || !isFinite(clock.tMyr) || clock.tMyr < 0) {
			this.bad = true; this.msg = 'clock refused: tMyr must be finite and non-negative'; return;
		}
		if (!clock.paused && !this.couplingMsg) {
			this.bad = true; this.msg = 'clock refused: no coupling snapshot has supplied kinematics'; return;
		}
		this.bad = false;
		this.syncLive = true;
		this.syncPaused = !!clock.paused;
	},
	overlay: function () {
		var rec = globalThis.hostRec;
		if (rec && rec.overlayData) return rec.overlayData;
		if (!this.pack || !this.world) return null;
		return {
			pathChecksum: this.pack.pathChecksum || '4a90d62b21f7b0f4',
			packChecksum: this.pack.checksum || '63825f6abdfde871',
			palette: {
				lith: ['#cdb991', '#dca58c', '#464b52', '#a59682', '#8c3c2d', '#c3553c'],
				host: ['#26303c', '#3c5268', '#826e5c', '#9c7860', '#b49e72']
			},
			segments: [{ sKm: 0, lith: 0, host: 2 }, { sKm: 20000, lith: 2, host: 1 }]
		};
	}
};
if (typeof globalThis.SECTION_PACKS === 'undefined') globalThis.SECTION_PACKS = {};`;
const COLCORELOG_SRC = `
var COLCORELOG = {
	build: function () { return null; },
	json: function (log) { return JSON.stringify(log); },
	exportActive: function () {
		var rec = globalThis.hostRec;
		return rec && rec.dueLog ? rec.dueLog : null;
	},
	note: function () {
		var rec = globalThis.hostRec;
		if (rec) { rec.notes++; rec.dueLog = null; }
	}
};`;
const COLCOUPLING_SRC = `
var COLCOUPLING = {
	CADENCE_MYR: 5,
	pathChecksum: function (pack) {
		if (pack && pack.pathChecksum) return pack.pathChecksum;
		if (pack && pack.path && typeof SlicePack !== 'undefined' && SlicePack.pathChecksum)
			return SlicePack.pathChecksum(pack.path);
		return '4a90d62b21f7b0f4';
	},
	fromPack: function () { return {}; },
	apply: function () { return { ok: true }; },
	last: function () { return null; }
};`;
const COLSIM_SRC = `
var COLSIM = (function () {
	'use strict';
	var host = null, active = false;
	function frame() {
		if (!active) return;
		globalThis.hostRec.frames++;
		globalThis.requestAnimationFrame(frame);
	}
	return {
		start: function (target) {
			var rec = globalThis.hostRec;
			if (!target) throw new Error('COLSIM.start needs a DOM host and requestAnimationFrame');
			if (target.window === target) throw new Error('COLSIM.start does not take a window');
			if (active && target === host) return;
			if (active) this.stop();
			if (!target.byId('c')) throw new Error('COLSIM host is missing the canvas #c');
			host = target; active = true;
			rec.starts.push(target);
			if (target.dataset.start === 'section') {
				var pack = globalThis.SECTION_PACKS[target.dataset.pack];
				if (!pack) throw new Error('COLSIM.start: unknown bundle ' + target.dataset.pack);
				COLSECTION.mode = true;
				COLSECTION.pack = pack;
				COLSECTION.world = true;
				target.byId('sMsg').textContent = 'loaded source L ' + target.dataset.pack;
			}
			globalThis.requestAnimationFrame(frame);
		},
		stop: function () {
			globalThis.hostRec.stops++;
			if (!active) return;
			active = false; host = null;
			COLSECTION.mode = false;
		},
		step: function () { globalThis.hostRec.steps++; }
	};
}());`;
const BUNDLES = {
	'js/data/section-earth-gc0.js': 'earth-gc0',
	'js/data/section-earth-100Ma-gc0.js': 'earth-100Ma-gc0',
	'js/data/section-earth-100Ma-gc1.js': 'earth-100Ma-gc1'
};
function fakeTree(base) {
	const scripts = {};
	for (const rel in ENGINE_GLOBALS)
		scripts[base + rel] = 'var ' + ENGINE_GLOBALS[rel] + ' = { fake: ' + JSON.stringify(rel) + ' };';
	scripts[base + 'js/ui.js'] = COLUI_SRC;
	scripts[base + 'js/section-pack.js'] = SECTION_PACK_SRC;
	scripts[base + 'js/coupling.js'] = COLCOUPLING_SRC;
	scripts[base + 'js/core-log.js'] = COLCORELOG_SRC;
	scripts[base + 'js/sim.js'] = COLSIM_SRC;
	// The bundle files precede js/section-pack.js in the canonical order, and the real
	// wrappers self-register the same way: guard the table, then add the id.
	for (const rel in BUNDLES)
		scripts[base + rel] = 'if (typeof globalThis.SECTION_PACKS === "undefined") globalThis.SECTION_PACKS = {};\n'
			+ 'globalThis.SECTION_PACKS[' + JSON.stringify(BUNDLES[rel])
			+ '] = { format: "pgt-slice-pack", version: 2, checksum: "63825f6abdfde871", pathChecksum: "4a90d62b21f7b0f4", path: { kind: "circle" }, source: { tMyr: 0 } };';
	return scripts;
}

// --- group harness ---------------------------------------------------------------------
let CANONICAL = null;   // SectionHost.SCRIPTS, read once from the first module run
function newPage(search, opts) {
	const api = makeDom(indexHtml);
	api.location.search = search || '';
	installGlobals(api);
	if (!opts || opts.ports !== false) {
		vm.runInThisContext(read('port/slice-format.js'), { filename: 'port/slice-format.js' });
		vm.runInThisContext(read('port/core-log-format.js'), { filename: 'port/core-log-format.js' });
		vm.runInThisContext(read('js/core-log.js'), { filename: 'js/core-log.js' });
	}
	// The snapshot is taken with the page's own globals installed: the claim is what the
	// host module adds on top of a booted page, not what the stub adds.
	const realmBefore = new Set(Object.keys(globalThis));
	vm.runInThisContext(hostSource, { filename: 'js/section-host.js' });
	const added = Object.keys(globalThis).filter((name) => !realmBefore.has(name));
	return { api: api, el: (id) => api.document.getElementById(id), added: added };
}

// --- 2. the module is lazy and single-global -------------------------------------------
{
	const page = newPage('');
	assert.deepEqual(page.added, ['SectionHost'],
		'loading the host module adds exactly one global: ' + page.added.join(', '));
	const host = globalThis.SectionHost;
	assert.equal(host.sliceBase, DEFAULT_BASE, 'the default base is the sibling checkout');
	assert.equal(host.mount, null, 'no mount before open');
	assert.equal(host.pack, null, 'no pack before open');
	assert.equal(host.state, 'closed', 'closed before open');
	assert.equal(host.loaded, false, 'the tree is not loaded before open');
	CANONICAL = host.SCRIPTS.slice();
	assert.equal(CANONICAL[0], 'port/slice-format.js', 'the canonical order leads with the shared pack codec');
	assert.equal(CANONICAL[1], 'port/core-log-format.js', 'then the shared core-log codec');
	assert.equal(CANONICAL.length, 32, 'the columns.html f84a57e set: 32 scripts');
	assert.equal(page.el('host-status').textContent, 'Closed.', 'the panel ships its closed status');
	// Loading did nothing: no script injected, no shadow, no engine global.
	assert.deepEqual(page.api.scriptLoads, [], 'module load injects nothing');
	assert.equal(page.el('host-shell').shadowRoot, undefined, 'module load attaches no shadow');
	assert.equal(typeof globalThis.COLSIM, 'undefined', 'module load defines no COL* global');
}

// --- 3. a wrong tree refuses naming the missing entries and never re-injects ------------
{
	const page = newPage('');
	const host = globalThis.SectionHost;
	for (const rel of CANONICAL.slice(2)) page.api.scripts[DEFAULT_BASE + rel] = '/* inert */';
	host.open();
	assert.equal(page.api.scriptLoads.length, 30, 'the whole inert chain loads');
	assert.equal(host.state, 'refused', 'and the missing surface refuses');
	assert.equal(host.loaded, true, 'scripts ran: the page reload is the remedy');
	const status = page.el('host-status').textContent;
	for (const entry of ['COLUI.build', 'COLSIM.start/stop', 'COLSECTION', 'SECTION_PACKS'])
		assert.ok(status.indexOf(entry) >= 0, 'the refusal names ' + entry + ': ' + status);
	assert.ok(status.indexOf('reload') >= 0, 'and asks for the reload');
	assert.equal(host.mount, null, 'nothing mounted against the wrong tree');
	for (const name of ['COLUI', 'COLSIM', 'COLSECTION'])
		assert.equal(typeof globalThis[name], 'undefined', 'the inert tree defined no ' + name);
	const loadsBefore = page.api.scriptLoads.length;
	host.open();
	assert.equal(page.api.scriptLoads.length, loadsBefore,
		'a reopen after a wrong-tree refusal injects no second copy of anything');
}

// --- 4. a missing tree refuses by name, leaves no COL* global and stays retryable -------
{
	const page = newPage('');
	const host = globalThis.SectionHost;
	host.open();
	assert.deepEqual(page.api.scriptLoads, [DEFAULT_BASE + 'js/params.js'],
		'the shared port files are skipped - the page holds SlicePack and CoreLogFormat - so the first injection is the engine\'s first own script');
	assert.equal(host.state, 'refused', 'the missing tree refuses');
	assert.equal(host.loaded, false, 'nothing ran, so the open stays retryable');
	assert.equal(host.mount, null, 'and nothing mounted');
	const status = page.el('host-status').textContent;
	assert.ok(status.indexOf(DEFAULT_BASE + 'js/params.js') >= 0 && status.indexOf('sibling') >= 0
		&& status.indexOf('?slice=') >= 0, 'the refusal names the url, the base remedy and the override: ' + status);
	assert.ok(status.indexOf('globe page runs unchanged') >= 0, 'and says the globe is untouched');
	for (const name of ['COLP', 'COLUI', 'COLSIM', 'COLSECTION', 'SECTION_PACKS'])
		assert.equal(typeof globalThis[name], 'undefined', 'a refused load defines no ' + name);
	assert.equal(page.el('host-shell').shadowRoot.children.length, 1,
		'the shadow holds its style and nothing else');
	// The toggle-facing state survives the refusal: a reopen with the tree now present
	// mounts on the same host instance (the retry the refusal promised).
	freshRec();
	Object.assign(page.api.scripts, fakeTree(DEFAULT_BASE));
	host.open();
	assert.equal(host.state, 'running', 'the retry with the tree present mounts');
	assert.equal(page.api.scriptLoads.length, 31, 'the retry walked the 30 engine scripts after the refused first');
	host.close();
}

// --- 5/6. the full mount rehearsal: order, mount, loop, banners, switch, dispose --------
{
	const page = newPage('');
	const host = globalThis.SectionHost;
	const rec = freshRec();
	Object.assign(page.api.scripts, fakeTree(DEFAULT_BASE));
	host.open();
	// The walk is the canonical order minus the two shared files the page already holds.
	assert.deepEqual(page.api.scriptLoads, CANONICAL.slice(2).map((rel) => DEFAULT_BASE + rel),
		'the loader walks the canonical set in order, shared files skipped');
	for (const name of Object.values(ENGINE_GLOBALS).concat(['COLUI', 'COLSIM', 'COLSECTION']))
		assert.ok(typeof globalThis[name] !== 'undefined', 'the chain delivered ' + name);
	assert.equal(host.state, 'running', 'the mount runs');
	assert.equal(host.loaded, true, 'the tree stays loaded for the page\'s lifetime');
	// The mount is the contract's: shadow, style, one div, dataset start bit, build then
	// start on the same element.
	const shell = page.el('host-shell');
	const shadow = shell.shadowRoot;
	assert.ok(shadow, 'the shell carries an open ShadowRoot');
	assert.equal(shadow.children.length, 2, 'the shadow holds the style and the one mount');
	assert.equal(shadow.children[0].tagName, 'STYLE', 'the chrome CSS rides inside the shadow');
	assert.ok(shadow.children[0].textContent.indexOf('#stage') >= 0
		&& shadow.children[0].textContent.indexOf('#orePanel') >= 0,
		'and styles the section chrome ids');
	const mount = host.mount;
	assert.equal(mount, shadow.children[1], 'SectionHost.mount is the shadow\'s mount');
	assert.equal(mount.dataset.start, 'section', 'the element host carries the section start bit');
	assert.equal(mount.dataset.pack, 'earth-gc0', 'and the default baked bundle');
	assert.equal(mount.attrs.class, 'column-engine-mount', 'the mount keeps the rehearsal class');
	assert.deepEqual(rec.builds, [mount], 'COLUI.build ran once, on the mount');
	assert.deepEqual(rec.starts, [mount], 'COLSIM.start ran once, on the mount');
	assert.ok(mount.byId('c'), 'the built chrome carries the engine canvas inside the mount');
	assert.equal(page.api.document.getElementById('c'), null,
		'and the document cannot see it: the ids stay scoped to the shadow tree');
	assert.equal(mount.byId('sMsg').textContent, 'loaded source L earth-gc0',
		'the engine loaded the bundle the dataset named');
	// The bundle select lists SECTION_PACKS and took the default.
	const select = page.el('host-pack');
	assert.equal(select.disabled, false, 'the bundle select enables with the tree');
	assert.deepEqual(select.children.map((option) => option.attrs.value),
		['earth-100Ma-gc0', 'earth-100Ma-gc1', 'earth-gc0'], 'sorted bundle ids');
	assert.equal(select.value, 'earth-gc0', 'the default bundle is selected');
	assert.equal(page.el('host-restart').disabled, false, 'Restart enables with the tree');
	// The status line: standalone while no live rung answered, the banner fields displayed.
	let status = page.el('host-status').textContent;
	assert.ok(status.startsWith('standalone'), 'no live rung: the panel reads standalone: ' + status);
	assert.ok(status.indexOf('baked bundle earth-gc0') >= 0 && status.indexOf('section mode on') >= 0,
		'the status names the bundle and the section\'s own mode field: ' + status);
	assert.ok(status.indexOf('loadPack') >= 0, 'and names the baked-bundle limitation');
	globalThis.COLSECTION.syncPaused = true;
	host.open();   // a reopen while running only repaints
	assert.ok(page.el('host-status').textContent.indexOf('globe clock paused') >= 0,
		'the banner fields drive the status line');
	globalThis.COLSECTION.syncPaused = false;
	globalThis.COLSECTION.syncLive = true;
	host.open();
	assert.ok(page.el('host-status').textContent.startsWith('live'),
		'a live rung would be the only thing to change the first word');
	globalThis.COLSECTION.syncLive = false;
	// One frame loop, registered through the host window's rAF.
	const framesBefore = rec.frames;
	page.api.pump(2);
	assert.equal(rec.frames, framesBefore + 2, 'the section loop runs on the stub frame clock');
	// A bundle switch remounts fresh: old mount gone, new dataset, one chrome.
	select.value = 'earth-100Ma-gc0';
	select.dispatch('change');
	assert.equal(host.pack, 'earth-100Ma-gc0', 'the switch takes the new bundle');
	assert.equal(rec.stops, 1, 'the switch stopped the old section');
	assert.equal(rec.builds.length, 2, 'and built a fresh chrome');
	assert.notEqual(host.mount, mount, 'on a fresh mount element');
	assert.equal(host.mount.dataset.pack, 'earth-100Ma-gc0', 'carrying the new bundle bit');
	assert.equal(shadow.children.length, 2, 'the old mount is gone: style + one mount');
	assert.equal(mount.parentNode, null, 'the old mount was removed, not hidden');
	assert.ok(page.el('host-status').textContent.indexOf('baked bundle earth-100Ma-gc0') >= 0,
		'the status follows the switch');
	// The Restart button repeats that from the panel.
	page.el('host-restart').click();
	assert.equal(rec.stops, 2, 'Restart stops');
	assert.equal(rec.starts.length, 3, 'and starts a fresh mount');
	assert.equal(shadow.children.length, 2, 'still exactly one mount in the shadow');
	// Close is stop + removal; the tree stays loaded; reopen restarts cleanly.
	host.close();
	assert.equal(rec.stops, 3, 'close stops the section');
	assert.equal(host.mount, null, 'close drops the mount');
	assert.equal(shadow.children.length, 1, 'and removes it from the shadow');
	assert.equal(host.state, 'closed', 'closed');
	assert.ok(page.el('host-status').textContent.indexOf('stays loaded') >= 0,
		'the closed status says the tree is still there');
	const rafAfterStop = page.api.raf.length;
	page.api.pump(1);
	assert.equal(page.api.raf.length, rafAfterStop, 'the stopped loop drains without re-registering');
	assert.equal(rec.frames, framesBefore + 2, 'and ran no further frame');
	host.open();
	assert.equal(host.state, 'running', 'a later open restarts');
	assert.equal(rec.starts.length, 4, 'bit for bit through the same entries');
	assert.equal(host.mount.dataset.pack, 'earth-100Ma-gc0', 'the selected bundle survives the restart');
	// A second open while running is a repaint, not a second mount.
	const mountNow = host.mount, startsNow = rec.starts.length;
	host.open();
	assert.equal(host.mount, mountNow, 'open while running keeps the one mount');
	assert.equal(rec.starts.length, startsNow, 'and starts nothing twice');

	// --- 6b. A3 (loadPack, applyClock, overlayFor) and A4 (pullObservation + note ack) ---
	const selectedCut = {
		format: 'pgt-slice-pack',
		version: 2,
		checksum: '0022e7edaa0ba7d8',
		pathChecksum: '4a90d62b21f7b0f4',
		path: { kind: 'circle', arcKm: 40030.2 },
		source: { tMyr: 120.5 }
	};
	const handoff = host.loadPack(selectedCut, { pathChecksum: '4a90d62b21f7b0f4', tMyr: 120.5, paused: true });
	assert.equal(handoff.ok, true, 'loadPack succeeds on a valid selected cut');
	assert.equal(handoff.checksum, '0022e7edaa0ba7d8');
	assert.equal(handoff.pathChecksum, '4a90d62b21f7b0f4');
	assert.equal(rec.loadedPacks.length, 1, 'COLSECTION.loadPack ran once');
	assert.equal(rec.loadedPacks[0].origin, 'selected-cut', 'and named the selected-cut origin');
	assert.equal(rec.clocks.length, 1, 'handoff delivered the paused clock via applyClock');
	assert.deepEqual(rec.clocks[0].clock, { pathChecksum: '4a90d62b21f7b0f4', tMyr: 120.5, paused: true });
	status = page.el('host-status').textContent;
	assert.ok(status.startsWith('standalone'), 'a paused manual clock still leads with standalone: ' + status);
	assert.ok(status.indexOf('selected cut 4a90d62b/0022e7ed via loadPack') >= 0,
		'the status names the selected cut identity: ' + status);
	assert.ok(status.indexOf('globe clock paused') >= 0, 'and reports the paused globe clock');

	// Atomic refusal on loadPack: a corrupt or unplaceable pack leaves the mounted cut intact.
	const refusedLoad = host.loadPack({ format: 'pgt-slice-pack', version: 2, refuseSeed: 'window wider than wrap' });
	assert.equal(refusedLoad.ok, false, 'an unplaceable cut is refused');
	assert.equal(globalThis.COLSECTION.pack, selectedCut, 'and the active section pack is untouched');
	assert.ok(page.el('host-status').textContent.indexOf('refused: window wider than wrap') >= 0,
		'the refusal reason is shown on the status line');

	// Atomic refusal on applyClock: foreign pathChecksum or negative tMyr is refused without stopping.
	const badClock = host.applyClock({ pathChecksum: 'ffffffffffffffff', tMyr: 120.5, paused: true }, 'manual');
	assert.equal(badClock.ok, false, 'a foreign pathChecksum clock is refused');
	assert.Match ? null : null;
	assert.ok(badClock.reason.indexOf('pathChecksum') >= 0, 'the clock refusal names the path mismatch');
	assert.equal(host.state, 'running', 'the section keeps running');

	// Cut-plane overlay identity-drop rule (0.8.5-answer.md §3.2).
	const currentResult = { pack: selectedCut, checksum: '0022e7edaa0ba7d8', pathChecksum: '4a90d62b21f7b0f4' };
	const ovl = host.overlayFor(currentResult, '');
	assert.ok(ovl && ovl.segments.length === 2, 'overlayFor returns the active overlay when path and pack match');
	assert.equal(ovl.palette.lith[0], '#cdb991');
	assert.equal(host.overlayFor(currentResult, 'world time changed after the selected export'), null,
		'overlayFor drops the strip immediately when the export context becomes stale');
	assert.equal(host.overlayFor({ pack: selectedCut, checksum: '1111111111111111', pathChecksum: '4a90d62b21f7b0f4' }, ''), null,
		'overlayFor drops the strip on packChecksum mismatch');
	assert.equal(host.overlayFor({ pack: selectedCut, checksum: '0022e7edaa0ba7d8', pathChecksum: '2222222222222222' }, ''), null,
		'overlayFor drops the strip on pathChecksum mismatch');

	// A4 automated observation return: exportActive -> CoreLog.importText -> note() ack only on commit.
	const coreLogFixture = read('port/fixtures/core-log-v2.json');
	const parsedLog = globalThis.CoreLogFormat.parse(coreLogFixture);
	const logTable = globalThis.CoreLog.createTable();
	const currentArtifact = {
		pathChecksum: parsedLog.pathChecksum,
		packChecksum: parsedLog.packChecksum,
		arcKm: parsedLog.arcKm
	};
	// 1) Nothing due -> status 'none', note() never called.
	rec.dueLog = null;
	let pull = host.pullObservation(logTable, currentArtifact);
	assert.equal(pull.status, 'none');
	assert.equal(pull.committed, false);
	assert.equal(rec.notes, 0, 'COLCORELOG.note is never called when nothing is due');

	// 2) Foreign log -> refused, note() never called, log stays due.
	const foreignObj = JSON.parse(coreLogFixture);
	foreignObj.pathChecksum = '0123456789abcdef';
	foreignObj.checksum = globalThis.CoreLogFormat.checksum(foreignObj);
	rec.dueLog = { text: JSON.stringify(foreignObj), pathChecksum: foreignObj.pathChecksum, packChecksum: foreignObj.packChecksum };
	pull = host.pullObservation(logTable, currentArtifact);
	assert.equal(pull.status, 'foreign');
	assert.equal(pull.committed, false);
	assert.equal(pull.noted, false);
	assert.equal(rec.notes, 0, 'COLCORELOG.note is never called on a foreign observation');
	assert.equal(logTable.order.length, 0);

	// 3) Stale log (same path + arcKm, different packChecksum): declined -> not committed, note() NOT called.
	const staleObj = JSON.parse(coreLogFixture);
	staleObj.packChecksum = '0123456789abcdef';
	staleObj.checksum = globalThis.CoreLogFormat.checksum(staleObj);
	rec.dueLog = { text: JSON.stringify(staleObj), pathChecksum: staleObj.pathChecksum, packChecksum: staleObj.packChecksum };
	pull = host.pullObservation(logTable, currentArtifact, { confirm: () => false });
	assert.equal(pull.status, 'confirmation-required');
	assert.equal(pull.committed, false);
	assert.equal(pull.noted, false);
	assert.equal(rec.notes, 0, 'declining confirmation leaves the section un-noted so the log stays due');
	assert.equal(logTable.order.length, 0);

	// 4) Stale log confirmed -> committed as stale, note() called once.
	pull = host.pullObservation(logTable, currentArtifact, { confirm: () => true, importedAt: 100 });
	assert.equal(pull.status, 'stale');
	assert.equal(pull.committed, true);
	assert.equal(pull.noted, true);
	assert.equal(rec.notes, 1, 'confirming stale archive calls COLCORELOG.note once');
	assert.equal(logTable.order.length, 1);

	// 5) Current log -> committed as current without confirmation, note() called once.
	rec.dueLog = { text: coreLogFixture, pathChecksum: parsedLog.pathChecksum, packChecksum: parsedLog.packChecksum };
	pull = host.pullObservation(logTable, currentArtifact, { importedAt: 200 });
	assert.equal(pull.status, 'current');
	assert.equal(pull.committed, true);
	assert.equal(pull.noted, true);
	assert.equal(rec.notes, 2, 'committing a current log calls COLCORELOG.note once');
	assert.equal(logTable.order.length, 2);

	// 6) Corrupt wire text -> caught, not committed, note() NOT called.
	rec.dueLog = { text: '{broken', pathChecksum: parsedLog.pathChecksum, packChecksum: parsedLog.packChecksum };
	pull = host.pullObservation(logTable, currentArtifact);
	assert.equal(pull.status, 'invalid');
	assert.equal(pull.committed, false);
	assert.equal(rec.notes, 2, 'corrupt wire text never calls COLCORELOG.note');

	host.close();
	assert.equal(host.overlayFor(currentResult, ''), null, 'closing the host drops the overlay');
}

// --- 2b. without the page's shared globals the loader injects the codecs itself ---------
{
	const page = newPage('', { ports: false });
	const host = globalThis.SectionHost;
	freshRec();
	// An earlier group ran the real codecs, and a global `var` cannot be deleted: blanking
	// to undefined is what "the page lacks them" looks like to the loader's typeof check.
	globalThis.SlicePack = undefined;
	globalThis.CoreLogFormat = undefined;
	Object.assign(page.api.scripts, fakeTree(DEFAULT_BASE));
	page.api.scripts[DEFAULT_BASE + 'port/slice-format.js'] = 'var SlicePack = { fake: "port" };';
	page.api.scripts[DEFAULT_BASE + 'port/core-log-format.js'] = 'var CoreLogFormat = { fake: "port" };';
	host.open();
	assert.equal(host.state, 'running', 'the tree without preloaded codecs still mounts');
	assert.deepEqual(page.api.scriptLoads.slice(0, 2),
		[DEFAULT_BASE + 'port/slice-format.js', DEFAULT_BASE + 'port/core-log-format.js'],
		'a page missing the shared globals gets them injected first, in canonical order');
	assert.deepEqual(globalThis.SlicePack, { fake: 'port' }, 'and the injected codec landed');
	host.close();
}

// --- 7. ?slice= overrides the base once, slash normalised -------------------------------
{
	const page = newPage('?slice=../../elsewhere');
	const host = globalThis.SectionHost;
	host.open();
	assert.equal(host.sliceBase, '../../elsewhere/', 'the override lands with its trailing slash');
	assert.deepEqual(page.api.scriptLoads, ['../../elsewhere/js/params.js'],
		'and the injections use the override base');
	assert.equal(host.state, 'refused', 'the missing override tree refuses like any missing tree');
}

// --- 8. with a slice checkout reachable, SCRIPTS is that tree's columns.html order ------
{
	const argvPath = process.argv.find((a) => a.startsWith('--slice='));
	const sliceRoot = argvPath ? argvPath.slice('--slice='.length) : path.join(ROOT, '..', 'planet-tectonics-2d-slice');
	const columnsPath = path.join(sliceRoot, 'columns.html');
	if (!fs.existsSync(columnsPath)) {
		console.log('SKIP the columns.html pin: no slice checkout at ' + sliceRoot
			+ ' (pass --slice=<path> to run it)');
	} else {
		const html = fs.readFileSync(columnsPath, 'utf8');
		const order = [];
		const re = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
		let m;
		while ((m = re.exec(html)) !== null) order.push(m[1]);
		assert.deepEqual(CANONICAL, order,
			'SectionHost.SCRIPTS is the reachable tree\'s columns.html script order');
		console.log('PASS the columns.html pin against ' + sliceRoot);
	}
}

console.log('PASS section host: lazy single global, canonical load with the shared-codec skip, '
	+ 'named refusals, shadow mount, banner-honest status, dispose and clean restart');

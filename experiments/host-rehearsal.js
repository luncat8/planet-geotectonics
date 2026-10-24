// host-rehearsal.js — the 0.8.5 A2 mounting rehearsal against the REAL slice tree, in node.
// The slice's experiments/library-host.js proves their engine mounts in a nested ShadowRoot
// host from their own page; this harness proves the globe's half of the same contract:
// js/section-host.js walks the real classic-script set from a configured base, skips the two
// shared port files the globe page already loaded (identity-checked, never re-run), mounts
// COLUI.build + COLSIM.start on a shadow-scoped element host with the dataset start bit,
// runs the section's own frame loop, disposes with COLSIM.stop + mount removal and restarts
// cleanly - all through the real engine bytes, no Chromium needed. The browser file:// smoke
// (0.8.5-answer §5) stays the owner-rig gate; this is the sandbox-runnable leg.
//
//   node experiments/host-rehearsal.js [path-to-planet-tectonics-2d-slice]
//
// The path defaults to the sibling checkout ../planet-tectonics-2d-slice. Without a tree
// this reports SKIP and exits 0: nothing here touches the network.
//
// The fake window/document models the surface the slice's own harness proved sufficient
// (their library-host.js fakeBrowser), plus the two things the globe host adds: removeChild
// and firstChild for the dispose path, and a head whose appended scripts execute from disk.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GLOBE = path.join(__dirname, '..');
const argvPath = process.argv.slice(2).find((a) => !a.startsWith('-'));
const sliceRoot = path.resolve(argvPath || path.join(GLOBE, '..', 'planet-tectonics-2d-slice'));
if (!fs.existsSync(path.join(sliceRoot, 'columns.html'))) {
	console.log('SKIP host rehearsal: no slice checkout at ' + sliceRoot
		+ ' (pass the path as argv[2]); nothing was claimed');
	process.exit(0);
}

let checks = 0, fails = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) fails++;
	console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
}

// --- the fake browser -------------------------------------------------------------------
function makeBrowser() {
	let now = 0, nextFrame = 0;
	const frames = new Map(), runtimeErrors = [], targets = [];
	function makeContext() {
		let calls = 0;
		const base = {
			createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
			measureText: (text) => ({ width: String(text).length * 6 }),
			_callCount: () => calls
		};
		return new Proxy(base, {
			get: (target, key) => key in target ? target[key] : function () { calls++; },
			set: (target, key, value) => { target[key] = value; return true; }
		});
	}
	function eventTarget(obj) {
		obj.listeners = {};
		obj.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
		obj.removeEventListener = function (type, fn) {
			const list = this.listeners[type] || [], at = list.indexOf(fn);
			if (at >= 0) list.splice(at, 1);
		};
		obj.dispatchEvent = function (event) {
			event = event || {};
			event.type = event.type || 'click';
			if (!event.target) event.target = this;
			const list = (this.listeners[event.type] || []).slice();
			for (let i = 0; i < list.length; i++) list[i].call(this, event);
			return true;
		};
		obj.click = function () { return this.dispatchEvent({ type: 'click' }); };
		return obj;
	}
	function match(node, selector) {
		if (selector.charAt(0) === '#') return node.id === selector.slice(1);
		return node.tagName && node.tagName.toLowerCase() === selector.toLowerCase();
	}
	function descendants(node, selector, out) {
		const kids = node.children || [];
		for (let i = 0; i < kids.length; i++) {
			if (match(kids[i], selector)) out.push(kids[i]);
			descendants(kids[i], selector, out);
		}
		return out;
	}
	function query(node, selector) {
		const parts = selector.trim().split(/\s+/);
		let found = descendants(node, parts[0], []);
		for (let i = 1; i < parts.length; i++) {
			const next = [];
			for (let j = 0; j < found.length; j++) descendants(found[j], parts[i], next);
			found = next;
		}
		return found.length ? found[0] : null;
	}
	function makeElement(tag, ownerDocument) {
		const el = eventTarget({
			nodeType: 1,
			tagName: String(tag || 'div').toUpperCase(),
			ownerDocument: ownerDocument || null,
			attrs: {}, dataset: {}, children: [], parentNode: null,
			id: '', value: '', textContent: '', className: '',
			checked: false, hidden: false, disabled: false,
			width: 0, height: 0, clientWidth: 0, clientHeight: 0, clientLeft: 0, clientTop: 0,
			classList: {
				_items: {},
				add: function (name) { this._items[name] = true; },
				remove: function (name) { delete this._items[name]; },
				contains: function (name) { return !!this._items[name]; }
			},
			setAttribute: function (name, value) {
				value = String(value);
				this.attrs[name] = value;
				if (name === 'id') this.id = value;
				if (name === 'value') this.value = value;
				if (name === 'width') { this.width = Number(value); this.clientWidth = this.width; }
				if (name === 'height') { this.height = Number(value); this.clientHeight = this.height; }
				if (name === 'checked') this.checked = true;
				if (name === 'hidden') this.hidden = true;
				if (name === 'disabled') this.disabled = true;
			},
			getAttribute: function (name) {
				return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
			},
			appendChild: function (child) {
				child.parentNode = this;
				if (!child.ownerDocument) child.ownerDocument = this.ownerDocument;
				this.children.push(child);
				return child;
			},
			removeChild: function (child) {
				const at = this.children.indexOf(child);
				if (at < 0) throw new Error('rehearsal stub: removeChild of a node that is not a child');
				this.children.splice(at, 1);
				child.parentNode = null;
				return child;
			},
			querySelector: function (selector) { return query(el, selector); },
			querySelectorAll: function (selector) { return descendants(el, selector.trim(), []); },
			getContext: function () {
				if (!this._context) this._context = makeContext();
				return this._context;
			},
			getBoundingClientRect: function () {
				const w = this.clientWidth || this.width || 1280, h = this.clientHeight || this.height || 560;
				return { left: 0, top: 0, width: w, height: h };
			},
			select: function () {}
		});
		Object.defineProperty(el, 'firstChild', { get: function () { return this.children[0] || null; } });
		targets.push(el);
		return el;
	}
	const win = eventTarget({
		window: null, parent: null,
		location: { search: '' },
		performance: { now: function () { return now; } },
		requestAnimationFrame: function (fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
		cancelAnimationFrame: function (id) { frames.delete(id); },
		Event: function (type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); },
		URLSearchParams: URLSearchParams
	});
	win.window = win;
	win.parent = win;
	win.console = console;
	const lightDom = {};
	const doc = {
		nodeType: 9,
		defaultView: win,
		createElement: function (tag) { return makeElement(tag, doc); },
		createTextNode: function (text) { return { nodeType: 3, textContent: text, ownerDocument: doc }; },
		// Light DOM only, like a browser: the engine's chrome lives inside the ShadowRoot
		// and must stay invisible to document-level lookups.
		getElementById: function (id) { return Object.prototype.hasOwnProperty.call(lightDom, id) ? lightDom[id] : null; }
	};
	win.document = doc;
	doc.body = makeElement('body', doc);
	lightDom.body = doc.body;
	doc.head = makeElement('head', doc);
	lightDom.head = doc.head;
	const scriptLoads = [];
	const headAppend = doc.head.appendChild;
	doc.head.appendChild = function (child) {
		headAppend.call(doc.head, child);
		if (child.tagName !== 'SCRIPT' || child.attrs.src === undefined) return child;
		// The loader's injection seam: the url IS the disk path (sliceBase is absolute
		// here), the source runs in the fake window, then load or error fires - a browser's
		// execute-on-append against the real tree bytes.
		const src = child.attrs.src;
		scriptLoads.push(src);
		let source = null;
		try { source = fs.readFileSync(src, 'utf8'); } catch (e) { source = null; }
		if (source === null) { child.dispatchEvent({ type: 'error' }); return child; }
		try { vm.runInContext(source, win, { filename: src }); }
		catch (e) { runtimeErrors.push(src + ': ' + e.name + ': ' + e.message); child.dispatchEvent({ type: 'error' }); return child; }
		child.dispatchEvent({ type: 'load' });
		return child;
	};
	return {
		win: win, doc: doc, lightDom: lightDom, scriptLoads: scriptLoads,
		runtimeErrors: runtimeErrors, makeElement: makeElement,
		pendingFrames: function () { return frames.size; },
		advanceFrame: function () {
			const jobs = Array.from(frames.values());
			frames.clear();
			now += 16.7;
			for (let i = 0; i < jobs.length; i++) {
				try { jobs[i](now); }
				catch (e) {
					runtimeErrors.push(e.name + ': ' + e.message);
					win.dispatchEvent({ type: 'error', message: e.message });
				}
			}
		},
		contextCallCount: function (el) { return el._context ? el._context._callCount() : 0; }
	};
}

const B = makeBrowser();
const win = B.win;
vm.createContext(win);

// --- the page side: the two shared codecs load once, the host panel exists --------------
vm.runInContext(fs.readFileSync(path.join(GLOBE, 'port/slice-format.js'), 'utf8'), win, { filename: 'port/slice-format.js' });
vm.runInContext(fs.readFileSync(path.join(GLOBE, 'port/core-log-format.js'), 'utf8'), win, { filename: 'port/core-log-format.js' });
vm.runInContext(fs.readFileSync(path.join(GLOBE, 'js/core-log.js'), 'utf8'), win, { filename: 'js/core-log.js' });
const pageSlicePack = win.SlicePack, pageCoreLogFormat = win.CoreLogFormat;
check('the page holds both shared codecs before the panel opens',
	typeof pageSlicePack === 'object' && typeof pageCoreLogFormat === 'object' && typeof win.CoreLog === 'object');

function panelEl(tag, id) {
	const el = B.makeElement(tag, B.doc);
	el.setAttribute('id', id);
	B.lightDom[id] = el;
	return el;
}
const shell = panelEl('div', 'host-shell');
const statusEl = panelEl('small', 'host-status');
const packSelect = panelEl('select', 'host-pack');
const restartBtn = panelEl('button', 'host-restart');
panelEl('button', 'host-close');
shell.attachShadow = function (init) {
	const shadow = B.makeElement('#shadow-root', B.doc);
	shadow.nodeType = 11;
	shadow.mode = init && init.mode;
	shell.shadowRoot = shadow;
	return shadow;
};

// --- open: the real tree through the globe loader ---------------------------------------
vm.runInContext(fs.readFileSync(path.join(GLOBE, 'js/section-host.js'), 'utf8'), win, { filename: 'js/section-host.js' });
const host = win.SectionHost;
check('the host module defines exactly its one global in the page realm', typeof host === 'object');
host.sliceBase = sliceRoot + path.sep;
host.open();

const canonical = host.SCRIPTS.slice(2).map((rel) => host.sliceBase + rel);
check('the loader walked the canonical set from the real tree, shared files skipped',
	host.state === 'running' && B.scriptLoads.length === canonical.length
	&& B.scriptLoads.join('\n') === canonical.join('\n'),
	B.scriptLoads.length + ' scripts · state ' + host.state + (host.reason ? ' · ' + host.reason : ''));
check('no shared codec was ever injected or re-run: the page\'s single load stands',
	win.SlicePack === pageSlicePack && win.CoreLogFormat === pageCoreLogFormat
	&& B.scriptLoads.every((url) => url.indexOf('port' + path.sep) < 0));
const ENGINE_NAMES = ['COLP', 'COLS', 'COLCOLUMNS', 'COLSIM', 'COLGEO', 'COLRNG', 'COLSURF', 'COLPLATES',
	'COLSLAB', 'COLMANTLE', 'COLMAGMA', 'COLERUPT', 'COLCRUST', 'COLORE', 'COLPERF', 'COLUI', 'COLRENDER',
	'COLDEPOSITCORE', 'COLDEPOSITS', 'COLSEED', 'COLSECTION', 'COLCHECKPOINT', 'COLCOUPLING', 'COLLINK',
	'COLCORELOG', 'COLDEPOSITMODELS', 'COLDEPOSITECONOMICS'];
check('all 27 engine globals answered after the walk',
	ENGINE_NAMES.every((name) => typeof win[name] !== 'undefined'),
	ENGINE_NAMES.filter((name) => typeof win[name] === 'undefined').join(',') || 'none missing');

// --- the mount ---------------------------------------------------------------------------
const mount = host.mount;
check('the mount is the contract\'s: open ShadowRoot, style, one element host',
	host.state === 'running' && !!mount && !!shell.shadowRoot && shell.shadowRoot.mode === 'open'
	&& shell.shadowRoot.children.length === 2 && shell.shadowRoot.children[0].tagName === 'STYLE'
	&& shell.shadowRoot.children[1] === mount);
check('the element host carries the section start bit and the default bundle',
	mount.dataset.start === 'section' && mount.dataset.pack === 'earth-gc0'
	&& win.COLSECTION.mode === true && win.COLSECTION.origin === 'earth-gc0',
	'origin ' + win.COLSECTION.origin);
check('the baked bundle the dataset named is the section the engine reconstructed',
	win.COLSECTION.pack.checksum === win.SECTION_PACKS['earth-gc0'].checksum
	&& String(mount.querySelector('#sMsg').textContent).indexOf('loaded source') >= 0,
	mount.querySelector('#sMsg').textContent);
const engineCanvas = mount.querySelector('#c');
check('the engine canvas is inside the mount and invisible to the document',
	!!engineCanvas && B.doc.getElementById('c') === null);
check('the bundle select lists the real SECTION_PACKS and took the default',
	packSelect.children.length === Object.keys(win.SECTION_PACKS).length && !packSelect.disabled
	&& packSelect.value === 'earth-gc0' && !restartBtn.disabled,
	packSelect.children.map((o) => o.attrs.value).join(', '));
check('the panel status is the section\'s own: standalone, mode on, limitation named',
	statusEl.textContent === host.statusText() && /^standalone/.test(statusEl.textContent)
	&& statusEl.textContent.indexOf('section mode on') >= 0 && statusEl.textContent.indexOf('loadPack') >= 0,
	statusEl.textContent);
check('one frame loop is pending through the host window', B.pendingFrames() === 1);

// --- frames -------------------------------------------------------------------------------
B.advanceFrame();
B.advanceFrame();
B.advanceFrame();
check('three browser-style frames ran the section loop without an error',
	!B.runtimeErrors.length && B.pendingFrames() === 1, B.runtimeErrors.join(' | ') || 'no errors');
check('and the section drew on its own canvas', B.contextCallCount(engineCanvas) > 0,
	B.contextCallCount(engineCanvas) + ' context calls');

// --- dispose and clean restart --------------------------------------------------------------
host.close();
check('close stopped the loop and removed the mount',
	win.COLSIM.started === false && B.pendingFrames() === 0 && host.mount === null
	&& shell.shadowRoot.children.length === 1 && host.state === 'closed');
B.advanceFrame();
check('a stale frame after close does nothing', !B.runtimeErrors.length && B.pendingFrames() === 0,
	B.runtimeErrors.join(' | ') || 'no errors');
const firstMount = mount;
host.open();
check('a later open restarts cleanly on a fresh mount',
	host.state === 'running' && host.mount && host.mount !== firstMount
	&& win.COLSIM.started === true && win.COLSECTION.mode === true && B.pendingFrames() === 1
	&& shell.shadowRoot.children.length === 2,
	host.reason || 'restarted');

// --- the bundle switch -----------------------------------------------------------------------
packSelect.value = 'earth-100Ma-gc0';
packSelect.dispatchEvent({ type: 'change' });
check('a bundle switch remounts from the select through the same entries',
	host.pack === 'earth-100Ma-gc0' && host.mount.dataset.pack === 'earth-100Ma-gc0'
	&& win.COLSECTION.origin === 'earth-100Ma-gc0'
	&& win.COLSECTION.pack.checksum === win.SECTION_PACKS['earth-100Ma-gc0'].checksum
	&& B.pendingFrames() === 1 && !B.runtimeErrors.length,
	win.COLSECTION.origin + (B.runtimeErrors.length ? ' · ' + B.runtimeErrors.join(' | ') : ''));
check('and the status follows the switch, still standalone',
	statusEl.textContent.indexOf('baked bundle earth-100Ma-gc0') >= 0
	&& /^standalone/.test(statusEl.textContent), statusEl.textContent);

// --- A3: selected-cut handoff (loadPack), clock (applyClock) and cut-plane overlay ---------
const { Grid, State, Sim } = require(path.join(GLOBE, 'tests/helpers.js'));
const Slice = require(path.join(GLOBE, 'js/slice.js'));
const CoreLog = win.CoreLog;
const grid5 = new Grid(5, 7).build();
const state5 = new State(grid5, 7);
Sim.raster(state5);
Sim.advance(state5, 0.1, 20);
const stateSnapshot = {
	t: state5.t, frame: state5.frame, rng: state5.rng, histI: state5.histI,
	hFel: Buffer.from(state5.hFel.buffer), hMaf: Buffer.from(state5.hMaf.buffer),
	hSed: Buffer.from(state5.hSed.buffer), z: Buffer.from(state5.z.buffer)
};
const aWorld = new Float64Array([1, 0, 0]), rawB = new Float64Array([0, 0.6, 0.8]);
const snappedBoundary = Slice.snapSecond(state5, aWorld, rawB, 'boundary');
const snappedMotion = Slice.snapSecond(state5, aWorld, rawB, 'motion');
const unsnappedB = Slice.snapSecond(state5, aWorld, rawB, 'none');
check('snapSecond moves only the second point and none restores it bit-for-bit',
	unsnappedB[0] === rawB[0] && unsnappedB[1] === rawB[1] && unsnappedB[2] === rawB[2]
	&& (snappedBoundary[1] !== rawB[1] || snappedMotion[1] !== rawB[1])
	&& state5.t === stateSnapshot.t && state5.rng === stateSnapshot.rng);

const cutPath = Slice.circleThrough(aWorld, snappedBoundary, Slice.radiusKm(), Slice.cellKmFor(grid5));
const cutResult = Slice.pack(
	state5, cutPath,
	{ mode: 'level', levelM: 0, volScale: 1 },
	{ pack: 'procedural-map', epochMa: 0, rotModel: 'procedural', built: '2026-10-24T09:00:00.000Z' },
	'Synthetic world · planet-geotectonics map start · no Earth data'
);
const encodedCut = pageSlicePack.encode(cutResult.pack);
const decodedCut = pageSlicePack.decode(encodedCut);
check('the cut pack validates and matches the Copy/Save wire checksum',
	pageSlicePack.validate(cutResult.pack) === '' && decodedCut.checksum === cutResult.checksum,
	cutResult.pathChecksum.slice(0, 8) + '/' + cutResult.checksum.slice(0, 8));

const handoff = host.loadPack(cutResult.pack, { pathChecksum: cutResult.pathChecksum, tMyr: state5.t, paused: true });
check('SectionHost.loadPack hands the selected cut to COLSECTION.loadPack and reconstructs it',
	handoff.ok === true && win.COLSECTION.world === true
	&& win.COLSECTION.pack.checksum === cutResult.checksum
	&& win.COLSECTION.origin === 'selected-cut',
	handoff.pathChecksum.slice(0, 8) + '/' + handoff.checksum.slice(0, 8));
check('handoff delivers the paused globe clock and the HUD and host status agree',
	win.COLSECTION.syncPaused === true && /^standalone/.test(host.statusText())
	&& host.statusText().indexOf('via loadPack') >= 0
	&& host.statusText().indexOf('globe clock paused') >= 0
	&& String(host.mount.querySelector('#hud').textContent).indexOf('globe paused') >= 0,
	host.statusText());

// Atomic refusal on loadPack: corrupt or unplaceable pack keeps the active section intact.
const corruptPack = JSON.parse(encodedCut);
corruptPack.zM[0] += 500;
const refusedCorrupt = host.loadPack(corruptPack);
check('a corrupted pack handed to loadPack is refused atomically without mutating the running section',
	refusedCorrupt.ok === false && win.COLSECTION.pack.checksum === cutResult.checksum
	&& win.COLSECTION.world === true,
	refusedCorrupt.reason);

// Atomic refusal on applyClock: foreign pathChecksum is refused without mutating the section.
const refusedClock = host.applyClock({ pathChecksum: '0123456789abcdef', tMyr: state5.t, paused: true }, 'manual');
check('a clock with a foreign pathChecksum is refused atomically',
	refusedClock.ok === false && refusedClock.reason.indexOf('pathChecksum') >= 0
	&& win.COLSECTION.pack.checksum === cutResult.checksum,
	refusedClock.reason);
// Restore clean paused clock on the active cut.
host.applyClock({ pathChecksum: host.activePathChecksum(), tMyr: state5.t, paused: true }, 'manual');

// Cut-plane overlay read and identity-drop rule.
const ovl = host.overlayFor(cutResult, '');
check('SectionHost.overlayFor reads the real COLSECTION.overlay() palette and column segments',
	!!ovl && ovl.packChecksum === cutResult.checksum
	&& Array.isArray(ovl.palette.lith) && ovl.palette.lith.length === 6
	&& Array.isArray(ovl.palette.host) && ovl.palette.host.length === 5
	&& Array.isArray(ovl.segments) && ovl.segments.length > 0 && ovl.segments.length <= 512
	&& ovl.segments[0].sKm === 0 && ovl.segments[ovl.segments.length - 1].sKm < cutResult.pack.path.arcKm,
	ovl ? (ovl.segments.length + ' segments · lith[0] ' + ovl.palette.lith[0]) : 'null');
check('overlayFor enforces the identity-drop rule on stale context or mismatched path/pack',
	host.overlayFor(cutResult, 'world time changed after the selected export') === null
	&& host.overlayFor({ pack: cutResult.pack, checksum: '0000000000000000', pathChecksum: cutResult.pathChecksum }, '') === null
	&& host.overlayFor({ pack: win.SECTION_PACKS['earth-100Ma-gc1'], checksum: cutResult.checksum, pathChecksum: '0000000000000000' }, '') === null);

// --- A4: automated observation return (exportActive -> CoreLog.importText -> note ack) ------
const logTable = CoreLog.createTable();
const currentArtifact = CoreLog.artifact(cutResult.pack);

// 1) Foreign refusal: against a different pathChecksum, pullObservation refuses and does NOT call note().
const foreignArtifact = { pathChecksum: '0123456789abcdef', couplingPathChecksum: 'fedcba9876543210', packChecksum: cutResult.checksum, arcKm: cutResult.pack.path.arcKm };
const foreignPull = host.pullObservation(logTable, foreignArtifact);
check('a foreign path observation is refused without mutating the side table or calling COLCORELOG.note',
	foreignPull.status === 'foreign' && foreignPull.committed === false && foreignPull.noted === false
	&& logTable.order.length === 0 && win.COLCORELOG.exportActive() !== null,
	foreignPull.reason);

// 2) Stale confirmation-required: same path + arcKm, different packChecksum.
const staleArtifact = Object.assign({}, currentArtifact, { packChecksum: '0123456789abcdef' });
const declinedStale = host.pullObservation(logTable, staleArtifact, { confirm: () => false });
check('a declined stale observation is not committed and does not call COLCORELOG.note (log stays due)',
	declinedStale.status === 'confirmation-required' && declinedStale.committed === false
	&& declinedStale.noted === false && logTable.order.length === 0
	&& win.COLCORELOG.exportActive() !== null);

// 3) Current observation: matches pathChecksum, packChecksum and arcKm -> commits and calls note().
const currentPull = host.pullObservation(logTable, currentArtifact, { importedAt: 1000 });
check('a current observation from exportActive commits into the globe side table and calls COLCORELOG.note',
	currentPull.status === 'current' && currentPull.committed === true && currentPull.noted === true
	&& logTable.order.length === 1 && CoreLog.freshness(currentPull.entry, currentArtifact).status === 'current',
	currentPull.entry ? (currentPull.entry.records.length + ' records · ' + currentPull.entry.sourceMetadata.checksum.slice(0, 8)) : 'no entry');
check('after COLCORELOG.note, exportActive returns null until columns diverge past the threshold',
	win.COLCORELOG.exportActive() === null && host.pullObservation(logTable, currentArtifact).status === 'none');

// 4) Reload the cut (which resets sentEver on the section), then confirm-archive against a stale packChecksum on the same path.
host.loadPack(cutResult.pack, { pathChecksum: cutResult.pathChecksum, tMyr: state5.t, paused: true });
const confirmedStale = host.pullObservation(logTable, staleArtifact, { confirm: () => true, importedAt: 2000 });
check('a confirmed stale observation on the same path commits as stale and calls COLCORELOG.note',
	confirmedStale.status === 'stale' && confirmedStale.committed === true && confirmedStale.noted === true
	&& win.COLCORELOG.exportActive() === null,
	confirmedStale.entry ? (confirmedStale.entry.records.length + ' records · ' + confirmedStale.entry.staleReason) : 'no entry');

// 5) No-state-handle invariant across the full A3/A4 adapter path: globe state is untouched.
check('the adapter path never mutates any globe state buffer, clock or RNG',
	state5.t === stateSnapshot.t && state5.frame === stateSnapshot.frame && state5.rng === stateSnapshot.rng
	&& Buffer.compare(Buffer.from(state5.hFel.buffer), stateSnapshot.hFel) === 0
	&& Buffer.compare(Buffer.from(state5.hMaf.buffer), stateSnapshot.hMaf) === 0
	&& Buffer.compare(Buffer.from(state5.hSed.buffer), stateSnapshot.hSed) === 0
	&& Buffer.compare(Buffer.from(state5.z.buffer), stateSnapshot.z) === 0);

host.close();

check('the whole rehearsal ran without an uncaught error',
	!B.runtimeErrors.length, B.runtimeErrors.join(' | ') || 'clean');

console.log((fails ? 'FAIL ' : 'PASS ') + 'host rehearsal against ' + sliceRoot + ': '
	+ (checks - fails) + '/' + checks + ' checks');
process.exit(fails ? 1 : 0);

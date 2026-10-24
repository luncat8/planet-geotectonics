// The globe-side section host (0.8.5 A2-A4): the adapter that mounts the slice's column
// engine inside the globe page, hands off the selected great-circle cut via COLSECTION.loadPack,
// reads the cut-plane overlay via COLSECTION.overlay, and pulls due observations via
// COLCORELOG.exportActive -> CoreLog.importText -> COLCORELOG.note, per 0.8.5-answer.md §3
// and the slice's host contract (0.9.0-contract.md at slice fd9cc46). This file is NOT in
// the page's boot script list: js/ui.js injects it when the host panel first opens, so a
// page that never opens the panel loads no slice script and gains no global. Loading it
// defines exactly one global, SectionHost, and does nothing else - no DOM walk, no location
// read, no network.
//
// The contract rules this module obeys:
//   - the engine never starts itself; the host starts it, and the host is an element:
//     COLUI.build(mount) + COLSIM.start(mount) with the mount inside an open ShadowRoot,
//     the isolation answer the slice's own library.html rehearsal proved;
//   - SlicePack and CoreLogFormat are one load per page: the globe page already loaded
//     both, so the loader detects them present and never injects a second copy;
//   - a refused start or a refused loadPack changes nothing on the running section, and
//     dispose is COLSIM.stop() plus removing the mount; a later open restarts cleanly;
//   - COLCORELOG.note() is called only when CoreLog.importText commits (current, or stale
//     after explicit user confirmation) - never on foreign, declined stale or corrupt text;
//   - no live rung is opened here: that stays gated behind the 0.8.4 M3-M5 pair evidence
//     and gate 7 (A5).
var SectionHost = (function () {
	'use strict';
	// The slice's canonical classic-script set in columns.html/library.html order, pinned
	// to the slice fd9cc46 read (0.8.5-answer.md §3.1). The two shared port files lead the
	// order and are skipped when the page already holds their globals; tests/section-host.js
	// re-pins this list against the sibling checkout's columns.html when one is present.
	var SCRIPTS = [
		'port/slice-format.js', 'port/core-log-format.js',
		'js/params.js', 'js/rng.js', 'js/geom.js', 'js/state.js', 'js/surface.js',
		'js/columns.js', 'js/mantle.js', 'js/slab.js', 'js/plates.js', 'js/magma.js',
		'js/erupt.js', 'js/crust.js', 'js/ore.js', 'js/perf.js', 'js/ui.js',
		'js/data/deposit-models.js', 'js/data/deposit-economics.js', 'js/deposit-core.js',
		'js/deposits.js', 'js/section-seed.js', 'js/checkpoint.js',
		'js/data/section-earth-gc0.js', 'js/data/section-earth-100Ma-gc0.js',
		'js/data/section-earth-100Ma-gc1.js',
		'js/section-pack.js', 'js/coupling.js', 'js/coupling-link.js', 'js/core-log.js',
		'js/render.js', 'js/sim.js'
	];
	var SHARED = { 'port/slice-format.js': 'SlicePack', 'port/core-log-format.js': 'CoreLogFormat' };
	var BANNER = ['mode', 'syncLive', 'syncStale', 'syncPaused'];
	var SECTION_FN = ['loadPack', 'applyClock', 'overlay'];
	var CORELOG_FN = ['exportActive', 'note'];
	var DEFAULT_BASE = '../planet-tectonics-2d-slice/';
	var DEFAULT_PACK = 'earth-gc0';
	// The section chrome is semantic, not styled (contract §3): the stylesheet is the
	// host's. This block is the slice library.html M2 host CSS, copied per the contract's
	// own offer, and it lives inside the ShadowRoot - the globe's style.css carries no
	// section rules.
	var CHROME_CSS = [
		':host { display:block; min-width:1310px; color:#9aa7bd; font:12px/1.5 monospace; }',
		'* { box-sizing:border-box; }',
		'#bar { width:1310px; padding:8px 0; display:flex; gap:18px; align-items:center; flex-wrap:wrap; }',
		'#bar label { white-space:nowrap; }',
		'input[type=range] { width:150px; vertical-align:middle; accent-color:#4f9284; }',
		'button { background:#121826; color:#9aa7bd; border:1px solid #2a3550; border-radius:3px; font:11px monospace; padding:3px 8px; cursor:pointer; }',
		'button:hover:not(:disabled) { color:#eafff8; border-color:#4f9284; }',
		'button[aria-pressed="true"] { background:#16323c; border-color:#3f8f88; color:#d9f7ec; }',
		'button[disabled] { color:#46536b; border-color:#222a3d; cursor:default; }',
		'label:has(input:checked) { color:#d9f7ec; }',
		'#stage { display:grid; grid-template-columns:22px 1282px; grid-template-rows:562px auto; column-gap:6px; row-gap:3px; }',
		'#sVZoom { grid-area:1 / 1; width:22px; height:562px; margin:0; writing-mode:vertical-lr; direction:rtl; }',
		'#wrap { grid-area:1 / 2; position:relative; width:1282px; height:562px; }',
		'#axis { grid-area:2 / 2; display:flex; gap:16px; align-items:center; }',
		'#sHZoom { width:380px; }',
		'canvas { display:block; border:1px solid #1c2438; cursor:crosshair; }',
		'#hud { position:absolute; left:8px; top:8px; white-space:pre; pointer-events:none; color:#9fd6b8; text-shadow:0 0 3px #000; }',
		'#help { width:1310px; box-sizing:border-box; padding:4px 0 12px 28px; color:#718198; font-size:10px; }',
		'#slice { display:none; }',
		'.section-mode #bar > label, .section-mode #presets, .section-mode #bMesh, .section-mode #bSave { display:none; }',
		'.section-mode #slice { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; width:100%; box-sizing:border-box; }',
		'#slice label { white-space:nowrap; }',
		'#slice textarea { width:560px; height:42px; background:#0a0f18; color:#9aa7bd; border:1px solid #2a3550; font:10px/1.4 monospace; padding:3px 4px; resize:vertical; }',
		'#slice input[type=file] { font:11px monospace; color:#9aa7bd; }',
		'#slice select { background:#121826; color:#9aa7bd; border:1px solid #2a3550; font:11px monospace; }',
		'#slice #sMsg { white-space:pre-wrap; max-width:1310px; color:#7f8ea8; }',
		'#slice #sMsg.bad { color:#e08585; }',
		'#orePanel { width:1282px; margin-left:28px; box-sizing:border-box; padding:10px; border:1px solid #2a3550; background:#0a0f18; }',
		'#orePanel[hidden] { display:none; }',
		'#oreLegend { display:flex; gap:18px; flex-wrap:wrap; margin-bottom:6px; }',
		'#orePick { width:600px; height:140px; background:#121826; color:#dfe7f5; border:1px solid #2a3550; font:11px/1.6 monospace; }',
		'#oreDetails { display:inline-block; vertical-align:top; margin:0 0 0 14px; width:620px; }',
		'#oreInfo { white-space:pre-wrap; margin:0 0 0 8px; color:#9fd6b8; }',
		'#oreStatus { display:block; margin-top:6px; color:#7f8ea8; }'
	].join('\n');

	// The configuration object the 0.8.5 answer §3.4 names, plus the adapter's own state.
	var api = {
		sliceBase: DEFAULT_BASE,   // ?slice=<relative-base> overrides once, at first open
		mount: null,               // the element host inside the ShadowRoot, while running
		pack: null,                // the baked bundle id the active mount started from
		source: 'bundle',          // 'bundle' | 'cut'
		activePack: null,          // the pack object currently mounted on the section
		lastError: '',             // last atomic loadPack/applyClock refusal on a running mount
		state: 'closed',           // closed | loading | running | refused
		reason: '',                // the refusal, named - the panel shows it verbatim
		loaded: false,             // slice scripts ran in this page: never inject them twice
		onChange: null,            // optional host listener called when mount/pack/clock changes
		SCRIPTS: SCRIPTS
	};
	var shell = null, statusEl = null, packSelect = null, restartBtn = null;
	var shadow = null, wired = false, baseResolved = false, surfaceOk = false;

	function byId(id) { return document.getElementById(id); }
	function notify() { if (typeof api.onChange === 'function') api.onChange(); }
	function paint() { if (statusEl) statusEl.textContent = api.statusText(); }
	function refuse(reason) {
		api.state = 'refused';
		api.reason = reason;
		paint();
		notify();
	}
	function withSlash(base) { return base.charAt(base.length - 1) === '/' ? base : base + '/'; }
	function resolveBase() {
		if (baseResolved) return;
		baseResolved = true;
		var override = new URLSearchParams(location.search).get('slice');
		if (override) api.sliceBase = withSlash(override);
	}
	function sharedPresent(rel) {
		var name = SHARED[rel];
		return name !== undefined && typeof globalThis[name] !== 'undefined';
	}
	// The surface A2-A4 code against (contract §2 plus the banner fields §7). A tree that
	// loads without errors but lacks these is the wrong tree, and the refusal names it -
	// no private read fills the gap.
	function missingEntries() {
		var missing = [], i = 0;
		if (typeof COLUI === 'undefined' || typeof COLUI.build !== 'function') missing.push('COLUI.build');
		if (typeof COLSIM === 'undefined' || typeof COLSIM.start !== 'function'
			|| typeof COLSIM.stop !== 'function') missing.push('COLSIM.start/stop');
		if (typeof COLSECTION === 'undefined') missing.push('COLSECTION');
		else {
			for (i = 0; i < BANNER.length; i++)
				if (!(BANNER[i] in COLSECTION)) missing.push('COLSECTION.' + BANNER[i]);
			for (i = 0; i < SECTION_FN.length; i++)
				if (typeof COLSECTION[SECTION_FN[i]] !== 'function') missing.push('COLSECTION.' + SECTION_FN[i]);
		}
		if (typeof COLCORELOG !== 'undefined') {
			for (i = 0; i < CORELOG_FN.length; i++)
				if (typeof COLCORELOG[CORELOG_FN[i]] !== 'function') missing.push('COLCORELOG.' + CORELOG_FN[i]);
		} else if (typeof COLSECTION !== 'undefined') {
			missing.push('COLCORELOG');
		}
		if (typeof SECTION_PACKS === 'undefined' || !SECTION_PACKS) missing.push('SECTION_PACKS');
		return missing;
	}
	// One sequential chain: classic scripts execute in append order, and the first load
	// error names the tree that is missing. ran counts executed scripts - after any ran,
	// a retry would inject a second copy, so the refusal then asks for a page reload.
	function loadTree(done, fail) {
		var at = 0, ran = 0;
		function next() {
			while (at < SCRIPTS.length && sharedPresent(SCRIPTS[at])) at++;
			if (at >= SCRIPTS.length) { done(); return; }
			var url = api.sliceBase + SCRIPTS[at++];
			var script = document.createElement('script');
			script.addEventListener('load', function () { ran++; next(); });
			script.addEventListener('error', function () {
				api.loaded = ran > 0;
				fail(url, ran);
			});
			script.setAttribute('src', url);
			document.head.appendChild(script);
		}
		next();
	}
	function populatePacks() {
		if (!packSelect) return;
		while (packSelect.firstChild) packSelect.removeChild(packSelect.firstChild);
		var ids = Object.keys(SECTION_PACKS).sort();
		for (var i = 0; i < ids.length; i++) {
			var option = document.createElement('option');
			option.setAttribute('value', ids[i]);
			option.textContent = ids[i];
			packSelect.appendChild(option);
		}
		api.pack = ids.indexOf(DEFAULT_PACK) >= 0 ? DEFAULT_PACK : ids[0];
		packSelect.value = api.pack;
		packSelect.disabled = false;
	}
	function disposeMount() {
		if (!api.mount) return;
		COLSIM.stop();
		if (api.mount.parentNode === shadow) shadow.removeChild(api.mount);
		api.mount = null;
	}
	function buildMount() {
		if (packSelect && !packSelect.disabled) api.pack = packSelect.value;
		var mount = document.createElement('div');
		mount.setAttribute('class', 'column-engine-mount');
		// The element host carries its start bit and bundle as data attributes (contract
		// §4): section mode without touching the page URL, bundle without a transport.
		mount.dataset.start = 'section';
		mount.dataset.pack = api.pack;
		shadow.appendChild(mount);
		api.mount = mount;
		try {
			COLUI.build(mount);
			COLSIM.start(mount);
		} catch (error) {
			// A refused start changes nothing engine-side (contract §1); undo the host half.
			COLSIM.stop();
			if (mount.parentNode === shadow) shadow.removeChild(mount);
			api.mount = null;
			refuse('the section engine refused the mount: ' + error.message);
			return;
		}
		api.state = 'running';
		api.source = 'bundle';
		api.activePack = (typeof COLSECTION !== 'undefined' && COLSECTION.pack) || SECTION_PACKS[api.pack] || null;
		api.lastError = '';
		api.reason = '';
		paint();
		notify();
	}
	function wirePanel() {
		if (wired) return;
		wired = true;
		if (packSelect) packSelect.addEventListener('change', function () {
			if (api.state === 'running') api.restart();
		});
		if (restartBtn) restartBtn.addEventListener('click', function () { api.restart(); });
	}
	api.activePathChecksum = function () {
		var p = (typeof COLSECTION !== 'undefined' && COLSECTION.pack) || api.activePack;
		if (!p || !p.path) return '';
		if (typeof COLCOUPLING !== 'undefined' && typeof COLCOUPLING.pathChecksum === 'function')
			return COLCOUPLING.pathChecksum(p);
		if (typeof SlicePack !== 'undefined' && typeof SlicePack.pathChecksum === 'function')
			return SlicePack.pathChecksum(p.path);
		return '';
	};
	api.open = function () {
		shell = byId('host-shell');
		statusEl = byId('host-status');
		packSelect = byId('host-pack');
		restartBtn = byId('host-restart');
		resolveBase();
		wirePanel();
		if (api.state === 'running' || api.state === 'loading') { paint(); return; }
		if (!shadow) {
			shadow = shell.attachShadow({ mode: 'open' });
			var style = document.createElement('style');
			style.textContent = CHROME_CSS;
			shadow.appendChild(style);
		}
		if (api.loaded) {
			// A wrong-tree refusal is permanent for this page: the scripts that ran cannot
			// be uninjected, so a reopen repaints the refusal instead of mounting against
			// entries that do not exist or re-injecting a second copy.
			if (surfaceOk) buildMount();
			else paint();
			return;
		}
		api.state = 'loading';
		api.reason = '';
		paint();
		loadTree(function () {
			api.loaded = true;
			var missing = missingEntries();
			surfaceOk = !missing.length;
			if (!surfaceOk) {
				refuse('the tree at ' + api.sliceBase + ' loaded but is not the slice engine: missing '
					+ missing.join(', ') + '. Fix ?slice= and reload the page - the scripts that ran cannot be uninjected.');
				return;
			}
			populatePacks();
			if (restartBtn) restartBtn.disabled = false;
			buildMount();
		}, function (url, ran) {
			if (ran > 0) {
				refuse('the slice tree broke mid-load at ' + url + ' (' + ran + ' scripts ran): reload the page, then reopen.');
				return;
			}
			refuse('the slice tree did not load: ' + url + ' · base ' + api.sliceBase
				+ ' - check out planet-tectonics-2d-slice as a sibling of the globe repo or set ?slice=<base>. The globe page runs unchanged.');
		});
	};
	api.close = function () {
		disposeMount();
		api.state = 'closed';
		api.lastError = '';
		api.reason = '';
		paint();
		notify();
	};
	api.restart = function () {
		if (!api.loaded) { api.open(); return; }
		disposeMount();
		if (!surfaceOk) { paint(); return; }
		buildMount();
	};
	// Selected-cut handoff (0.8.5 A3, contract §4): validates and reconstructs `pack` on
	// the running section via COLSECTION.loadPack(pack, 'selected-cut'), then delivers the
	// paused clock for that path. A refusal throws before COLSECTION mutates its mounted
	// pack or world, so the previously shown section stays intact.
	api.loadPack = function (pack, clock) {
		if (api.state !== 'running' || typeof COLSECTION === 'undefined' || typeof COLSECTION.loadPack !== 'function')
			return { ok: false, reason: 'the hosted section is not running' };
		var loaded = null;
		try {
			loaded = COLSECTION.loadPack(pack, 'selected-cut');
		} catch (error) {
			api.lastError = error.message;
			paint();
			notify();
			return { ok: false, reason: error.message };
		}
		api.source = 'cut';
		api.activePack = loaded || COLSECTION.pack || pack;
		api.lastError = '';
		var pathChecksum = api.activePathChecksum();
		var tMyr = clock && Number.isFinite(clock.tMyr) ? clock.tMyr
			: (api.activePack && api.activePack.source ? api.activePack.source.tMyr : 0);
		var paused = clock && clock.paused !== undefined ? !!clock.paused : true;
		api.syncClock({ pathChecksum: pathChecksum, tMyr: tMyr, paused: paused });
		paint();
		notify();
		return {
			ok: true,
			pack: api.activePack,
			checksum: api.activePack ? api.activePack.checksum : '',
			pathChecksum: pathChecksum
		};
	};
	// Direct clock entry (0.8.5 A3, contract §5): passes `{ pathChecksum, tMyr, paused }`
	// to COLSECTION.applyClock and checks whether the section refused it.
	api.applyClock = function (clock, rung) {
		if (api.state !== 'running' || typeof COLSECTION === 'undefined' || typeof COLSECTION.applyClock !== 'function')
			return { ok: false, reason: 'the hosted section is not running' };
		COLSECTION.applyClock(clock, rung || 'manual');
		if (COLSECTION.bad) {
			api.lastError = COLSECTION.msg || 'clock refused';
			paint();
			notify();
			return { ok: false, reason: api.lastError };
		}
		api.lastError = '';
		paint();
		notify();
		return { ok: true, paused: !!COLSECTION.syncPaused };
	};
	// Adapter clock helper: delivers `{ pathChecksum, tMyr, paused: true }` on handoff and
	// globe pause; when unpausing in standalone mode (no couplingMsg), leaves the section's
	// own clock rate untouched instead of tripping the live-kinematics guard.
	api.syncClock = function (clock) {
		if (api.state !== 'running' || !clock) return { ok: false, reason: 'the hosted section is not running' };
		var activePath = api.activePathChecksum();
		var pathChecksum = clock.pathChecksum || activePath;
		var p = (typeof COLSECTION !== 'undefined' && COLSECTION.pack) || api.activePack;
		if (p && p.path && typeof SlicePack !== 'undefined' && typeof SlicePack.pathChecksum === 'function') {
			try {
				if (pathChecksum === SlicePack.pathChecksum(p.path)) pathChecksum = activePath;
			} catch (e) {}
		}
		if (clock.paused) {
			return api.applyClock({ pathChecksum: pathChecksum, tMyr: clock.tMyr, paused: true }, 'manual');
		}
		if (typeof COLSECTION !== 'undefined' && COLSECTION.couplingMsg) {
			return api.applyClock({ pathChecksum: pathChecksum, tMyr: clock.tMyr, paused: false }, 'manual');
		}
		api.lastError = '';
		paint();
		return { ok: true, paused: false };
	};
	// Cut-plane overlay read (0.8.5 A3, contract §8): returns the active section's
	// `{ pathChecksum, packChecksum, palette, segments }` or null when no section is mounted.
	api.overlay = function () {
		if (api.state !== 'running' || typeof COLSECTION === 'undefined' || typeof COLSECTION.overlay !== 'function')
			return null;
		return COLSECTION.overlay();
	};
	// Identity-drop rule (0.8.5-answer.md §3.2): returns the overlay only when its
	// pathChecksum and packChecksum match the globe's current non-stale section export.
	api.overlayFor = function (currentResult, contextStaleReason) {
		if (!currentResult || !currentResult.pack || contextStaleReason) return null;
		var ovl = api.overlay();
		if (!ovl || !ovl.palette || !Array.isArray(ovl.palette.lith) || !Array.isArray(ovl.segments) || !ovl.segments.length)
			return null;
		var wantPack = currentResult.checksum || currentResult.pack.checksum;
		if (ovl.packChecksum !== wantPack) return null;
		var p = currentResult.pack, slicePath = '';
		if (p.path && typeof SlicePack !== 'undefined' && typeof SlicePack.pathChecksum === 'function') {
			try { slicePath = SlicePack.pathChecksum(p.path); } catch (e) { slicePath = ''; }
		}
		var wantSlicePath = currentResult.pathChecksum || slicePath;
		var wantCouplingPath = '';
		if ((!currentResult.pathChecksum || currentResult.pathChecksum === slicePath)
			&& typeof COLCOUPLING !== 'undefined' && typeof COLCOUPLING.pathChecksum === 'function') {
			try { wantCouplingPath = COLCOUPLING.pathChecksum(p); } catch (e2) { wantCouplingPath = ''; }
		}
		if (ovl.pathChecksum !== wantSlicePath && (!wantCouplingPath || ovl.pathChecksum !== wantCouplingPath))
			return null;
		return ovl;
	};
	// Automated observation return (0.8.5 A4, contract §6): pulls COLCORELOG.exportActive(),
	// validates and files it through CoreLog.importText, and calls COLCORELOG.note() ONLY
	// when the import commits (current, or stale after explicit user confirmation).
	api.pullObservation = function (table, currentArtifact, options) {
		if (api.state !== 'running' || typeof COLCORELOG === 'undefined' || typeof COLCORELOG.exportActive !== 'function')
			return { status: 'closed', committed: false, noted: false, reason: 'the hosted section is not running' };
		var due = COLCORELOG.exportActive();
		if (!due || typeof due.text !== 'string' || !due.text)
			return { status: 'none', committed: false, noted: false, reason: 'no observation is due from the active section' };
		if (!currentArtifact)
			return { status: 'no-export', committed: false, noted: false, reason: 'build a current section export before importing an observation' };
		if (options && options.contextStaleReason)
			return { status: 'stale-export', committed: false, noted: false, reason: 'the selected section export is stale (' + options.contextStaleReason + ')' };
		var importedAt = options ? options.importedAt : undefined;
		var result = null;
		try {
			result = CoreLog.importText(table, due.text, currentArtifact, { importedAt: importedAt });
		} catch (error) {
			return { status: 'invalid', committed: false, noted: false, reason: error.message };
		}
		if (result.status === 'foreign')
			return { status: 'foreign', committed: false, noted: false, reason: result.reason };
		if (result.status === 'confirmation-required') {
			var confirmFn = options && typeof options.confirm === 'function' ? options.confirm : null;
			if (!confirmFn || !confirmFn(result.reason, due))
				return { status: 'confirmation-required', committed: false, noted: false, reason: result.reason };
			result = CoreLog.importText(table, due.text, currentArtifact, { confirmStale: true, importedAt: importedAt });
			COLCORELOG.note();
			return { status: result.status, committed: true, noted: true, reason: result.reason, entry: result.entry };
		}
		if (result.committed) {
			COLCORELOG.note();
			return { status: result.status, committed: true, noted: true, reason: '', entry: result.entry };
		}
		return { status: result.status, committed: false, noted: false, reason: result.reason || '' };
	};
	// The panel's one status line. While no live coupling snapshot is active it leads with
	// standalone - Note that COLSECTION.applyClock sets syncLive = true even on a paused
	// manual clock, so live is true only when syncLive && !syncPaused.
	api.statusText = function () {
		if (api.state === 'loading') return 'Loading the slice tree from ' + api.sliceBase + ' …';
		if (api.state === 'refused') return api.reason;
		if (api.state !== 'running')
			return 'Closed' + (api.loaded ? ' · the slice tree stays loaded; reopen remounts' : '') + '.';
		var live = !!(COLSECTION.syncLive && !COLSECTION.syncPaused);
		var sourceLabel = api.source === 'cut' && api.activePack
			? 'selected cut ' + api.activePathChecksum().slice(0, 8) + '/' + (api.activePack.checksum || '').slice(0, 8) + ' via loadPack'
			: 'baked bundle ' + api.pack;
		var text = (live ? 'live' : 'standalone')
			+ ' · ' + sourceLabel + ' · section mode ' + (COLSECTION.mode ? 'on' : 'off');
		if (COLSECTION.syncStale) text += ' · stale: the section demoted to its own solve';
		if (COLSECTION.syncPaused) text += ' · globe clock paused';
		if (!live && api.source !== 'cut') text += ' · loadPack ready for selected cut';
		if (api.lastError) text += ' · refused: ' + api.lastError;
		return text;
	};
	return api;
}());

if (typeof module !== 'undefined' && module.exports) module.exports = SectionHost;

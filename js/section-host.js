// The globe-side section host (0.8.5 A2): the adapter that mounts the slice's column engine
// inside the globe page, per 0.8.5-answer.md §3.1/§3.4 and the slice's host contract
// (0.9.0-contract.md at slice f84a57e). This file is NOT in the page's boot script list:
// js/ui.js injects it when the host panel first opens, so a page that never opens the panel
// loads no slice script and gains no global. Loading it defines exactly one global,
// SectionHost, and does nothing else - no DOM walk, no location read, no network.
//
// The contract rules this module obeys:
//   - the engine never starts itself; the host starts it, and the host is an element:
//     COLUI.build(mount) + COLSIM.start(mount) with the mount inside an open ShadowRoot,
//     the isolation answer the slice's own library.html rehearsal proved;
//   - SlicePack and CoreLogFormat are one load per page: the globe page already loaded
//     both, so the loader detects them present and never injects a second copy;
//   - a refused start changes nothing, and dispose is COLSIM.stop() plus removing the
//     mount; a later open restarts cleanly;
//   - startup is the baked SECTION_PACKS bundles only (standalone mode) until the slice
//     lands the loadPack entry (A1); the panel names that limitation instead of reaching
//     into COLCOUPLING internals. No live rung is opened here - that stays gated behind
//     the 0.8.4 M3-M5 pair evidence and gate 7 (A5).
var SectionHost = (function () {
	'use strict';
	// The slice's canonical classic-script set in columns.html/library.html order, pinned
	// to the slice f84a57e read (0.8.5-answer.md §3.1). The two shared port files lead the
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
		state: 'closed',           // closed | loading | running | refused
		reason: '',                // the refusal, named - the panel shows it verbatim
		loaded: false,             // slice scripts ran in this page: never inject them twice
		SCRIPTS: SCRIPTS
	};
	var shell = null, statusEl = null, packSelect = null, restartBtn = null;
	var shadow = null, wired = false, baseResolved = false, surfaceOk = false;

	function byId(id) { return document.getElementById(id); }
	function paint() { if (statusEl) statusEl.textContent = api.statusText(); }
	function refuse(reason) {
		api.state = 'refused';
		api.reason = reason;
		paint();
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
	// The surface A2 codes against (contract §2 plus the banner fields §7). A tree that
	// loads without errors but lacks these is the wrong tree, and the refusal names it -
	// no private read fills the gap. A3/A4 extend this list with their own entries.
	function missingEntries() {
		var missing = [];
		if (typeof COLUI === 'undefined' || typeof COLUI.build !== 'function') missing.push('COLUI.build');
		if (typeof COLSIM === 'undefined' || typeof COLSIM.start !== 'function'
			|| typeof COLSIM.stop !== 'function') missing.push('COLSIM.start/stop');
		if (typeof COLSECTION === 'undefined') missing.push('COLSECTION');
		else for (var i = 0; i < BANNER.length; i++)
			if (!(BANNER[i] in COLSECTION)) missing.push('COLSECTION.' + BANNER[i]);
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
		api.reason = '';
		paint();
	}
	function wirePanel() {
		if (wired) return;
		wired = true;
		if (packSelect) packSelect.addEventListener('change', function () {
			if (api.state === 'running') api.restart();
		});
		if (restartBtn) restartBtn.addEventListener('click', function () { api.restart(); });
	}
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
		api.reason = '';
		paint();
	};
	api.restart = function () {
		if (!api.loaded) { api.open(); return; }
		disposeMount();
		if (!surfaceOk) { paint(); return; }
		buildMount();
	};
	// The panel's one status line. While no live rung has answered it reads standalone -
	// the mode/banner display is the section's own (COLSECTION fields, contract §7), never
	// a host-side guess; A5's live rung is the only thing that can change the first word.
	api.statusText = function () {
		if (api.state === 'loading') return 'Loading the slice tree from ' + api.sliceBase + ' …';
		if (api.state === 'refused') return api.reason;
		if (api.state !== 'running')
			return 'Closed' + (api.loaded ? ' · the slice tree stays loaded; reopen remounts' : '') + '.';
		var live = COLSECTION.syncLive, text = (live ? 'live' : 'standalone')
			+ ' · baked bundle ' + api.pack + ' · section mode ' + (COLSECTION.mode ? 'on' : 'off');
		if (COLSECTION.syncStale) text += ' · stale: the section demoted to its own solve';
		if (COLSECTION.syncPaused) text += ' · globe clock paused';
		if (!live) text += ' · startup is baked bundles only until the slice loadPack entry (A3)';
		return text;
	};
	return api;
}());

if (typeof module !== 'undefined' && module.exports) module.exports = SectionHost;

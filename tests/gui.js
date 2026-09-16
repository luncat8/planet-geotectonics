// The GUI's own invariants - the ones no simulation test can see, and the ones that broke
// silently before:
//   1. the Resolution select rebuilds the world (grid, state, renderer, engine, badge, the
//      map-top cell line, the copy header) instead of only relabelling it;
//   2. a rebuild never runs under an in-flight GPU transfer, which would size the new arenas
//      against the old world's numbers;
//   3. a checkpoint carries its own level and seed, and Load follows it instead of failing;
//   4. the perf strip keeps one reserved slot per part and rewrites text in place, so the parts
//      coming and going at 2 Hz cannot move the strip's height or the page under it; the whole
//      strip is the copy control and acknowledgement never replaces those row nodes;
//   5. every setting the page offers is one bench.html can measure - three owner-rig captures
//      came back without the 20-step rows because the bench silently filtered its own default;
//   6. a pan turns the view under a running sim: the probe names the cell actually painted,
//      a sub-4 px wobble is still a click, the sim runs under a held-still pointer and resumes
//      once the pointer rests (the old bug paused on pointerdown and waited for mouse-up), the
//      view outlives a rebuild, both engines defer a step while the view is moving - the GPU's
//      batch carries the event round trip, which is the stutter a drag used to have - and a
//      view-only frame repaints without recolouring;
//   7. the copied report opens with the one-line environment header (js/env.js): minute stamp,
//      browser at its major version, OS/CPU type, and the GPU as a type plus one vendor word -
//      a capture never carries a UA string, an adapter model or seconds;
//   8. a final hardware drag capture names a real pan and the view gate it exercised instead
//      of relying on an unmarked idle performance strip;
//   9. the 0.3.3 adjustments are Adjust controls: the readouts track the sliders, the
//      ?tm/?cool/?fric/?ero/?relief pre-fill lands on the world and its Params, the copied
//      adj line names only what differs from the defaults, and the relief ramp recolours
//      (never rebuilds the world or the pipeline) on both engines.
//
// js/ui.js runs as a classic script against tests/dom-stub.js, which is built by parsing the
// real index.html, and a recorded fake GpuSim: the device side of the engine is
// tests/gpu-play.js's job, here the question is what the page does and in what order.
// runInThisContext rather than a vm context on purpose - a context runs the same code ~6x
// slower, and this test builds eight worlds.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert, Grid, State, Sim } = require('./helpers.js');
const Checkpoint = require('../js/checkpoint.js');
const { makeDom, installGlobals } = require('./dom-stub.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const indexHtml = read('index.html'), benchHtml = read('bench.html'), css = read('style.css');

// --- 1. what the pages offer, and whether the bench can measure it -----------------------
function options(html, id) {
	const select = new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(html);
	assert.ok(select, 'index.html has a #' + id + ' select');
	const out = [];
	const option = /<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)</g;
	let m;
	while ((m = option.exec(select[1]))) out.push(m[1] !== undefined ? m[1] : m[2].trim());
	return out;
}
const levelOptions = options(indexHtml, 'level').map(Number);
const stepsOptions = options(indexHtml, 'speed').map(Number);
const cadenceOptions = options(indexHtml, 'cadence').map(Number);
assert.deepEqual(levelOptions, [5, 6, 7], 'the Resolution select offers L5, L6 and L7');
assert.deepEqual(stepsOptions, [1, 5, 20], 'the Steps/frame select offers 1, 5 and 20');
assert.deepEqual(cadenceOptions, [1, 5, 10], 'the Event cadence select offers 1, 5 and 10 Myr');

// The bench's accepted ranges, read out of its own source: the drift between these numbers and
// the page's options is what dropped `20` from every bench run taken with the defaults.
const stepsMax = +/var STEPS_MAX = (\d+);/.exec(benchHtml)[1];
const [, levelsLo, levelsHi] = /parseList\(levelsIn, (\d+), (\d+)\)/.exec(benchHtml);
assert.ok(/parseList\(stepsIn, 1, STEPS_MAX\)/.test(benchHtml), 'the bench bounds steps by STEPS_MAX');
assert.ok(stepsMax >= Math.max(...stepsOptions),
	'bench steps cap ' + stepsMax + ' must reach the app\'s ' + Math.max(...stepsOptions));
assert.ok(+levelsLo <= Math.min(...levelOptions) && +levelsHi >= Math.max(...levelOptions),
	'bench levels ' + levelsLo + '-' + levelsHi + ' must cover the app\'s L' + levelOptions.join('/L'));
// And the bench's own defaults must survive its own filter, or the auto-run measures less than
// the page says it does.
for (const [id, lo, hi] of [['levels', +levelsLo, +levelsHi], ['steps', 1, stepsMax]]) {
	const value = new RegExp('<input id="' + id + '" type="text" value="([^"]+)"').exec(benchHtml)[1];
	for (const entry of value.split(',')) {
		const v = +entry;
		assert.ok(v >= lo && v <= hi,
			'bench.html default ' + id + '="' + value + '": ' + entry + ' is outside ' + lo + '-' + hi
			+ ' and would be dropped from the run');
	}
}
assert.ok(/BENCH ignored:/.test(benchHtml), 'a config the bench drops is reported, not silent');

// --- 2. the reserved strip and the reserved readouts, in the stylesheet ------------------
function rule(selector) {
	const at = css.indexOf(selector + ' {');
	assert.ok(at >= 0, 'style.css has a ' + selector + ' rule');
	return css.slice(at, css.indexOf('}', at));
}
const rowsCss = rule('.perf .rows'), spanCss = rule('.perf .rows span');
assert.ok(/display: grid/.test(rowsCss) && /grid-auto-rows: 1\.5em/.test(rowsCss),
	'the strip reserves one line track per slot: ' + rowsCss);
assert.ok(/white-space: pre;/.test(spanCss), 'a row does not wrap, so its height cannot depend on the width');
assert.ok(/overflow-x: auto/.test(spanCss) && /scrollbar-width: none/.test(spanCss),
	'a row that is too long scrolls instead of growing, and its scrollbar cannot eat the track');
assert.ok(/cursor: copy/.test(rowsCss), 'the whole strip reads as a copy control');
rule('.perf .rows.copied');
rule('.perf .rows.copy-failed');
// The settings live in two named groups (index.html), and the slow-on-CPU warning has its
// amber rule: the test realm's DOM stub reads classes but not styles, so the stylesheet is
// pinned the way the strip rules are.
rule('.controls fieldset');
rule('.controls fieldset legend');
const slowCss = rule('.controls label.slow');
assert.ok(/#e8b45a/.test(slowCss), 'the slow warning is amber, not red: ' + slowCss);
assert.ok(/label\.slow select/.test(css), 'the slow rule tints the control itself');
assert.ok(!/id="copy-perf"/.test(indexHtml) && !/\.perf \.copy\b/.test(css),
	'the separate Copy button is gone from the page and stylesheet');
assert.ok(/id="perf-rows" role="button" tabindex="0" aria-label="Copy performance report"/.test(indexHtml),
	'the strip is focusable and announced as a copy button');
assert.ok(/min-width: \d+px/.test(rule('.clock')), 'the header clock reserves its width');
assert.ok(/min-height: [\d.]+em/.test(rule('#probe')), 'the column inspector reserves its lines');

// The resolution line the map-top prints, against the numbers the design quotes (0.1.5 §1:
// L5 223 km, L6 112 km, L7 56 km). Pinned from the grid itself, so a level the page never
// builds in this test still has its cell count and cell size checked.
const R = require('../js/params.js').radius;
for (const [level, V, km] of [[5, 10242, 223], [6, 40962, 112], [7, 163842, 56]]) {
	assert.equal(new Grid(level, 7).build().V, V, 'L' + level + ' cell count');
	assert.equal(Math.round(Math.sqrt(4 * Math.PI * R * R / V) / 1000), km, 'L' + level + ' cell size in km');
}

// --- 3. the page, running ----------------------------------------------------------------
const MODULES = ['env', 'geodesics', 'params', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges',
	'plates', 'contact', 'column-update', 'surface', 'events', 'checkpoint', 'perf', 'clipboard',
	'extract', 'sim', 'render'];

// The fake device side of the engine: records who was initialised with what, and hands the test
// the play promise so an in-flight transfer can be held open on purpose. `adapter` is what the
// capture header reads for the GPU type (the real engine keeps it on GpuSim too).
function fakeGpu() {
	const api = {
		device: null, S: null, inits: [], plays: [], steps: 0, uploads: 0, downloads: 0, rasters: 0,
		adapter: { info: { vendor: 'nvidia', description: 'NVIDIA GeForce RTX 4070' } },
		tsLine: 'winners 1.92 diagC 1.74 diagA 0.99',
		init: function (state, opts) {
			api.inits.push({ state: state, device: opts && opts.device, fallback: opts && opts.fallback });
			if (!api.device) {
				let lose;
				api.device = { name: 'fake-device',
					// The page hooks device.lost once per device; the test resolves it to
					// check a device-side failure stops the run instead of stalling the
					// play promise behind an idle 150 fps loop.
					lost: new Promise(function (resolve) { lose = resolve; }),
					loseDevice: function (reason) { lose({ reason: reason }); },
					// The page's drain gate: the canvas blit waits for the queue before it
					// presents, so the fake device answers the drain like an idle one does.
					queue: { onSubmittedWorkDone: function () { return Promise.resolve(); } } };
			}
			api.S = { device: api.device, tsOn: true };
			return Promise.resolve(api.S);
		},
		release: function () { api.releases = (api.releases || 0) + 1; },
		raster: function () { api.rasters++; },
		play: function (state, dt, n, hold, opts) {
			const rec = { state: state, dt: dt, n: n, hold: hold, settle: null, renders: 0 };
			rec.encoder = { fake: true };
			rec.promise = new Promise(function (resolve) { rec.settle = resolve; });
			// The real play appends each segment encoder's render tail synchronously as
			// encoders are built; call once for the synchronous first segment, handing the
			// fake encoder the page would otherwise submit sim plus draw in.
			if (opts && opts.render) { opts.render(rec.encoder); rec.renders++; }
			rec.renderAgain = function () { if (opts && opts.render) { opts.render(rec.encoder); rec.renders++; } };
			api.plays.push(rec);
			return rec.promise;
		},
		step: function () { api.steps++; return Promise.resolve(); },
		download: function () { api.downloads = (api.downloads || 0) + 1; return Promise.resolve(); },
		uploadState: function () { api.uploads++; return Promise.resolve(); },
		wantDiag: function () { api.diagWants = (api.diagWants || 0) + 1; },
		tsCollect: function () {},
		tsReset: function () {},
		tsReport: function () { return api.tsLine; }
	};
	return api;
}
// Mirrors the real GpuRenderer's canvas sizing and setView: a fake that leaves the canvas at
// width 0 makes the page's mapRect bail out of every drag on the GPU canvas, which would turn
// the GPU drag gate into a test of a drag that never happened.
const fakeRenderers = [];
function FakeRenderer(canvas) { this.canvas = canvas; this.draws = 0; this.presents = 0; this.appends = 0; this.appendLayers = []; this.views = []; fakeRenderers.push(this); }
FakeRenderer.prototype.init = function (state) {
	this.state = state;
	this.canvas.width = state.grid.lookupW; this.canvas.height = state.grid.lookupH;
	return this;
};
FakeRenderer.prototype.setView = function (q) { this.views.push(q.slice(0)); };
// The world/canvas split: appendTo paints the world inside the play segment encoder
// (one sim submit per rAF), redraw is the paused/view-only world draw, and present is
// the drain-gated canvas blit - its own submit, never a pass inside the heavy encoder.
FakeRenderer.prototype.redraw = function () { this.draws++; };
FakeRenderer.prototype.present = function () { this.presents++; };
// A level switch releases the replaced renderer's own allocations before building the
// new one; the fake has none to free.
FakeRenderer.prototype.release = function () {};
FakeRenderer.prototype.appendTo = function (enc, layer) {
	this.appends++;
	this.lastEncoder = enc;
	this.appendLayers.push(layer);
};
// FileReader is only ever asked for an ArrayBuffer the test already has.
function FakeReader() { this.result = null; this.onload = null; }
FakeReader.prototype.readAsArrayBuffer = function (file) {
	const self = this;
	setTimeout(function () { self.result = file.bytes.buffer; if (self.onload) self.onload(); }, 0);
};

function loadPage(search) {
	const api = makeDom(indexHtml);
	api.location.search = search || '';
	const gpu = fakeGpu();
	installGlobals(api, { GpuSim: gpu, GpuRenderer: FakeRenderer, FileReader: FakeReader });
	for (const file of MODULES) {
		vm.runInThisContext(read('js/' + file + '.js'), { filename: 'js/' + file + '.js' });
	}
	vm.runInThisContext(read('js/ui.js'), { filename: 'js/ui.js' });
	const el = (id) => {
		const node = api.document.getElementById(id);
		assert.ok(node, 'index.html has #' + id);
		return node;
	};
	const page = {
		api: api, gpu: gpu, el: el, Perf: globalThis.Perf, Params: globalThis.Params,
		strip: el('perf-rows'),
		copy: () => { el('perf-rows').click(); return api.document.copied[api.document.copied.length - 1]; },
		// The strip rewrites its text at 2 Hz (Perf.TEXT_MS) and the gap distribution reports
		// only once it has 8 gaps inside a 1 s window, so a pump has to span both: 16.7 ms
		// frames over ~1.5 s give three text updates and a full gap window.
		pump: (frames, from, stepMs) => api.pump(frames, from === undefined ? 1000 : from, stepMs || 16.7),
		tick: () => new Promise((r) => setTimeout(r, 1))
	};
	return page;
}

// The copy report opens with the environment header (js/env.js) and the world line follows it.
// The header is what a capture gets filed under, so its shape is pinned: date to the minute, the
// browser at its major version, the OS with the CPU type, and - on the GPU engine only - the GPU
// as a type plus one vendor word. Never a UA string, never an adapter model, never seconds.
const envLine = (text) => text.split('\n')[0];
const worldLine = (text) => text.split('\n')[1];
const ENV_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · \S+ · \S+( · gpu \S+ \S+)?$/;

(async () => {
	const page = loadPage('');
	const { el, strip, gpu } = page;

	// --- boot: the world line, the badge and the reserved strip ---------------------------
	assert.equal(el('badge').textContent, 'CPU · L5');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 10,242 CELLS / 223 KM');
	assert.equal(el('level').value, '5');
	assert.equal(strip.children.length, page.Perf.SLOTS, 'one span per slot, mounted at boot');
	assert.equal(strip.children[0].textContent, 'performance counter idle', 'the page\'s own placeholder');
	assert.equal(gpu.inits.length, 0, 'the CPU default never touches the device');

	// --- the strip is rewritten in place: same nodes, same count, fixed slot positions ----
	const before = strip.children.slice();
	page.pump(90);
	assert.equal(strip.children.length, page.Perf.SLOTS, 'the row count never changes');
	for (let i = 0; i < before.length; i++) {
		assert.equal(strip.children[i], before[i], 'slot ' + i + ' is the same node it was');
	}
	const rows = strip.children.map((span) => span.textContent);
	assert.ok(/^\d+\.\d fps/.test(rows[0]), 'slot 0 throughput: ' + rows[0]);
	assert.ok(/^p95 \d+\.\d ms · max \d+\.\d ms$/.test(rows[1]), 'slot 1 gap distribution: ' + rows[1]);
	assert.equal(rows[2], '', 'slot 2 events: nothing on the CPU engine, and the slot stays put');
	assert.equal(rows[3], '', 'slot 3 checkpoint: ditto');
	assert.equal(rows[4], '', 'slot 4 kernels: nothing has stepped yet');

	// One Step fills the kernel slot - the same slot the device's timestamp table lands in
	// later, which is why the row does not move when the engine does.
	el('step').click();
	page.pump(2, 4000);
	assert.ok(/^(events|integrate|move|bin|raster|mantle|edges|contact|apply|column|surface|forces|reduce|diag) /
		.test(strip.children[4].textContent), 'slot 4 kernel laps: ' + strip.children[4].textContent);

	// --- the strip is the copy control: the capture header names its rig and its world -----
	const text = page.copy();
	await page.tick();
	assert.ok(ENV_LINE.test(envLine(text)), 'the report opens with the one-line environment header: ' + envLine(text));
	assert.ok(worldLine(text).startsWith('engine cpu · L5 · dt 0.1 · 1 steps/frame · view plate · map start · seed 7'),
		'copy header: ' + worldLine(text));
	assert.ok(!/\n\n/.test(text) && !/\n$/.test(text), 'no blank line for a reserved-but-empty slot');
	assert.ok(/\nt 0\.1 Myr · CPU · L5$/.test(text), 'the world line closes the report: ' + text.split('\n').pop());
	assert.ok(strip.classList.contains('copied'), 'the strip acknowledges that the write landed');
	assert.equal(strip.children.length, page.Perf.SLOTS, 'acknowledgement does not replace the report rows');
	assert.equal(page.api.document.getElementById('copy-perf'), null, 'there is no separate Copy button');
	let prevented = false, copies = page.api.document.copied.length;
	strip.dispatch('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
	assert.ok(prevented, 'Enter suppresses its default action');
	assert.equal(page.api.document.copied.length, copies + 1, 'Enter copies the strip');
	copies = page.api.document.copied.length;
	strip.dispatch('keydown', { key: ' ', preventDefault: () => {} });
	assert.equal(page.api.document.copied.length, copies + 1, 'Space copies the strip');

	// Env is the one formatter for that header - the browser rigs' boot lines and the
	// double-click runners' log headers use it too - so its parsing is pinned on real strings.
	const Env = globalThis.Env;
	assert.ok(ENV_LINE.test(Env.line()), 'Env.line() is the header format: ' + Env.line());
	assert.equal(Env.stamp(new Date(2026, 8, 15, 1, 34, 59)), '2026-09-15 01:34', 'a stamp has no seconds');
	assert.equal(Env.fileStamp(new Date(2026, 8, 15, 1, 34, 59)), '2026-09-15-01-34');
	const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
	assert.equal(Env.browser(CHROME), 'chrome 151', 'a browser is a name and a major version');
	assert.equal(Env.browser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0'), 'edge 151');
	assert.equal(Env.browser('Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0'), 'firefox 141');
	assert.equal(Env.browser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'safari 18');
	assert.equal(Env.browser('node-dom-stub'), 'unknown', 'an unrecognised UA is unknown, not a guess');
	assert.equal(Env.platform(CHROME), 'linux x86_64');
	assert.equal(Env.platform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0'), 'win x86_64');
	assert.equal(Env.platform('Mozilla/5.0 (X11; Linux aarch64) Chrome/151.0.0.0'), 'linux arm64');
	assert.equal(Env.platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.1 Safari/605.1.15'), 'mac',
		'a Mac claims no architecture: its UA says "Intel" on an M-series machine too');
	assert.equal(Env.gpu({ info: { vendor: 'nvidia', description: 'NVIDIA GeForce RTX 4070' } }), 'hardware nvidia',
		'the GPU is a type and a vendor, never the model');
	assert.equal(Env.gpu({ info: { vendor: 'google', description: 'Google SwiftShader LVP' } }, false), 'software swiftshader');
	assert.equal(Env.gpu(null), 'none');

	// --- the Resolution select rebuilds the world, it does not relabel it -----------------
	el('level').value = '6';
	el('level').dispatch('change');
	assert.equal(el('badge').textContent, 'CPU · L6', 'the badge follows the grid, not the select');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 40,962 CELLS / 112 KM');
	assert.equal(page.Params.level, 6, 'Params.level tracks the world that is built');
	assert.equal(el('seed').value, '7', 'the seed survives a resolution change');
	assert.ok(/CPU engine runs at a few frames\/s/.test(el('probe').textContent),
		'L6 on the CPU engine says what it will feel like: ' + el('probe').textContent);
	page.pump(2, 5000);
	const levelReport = page.copy();
	assert.ok(worldLine(levelReport).startsWith('engine cpu · L6 ·'), 'the capture header follows the level: '
		+ worldLine(levelReport));
	assert.equal(strip.children.length, page.Perf.SLOTS, 'a rebuild does not change the strip\'s shape');

	// --- Load follows the blob's own level and seed ---------------------------------------
	// Built in the test realm and handed over as bytes, which is what a real file is.
	const saved = new State(new Grid(5, 7).build(), 7);
	saved.ckptCap = 0;
	Sim.raster(saved);
	Sim.advance(saved, 0.1, 30);
	const blob = Checkpoint.save(saved);
	el('load').files = [{ bytes: blob }];
	el('load').dispatch('change');
	await page.tick();
	assert.equal(el('level').value, '5', 'the select follows the blob');
	assert.equal(el('badge').textContent, 'CPU · L5');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 10,242 CELLS / 223 KM');
	assert.equal(el('probe').textContent, 'Loaded L5 seed 7 at t 3.0 Myr.', el('probe').textContent);

	// A blob from a level the page does not offer is refused with the level named, and the
	// world is left alone rather than rebuilt around a load that cannot happen.
	const odd = new Uint8Array(blob);      // head[2] is the level, at byte 8
	odd[8] = 3;
	el('load').files = [{ bytes: odd }];
	el('load').dispatch('change');
	await page.tick();
	assert.equal(el('probe').textContent, 'Load failed: that world is L3, this page offers L5-L7.');
	assert.equal(el('level').value, '5', 'a refused load does not move the world');

	// --- the GPU engine: one device across worlds, and a rebuild that waits for it --------
	globalThis.navigator.gpu = { getPreferredCanvasFormat: () => 'bgra8unorm' };
	el('engine').value = 'gpu';
	el('engine').dispatch('change');
	await page.tick();
	assert.equal(gpu.inits.length, 1, 'the engine select boots the device');
	assert.equal(gpu.rasters, 1, 'and runs the boot raster on it');
	assert.equal(el('badge').textContent, 'GPU · L5');
	assert.equal(el('mapgpu').hidden, false, 'the GPU canvas is the visible one');
	assert.equal(el('map').hidden, true);
	page.pump(2, 9000);
	assert.ok(strip.children[4].textContent.startsWith(gpu.tsLine),
		'the last slot is the device\'s own kernel table: ' + strip.children[4].textContent);
	assert.ok(/CPU mirror one event cycle old/.test(strip.children[4].textContent));
	const gpuReport = page.copy();
	assert.ok(worldLine(gpuReport).startsWith('engine gpu · L5 ·'), worldLine(gpuReport));
	assert.ok(/ · gpu hardware nvidia$/.test(envLine(gpuReport)),
		'the GPU engine names the device type, not the model: ' + envLine(gpuReport));

	// Playing hands the loop to GpuSim.play; while that promise is open, a resolution change
	// must not swap the grid, the state and the arenas underneath it. The world draw still
	// rides the play encoder, but the visible canvas waits for the play to finish, then does
	// one tiny redraw+present of the latest buffers. That is the L7 black-frame fix: the
	// present is not allowed to race the next heavy segment on the same drain.
	const gpuRendererNow = fakeRenderers[fakeRenderers.length - 1];
	const appendsAtPlay = gpuRendererNow.appends, drawsAtPlay = gpuRendererNow.draws,
		presentsAtPlay = gpuRendererNow.presents;
	el('play').click();
	page.pump(3, 20000);
	assert.equal(gpu.plays.length, 1, 'one play in flight');
	assert.equal(gpu.plays[0].state.grid.V, 10242);
	assert.ok(gpu.plays[0].renders === 1, 'the play call carries the render tail (the world draw rides the segment encoder)');
	assert.equal(gpuRendererNow.lastEncoder, gpu.plays[0].encoder,
		'the world draw is appended to the play encoder, not submitted on its own');
	assert.equal(gpuRendererNow.appendLayers[gpuRendererNow.appendLayers.length - 1], 'plate');
	assert.ok(gpuRendererNow.appends > appendsAtPlay && gpuRendererNow.draws === drawsAtPlay,
		'while the batch is in flight there is no standalone redraw yet');
	assert.equal(gpuRendererNow.presents, presentsAtPlay,
		'and no canvas blit yet: the visible refresh waits for the batch to finish');
	page.pump(2, 21000);
	assert.equal(gpu.plays.length, 1, 'a busy device is not handed a second play');
	assert.ok((gpu.diagWants || 0) >= 1,
		'a HUD tick due while playing asks for one diagnostic frame; play does not run K11 every frame');

	el('level').value = '7';
	el('level').dispatch('change');
	assert.equal(gpu.inits.length, 1, 'the rebuild waits for the in-flight transfer');
	assert.equal(el('badge').textContent, 'GPU · L5', 'and the world is still the old one');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 10,242 CELLS / 223 KM');

	gpu.plays[0].settle(gpu.plays[0].n);
	await page.tick();
	assert.ok(gpuRendererNow.draws > drawsAtPlay,
		'once the play finishes the page redraws the latest buffers before it presents them');
	assert.ok(gpuRendererNow.presents > presentsAtPlay,
		'and then blits that completed redraw to the canvas');
	assert.equal(gpu.inits.length, 2, 'the rebuild runs once the transfer has settled');
	assert.equal(gpu.inits[1].state.grid.V, 163842, 'on the new world');
	assert.equal(gpu.inits[1].device, gpu.device,
		'and on the same device: a level switch does not ask for another adapter');
	assert.equal(el('badge').textContent, 'GPU · L7');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 163,842 CELLS / 56 KM');
	assert.equal(el('level').value, '7');
	assert.equal(page.Params.level, 7);
	const level7Report = page.copy();
	assert.ok(worldLine(level7Report).startsWith('engine gpu · L7 ·'), worldLine(level7Report));

	// A lost device must stop the run and say so. Without the hook, a dead device hangs
	// the play promise forever - gpu.busy never clears, the strip goes on ticking fps
	// over an idle loop, and the page reads as "150 fps but the sim does nothing" (the
	// owner-rig L7 signature). The handler also drops GpuSim.device, so the engine
	// switch it suggests re-boots on a fresh adapter instead of the dead one.
	el('play').click();
	page.pump(2, 22000);
	assert.equal(gpu.plays.length, 2, 'playing again on the rebuilt world');
	gpu.device.loseDevice('internal');
	await page.tick();
	assert.match(el('probe').textContent, /GPU device lost \(internal\)/);
	assert.equal(el('play').textContent, 'Play', 'the lost device stops the run');
	assert.equal(gpu.device, null, 'the dead device is dropped: the next GPU boot asks for a fresh adapter');

	// --- the query pre-fill names a run instead of describing clicks ----------------------
	const asked = loadPage('?level=6&engine=cpu&seed=11&steps=5&dt=0.05&cadence=10');
	assert.equal(asked.el('badge').textContent, 'CPU · L6', asked.el('badge').textContent);
	assert.equal(asked.el('grid-info').textContent, 'EQUIRECTANGULAR / 40,962 CELLS / 112 KM');
	assert.equal(asked.el('seed').value, '11');
	assert.equal(asked.el('speed').value, '5');
	assert.equal(asked.el('dt').value, '0.05');
	assert.equal(asked.el('cadence').value, '10', '?cadence= pre-fills the Event cadence select');
	assert.equal(asked.Params.eventCadence, 10, 'the cadence is applied live to Params, no rebuild involved');
	asked.el('cadence').value = '5';
	asked.el('cadence').dispatch('change');
	assert.equal(asked.Params.eventCadence, 5, 'changing the select applies the new cadence immediately');
	const askedReport = asked.copy();
	assert.ok(worldLine(askedReport).startsWith('engine cpu · L6 · dt 0.05 · 5 steps/frame · view plate · map start · seed 11 · cadence 5 Myr'),
		worldLine(askedReport));
	// A level the select does not offer is ignored, not built: Grid takes 0-7 and a stray
	// ?level=9 would throw before the page drew anything.
	const stray = loadPage('?level=9');
	assert.equal(stray.el('badge').textContent, 'CPU · L5', 'an unoffered ?level= is ignored');
	stray.pump(40, 1000);
	assert.ok(!/^adj /m.test(stray.copy()),
		'a capture at the defaults says nothing about adjustments:\n' + stray.copy());

	// The five 0.3.3 controls ride the same pre-fill, and the copied adj line is the query
	// that reproduces the capture - the line the sliders themselves write when moved.
	const tuned = loadPage('?tm=1.4&cool=0&fric=1.5&ero=0.5&relief=9');
	assert.equal(tuned.el('cooling').checked, false, '?cool=0 unchecks Cooling');
	assert.equal(tuned.el('tm').value, '1.4');
	assert.equal(tuned.Params.friction, 1.5, '?fric= reaches the kernels');
	assert.equal(tuned.Params.eroScale, 0.5, '?ero= too');
	assert.equal(tuned.Params.zRange, 9000, '?relief= is kilometres on the control, metres in the ramp');
	assert.equal(tuned.el('tm-value').textContent, '1.40', 'the readouts follow the pre-fill');
	assert.equal(tuned.el('friction-value').textContent, '1.50');
	assert.equal(tuned.el('ero-value').textContent, '0.50');
	assert.equal(tuned.el('relief-value').textContent, '9.0 km');
	tuned.pump(40, 1000);
	assert.ok(/^adj Tm 1\.40 cooling off · friction 1\.5x · erosion 0\.5x · relief 9\.0 km$/m.test(tuned.copy()),
		'the capture names every adjustment it ran with:\n' + tuned.copy());

	// The relief slider is a recolour, not a rebuild: the CPU engine repaints the canvas on
	// the next frame (the GPU engine's own redraw is pinned in the play section below).
	const tunedMap = tuned.el('map'), putsBefore = tunedMap.puts;
	tuned.el('relief').value = '3';
	tuned.el('relief').dispatch('input');
	assert.equal(tuned.Params.zRange, 3000, 'the ramp is metres');
	tuned.pump(2, 3000);
	assert.ok(tunedMap.puts > putsBefore, 'the CPU map repainted after the ramp change');

	// --- pan: the view turns under a running sim, and never waits for the mouse ------------
	// A fresh page with an untouched world; the mirror worlds built here match the page's
	// cell for cell (same grid, same seed, nothing stepped yet), so a painted pixel can be
	// checked against the plate colour of the cell the probe names.
	const panPage = loadPage('');
	const pEl = panPage.el;
	const map = pEl('map');
	const TOTAL = 1024 * 512;
	const world = (level, seed) => {
		const s = new State(new Grid(level, seed).build(), seed);
		Sim.raster(s);
		return s;
	};
	const plateOf = (s) => {
		const r = new Renderer({ getContext: () => ({
			createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
			putImageData: () => {}
		}) }, s);
		r.draw('plate');
		return r;
	};
	const countChanged = (a, b) => {
		let n = 0;
		for (let i = 0; i < a.length; i += 4)
			if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
		return n;
	};
	const mirror = plateOf(world(5, 7));

	// A drag rotates the view, and the probe must name the cell actually painted under it.
	panPage.pump(1);
	const identity = map.lastImage.data.slice();
	map.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 250, currentTarget: map });
	map.dispatch('pointermove', { pointerId: 1, clientX: 460, clientY: 250, currentTarget: map });
	map.dispatch('pointerup', { pointerId: 1, currentTarget: map });
	panPage.pump(1);
	const dragged = map.lastImage.data.slice();
	assert.ok(countChanged(identity, dragged) > 20000,
		'the drag re-mapped the paint: ' + countChanged(identity, dragged) + ' of ' + TOTAL + ' pixels');
	// The drag's own release-click is suppressed; a fresh press-release inspects the column.
	map.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 460, clientY: 250, currentTarget: map });
	map.dispatch('pointerup', { pointerId: 1, currentTarget: map });
	map.dispatch('click', { clientX: 460, clientY: 250, currentTarget: map });
	const probed = /^Cell (\d+)/.exec(pEl('probe').textContent);
	assert.ok(probed, 'a click after the drag inspected a column: ' + pEl('probe').textContent);
	const cell = +probed[1], p4 = (250 * 1024 + 460) * 4;
	assert.deepEqual([map.lastImage.data[p4], map.lastImage.data[p4 + 1], map.lastImage.data[p4 + 2]],
		[mirror.colors[cell * 3], mirror.colors[cell * 3 + 1], mirror.colors[cell * 3 + 2]],
		'the painted pixel under the probe is that cell\'s plate colour');

	// "Info follows pointer" is on by default: a plain hover inspects the cell under the
	// pointer, a drag does not (the pan owns the pointer), and unchecking it restores the
	// click-only inspector.
	assert.ok(pEl('follow').checked, 'the follow checkbox ships checked');
	map.dispatch('pointermove', { pointerId: 9, clientX: 200, clientY: 200, currentTarget: map });
	const hovered = /^Cell (\d+)/.exec(pEl('probe').textContent);
	assert.ok(hovered, 'a hover inspects a column: ' + pEl('probe').textContent);
	map.dispatch('pointermove', { pointerId: 9, clientX: 700, clientY: 100, currentTarget: map });
	const hovered2 = /^Cell (\d+)/.exec(pEl('probe').textContent);
	assert.ok(hovered2 && hovered2[1] !== hovered[1], 'the inspector follows the pointer to another cell');
	pEl('follow').checked = false;
	pEl('probe').textContent = 'untouched';
	map.dispatch('pointermove', { pointerId: 9, clientX: 300, clientY: 300, currentTarget: map });
	assert.equal(pEl('probe').textContent, 'untouched', 'unchecked, a hover leaves the inspector alone');
	pEl('follow').checked = true;

	// A press that never travels 4 px is the probe click, and the view does not move.
	map.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100, currentTarget: map });
	map.dispatch('pointermove', { pointerId: 2, clientX: 102, clientY: 101, currentTarget: map });
	map.dispatch('pointerup', { pointerId: 2, currentTarget: map });
	map.dispatch('click', { clientX: 102, clientY: 101, currentTarget: map });
	assert.ok(/^Cell \d+/.test(pEl('probe').textContent), 'a 2 px wobble is still a probe click');
	panPage.pump(1);
	assert.equal(countChanged(dragged, map.lastImage.data), 0, 'the wobble did not move the view');

	// The sim runs under a held-still pointer and resumes once the pointer rests: the gate is
	// the view version, never the mouse button, and it stays closed for VIEW_HOLD_FRAMES after
	// the last move. The hold is what makes the gate work on the GPU engine too: a drag whose
	// moves arrive slower than its frames leaves empty frames, and an empty frame is where a
	// batch - and the event round trip inside it - would slip in mid-drag.
	panPage.pump(4);   // the drag above left the hold running; let it expire before counting
	const tOf = () => +/^t (\d+\.\d) Myr/.exec(panPage.copy().split('\n').pop())[1];
	pEl('play').click();
	panPage.pump(3);
	assert.equal(tOf(), 0.3, 'one step per frame, t at ' + tOf());
	map.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 500, clientY: 300, currentTarget: map });
	panPage.pump(1);
	assert.equal(tOf(), 0.4, 'holding the pointer down without moving does not pause the sim');
	map.dispatch('pointermove', { pointerId: 3, clientX: 560, clientY: 300, currentTarget: map });
	panPage.pump(1);
	assert.equal(tOf(), 0.4, 'the frame the view moves defers its step');
	panPage.pump(2);
	assert.equal(tOf(), 0.4, 'and so do its hold frames, so a move every other frame is still a drag');
	map.dispatch('pointermove', { pointerId: 3, clientX: 560, clientY: 300, currentTarget: map });
	panPage.pump(1);
	assert.equal(tOf(), 0.5, 'a move event that does not turn the view is not a move: the sim resumes, button still down');
	map.dispatch('pointermove', { pointerId: 3, clientX: 620, clientY: 300, currentTarget: map });
	panPage.pump(3);
	assert.equal(tOf(), 0.5, 'moving again closes the gate for the same hold');
	panPage.pump(1);
	assert.equal(tOf(), 0.6, 'and it opens again once the pointer rests');
	map.dispatch('pointerup', { pointerId: 3, currentTarget: map });
	panPage.pump(1);
	assert.equal(tOf(), 0.7, 'and it keeps stepping after the release');
	const cpuDragReport = panPage.copy();
	assert.match(cpuDragReport, /view gate: 2 drags · 3 moves · 280 px · closed 2x · deferred 6 rAF · re-opened 2x/,
		'the copied capture proves an actual pan exercised the CPU gate: ' + cpuDragReport);
	pEl('play').click();

	// The view outlives the world: a rebuild must not reset the camera.
	pEl('level').value = '6';
	pEl('level').dispatch('change');
	panPage.pump(1);
	assert.equal(pEl('badge').textContent, 'CPU · L6');
	const l6mirror = plateOf(world(6, 7));
	const l6img = map.lastImage.data;
	let stillIdentity = 0;
	for (let i = 0; i < l6img.length; i += 4)
		if (l6img[i] === l6mirror.image.data[i] && l6img[i + 1] === l6mirror.image.data[i + 1]
			&& l6img[i + 2] === l6mirror.image.data[i + 2]) stillIdentity++;
	assert.ok(stillIdentity < TOTAL * 0.5, 'the view survived the rebuild: ' + stillIdentity
		+ ' of ' + TOTAL + ' pixels still read as the plain map');

	// The GPU engine defers on the same gate and needs it more: its draw is one triangle, but a
	// batch that contains the event round trip holds the device queue for the readback and then
	// the main thread for the unpack and the cycle - one stutter per cadence under a drag. The
	// gate is still the view, so a held-still pointer keeps stepping and a resting pointer
	// resumes without waiting for the release; and a batch the drag catches mid-flight is
	// handed the same predicate, so it stops at its next frame boundary (tests/gpu-play.js pins
	// what stopping does to the run).
	globalThis.navigator.gpu = { getPreferredCanvasFormat: () => 'bgra8unorm' };
	pEl('engine').value = 'gpu';
	pEl('engine').dispatch('change');
	await panPage.tick();
	assert.equal(pEl('badge').textContent, 'GPU · L6');
	const gpuMap = pEl('mapgpu');
	pEl('play').click();
	panPage.pump(3);
	const inFlight = panPage.gpu.plays[panPage.gpu.plays.length - 1];
	inFlight.settle(inFlight.n);
	await panPage.tick();
	const playsBefore = panPage.gpu.plays.length;
	gpuMap.dispatch('pointerdown', { button: 0, pointerId: 4, clientX: 200, clientY: 150, currentTarget: gpuMap });
	panPage.pump(1);
	assert.equal(panPage.gpu.plays.length, playsBefore + 1, 'a held-still pointer keeps the GPU engine stepping');
	const heldStill = panPage.gpu.plays[playsBefore];
	heldStill.settle(heldStill.n);
	await panPage.tick();
	gpuMap.dispatch('pointermove', { pointerId: 4, clientX: 280, clientY: 150, currentTarget: gpuMap });
	panPage.pump(3);
	assert.equal(panPage.gpu.plays.length, playsBefore + 1, 'no batch starts while the view moves or during its hold');
	panPage.pump(1);
	assert.equal(panPage.gpu.plays.length, playsBefore + 2, 'and one starts once the pointer rests, button still down');
	const resumed = panPage.gpu.plays[playsBefore + 1];
	resumed.settle(resumed.n);
	await panPage.tick();
	assert.equal(typeof resumed.hold, 'function', 'the batch was handed the view gate');
	assert.equal(resumed.hold(), false, 'which reads open while the view rests');
	gpuMap.dispatch('pointermove', { pointerId: 4, clientX: 340, clientY: 150, currentTarget: gpuMap });
	assert.equal(resumed.hold(), true, 'and closed the moment the view moves, before any frame has counted it');
	gpuMap.dispatch('pointerup', { pointerId: 4, currentTarget: gpuMap });
	const gpuDragReport = panPage.copy();
	assert.match(gpuDragReport, /view gate: 1 drag · 2 moves · 140 px · closed 1x · deferred 3 rAF · re-opened 1x/,
		'the copied capture proves the GPU gate deferred the moving view then reopened: ' + gpuDragReport);
	const fakeGpuRenderer = fakeRenderers[fakeRenderers.length - 1];
	assert.ok(fakeGpuRenderer.views.length > 1, 'the dragged view was applied to the GPU renderer');
	const viewBoot = fakeGpuRenderer.views[0], viewLast = fakeGpuRenderer.views[fakeGpuRenderer.views.length - 1];
	assert.ok(viewBoot[0] !== viewLast[0] || viewBoot[1] !== viewLast[1] || viewBoot[2] !== viewLast[2],
		'the GPU renderer sees the moved view, not the boot view');
	pEl('play').click();

	// --- live controls: hover view modes, groups, an engine switch that keeps the run, slow warnings
	// This scenario loads its pages last-on-purpose: the stub's global rAF is re-pointed at
	// the newest page by every loadPage, so only the newest page's frame loop can pump.
	const modeLabel = (page, value) => {
		const group = page.el('layer');
		for (const label of group.children)
			for (const child of label.children)
				if (child.getAttribute && child.getAttribute('name') === 'layer' && child.getAttribute('value') === value) return label;
		return null;
	};
	// The view mode: without a hover-capable fine pointer (this stub has no matchMedia),
	// hovering a label does nothing; the click path is the only switch.
	const stillPage = loadPage('');
	const stillGroup = stillPage.el('layer');
	// The stub does not bubble: the hover reaches the group's listener with the label as
	// the event's target, exactly what a browser delivers.
	stillGroup.dispatch('pointerover', { type: 'pointerover', target: modeLabel(stillPage, 'z') });
	assert.ok(worldLine(stillPage.copy()).includes(' · view plate ·'),
		'no fine pointer, no hover switch: ' + worldLine(stillPage.copy()));

	// With one, a hover over a label selects that view mode and moves the radio's checked
	// state with it; crossing the group without touching a label changes nothing.
	globalThis.matchMedia = (q) => ({ matches: /hover: hover/.test(q) && /pointer: fine/.test(q) });
	const hoverPage = loadPage('');
	const hEl = hoverPage.el;
	hEl('layer').dispatch('pointerover', { type: 'pointerover', target: hEl('layer') });
	assert.ok(worldLine(hoverPage.copy()).includes(' · view plate ·'), 'crossing the group is not a choice');
	hEl('layer').dispatch('pointerover', { type: 'pointerover', target: modeLabel(hoverPage, 'z') });
	assert.ok(worldLine(hoverPage.copy()).includes(' · view z ·'), 'a hover switches the view mode: ' + worldLine(hoverPage.copy()));
	assert.equal(modeLabel(hoverPage, 'z').children[0].checked, true, 'the hovered radio reads checked');
	hEl('layer').dispatch('pointerover', { type: 'pointerover', target: modeLabel(hoverPage, 'plate') });
	assert.ok(worldLine(hoverPage.copy()).includes(' · view plate ·'), 'and hovering back switches again');
	globalThis.matchMedia = undefined;

	// A fresh page, CPU engine - now the newest, so its frame loop pumps below.
	const livePage = loadPage('');
	const lEl = livePage.el;
	const groupOf = (node) => {
		while (node && node.tagName !== 'FIELDSET') node = node.parentNode;
		return node;
	};
	for (const id of ['level', 'start', 'seed', 'reset', 'load'])
		assert.equal(groupOf(lEl(id)) && groupOf(lEl(id)).id, 'startup', '#' + id + ' lives in the Startup group');
	for (const id of ['dt', 'speed', 'cadence', 'run-to', 'engine', 'save', 'deposits'])
		assert.equal(groupOf(lEl(id)) && groupOf(lEl(id)).id, 'adjust', '#' + id + ' lives in the Adjust group');
	// The five live controls of 0.3.3 are Adjust controls too: nothing in this group rebuilds
	// the world, which is what the legend promises.
	for (const id of ['cooling', 'tm', 'friction', 'ero', 'relief'])
		assert.equal(groupOf(lEl(id)) && groupOf(lEl(id)).id, 'adjust', '#' + id + ' lives in the Adjust group');
	assert.equal(lEl('tm-value').textContent, '1.00', 'the slider readouts start on the control values');
	assert.equal(lEl('relief-value').textContent, '6.5 km');
	assert.equal(groupOf(lEl('play')), null, 'the transport buttons are outside both groups');

	// The slow-on-CPU warning: L7 on the CPU flags the Resolution control, more than one
	// step per frame flags Steps/frame too, the GPU engine clears both, and the boot
	// fallbacks repaint it because paintSlow rides bootEngine's completion.
	const levelSlow = () => lEl('level').parentNode.classList.contains('slow');
	const stepsSlow = () => lEl('speed').parentNode.classList.contains('slow');
	assert.ok(!levelSlow() && !stepsSlow(), 'L5 at one step per frame on the CPU is not slow');
	lEl('level').value = '7';
	lEl('level').dispatch('change');
	assert.ok(levelSlow() && !stepsSlow(), 'L7 on the CPU flags the Resolution control');
	lEl('speed').value = '5';
	lEl('speed').dispatch('change');
	assert.ok(levelSlow() && stepsSlow(), 'L7 with 5 steps/frame flags both controls');
	lEl('level').value = '6';
	lEl('level').dispatch('change');
	assert.ok(levelSlow() && stepsSlow(), 'L6 at 5 steps/frame keeps both flags: both are the cause');
	lEl('speed').value = '1';
	lEl('speed').dispatch('change');
	assert.ok(!levelSlow() && !stepsSlow(), 'L6 at one step per frame is the acceptable CPU case');
	globalThis.navigator.gpu = { getPreferredCanvasFormat: () => 'bgra8unorm' };
	lEl('engine').value = 'gpu';
	lEl('engine').dispatch('change');
	await livePage.tick();
	assert.ok(!levelSlow() && !stepsSlow(), 'the GPU engine is never slow-flagged');

	// The engine switch keeps the run: while a GPU batch is in flight the frame loop stops
	// stepping (the CPU mirror is not the world to advance), the switch to CPU pulls the
	// full mirror first, and afterwards the sim continues on the CPU at the same run state.
	lEl('play').click();
	// Five frames, not two: this page has never pumped, so the boot draw's view hold
	// consumes the first frames before the first batch is handed to the device.
	livePage.pump(5, 30000);
	const liveGpu = livePage.gpu;
	assert.equal(liveGpu.plays.length, 1, 'one GPU batch in flight');
	// The relief slider on the GPU engine: the next frame's world draw writes the new ramp
	// into the draw uniform (no pipeline, no device rebuild), and the GPU engine's draw is
	// the world texture's, not the canvas'.
	const liveGpuRenderer = fakeRenderers[fakeRenderers.length - 1];
	const drawsBeforeRamp = liveGpuRenderer.draws;
	lEl('relief').value = '9';
	lEl('relief').dispatch('input');
	assert.equal(livePage.Params.zRange, 9000, 'the ramp is metres on the GPU engine too');
	livePage.pump(1, 30500);
	assert.ok(liveGpuRenderer.draws > drawsBeforeRamp, 'the GPU engine redrew the world for the new ramp');
	lEl('relief').value = '6.5';
	lEl('relief').dispatch('input');
	assert.equal(livePage.Params.zRange, 6500, 'and the default is restored for the rest of the run');
	lEl('engine').value = 'cpu';
	lEl('engine').dispatch('change');
	assert.equal(lEl('play').textContent, 'Pause', 'the switch does not stop the run');
	livePage.pump(3, 31000);
	assert.equal(liveGpu.downloads, 0, 'nothing is pulled while the batch is still in flight');
	liveGpu.plays[0].settle(liveGpu.plays[0].n);
	await livePage.tick();
	await livePage.tick();
	assert.ok(liveGpu.downloads >= 1, 'the CPU handover pulls the full mirror (the event mirror is a cycle old)');
	assert.equal(lEl('badge').textContent, 'CPU · L6', 'the switch completed');
	assert.equal(lEl('play').textContent, 'Pause', 'still playing on the CPU engine');
	const liveT = () => +/^t (\d+\.\d) Myr/.exec(livePage.copy().split('\n').pop())[1];
	livePage.pump(4, 32000);
	assert.ok(liveT() > 0, 'the sim advances on the CPU engine: t ' + liveT());
	lEl('play').click();

	// --- the CPU renderer's view path, straight: fast re-sample, repaint without recolour ---
	const g5 = new Grid(5, 7).build();
	const s5 = new State(g5, 7);
	Sim.raster(s5);
	const ru = new Renderer({ getContext: () => ({
		createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
		putImageData: () => {}
	}) }, s5);
	ru.draw('plate');
	ru.viewDirty = true;
	ru.updateViewLookup();
	let identBad = 0;
	for (let i = 0; i < g5.lookup.length; i++) if (ru.viewLookup[i] !== g5.lookup[i]) identBad++;
	assert.equal(identBad, 0, 'the identity re-sample is the lookup itself: ' + identBad + ' pixels off');

	// A 56 degree rotation about an oblique axis: large enough that the plate colours
	// genuinely shuffle, oblique enough that some pixels land within 1.7e-6 rad of a cell
	// boundary (the flip count below must be nonzero, so the bound is real).
	const avx = 0.087, avy = 0.021, avz = -0.053;
	const an = Math.hypot(avx, avy, avz), a2 = 28 * Math.PI / 180;
	const vx = avx / an * Math.sin(a2), vy = avy / an * Math.sin(a2), vz = avz / an * Math.sin(a2);
	const vn = Math.cos(a2);
	ru.setView(vx, vy, vz, vn);
	assert.ok(ru.viewDirty, 'setView marks the re-sample');
	const colorsBefore = ru.colors.slice();
	const pixelsBefore = ru.image.data.slice();
	// A state change under a view-only redraw must not leak in: paint() paints the last
	// draw's colours, and the next draw() is what sees the new state. (A smooth layer like
	// sediment cannot pin the re-map, because a rotated cell's neighbour reads the same colour;
	// plate identity is what shuffles under the rotation.)
	const c0 = s5.owner.findIndex((o) => o >= 0);
	const owner0 = s5.owner[c0];
	s5.owner[c0] = -1;
	ru.paint();
	s5.owner[c0] = owner0;
	assert.ok(!ru.viewDirty, 'paint() consumes the re-sample');
	assert.deepEqual(ru.colors, colorsBefore, 'a view move repaints, it does not recolor');
	assert.ok(countChanged(pixelsBefore, ru.image.data) > TOTAL * 0.5, 'the rotated view re-mapped the paint');

	// The fast atan must agree with exact trigonometry everywhere except within 1.7e-6 rad of
	// a cell boundary: count the exceptions against an independent exact-trig reference.
	const W = g5.lookupW, H = g5.lookupH, TAU = Math.PI * 2;
	const rqx = -vx, rqy = -vy, rqz = -vz, rqw = vn;
	let flips = 0;
	for (let y = 0; y < H; y++) {
		const lat = (0.5 - (y + 0.5) / H) * Math.PI, cl = Math.cos(lat), sy = Math.sin(lat);
		for (let x = 0; x < W; x++) {
			const lon = ((x + 0.5) / W - 0.5) * TAU;
			const sx = cl * Math.cos(lon), sz = cl * Math.sin(lon);
			const tx = 2 * (rqy * sz - rqz * sy), ty = 2 * (rqz * sx - rqx * sz), tz = 2 * (rqx * sy - rqy * sx);
			const wx = sx + rqw * tx + rqy * tz - rqz * ty;
			const wy = sy + rqw * ty + rqz * tx - rqx * tz;
			const wz = sz + rqw * tz + rqx * ty - rqy * tx;
			const sLat = Math.asin(Math.max(-1, Math.min(1, wy)));
			const sLon = Math.atan2(wz, wx);
			let sX = Math.floor((sLon / TAU + 0.5) * W);
			if (sX < 0) sX += W;
			if (sX >= W) sX -= W;
			let sY = Math.floor((sLat / Math.PI + 0.5) * H);
			if (sY < 0) sY = 0;
			if (sY >= H) sY = H - 1;
			if (ru.viewLookup[(H - 1 - y) * W + x] !== g5.lookup[sY * W + sX]) flips++;
		}
	}
	assert.ok(flips <= 4096, 'fast-atan boundary exceptions: ' + flips + ' of ' + (W * H));
	assert.ok(flips > 0, 'the bound is real, not a degenerate match');

	ru.resetView();
	ru.updateViewLookup();
	let backBad = 0;
	for (let i = 0; i < g5.lookup.length; i++) if (ru.viewLookup[i] !== g5.lookup[i]) backBad++;
	assert.equal(backBad, 0, 'resetView returns the plain map, bit for bit: ' + backBad + ' pixels off');

	// The minimax atan2 stays three orders under the half-pixel margin (~3e-3 rad).
	let maxErr = 0;
	for (let i = 0; i < 100000; i++) {
		const x = Math.random() * 2 - 1, y = Math.random() * 2 - 1;
		const e = Math.abs(Renderer.atan2Fast(y, x) - Math.atan2(y, x));
		if (e > maxErr) maxErr = e;
	}
	assert.ok(maxErr < 3e-6, 'atan2Fast max error ' + maxErr + ' rad');

	console.log('PASS gui: L5/L6/L7 select rebuilds the world (badge, cell line, copy header, device reuse,'
		+ ' in-flight transfer waited for), load follows the blob\'s level, the strip holds '
		+ page.Perf.SLOTS + ' slots in place and is the copy control, the bench can measure every setting the page offers,'
		+ ' and a pan turns the view under a running sim (probe agrees with the paint, the dead zone keeps the click,'
		+ ' the sim never waits for the mouse, the view outlives a rebuild, both engines defer a step'
		+ ' while the view moves, the copied report records that gate, a GPU batch handed the gate stops'
		+ ' at its frame boundary, and paint never recolors); a fine-pointer hover switches the view mode,'
		+ ' the controls live in Startup/Adjust groups, the slow-on-CPU warning flags L7 and L6 >1 step/frame,'
		+ ' the Adjust sliders pre-fill from the query, report themselves in the copy header and recolor the'
		+ ' map without a rebuild, and an engine switch mid-run pulls the full mirror and keeps playing');
})().catch((error) => { console.error(error); process.exit(1); });

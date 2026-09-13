// The GUI's own invariants - the ones no simulation test can see, and the ones that broke
// silently before:
//   1. the Resolution select rebuilds the world (grid, state, renderer, engine, badge, the
//      map-top cell line, the copy header) instead of only relabelling it;
//   2. a rebuild never runs under an in-flight GPU transfer, which would size the new arenas
//      against the old world's numbers;
//   3. a checkpoint carries its own level and seed, and Load follows it instead of failing;
//   4. the perf strip keeps one reserved slot per part and rewrites text in place, so the parts
//      coming and going at 2 Hz cannot move the strip's height or the page under it;
//   5. every setting the page offers is one bench.html can measure - three owner-rig captures
//      came back without the 20-step rows because the bench silently filtered its own default.
//
// js/ui.js runs as a classic script against tests/dom-stub.js, which is built by parsing the
// real index.html, and a recorded fake GpuSim: the device side of the engine is
// tests/gpu-play.js's job, here the question is what the page does and in what order.
// runInThisContext rather than a vm context on purpose - a context runs the same code ~6x
// slower, and this test builds four worlds.
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
assert.deepEqual(levelOptions, [5, 6, 7], 'the Resolution select offers L5, L6 and L7');
assert.deepEqual(stepsOptions, [1, 5, 20], 'the Steps/frame select offers 1, 5 and 20');

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
const MODULES = ['geodesics', 'params', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges',
	'plates', 'contact', 'column-update', 'surface', 'events', 'checkpoint', 'perf', 'clipboard',
	'extract', 'sim', 'render'];

// The fake device side of the engine: records who was initialised with what, and hands the test
// the play promise so an in-flight transfer can be held open on purpose.
function fakeGpu() {
	const api = {
		device: null, S: null, inits: [], plays: [], steps: 0, uploads: 0, rasters: 0,
		tsLine: 'winners 1.92 diagC 1.74 diagA 0.99',
		init: function (state, opts) {
			api.inits.push({ state: state, device: opts && opts.device, fallback: opts && opts.fallback });
			if (!api.device) api.device = { name: 'fake-device' };
			api.S = { device: api.device, tsOn: true };
			return Promise.resolve(api.S);
		},
		release: function () { api.releases = (api.releases || 0) + 1; },
		raster: function () { api.rasters++; },
		play: function (state, dt, n) {
			const rec = { state: state, dt: dt, n: n, settle: null };
			rec.promise = new Promise(function (resolve) { rec.settle = resolve; });
			api.plays.push(rec);
			return rec.promise;
		},
		step: function () { api.steps++; return Promise.resolve(); },
		download: function () { return Promise.resolve(); },
		uploadState: function () { api.uploads++; return Promise.resolve(); },
		tsCollect: function () {},
		tsReport: function () { return api.tsLine; }
	};
	return api;
}
function FakeRenderer(canvas) { this.canvas = canvas; this.draws = 0; }
FakeRenderer.prototype.init = function (state) { this.state = state; return this; };
FakeRenderer.prototype.draw = function () { this.draws++; };
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
		copy: () => { el('copy-perf').click(); return api.document.copied[api.document.copied.length - 1]; },
		// The strip rewrites its text at 2 Hz (Perf.TEXT_MS) and the gap distribution reports
		// only once it has 8 gaps inside a 1 s window, so a pump has to span both: 16.7 ms
		// frames over ~1.5 s give three text updates and a full gap window.
		pump: (frames, from, stepMs) => api.pump(frames, from === undefined ? 1000 : from, stepMs || 16.7),
		tick: () => new Promise((r) => setTimeout(r, 1))
	};
	return page;
}

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

	// --- the copy button: the capture header names the world it came from -----------------
	const text = page.copy();
	await page.tick();
	assert.ok(text.startsWith('engine cpu · L5 · dt 0.1 · 1 steps/frame · view plate · map start · seed 7'),
		'copy header: ' + text.split('\n')[0]);
	assert.ok(!/\n\n/.test(text) && !/\n$/.test(text), 'no blank line for a reserved-but-empty slot');
	assert.ok(/\nt 0\.1 Myr · CPU · L5$/.test(text), 'the world line closes the report: ' + text.split('\n').pop());
	assert.equal(el('copy-perf').textContent, 'Copied ✓', 'the button says whether the write landed');

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
	assert.ok(page.copy().startsWith('engine cpu · L6 ·'), 'the capture header follows the level');
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
	assert.ok(page.copy().startsWith('engine gpu · L5 ·'), page.copy().split('\n')[0]);

	// Playing hands the loop to GpuSim.play; while that promise is open, a resolution change
	// must not swap the grid, the state and the arenas underneath it.
	el('play').click();
	page.pump(3, 20000);
	assert.equal(gpu.plays.length, 1, 'one play in flight');
	assert.equal(gpu.plays[0].state.grid.V, 10242);
	page.pump(2, 21000);
	assert.equal(gpu.plays.length, 1, 'a busy device is not handed a second play');

	el('level').value = '7';
	el('level').dispatch('change');
	assert.equal(gpu.inits.length, 1, 'the rebuild waits for the in-flight transfer');
	assert.equal(el('badge').textContent, 'GPU · L5', 'and the world is still the old one');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 10,242 CELLS / 223 KM');

	gpu.plays[0].settle(gpu.plays[0].n);
	await page.tick();
	assert.equal(gpu.inits.length, 2, 'the rebuild runs once the transfer has settled');
	assert.equal(gpu.inits[1].state.grid.V, 163842, 'on the new world');
	assert.equal(gpu.inits[1].device, gpu.device,
		'and on the same device: a level switch does not ask for another adapter');
	assert.equal(el('badge').textContent, 'GPU · L7');
	assert.equal(el('grid-info').textContent, 'EQUIRECTANGULAR / 163,842 CELLS / 56 KM');
	assert.equal(el('level').value, '7');
	assert.equal(page.Params.level, 7);
	assert.ok(page.copy().startsWith('engine gpu · L7 ·'), page.copy().split('\n')[0]);

	// --- the query pre-fill names a run instead of describing clicks ----------------------
	const asked = loadPage('?level=6&engine=cpu&seed=11&steps=5&dt=0.05');
	assert.equal(asked.el('badge').textContent, 'CPU · L6', asked.el('badge').textContent);
	assert.equal(asked.el('grid-info').textContent, 'EQUIRECTANGULAR / 40,962 CELLS / 112 KM');
	assert.equal(asked.el('seed').value, '11');
	assert.equal(asked.el('speed').value, '5');
	assert.equal(asked.el('dt').value, '0.05');
	assert.ok(asked.copy().startsWith('engine cpu · L6 · dt 0.05 · 5 steps/frame · view plate · map start · seed 11'),
		asked.copy().split('\n')[0]);
	// A level the select does not offer is ignored, not built: Grid takes 0-7 and a stray
	// ?level=9 would throw before the page drew anything.
	const stray = loadPage('?level=9');
	assert.equal(stray.el('badge').textContent, 'CPU · L5', 'an unoffered ?level= is ignored');

	console.log('PASS gui: L5/L6/L7 select rebuilds the world (badge, cell line, copy header, device reuse,'
		+ ' in-flight transfer waited for), load follows the blob\'s level, the strip holds '
		+ page.Perf.SLOTS + ' slots in place, and the bench can measure every setting the page offers');
})().catch((error) => { console.error(error); process.exit(1); });

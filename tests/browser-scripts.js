const { assert } = require('./helpers.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console, performance });
for (const file of ['geodesics', 'params', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges', 'plates', 'contact', 'column-update', 'surface', 'events', 'checkpoint', 'extract', 'perf', 'sim', 'render']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context, { filename: file });
}
// The WebGPU pack loads as classic scripts too (harness page, index.html): every file must
// define its global through the browser branch of its guard — `module` does not exist here,
// so a bare module.exports would throw exactly the ReferenceError file:// reported.
const GPU_FILES = ['gpu/layout', 'gpu/common.wgsl', 'gpu/scan.wgsl', 'gpu/mantle.wgsl', 'gpu/plates.wgsl',
	'gpu/columns.wgsl', 'gpu/bin.wgsl', 'gpu/raster.wgsl', 'gpu/edges.wgsl', 'gpu/contact.wgsl',
	'gpu/column.wgsl', 'gpu/surface.wgsl', 'gpu/forces.wgsl', 'gpu/diag.wgsl', 'gpu/events.wgsl',
	'gpu/sim-gpu', 'gpu/render-gpu'];
for (const file of GPU_FILES) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context, { filename: file });
}
vm.runInContext(`
var state = new State(new Grid(2, 7).build(), 7);
Sim.raster(state);
var image;
var canvas = { getContext: function () { return {
	createImageData: function (w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
	putImageData: function (value) { image = value; }
}; } };
var renderer = new Renderer(canvas, state);
renderer.draw('plate');
Sim.advance(state, 0.1, 10);
renderer.draw('z'); renderer.draw('owner'); renderer.draw('type'); renderer.draw('sediment');
Sim.advance(state, 0.1, 190);
renderer.draw('plate'); renderer.draw('type'); renderer.draw('z'); renderer.draw('owner');
renderer.draw('damage'); renderer.draw('sediment');
for (const ore of Renderer.ORE) renderer.draw(ore);
const deposits = Extract.deposits(state, 0.01, 4, new Float64Array(state.grid.V));
if (!Array.isArray(deposits)) throw new Error('extraction returns a list');
if (JSON.parse(Extract.json(state, 0.01, 2, new Float64Array(state.grid.V))).format !== 'pgt-deposits') {
	throw new Error('deposit json carries its format tag');
}
var blob = Checkpoint.save(state);
Checkpoint.load(state, blob);
Sim.raster(state);
`, context);
assert.equal(context.state.frame, 200);
assert.equal(context.image.data.length, 1024 * 512 * 4);
assert.equal(context.image.data[3], 255);
const grid = context.state.grid;
const topCell = grid.lookup[(grid.lookupH - 1) * grid.lookupW];
assert.ok(grid.pos[topCell * 3 + 1] > 0, 'north is at the top');
assert.equal(context.image.data[0], context.renderer.colors[topCell * 3]);
// GPU pack: kernels reachable through the browser globals, entry lists intact, prelude builds.
vm.runInContext(`
var glayout = new GpuLayout(new Grid(2, 7).build());
var pcode = prelude(glayout);
if (pcode.indexOf('fn add64') < 0) throw new Error('prelude helpers missing');
var entries = 0;
for (var i = 0; i < GpuKernelBodies.length; i++) entries += GpuKernelBodies[i].entry.length;
if (entries !== 53) throw new Error('kernel entries ' + entries);
if (GpuKernelBodies[0]() .indexOf('kScanBlocksBins') < 0) throw new Error('scan body missing');
if (GpuRenderer.SHADER.indexOf('fn cellColor') < 0) throw new Error('renderer shader missing');
if (GpuSim.FIELD_KIND.ore !== 'ore') throw new Error('field kinds missing');
`, context, { filename: 'gpu-pack' });
// Every element ui.js touches must exist in index.html — a renamed or ghosted button would
// otherwise only fail at first click with "properties of null".
const ui = fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
for (const m of ui.matchAll(/getElementById\('([^']+)'\)/g)) {
	assert.ok(page.includes('id="' + m[1] + '"'), 'index.html lacks id "' + m[1] + '" that ui.js reads');
}
// And the GPU wiring must actually be hooked up — these strings vanished once to silent
// ghost edits, so the test keeps them from vanishing again.
for (const needle of [
	'new GpuRenderer(gpuCanvas, gpuSim)',
	'gpuSim.applyArrived()',
	'gpuSim.snapshot()',
	'gpuRenderer.draw(layerInput.value)',
	'rebuildGpu().then'
]) {
	assert.ok(ui.includes(needle), 'ui.js lost the GPU wiring: ' + needle);
}
console.log('PASS classic-script loading and Canvas render API smoke test (not a browser E2E test)');

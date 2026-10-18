const { assert } = require('./helpers.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console, performance });
for (const file of ['env', 'geodesics', 'params', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges', 'plates', 'contact', 'column-update', 'surface', 'events', 'checkpoint', 'extract', 'data/deposit-economics', 'deposits', 'core', 'instruments', 'perf', 'clipboard', 'sim', 'render', 'gpu/render-gpu',
'render3d', 'heightfield', 'gpu/d1diff', 'resolution']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context, { filename: file });
}
vm.runInContext(fs.readFileSync(path.join(__dirname, '../port/slice-format.js'), 'utf8'), context, { filename: 'slice-format' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../port/core-log-format.js'), 'utf8'), context, { filename: 'core-log-format' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/slice.js'), 'utf8'), context, { filename: 'slice' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/core-log.js'), 'utf8'), context, { filename: 'core-log' });
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
renderer.draw('damage'); renderer.draw('sediment'); renderer.draw('speed'); renderer.draw('age'); renderer.draw('force');
for (const ore of Renderer.ORE) renderer.draw(ore);
var ledger = new Instruments.Ledger(state.grid.V);
var survey = Instruments.survey(state, 0, ['d5k'], ledger);
if (!survey.ok || ledger.cellsN !== 1 || !Instruments.report(survey).startsWith('cell 0')) {
	throw new Error('single-cell instrument survey did not load');
}
const catalogue = Deposits.build(state);
if (!Array.isArray(catalogue.records)) throw new Error('the catalogue returns a record list');
const dump = JSON.parse(Deposits.json(state));
if (dump.format !== 'pgt-deposits' || dump.version !== 2) throw new Error('deposit json carries its v2 format tag');
if (!dump.classes.length || !dump.totals) throw new Error('deposit json carries the class table and its totals');
var blob = Checkpoint.save(state);
Checkpoint.load(state, blob);
Sim.raster(state);
// The cutter's classic-script chain (0.8.1): the shared codec loads before js/slice.js, and
// the page-order globals (SlicePack, Resolution, Slice) resolve without module machinery.
var slicePath = Slice.circleThrough(new Float64Array([1, 0, 0.2]), new Float64Array([-0.4, 0.9, -0.1]),
	Slice.radiusKm(), Slice.cellKmFor(state.grid));
var sliceRuns = Slice.walk(state.grid, slicePath, Resolution.nearestCell);
if (sliceRuns.n < 2) throw new Error('the classic-script cutter walk produced no runs');
var slicePack = Slice.pack(state, slicePath, { mode: 'level', levelM: 0, volScale: 1 },
	{ pack: 'procedural-map', epochMa: 0, rotModel: 'procedural', built: '2026-10-13T12:00:00.000Z' },
	'classic-script smoke');
if (SlicePack.validate(slicePack.pack) !== '') throw new Error('the classic-script pack does not validate');
if (SlicePack.decode(SlicePack.encode(slicePack.pack)).checksum !== slicePack.pack.checksum)
	throw new Error('the classic-script pack does not round-trip');
`, context);
assert.equal(context.state.frame, 200);
assert.equal(context.image.data.length, 1024 * 512 * 4);
assert.equal(context.image.data[3], 255);
const grid = context.state.grid;
const topCell = grid.lookup[(grid.lookupH - 1) * grid.lookupW];
assert.ok(grid.pos[topCell * 3 + 1] > 0, 'north is at the top');
assert.equal(context.image.data[0], context.renderer.colors[topCell * 3]);
console.log('PASS classic-script loading and Canvas render API smoke test (not a browser E2E test)');

const { assert } = require('./helpers.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console, performance });
for (const file of ['geodesics', 'params', 'quat', 'mantle', 'diag', 'state', 'columns', 'edges', 'plates', 'contact', 'column-update', 'surface', 'events', 'perf', 'sim', 'render']) {
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
`, context);
assert.equal(context.state.frame, 200);
assert.equal(context.image.data.length, 1024 * 512 * 4);
assert.equal(context.image.data[3], 255);
const grid = context.state.grid;
const topCell = grid.lookup[(grid.lookupH - 1) * grid.lookupW];
assert.ok(grid.pos[topCell * 3 + 1] > 0, 'north is at the top');
assert.equal(context.image.data[0], context.renderer.colors[topCell * 3]);
console.log('PASS classic-script loading and Canvas render API smoke test (not a browser E2E test)');

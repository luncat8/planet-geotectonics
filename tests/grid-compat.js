const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { loadGrid, compare } = require('../experiments/grid-compat.js');
const Grid = require('../js/geodesics.js');

for (const source of [
	'function Grid() {}',
	'module.exports = function Grid() {};',
	'module.exports = { Grid: function Grid() {} };'
]) assert.equal(typeof loadGrid(source, 'fixture.js'), 'function');
assert.throws(() => loadGrid('var other = 1;', 'fixture.js'), /constructor/);

const g = new Grid(0, 12345).build();
function climateGrid() {
	const cellA = new Float32Array(g.W * g.H * 4);
	const nbrA = new Float32Array(g.W * g.H * 24);
	for (let i = 0; i < g.V; i++) {
		cellA.set(g.pos.subarray(i * 3, i * 3 + 3), i * 4);
		for (let k = 0; k < g.ringN[i]; k++) {
			const offset = (i + k * g.W * g.H) * 4;
			nbrA[offset] = g.ring[i * 6 + k];
			nbrA[offset + 3] = 1;
		}
	}
	return { V: g.V, W: g.W, H: g.H, lookupW: g.lookupW, lookupH: g.lookupH,
		cellA, nbrA, lookup: g.lookup.slice() };
}
const c = climateGrid();
assert.equal(compare(g, c).pass, true);
assert.ok(compare(g, c).maxDistanceM < 1, 'float32 radial rounding is not kilometre-scale angular error');
c.cellA[0] *= 0.9; c.cellA[1] *= 0.9; c.cellA[2] *= 0.9;
assert.equal(compare(g, c).pass, true, 'directions ignore radial scaling');
c.cellA[0] = 1; c.cellA[1] = 0; c.cellA[2] = 0;
assert.equal(compare(g, c).pass, false, 'different direction rejected');
const ring = climateGrid();
ring.nbrA[0] = (ring.nbrA[0] + 1) % g.V;
assert.equal(compare(g, ring).ringMismatches, 1);
const lookup = climateGrid();
lookup.lookup[0] = (lookup.lookup[0] + 1) % g.V;
assert.equal(compare(g, lookup).lookupMismatches, 1);
assert.throws(() => compare(g, { ...c, V: g.V + 1 }), /V mismatch/);
assert.throws(() => compare(g, { ...c, lookup: [] }), /buffer dimensions/);
const invalid = climateGrid();
invalid.cellA[0] = NaN;
assert.throws(() => compare(g, invalid), /Invalid centre/);
for (const args of [[], ['unused', '7', '3'], ['unused', 'NaN'], ['unused', '0', '8']]) {
	const result = spawnSync(process.execPath, ['experiments/grid-compat.js', ...args], { encoding: 'utf8' });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage:|Levels must/);
}
console.log('PASS grid-compat: script/export loading, float32 angle, topology/lookup drift, malformed input and CLI refusals');

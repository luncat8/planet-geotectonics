'use strict';
const { assert, Grid } = require('./helpers.js');
const Surface = require('../js/climate-surface.js');

const sourceGrid = new Grid(2, 7).build();
function packet() {
	const elevation = new Float64Array(sourceGrid.V);
	for (let i = 0; i < elevation.length; i++) elevation[i] = (i % 11 - 5) * 500;
	return {
		format: Surface.FORMAT, version: 1,
		level: sourceGrid.level, V: sourceGrid.V,
		lookupW: sourceGrid.lookupW, lookupH: sourceGrid.lookupH,
		lookup: sourceGrid.lookup, elevation: elevation,
		seaLevel: 250, tMyr: 12.5
	};
}
function planet(reverse) {
	const V = sourceGrid.V;
	const grid = {
		level: sourceGrid.level, V: V,
		cellA: new Float32Array(V * 4), cellB: new Float32Array(V * 4), cellC: new Float32Array(V * 4)
	};
	for (let i = 0; i < V; i++) {
		const source = reverse ? V - 1 - i : i;
		grid.cellA[i * 4] = sourceGrid.pos[source * 3];
		grid.cellA[i * 4 + 1] = sourceGrid.pos[source * 3 + 1];
		grid.cellA[i * 4 + 2] = sourceGrid.pos[source * 3 + 2];
		grid.cellA[i * 4 + 3] = sourceGrid.A0[source];
	}
	return {
		grid: grid, params: { hTop: 60, dShelf: 200, depthMax: 4000 },
		texCellB: { name: 'B' }, texCellC: { name: 'C' }, writes: [],
		writeTex: function (tex, data) { this.writes.push({ tex: tex, data: data }); }
	};
}

// The raster is a direction map, not an indexCompatibility claim. Reversing every target
// direction must reverse the source assignments while producing the same field values.
{
	const source = packet();
	for (let i = 0; i < sourceGrid.V; i++) {
		assert.equal(Surface.sourceCell(source, sourceGrid.pos[i * 3], sourceGrid.pos[i * 3 + 1], sourceGrid.pos[i * 3 + 2]), i,
			'a source centre maps back to its own cell ' + i);
	}
	const p = planet(true);
	const stats = Surface.apply(p, source);
	assert.equal(p.writes.length, 2, 'exactly the land and geometry textures are uploaded');
	assert.strictEqual(p.writes[0].data, p.grid.cellB);
	assert.strictEqual(p.writes[1].data, p.grid.cellC);
	assert.equal(source.targetLevel, 2);
	let land = 0;
	for (let i = 0; i < sourceGrid.V; i++) {
		const sourceCell = sourceGrid.V - 1 - i;
		const bed = source.elevation[sourceCell] - source.seaLevel;
		const wet = bed < 0;
		const depth = wet ? Math.max(5, -bed) : 200;
		assert.equal(p.grid.cellB[i * 4 + 3], wet ? 0 : 1, 'land mask at reversed cell ' + i);
		assert.equal(p.grid.cellC[i * 4], depth, 'depth at reversed cell ' + i);
		assert.equal(p.grid.cellC[i * 4 + 1], Math.max(1, Math.min(60, depth * 0.4)), 'reference thickness');
		assert.equal(p.grid.cellC[i * 4 + 2], wet ? -depth : bed, 'bed elevation');
		assert.equal(p.grid.cellC[i * 4 + 3], 0, 'old procedural coast distance is not retained');
		if (!wet) land++;
	}
	assert.equal(stats.landCells, land);
	assert.equal(stats.surfaceTMyr, 12.5);
	assert.equal(stats.seaLevel, 250);
	assert.equal(stats.minElevation, -2750);
	assert.equal(stats.maxElevation, 2250);
	console.log('PASS climate surface: direction mapping, sea level, land/depth/reference geometry and texture uploads');
}

// The encoded held surface is plain data suitable for the PGTS JSON half and restores exact
// typed arrays, rather than JSON objects with numeric keys.
{
	const held = packet();
	held.targetLevel = 2;
	const encoded = Surface.encode(held);
	assert.equal(typeof encoded.lookup, 'string');
	assert.equal(typeof encoded.elevation, 'string');
	const decoded = Surface.decode(encoded);
	assert.ok(decoded.lookup instanceof Float32Array);
	assert.ok(decoded.elevation instanceof Float64Array);
	assert.deepEqual(decoded.lookup, sourceGrid.lookup);
	assert.deepEqual(decoded.elevation, packet().elevation);
	assert.equal(decoded.targetLevel, 2);
	assert.equal(decoded.tMyr, 12.5);
	const bad = Object.assign({}, encoded, { elevation: encoded.elevation.slice(0, -4) });
	assert.throws(() => Surface.decode(bad), /byte length|base64/);
	console.log('PASS climate surface: held-packet base64 round trip and malformed payload refusal');
}

// The globe uses NaN for a temporarily uncovered cell. Keep that marker in the packet and
// give the climate a deep ocean there; it is not land and it is not a validation failure.
{
	const source = packet();
	source.elevation[0] = NaN;
	const p = planet(true), at = sourceGrid.V - 1;
	const stats = Surface.apply(p, source);
	assert.equal(stats.gapCells, 1);
	assert.equal(p.grid.cellB[at * 4 + 3], 0);
	assert.equal(p.grid.cellC[at * 4], 4000);
	assert.equal(p.grid.cellC[at * 4 + 2], -4000);
	assert.ok(Number.isNaN(Surface.decode(Surface.encode(source)).elevation[0]));
	console.log('PASS climate surface: uncovered globe cells become named-depth ocean and survive save/load');
}

// Validation finishes before either target table or texture is touched.
{
	const source = packet();
	const p = planet(false);
	source.lookup[source.lookup.length - 1] = source.V;
	assert.throws(() => Surface.apply(p, source), /lookup id/);
	assert.equal(p.writes.length, 0);
	assert.ok(p.grid.cellB.every((value) => value === 0));
	assert.ok(p.grid.cellC.every((value) => value === 0));
	source.lookup[source.lookup.length - 1] = 0;
	source.elevation[3] = Infinity;
	assert.throws(() => Surface.apply(p, source), /elevation 3/);
	assert.equal(p.writes.length, 0);
	console.log('PASS climate surface: invalid packets leave the live climate geometry untouched');
}

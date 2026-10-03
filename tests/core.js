const { assert, Grid, State, Sim } = require('./helpers.js');
const Core = require('../js/core.js');
const Deposits = require('../js/deposits.js');
const Checkpoint = require('../js/checkpoint.js');
const Params = require('../js/params.js');

function site(seed, options) {
	options = options || {};
	const grid = new Grid(2, seed).build(), state = new State(grid, seed);
	state.ckptCap = 0;
	Sim.raster(state);
	state.owner.fill(-1); state.alive.fill(0); state.cell.fill(-1);
	for (const name of Deposits.FIELDS) state[name].fill(0);
	const cell = options.cell === undefined ? 0 : options.cell;
	state.alive[0] = 1; state.owner[cell] = 0; state.cell[0] = cell; state.plate[0] = 0;
	state.body.set(grid.pos.subarray(cell * 3, cell * 3 + 3), 0);
	state.world.set(state.body.subarray(0, 3), 0);
	state.hSed[0] = options.sed === undefined ? 800 : options.sed;
	state.hFel[0] = options.fel === undefined ? 35000 : options.fel;
	state.hMaf[0] = options.maf === undefined ? 5000 : options.maf;
	state.age[0] = options.age === undefined ? 900 : options.age;
	state.z[cell] = options.z === undefined ? 500 : options.z;
	state.low.fill(-1);
	if (options.field) state[options.field][0] = options.value === undefined ? 0.95 : options.value;
	return state;
}
function sameLayers(section) {
	return section.layers.map((layer) => [layer.top, layer.bottom, layer.lithology, layer.detail, layer.id || '']);
}
function sumsToDepth(section) {
	let at = 0, total = 0;
	for (const layer of section.layers) {
		assert.equal(layer.top, at, 'core layers are contiguous at ' + at);
		assert.ok(layer.bottom >= layer.top, 'layer thickness is nonnegative');
		assert.equal(layer.thickness, layer.bottom - layer.top);
		at = layer.bottom;
		total += layer.thickness;
	}
	assert.equal(at, section.depth, 'the core ends at the requested or free depth');
	assert.equal(total, section.depth, 'layer thicknesses sum to the hole depth');
}

// A real catalogue record is the source of each ore interval; the core does not invent a
// convenient synthetic intercept that could conceal a mismatch in the 0.6.1 geometry.
const arc = site(1, { field: 'oArc' });
const record = Deposits.at(arc, 'arc', 0);
assert.ok(record && record.variant === 'porphyry', 'the synthetic hole has a real porphyry record');
const shallow = Core.section(arc, 0, 500);
const deep = Core.section(arc, 0, 5000);
assert.equal(shallow.intersections.length, 0, 'the 500 m hole stops above the actual body');
assert.ok(deep.intersections.length > 0, 'the 5 km hole intersects at least one actual body');
for (const hit of deep.intersections) {
	const body = record.bodies[hit.bodyIndex];
	assert.equal(hit.id, record.id);
	assert.equal(hit.bodyTop, body.top, 'land intervals use the catalogue depth');
	assert.ok(hit.from >= hit.bodyTop && hit.to <= hit.bodyBottom);
	assert.deepEqual(hit.grade, record.grade);
	const pieces = deep.layers.filter((layer) => layer.oreRecords
		&& layer.oreRecords.some((ore) => ore.id === record.id && ore.bodyIndex === hit.bodyIndex));
	assert.ok(pieces.length, 'the hit is an ore overlay on host rock');
	let at = hit.from;
	for (const piece of pieces) {
		assert.equal(piece.top, at, 'ore overlay pieces are contiguous');
		assert.ok(piece.bottom <= hit.to);
		at = piece.bottom;
	}
	assert.equal(at, hit.to, 'the core logs the full catalogue body intersection');
}
sumsToDepth(deep);
sumsToDepth(shallow);
assert.ok(deep.layers.some((layer) => layer.lithology === 'felsic crust'), 'felsic crust is logged');

// Two real-format body records can occupy the same vertical interval. The host remains one
// contiguous layer, but every coincident ore record is retained on the overlay and in text.
const overlapSite = site(3);
const overlapRecords = [
	{ id: 'core-a', kind: 'vms', variant: 'sulfide', commodity: 'Cu-Zn',
		grade: { Cu: 1.2 }, gradeUnit: { Cu: '%' }, bodies: [{ top: 1000, bottom: 1500 }] },
	{ id: 'core-b', kind: 'mafic', variant: 'sulfide', commodity: 'Ni-Cu',
		grade: { Ni: 0.8 }, gradeUnit: { Ni: '%' }, bodies: [{ top: 1250, bottom: 1750 }] }
];
const originalAt = Deposits.at;
Deposits.at = function (state, kind, cell) {
	return cell === 0 && (kind === 0 || kind === 1) ? overlapRecords[kind] : null;
};
let overlapCore;
try { overlapCore = Core.section(overlapSite, 0, 5000); }
finally { Deposits.at = originalAt; }
sumsToDepth(overlapCore);
const coincident = overlapCore.layers.find((layer) => layer.top === 1250 && layer.bottom === 1500);
assert.deepEqual(coincident.oreRecords.map((ore) => ore.id), ['core-a', 'core-b'],
	'overlapping bodies retain every record on one host interval');
assert.match(Core.text(overlapCore), /#core-a.*#core-b/,
	'the printed section names every overlapping record');

const free = Core.section(arc, 0, 'basement');
assert.equal(free.depth, free.crustBottom, 'to basement ends at the quantized Moho');
assert.ok(!free.layers.some((layer) => layer.lithology === 'mantle'), 'free depth does not drill into mantle');
assert.ok(free.layers.some((layer) => layer.lithology === 'mafic crust'), 'the basement stop includes mafic crust');
sumsToDepth(free);
const overdeep = Core.section(arc, 0, 50000);
assert.ok(overdeep.layers.some((layer) => layer.lithology === 'mantle'), 'a fixed hole past the Moho logs mantle');
assert.equal(overdeep.layers[overdeep.layers.length - 1].bottom, 50000);
sumsToDepth(overdeep);

// The surface datum includes water; catalogue body depths are below the seafloor, so every
// hit is translated by the rounded water column and a short hole can stop in seawater.
const oldSea = Params.sea;
Params.sea = 0;
const wet = site(1, { field: 'oArc', z: -1000 });
const wetRecord = Deposits.at(wet, 'arc', 0);
const wetCore = Core.section(wet, 0, 5000);
assert.equal(wetCore.datum, 'sea surface');
assert.equal(wetCore.water, 1000);
assert.equal(wetCore.layers[0].lithology, 'seawater');
assert.ok(wetCore.intersections.length > 0, 'the deeper wet hole reaches the same body');
for (const hit of wetCore.intersections) {
	const body = wetRecord.bodies[hit.bodyIndex];
	assert.equal(hit.bodyTop, wetCore.water + body.top, 'the sea-water datum offset is explicit');
}
const waterOnly = Core.section(wet, 0, 500);
assert.equal(waterOnly.layers.length, 1);
assert.equal(waterOnly.layers[0].lithology, 'seawater');
assert.equal(waterOnly.layers[0].bottom, 500);
assert.equal(Core.section(wet, 0, 0).layers[0].lithology, 'seawater', 'wet zero-depth holes retain the water datum');
sumsToDepth(waterOnly);
Params.sea = oldSea;

// Context beds are part of the sediment package, not overlapping extra thickness. Coal may
// come from a local record or the specified on-land basin signal; uranium and placer pay beds
// require the matching local record (or the one-hop downstream placer case).
const coalSite = site(7, { sed: 1400, field: 'oBas', value: 0.5 });
const coalCore = Core.section(coalSite, 0, 'basement');
assert.ok(coalCore.layers.some((layer) => layer.lithology === 'coal' && layer.thickness <= 4),
	'the land basin signal inserts a bounded coal seam');
sumsToDepth(coalCore);
const barren = site(7, { sed: 1400 });
assert.ok(!Core.section(barren, 0, 'basement').layers.some((layer) => layer.lithology === 'coal'),
	'a cell without a coal context has no coal seam');
const placer = site(7, { sed: 800, field: 'oPla', value: 0.95 });
assert.ok(Deposits.at(placer, 'placer', 0), 'the placer test cell has a catalogue record');
assert.ok(Core.section(placer, 0, 'basement').layers.some((layer) => layer.lithology === 'gravel'),
	'a placer record inserts a pay streak');
const noPlacer = site(7, { sed: 800 });
assert.ok(!Core.section(noPlacer, 0, 'basement').layers.some((layer) => layer.lithology === 'gravel'),
	'no placer context means no pay streak');
let uranium = null, uraniumRecord = null;
for (let seed = 1; seed <= 32 && !uranium; seed++) {
	const candidate = site(seed, { sed: 1400, field: 'oBas', value: 0.95 });
	const basin = Deposits.at(candidate, 'basin', 0);
	if (basin && basin.variant === 'uranium') { uranium = candidate; uraniumRecord = basin; }
}
assert.ok(uranium, 'the deterministic seed sweep reaches a uranium basin variant');
assert.ok(Core.section(uranium, 0, 'basement').layers.some((layer) => layer.lithology === 'sandstone'
	&& layer.detail.indexOf('U-bearing') >= 0), 'a uranium record inserts its redox sandstone bed');
assert.ok(!Core.section(barren, 0, 'basement').layers.some((layer) => layer.detail.indexOf('U-bearing') >= 0),
	'a non-uranium cell has no U-bearing bed');

// The downstream placer case follows the sim's reverse-drainage pointer and is still local.
const pair = site(13, { sed: 800 });
let source = -1, outlet = -1;
for (let c = 1; c < pair.grid.V && source < 0; c++) {
	for (let n = 0; n < pair.grid.ringN[c]; n++) {
		const next = pair.grid.ring[c * 6 + n];
		if (next < c) { source = c; outlet = next; break; }
	}
}
assert.ok(source >= 0, 'a lower-index downstream neighbor exists');
pair.alive[1] = 1;
pair.owner[source] = 0; pair.cell[0] = source;
pair.body.set(pair.grid.pos.subarray(source * 3, source * 3 + 3), 0);
pair.world.set(pair.body.subarray(0, 3), 0);
pair.owner[outlet] = 1; pair.cell[1] = outlet;
pair.body.set(pair.grid.pos.subarray(outlet * 3, outlet * 3 + 3), 3);
pair.world.set(pair.body.subarray(3, 6), 3);
pair.hFel[1] = 35000; pair.hMaf[1] = 5000; pair.hSed[1] = 800; pair.age[1] = 900; pair.z[outlet] = 500;
pair.oPla[0] = 0.4; pair.oPla[1] = 1;
pair.low[source] = outlet;
assert.equal(Deposits.at(pair, 'placer', source), null, 'the source is not its own local maximum');
assert.ok(Deposits.at(pair, 'placer', outlet), 'the one-hop outlet holds the placer record');
assert.ok(Core.section(pair, source, 'basement').layers.some((layer) => layer.lithology === 'gravel'),
	'a loaded cell can expose the downstream placer pay streak');

// S1/S2: anchor-keyed bedding is deterministic, survives checkpoints and follows a carried
// column to a new grid cell without rerolling. Repeated calls also produce byte-identical JSON.
const stable = site(1, { field: 'oArc' });
const first = Core.section(stable, 0, 5000);
const firstJson = Core.json(first);
assert.equal(Core.json(Core.section(stable, 0, 5000)), firstJson);
assert.equal(Core.text(first).split('\n').length, first.layers.length + 1, 'one header plus one line per layer');
const coreDump = JSON.parse(firstJson);
assert.equal(coreDump.format, 'pgt-core');
assert.equal(coreDump.version, 1);
assert.equal(coreDump.intersections[0].id, record.id);
const bytes = Checkpoint.save(stable);
Checkpoint.load(stable, bytes);
assert.equal(Core.json(Core.section(stable, 0, 5000)), firstJson, 'checkpoint round-trip preserves the core');
const next = stable.grid.ring[0];
stable.owner[0] = -1; stable.owner[next] = 0; stable.cell[0] = next;
stable.world.set(stable.grid.pos.subarray(next * 3, next * 3 + 3), 0);
stable.z[next] = 500;
const carried = Core.section(stable, next, 5000);
assert.deepEqual(sameLayers(carried), sameLayers(first), 'a column keeps its bedding when its cell changes');
assert.equal(carried.intersections[0].id, first.intersections[0].id, 'ore identity follows the same anchor');

console.log('PASS core: contiguous anchored beds, water datum, local context features, real catalogue intersections, stable JSON and a basement stop');

const { assert, Grid, State, Sim } = require('./helpers.js');
const Deposits = require('../js/deposits.js');
const Extract = require('../js/extract.js');
const Instruments = require('../js/instruments.js');
const Checkpoint = require('../js/checkpoint.js');
const Params = require('../js/params.js');

const grid = new Grid(2, 19).build();
const state = new State(grid, 19);
state.ckptCap = 0;
Sim.raster(state);
const cell = 0, owner = 0, body = cell * 3;
state.owner.fill(-1);
state.alive.fill(0);
state.alive[owner] = 1;
state.owner[cell] = owner;
state.cell[owner] = cell;
state.body[body] = grid.pos[cell * 3];
state.body[body + 1] = grid.pos[cell * 3 + 1];
state.body[body + 2] = grid.pos[cell * 3 + 2];
state.world.set(state.body.subarray(0, 3), 0);
state.plate[owner] = 0;
state.hFel[owner] = 35000;
state.hMaf[owner] = 5000;
state.hSed[owner] = 137;
state.age[owner] = 312.4;
state.z[cell] = 480;
state.oArc[owner] = 0.8001;

const anchor = Deposits.anchorKey(state, cell);
assert.deepEqual(anchor, Array.from(state.body.subarray(0, 3), (v) => Math.round(v * 32768)),
	'the physical anchor is quantized in the column frame');
assert.equal(Deposits.idFor(state.seed, 'arc', anchor), Deposits.idFor(state.seed, 'arc', anchor), 'stable id');
assert.notEqual(Deposits.idFor(state.seed, 'arc', anchor), Deposits.idFor(state.seed, 'vms', anchor),
	'class is part of a prospect identity');
assert.equal(Deposits.potential(0.8001), Deposits.potential(0.8005), 'sub-bucket potential drift is suppressed');
assert.equal(Deposits.potential(-1), 0, 'potential clamps below zero');
assert.equal(Deposits.potential(2), 1, 'potential clamps above one');

const first = Deposits.at(state, 'arc', cell);
assert.ok(first, 'a strong local maximum makes one candidate');
assert.equal(first.potential, Deposits.potential(0.8001));
assert.equal(first.host, 'continental');
assert.equal(first.ageMyr, 312);
assert.equal(first.cover % 50, 0, 'cover is quantized to 50 m');
assert.equal(first.top % 50, 0, 'emplacement depth is quantized to 50 m');
assert.equal(first.id, Deposits.at(state, 'arc', cell).id, 'a repeated local query has the same id');

// S1: a record is a function of integer buckets, so drift smaller than one bucket changes
// nothing at all, and the clock changes nothing ever (S2).
const frozen = JSON.stringify(first);
state.oArc[owner] = 0.8001 + 1e-6;
state.t = 777.25;
state.frame = 7772;
const drifted = Deposits.at(state, 'arc', cell);
assert.equal(JSON.stringify({ ...drifted, epochMyr: first.epochMyr }), frozen,
	'sub-bucket drift and the clock leave every number of a record identical');
assert.equal(drifted.epochMyr, 777.3, 'only the snapshot stamp follows the clock');
state.t = 0; state.frame = 0;
// A full bucket step is allowed to move the numbers, but only the ones that depend on q.
state.oArc[owner] = (Math.round(0.8001 * 255) + 1) / 255;
const stepped = Deposits.at(state, 'arc', cell);
assert.notEqual(stepped.potential, first.potential, 'one bucket up is a different potential');
assert.equal(stepped.id, first.id, 'the identity does not depend on the potential');
assert.equal(stepped.variant, first.variant, 'nor does the class row');
state.oArc[owner] = 0.8001;

// S2/S3: the stable id is independent of the raster cell and the simulation clock. A rigid
// plate move updates world coordinates, not the body-frame key, so a survey does not reroll.
const neighbor = grid.ring[cell * 6];
state.owner[cell] = -1;
state.owner[neighbor] = owner;
state.cell[owner] = neighbor;
state.world[0] = grid.pos[neighbor * 3];
state.world[1] = grid.pos[neighbor * 3 + 1];
state.world[2] = grid.pos[neighbor * 3 + 2];
state.z[neighbor] = 470;
state.t = 10.2;
state.frame = 102;
const moved = Deposits.at(state, 'arc', neighbor);
assert.ok(moved, 'the prospect follows its owning column');
assert.equal(moved.id, first.id, 'cell and frame do not enter the id');
assert.equal(moved.top, first.top, 'depth is stable while cover is unchanged within a bucket');
assert.equal(moved.size, first.size, 'tonnage rides the anchor, not the cell');
assert.deepEqual(moved.grade, first.grade, 'so does the grade');
assert.equal(moved.epochMyr, 10.2, 'the report carries the current snapshot epoch');
assert.ok(moved.lat !== first.lat || moved.lon !== first.lon, 'the display position follows the moved column');

state.oArc[owner] = 0.2;
assert.equal(Deposits.at(state, 'arc', neighbor), null, 'background is not promoted to a named prospect');
assert.ok(Deposits.blurAt(state, 'arc', neighbor) >= Deposits.TRACE_MIN,
	'a sub-deposit anomaly can still be read without becoming a record');

// --- the class table ------------------------------------------------------------------
for (const row of Deposits.CLASSES) {
	for (let i = 1; i < row.ladder.length; i++) {
		assert.ok(row.ladder[i] > row.ladder[i - 1], row.kind + '/' + row.variant + ' ladder is a monotone percentile ladder');
	}
	assert.ok(row.aspect[0] > 0 && row.aspect[1] > row.aspect[0], row.variant + ' aspect band');
	assert.ok(row.bodies[0] >= 1 && row.bodies[1] >= row.bodies[0], row.variant + ' body-count band');
	assert.ok(row.emplace[1] >= row.emplace[0] && row.rho > 0, row.variant + ' emplacement band and density');
	assert.ok(row.source && (row.hosted === 'sediment' || row.hosted === 'basement'),
		row.variant + ' names its host and its source');
	for (const metal of row.grades) assert.ok(metal[2] > 0 && metal[3] > metal[2], row.variant + ' ' + metal[0] + ' band');
	assert.ok(row.grades.length || row.bulk, row.variant + ' has a grade band or is a bulk commodity');
}

// --- a varied synthetic world: every row gets exercised without a long history ----------
function garden() {
	const g = new Grid(3, 11).build(), s = new State(g, 11);
	s.ckptCap = 0;
	Sim.raster(s);
	// A deterministic spread of potentials, covers, ages and depths over the map start, so
	// all twelve rows of the class table are reachable in a test that runs in a second.
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		const mix = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
		s.oVms[i] = (mix * 1.7) % 1;
		s.oMaf[i] = (mix * 2.3 + 0.1) % 1;
		s.oArc[i] = (mix * 3.1 + 0.2) % 1;
		s.oOro[i] = (mix * 4.7 + 0.3) % 1;
		s.oBas[i] = (mix * 5.3 + 0.4) % 1;
		s.oPla[i] = (mix * 6.1 + 0.5) % 1;
		s.hSed[i] = Math.round(mix * 3000);
		s.age[i] = 50 + mix * 1200;
		if (mix > 0.8) { s.hFel[i] = 48000; s.age[i] = 900; }
		if (mix < 0.12) { s.hFel[i] = 0; s.hMaf[i] = 7000; }
	}
	return s;
}
const world = garden();
const catalogue = Deposits.build(world);
assert.ok(catalogue.records.length > 50, 'the synthetic world is populated: ' + catalogue.records.length);
assert.equal(catalogue.cellStart[world.grid.V], catalogue.records.length, 'the per-cell index covers every record');
for (let c = 0; c < world.grid.V; c++) {
	for (let at = catalogue.cellStart[c]; at < catalogue.cellStart[c + 1]; at++) {
		assert.equal(catalogue.records[at].cell, c, 'the per-cell buckets agree with the flat array');
	}
}

const seen = Object.create(null);
for (const record of catalogue.records) {
	const row = Deposits.CLASSES.find((r) => r.kind === record.kind && r.variant === record.variant);
	const tag = record.kind + '/' + record.variant;
	seen[tag] = (seen[tag] || 0) + 1;
	// 4. internal consistency: the geometry reproduces the tonnage, and the record sits inside
	// the crust that hosts it.
	let volume = 0, shares = 0;
	for (const b of record.bodies) {
		const area = b.footprintKm2 * 1e6;
		assert.ok(Math.abs(b.thicknessM - b.aspect * Math.sqrt(area)) <= 1 + 0.01 * b.thicknessM,
			tag + ' body thickness is k·√area: ' + b.thicknessM + ' vs ' + b.aspect * Math.sqrt(area));
		assert.ok(b.aspect >= row.aspect[0] * 0.99 && b.aspect <= row.aspect[1] * 1.01, tag + ' aspect inside its band');
		assert.ok(b.top >= record.top && b.bottom <= record.bottom && b.bottom > b.top, tag + ' body interval');
		volume += area * b.aspect * Math.sqrt(area);
		shares += b.share;
	}
	assert.ok(Math.abs(shares - 1) < 1e-9, tag + ' body shares sum to one');
	assert.ok(record.bodies.length >= row.bodies[0] && record.bodies.length <= row.bodies[1], tag + ' body count');
	const oreTonnes = volume * row.rho;
	assert.ok(Math.abs(oreTonnes / (record.sizeMt * 1e6) - 1) < 0.05,
		tag + ' the bodies carry the record tonnage: ' + oreTonnes + ' vs ' + record.sizeMt * 1e6);
	assert.ok(record.size <= row.ladder[4] && record.size >= row.ladder[0], tag + ' size inside the ladder');
	assert.equal(record.sizeClass, record.size < row.ladder[1] ? 'small'
		: record.size < row.ladder[2] ? 'medium' : record.size < row.ladder[3] ? 'large' : 'giant',
		tag + ' size class matches the percentile the size falls in');
	for (const metal of row.grades) {
		const value = record.grade[metal[0]];
		assert.ok(value >= metal[2] * 0.95 && value <= metal[3] * 1.05, tag + ' ' + metal[0] + ' grade inside the band: ' + value);
		const factor = metal[1] === '%' ? 0.01 : metal[1] === 'g/t' ? 1e-6 : 1;
		const exact = record.sizeMt * 1e6 * value * factor;
		assert.ok(Math.abs(record.contained[metal[0]] - exact) <= Math.abs(exact) * 5e-3 + 1e-9,
			tag + ' contained ' + metal[0] + ' is tonnage × grade');
	}
	assert.ok(record.top >= record.cover || row.hosted === 'sediment', tag + ' a basement body sits under its cover');
	assert.ok(record.potential >= Params.depositMin, tag + ' every record clears the deposit threshold');
	assert.ok(['ok', 'grade', 'size', 'depth'].indexOf(record.reason) >= 0, tag + ' names a screen leg');
	assert.equal(record.viable, record.reason === 'ok', tag + ' viability and reason agree');
}
// the deepest body of every record stays inside the crust that hosts it
for (const record of catalogue.records) {
	const o = world.owner[record.cell];
	const crust = world.hSed[o] + world.hFel[o] + world.hMaf[o];
	assert.ok(record.bottom <= crust + 1, record.kind + ' record bottom ' + record.bottom + ' inside crust ' + crust);
}
for (const row of Deposits.CLASSES) {
	assert.ok(seen[row.kind + '/' + row.variant] > 0, row.kind + '/' + row.variant + ' is reachable: ' + JSON.stringify(seen));
}

// 3. determinism: two builds of the same state are byte-identical, including array order.
world.frame++;
const dumpA = Deposits.json(world);
world.frame++;
const dumpB = Deposits.json(world);
assert.equal(dumpA, dumpB, 'two catalogue builds are byte-identical');
const parsed = JSON.parse(dumpA);
assert.equal(parsed.format, 'pgt-deposits');
assert.equal(parsed.version, 2);
assert.equal(parsed.classes.length, Deposits.CLASSES.length);
assert.equal(parsed.totals.records, catalogue.records.length);
assert.ok(parsed.totals.viable >= 0 && parsed.totals.viable <= parsed.totals.records);
assert.ok(parsed.deposits[0].id && parsed.deposits[0].bodies.length, 'a dumped record carries its bodies');
assert.equal(parsed.deposits[0].direction, undefined, 'the dump carries no internal scratch');
assert.equal(Deposits.viable(world).length, catalogue.viableCount, 'the viable filter agrees with the count');
const summary = Deposits.summary(world);
assert.equal(summary.records, catalogue.records.length);
assert.equal(summary.byKind.length, Deposits.KINDS.length);
for (const entry of summary.byKind) assert.ok(entry.top.length <= 10, 'the summary keeps the ten largest per kind');
function sumContained(records) {
	const totals = {};
	for (const record of records) for (const metal in record.contained)
		totals[metal] = (totals[metal] || 0) + record.contained[metal];
	return totals;
}
assert.deepEqual(summary.contained, sumContained(Deposits.viable(world)),
	'the summary total is the exact sum of viable records');
assert.deepEqual(summary.containedAll, sumContained(catalogue.records),
	'the all-record total is exact rather than rounded to three significant figures');
assert.deepEqual(parsed.totals.viableContained, summary.contained, 'the JSON viable total matches the summary');
assert.deepEqual(parsed.totals.contained, summary.containedAll, 'the JSON all-record total matches the summary');
const savedTime = world.t;
world.t = catalogue.time + 5;
assert.equal(Deposits.stale(world, catalogue), false, 'the snapshot is not stale at exactly five Myr');
world.t = catalogue.time + 5.001;
assert.equal(Deposits.stale(world, catalogue), true, 'staleness uses the exact snapshot time and a strict five-Myr boundary');
world.t = savedTime;
const exactTimeCatalogue = Deposits.build(world);
world.t += 0.01;
const nextTimeCatalogue = Deposits.build(world);
assert.notEqual(nextTimeCatalogue, exactTimeCatalogue, 'catalogue caching distinguishes times within one rounded epoch');
assert.equal(nextTimeCatalogue.time, world.t);
world.t = savedTime;
const filteredLedger = new Instruments.Ledger(world.grid.V);
const filteredRecord = catalogue.records[0];
filteredLedger.byId[filteredRecord.id] = { id: filteredRecord.id };
filteredLedger.cellsN = 1;
const filteredSummary = Deposits.summary(world, { catalogue: catalogue, ledger: filteredLedger, kind: filteredRecord.kind });
assert.equal(filteredSummary.records, 1, 'summary can be filtered to the records the session ledger found');
assert.equal(filteredSummary.viable, filteredRecord.viable ? 1 : 0);
assert.deepEqual(filteredSummary.contained, filteredRecord.viable ? filteredRecord.contained : {});
const filteredJson = JSON.parse(Deposits.json(world, {
	catalogue: catalogue, ledger: filteredLedger, kind: filteredRecord.kind
}));
assert.equal(filteredJson.deposits.length, 1, 'the v2 export can carry the same session filter');
assert.deepEqual(filteredJson.totals.viableContained, filteredSummary.contained);
const cacheHit = Deposits.build(world);
assert.strictEqual(Deposits.build(world), cacheHit, 'an unchanged state reuses its explicit catalogue');
const cachedViable = Deposits.build(world, { min: 'viable' });
assert.ok(Array.isArray(cachedViable) && cachedViable.every((record) => record.viable),
	'the cached minimum option still returns only viable records');
world.t += 0.1;
assert.notStrictEqual(Deposits.build(world), cacheHit, 'a changed epoch refreshes the catalogue stamp');
world.t -= 0.1;
const liveEpoch = Deposits.build(world);
world.reconEpoch = 250;
assert.notStrictEqual(Deposits.build(world), liveEpoch, 'a reconstruction scrub invalidates the same-frame catalogue');
world.reconEpoch = 0;
const liveMap = Deposits.build(world);
const oldSea = Params.sea;
Params.sea = 1200;
assert.notStrictEqual(Deposits.build(world), liveMap, 'a display sea-level change rebuilds water-depth fields');
Params.sea = oldSea;
Deposits.build(world);

// --- 6. variants: the context decides the commodity ------------------------------------
function column(options) {
	const g = new Grid(2, 23).build(), s = new State(g, 23);
	s.ckptCap = 0;
	Sim.raster(s);
	s.owner.fill(-1); s.alive.fill(0); s.cell.fill(-1);
	for (const name of Deposits.FIELDS) s[name].fill(0);
	const at = options.cell === undefined ? 0 : options.cell;
	s.alive[0] = 1; s.owner[at] = 0; s.cell[0] = at; s.plate[0] = 0;
	s.body.set(g.pos.subarray(at * 3, at * 3 + 3), 0);
	s.world.set(g.pos.subarray(at * 3, at * 3 + 3), 0);
	s.hFel[0] = options.fel === undefined ? 35000 : options.fel;
	s.hMaf[0] = options.maf === undefined ? 5000 : options.maf;
	s.hSed[0] = options.sed || 0;
	s.age[0] = options.age === undefined ? 100 : options.age;
	s.z[at] = options.z === undefined ? 500 : options.z;
	if (options.field) s[options.field][0] = options.value === undefined ? 0.9 : options.value;
	s.probeCell = at;
	return s;
}
const craton = column({ field: 'oMaf', fel: 48000, age: 900 });
assert.equal(Deposits.at(craton, 'mafic', 0).variant, 'diamond', 'a cratonic column yields diamonds');
const youngMafic = column({ field: 'oMaf', fel: 20000, age: 80 });
assert.equal(Deposits.at(youngMafic, 'mafic', 0).variant, 'sulfide', 'a young host yields Ni-Cu-PGE, not diamonds');
const islandArc = column({ field: 'oArc', fel: 2000, maf: 9000 });
assert.equal(Deposits.at(islandArc, 'arc', 0).variant, 'epithermal', 'a thin-crust island arc yields epithermal Au');
const continentalArc = column({ field: 'oArc', fel: 40000 });
assert.equal(Deposits.at(continentalArc, 'arc', 0).variant, 'porphyry', 'a continental arc yields porphyry Cu');
const coveredBelt = column({ field: 'oOro', sed: 900 });
assert.equal(Deposits.at(coveredBelt, 'orogenic', 0).variant, 'sedhost', 'a covered belt yields sediment-hosted Au');
const bareBelt = column({ field: 'oOro', sed: 100 });
assert.equal(Deposits.at(bareBelt, 'orogenic', 0).variant, 'vein', 'a bare belt yields quartz veins');

// A deep wet tropical basin can evaporate to potash and can never be a coal measure; the
// same potential on dry land is coal or uranium, never potash.
const equator = (function () {
	const g = new Grid(2, 23).build();
	let best = 0;
	for (let c = 0; c < g.V; c++) if (Math.abs(g.pos[c * 3 + 1]) < Math.abs(g.pos[best * 3 + 1])) best = c;
	return best;
}());
let potashSeen = 0, coalSeen = 0;
for (let shift = 0; shift < 12; shift++) {
	const wetBasin = column({ field: 'oBas', cell: equator, z: -900, fel: 0, maf: 7000, sed: 2000 + shift });
	wetBasin.body[0] += shift * 1e-4;
	wetBasin.world[0] = wetBasin.body[0];
	const record = Deposits.at(wetBasin, 'basin', equator);
	if (!record) continue;
	if (record.variant === 'potash') potashSeen++;
	if (record.variant === 'coal') coalSeen++;
}
assert.ok(potashSeen > 0, 'a wet low-latitude basin can evaporate to potash');
assert.equal(coalSeen, 0, 'a drowned basin never yields a coal measure');
const dryBasin = column({ field: 'oBas', z: 120, sed: 1500 });
assert.notEqual(Deposits.at(dryBasin, 'basin', 0).variant, 'potash', 'a dry basin is not an evaporite');

// --- 7. iron is derived, not stored ----------------------------------------------------
const bareOcean = column({ field: 'oMaf', fel: 500, maf: 8000, z: 200 });
assert.equal(Deposits.at(bareOcean, 'iron', 0).variant, 'algoma',
	'exposed mafic crust derives Algoma-type iron from oMaf');
const drowned = column({ field: 'oMaf', fel: 500, maf: 8000, z: -200 });
assert.equal(Deposits.at(drowned, 'iron', 0), null, 'submerged mafic crust is not an iron exposure');
const oldBasin = column({ field: 'oBas', sed: 2500, age: 900, z: 100 });
assert.equal(Deposits.at(oldBasin, 'iron', 0).variant, 'bif', 'an old thick basin carries Superior-type BIF');
assert.ok(Deposits.at(oldBasin, 'iron', 0).top < 500, 'BIF is the basin fill, not a body buried under it');
const youngBasin = column({ field: 'oBas', sed: 2500, age: 100, z: 100 });
assert.equal(Deposits.at(youngBasin, 'iron', 0), null, 'a young basin has no banded iron formation');
const thickFelsic = column({ field: 'oMaf', fel: 35000, sed: 0, age: 900, z: 500 });
assert.equal(Deposits.at(thickFelsic, 'iron', 0), null, 'thick felsic crust is not an iron host');
assert.equal(Deposits.blurAt(bareOcean, 'iron', 0), Deposits.blurAt(bareOcean, 'mafic', 0),
	'the derived field carries the parent class value');

// --- 8. viability: one synthetic record per failing leg ---------------------------------
const screens = Object.create(null);
for (const record of catalogue.records) screens[record.reason] = (screens[record.reason] || 0) + 1;
for (const reason of ['ok', 'grade', 'size', 'depth']) {
	assert.ok(screens[reason] > 0, 'the screen rejects on ' + reason + ' somewhere: ' + JSON.stringify(screens));
}
for (const record of catalogue.records) {
	const row = Deposits.CLASSES.find((r) => r.kind === record.kind && r.variant === record.variant);
	const principal = row.grades.length ? record.grade[row.grades[0][0]] : 0;
	if (record.reason === 'size') assert.ok(record.size < row.minSize || (row.minContained
		&& record.contained[row.grades[0][0]] < row.minContained), 'a size rejection is a size rejection');
	if (record.reason === 'depth') {
		assert.ok(record.top > row.maxTop, 'a depth rejection is below the class mining depth');
		assert.ok(row.screen.type !== 'grade' || principal >= row.screen.cutOff, 'and it passed grade first');
	}
	if (record.viable && row.screen.type === 'grade') assert.ok(principal >= row.screen.cutOff, 'a viable record clears its cut-off');
	if (record.viable) assert.ok(record.size >= row.minSize && record.top <= row.maxTop, 'and its size and depth screens');
}

// --- 9. local stays local: a click never pays for the planet ----------------------------
const spyWorld = garden();
const realPeaks = Extract.peaks;
let scans = 0;
Extract.peaks = function (...args) { scans++; return realPeaks.apply(Extract, args); };
Deposits.at(spyWorld, 'arc', 0);
const ledger = new Instruments.Ledger(spyWorld.grid.V);
Instruments.survey(spyWorld, 0, ['obs', 'geo', 'mag', 'gpr', 'd500', 'd5k', 'lab'], ledger);
assert.equal(scans, 0, 'neither a local record query nor a full instrument survey scans the world');
Deposits.build(spyWorld);
assert.equal(scans, Deposits.KINDS.length, 'only the explicit build scans, once per kind');
Extract.peaks = realPeaks;

// --- the catalogue is a read-only view: it never touches checkpointed state --------------
const untouched = garden();
const before = Checkpoint.save(untouched);
Deposits.build(untouched);
Instruments.survey(untouched, 0, ['d5k'], new Instruments.Ledger(untouched.grid.V));
assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(Checkpoint.save(untouched))), 0,
	'building the catalogue and surveying change no checkpointed byte');

// --- the explicit build stays inside its budget -------------------------------------------
const timed = new State(new Grid(5, 7).build(), 7, true);
timed.ckptCap = 0;
Sim.raster(timed);
Sim.advance(timed, 0.1, 200);
Deposits.release();
const t0 = Date.now();
Deposits.build(timed);
const buildMs = Date.now() - t0;
assert.ok(buildMs < 250, 'the L5 catalogue build stays inside its budget: ' + buildMs + ' ms');
timed.frame++;
const t1 = Date.now();
Deposits.build(timed);
assert.ok(Date.now() - t1 <= buildMs + 50, 'a rebuild is not slower than the first build');
Deposits.release();

console.log('PASS deposits: quantized potential, physical anchor identity, stable depth, thresholded'
	+ ' local peaks, the Earth-anchored class table, body geometry, contained metal, viability,'
	+ ' derived iron, a local click that never scans, and an L5 build in ' + buildMs + ' ms');

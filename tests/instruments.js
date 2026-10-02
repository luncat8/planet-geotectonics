const { assert, Grid, State, Sim } = require('./helpers.js');
const Deposits = require('../js/deposits.js');
const Instruments = require('../js/instruments.js');
const Checkpoint = require('../js/checkpoint.js');

const grid = new Grid(3, 7).build();
function site(field, value, options = {}) {
	const s = new State(grid, 7);
	s.ckptCap = 0;
	Sim.raster(s);
	s.owner.fill(-1);
	s.alive.fill(0);
	s.cell.fill(-1);
	s.hFel.fill(0); s.hMaf.fill(0); s.hSed.fill(0); s.age.fill(0); s.damage.fill(0);
	for (const name of Deposits.FIELDS) s[name].fill(0);
	s.world.fill(0);
	s.z.fill(NaN); s.mobile.fill(0); s.mobilePla.fill(0); s.low.fill(-1); s.belt.fill(0);
	const cell = options.cell === undefined ? 0 : options.cell;
	s.alive[0] = 1;
	s.owner[cell] = 0;
	s.cell[0] = cell;
	s.body.set(grid.pos.subarray(cell * 3, cell * 3 + 3), 0);
	s.world.set(grid.pos.subarray(cell * 3, cell * 3 + 3), 0);
	s.plate[0] = 0;
	s.hFel[0] = options.fel === undefined ? 35000 : options.fel;
	s.hMaf[0] = options.maf === undefined ? 5000 : options.maf;
	s.hSed[0] = options.sediment || 0;
	s.age[0] = 312;
	s.z[cell] = options.elevation === undefined ? 500 : options.elevation;
	s[field][0] = value;
	s.mobile[cell] = options.mobile === undefined ? 10 : options.mobile;
	s.mobilePla[cell] = options.placerLoad || 0;
	return s;
}
function selectLedger(s) { return new Instruments.Ledger(s.grid.V); }

const instrumentIds = Instruments.LIST.map((instrument) => instrument.id);
assert.deepEqual(instrumentIds, ['obs', 'geo', 'mag', 'gpr', 'd500', 'd5k', 'lab']);
const emptyWorld = site('oVms', 1);
assert.equal(Instruments.survey(emptyWorld, 0, [], selectLedger(emptyWorld)).ok, false,
	'an empty instrument set makes no discovery');

// Noise is keyed by seed, class, physical anchor and instrument - not by the clock or cell.
const noiseWorld = site('oVms', 0.95);
const noiseRecord = Deposits.at(noiseWorld, 'vms', 0);
const noise0 = Instruments.noise(noiseWorld.seed, noiseRecord, 2);
assert.equal(noise0, Instruments.noise(noiseWorld.seed, noiseRecord, 2));
noiseWorld.t = 25; noiseWorld.frame = 250;
assert.equal(noise0, Instruments.noise(noiseWorld.seed, noiseRecord, 2), 'noise does not use time');
assert.notEqual(noise0, Instruments.noise(noiseWorld.seed, noiseRecord, 3), 'instruments have distinct noise');
assert.notEqual(noise0, Instruments.noise(noiseWorld.seed, {
	kindIndex: noiseRecord.kindIndex, anchorKey: [noiseRecord.anchorKey[0] + 7, noiseRecord.anchorKey[1], noiseRecord.anchorKey[2]]
}, 2), 'separate anchors do not share noise');

// One-cell survey only: no whole-world scan or simulation mutation, with quantized reports.
const shallow = site('oPla', 0.2);
const shallowLedger = selectLedger(shallow);
const before = Checkpoint.save(shallow);
const weak = Instruments.survey(shallow, 0, ['obs'], shallowLedger);
assert.equal(weak.ledger.cellsN, 1);
assert.equal(weak.found.length, 0, 'sub-threshold anomaly is a reading, not a deposit');
assert.ok(weak.readings[0].values[5] >= Deposits.TRACE_MIN, 'weak surface signal remains measurable');
assert.match(Instruments.report(weak), /no deposits detected/);
assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(Checkpoint.save(shallow))), 0,
	'a survey changes only its session ledger, never checkpointed world state');

const exposed = site('oPla', 0.95, { elevation: 500, sediment: 0, placerLoad: 0.04 });
const exposedLedger = selectLedger(exposed);
const observation = Instruments.survey(exposed, 0, ['obs'], exposedLedger);
assert.equal(observation.found.length, 1, 'field observation sees a shallow exposed placer');
assert.equal(observation.found[0].entry.confidence, 1);
assert.match(Instruments.report(observation), /obs  clicked column exposed/);
assert.match(Instruments.report(observation), /inferred/);
const buriedOutcrop = site('oPla', 0.95, { elevation: 500, sediment: 6 });
const buriedObservation = Instruments.survey(buriedOutcrop, 0, ['obs'], selectLedger(buriedOutcrop));
assert.equal(buriedObservation.found.length, 0, 'observation does not work through more than five metres of cover');
assert.match(Instruments.report(buriedObservation), /obs  clicked column covered/);

// Geochemistry follows reverse drainage: a deposit upstream of the clicked stream cell is
// diluted into its loaded catchment; a cell on another branch cannot see it.
let source = -1, outlet = -1;
for (let c = 0; c < grid.V && source < 0; c++) {
	for (let k = 0; k < grid.ringN[c]; k++) {
		const j = grid.ring[c * 6 + k];
		if (c < j) { source = c; outlet = j; break; }
	}
}
assert.ok(source >= 0 && outlet > source, 'a deterministic adjacent source/outlet pair exists');
const nearbyOutcrop = site('oPla', 0.95, { cell: source, elevation: 500 });
assert.equal(Instruments.survey(nearbyOutcrop, outlet, ['obs'], selectLedger(nearbyOutcrop)).found.length, 1,
	'field observation senses one ring away');
assert.equal(Instruments.survey(nearbyOutcrop, outlet, ['d500'], selectLedger(nearbyOutcrop)).found.length, 0,
	'a drill remains confined to the clicked cell');
const radarWorld = site('oPla', 0.95, { sediment: 800 });
assert.equal(Instruments.survey(radarWorld, 0, ['gpr'], selectLedger(radarWorld)).found.length, 1,
	'ground radar reads a shallow placer through sediment cover');
const drainage = site('oVms', 1, { cell: source, mobile: 10 });
drainage.alive[1] = 1;
drainage.owner[outlet] = 1;
drainage.cell[1] = outlet;
drainage.body.set(grid.pos.subarray(outlet * 3, outlet * 3 + 3), 3);
drainage.world.set(grid.pos.subarray(outlet * 3, outlet * 3 + 3), 3);
drainage.plate[1] = 0;
drainage.hFel[1] = 35000;
drainage.hMaf[1] = 5000;
drainage.age[1] = 312;
drainage.z[outlet] = 500;
drainage.mobile[outlet] = 1;
drainage.low[source] = outlet;
assert.ok(Deposits.at(drainage, 'vms', source), 'the source is the deterministic local maximum');
const downstream = Instruments.survey(drainage, outlet, ['geo'], selectLedger(drainage));
assert.equal(downstream.found.length, 1, 'a downstream sample detects its loaded upstream source');
const other = [0, 1, 2, 3, 4, 5].find((c) => c !== source && c !== outlet && drainage.low[c] < 0);
const unrelated = Instruments.survey(drainage, other, ['geo'], selectLedger(drainage));
assert.equal(unrelated.found.length, 0, 'geochemistry does not search unrelated cells');

// A 500 m hole cannot reach an 800 m-deep top; the 5 km hole can. Drilling raises confidence
// to measured, while two distinct remote tools only raise it to indicated.
const covered = site('oVms', 1, { sediment: 800 });
const coveredLedger = selectLedger(covered);
const shallowHole = Instruments.survey(covered, 0, ['d500'], coveredLedger);
assert.equal(shallowHole.found.length, 0, 'the 500 m drill misses the buried record');
const deepHole = Instruments.survey(covered, 0, ['d5k'], coveredLedger);
assert.equal(deepHole.found.length, 1, 'the 5 km drill intersects it');
assert.equal(deepHole.found[0].entry.confidence, 3, 'a drill intersection is measured');
assert.match(Instruments.report(deepHole), /assay pending/);
const labMeasured = Instruments.survey(covered, 0, ['lab'], coveredLedger);
assert.equal(labMeasured.found[0].entry.confidence, 3, 'lab cannot promote or demote a measured record');

const remote = site('oVms', 1);
const remoteLedger = selectLedger(remote);
const remoteResult = Instruments.survey(remote, 0, ['geo', 'mag'], remoteLedger);
assert.equal(remoteResult.found.length, 1);
assert.equal(remoteResult.found[0].entry.confidence, 2, 'two independent instruments are indicated');
assert.equal(remoteResult.readings[1].magneticIndex, 1, 'magnetics expose a normalized anomaly index');
assert.ok(remoteResult.readings[1].depthToSource >= 0 && remoteResult.readings[1].depthToSource % 250 === 0,
	'magnetic source depth is reported in 250 m buckets only after detection');
assert.match(Instruments.report(remoteResult), /magnetic index 1\.00/);
const weakMag = site('oVms', 0.31);
weakMag.seed = 0;
const weakMagResult = Instruments.survey(weakMag, 0, ['mag'], selectLedger(weakMag));
assert.equal(weakMagResult.found.length, 0, 'a weak source can stay below deterministic noise');
assert.equal(weakMagResult.readings[0].depthToSource, -1, 'an undetected source has no resolved depth');
const noNewDiscovery = site('oPla', 1);
const labOnly = Instruments.survey(noNewDiscovery, 0, ['lab'], selectLedger(noNewDiscovery));
assert.equal(labOnly.found.length, 0, 'lab alone cannot discover a record');
assert.match(Instruments.report(labOnly), /no previously found sample/);
const refined = Instruments.survey(exposed, 0, ['lab'], exposedLedger);
assert.equal(refined.found[0].entry.confidence, 2, 'lab refines an inferred record by one step');
assert.equal(refined.found[0].entry.confidence, 2, 'lab never promotes a record to measured');

// Stable session history: evidence survives an undetectable-but-above-floor interval, and is
// retired only below the hysteresis floor. A merge-like anchor rewrite re-associates nearby.
const ledgerWorld = site('oVms', 1);
const ledger = selectLedger(ledgerWorld);
Instruments.survey(ledgerWorld, 0, ['d5k'], ledger);
ledgerWorld.oVms[0] = 0.25;
const retained = Instruments.survey(ledgerWorld, 0, ['d5k'], ledger);
assert.equal(ledger.found.length, 1, 'a record above the hysteresis floor stays in the ledger');
assert.ok(retained.found[0].stale, 'the panel marks a retained discovery as stale');
ledgerWorld.oVms[0] = 0.1;
Instruments.survey(ledgerWorld, 0, ['d5k'], ledger);
assert.equal(ledger.found.length, 0, 'a record below the hysteresis floor is retired');

const movedWorld = site('oVms', 1);
const movedLedger = selectLedger(movedWorld);
const initial = Instruments.survey(movedWorld, 0, ['d5k'], movedLedger);
const oldId = initial.found[0].entry.id, confidence = initial.found[0].entry.confidence;
const x = movedWorld.body[0] + 0.0002, y = movedWorld.body[1], z = movedWorld.body[2];
const norm = Math.hypot(x, y, z);
movedWorld.body[0] = x / norm; movedWorld.body[1] = y / norm; movedWorld.body[2] = z / norm;
const rebased = Instruments.survey(movedWorld, 0, ['d5k'], movedLedger);
assert.notEqual(rebased.found[0].entry.id, oldId, 'the rewritten anchor gets its new stable id');
assert.equal(movedLedger.found.length, 1, 'reassociation does not duplicate the session record');
assert.equal(rebased.found[0].entry.confidence, confidence, 'confidence carries across a nearby rebase');

// Coverage is an OR of tools on one unique cell, and hover has no path into this module.
assert.equal(remoteLedger.cellsN, 1);
assert.equal(remoteLedger.coverage[0], (1 << 1) | (1 << 2));
assert.equal(remoteLedger.calls, 1);

console.log('PASS instruments: local footprints, deterministic noise, reach/cover, evidence ladder, lab, hysteresis, rebase and session-only state');

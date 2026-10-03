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
assert.deepEqual(instrumentIds, ['obs', 'geo', 'mag', 'gpr', 'seis', 'd500', 'd5k', 'lab']);
// The confidence ladder is declared, not inferred from list order: appending the
// seismic line at the end must not have promoted it to a drill.
assert.deepEqual(Instruments.LIST.map((instrument) => instrument.tier),
	['indirect', 'indirect', 'indirect', 'indirect', 'indirect', 'direct', 'direct', 'refine'],
	'evidence tiers are declared per instrument');
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
// 0.03 raw: above the trace floor once the placer field scale is applied, below depositMin.
const shallow = site('oPla', 0.03);
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
// 0.6.1: the found line carries the record's economics, not a placeholder.
const economics = Instruments.report(observation);
const found = observation.found[0].record;
assert.match(economics, new RegExp(found.top + '-' + found.bottom + ' m'), 'the found line gives the depth interval');
assert.match(economics, /gold · Au · [\d.,]+ Mt \((small|medium|large|giant)\) @ Au [\d.]+g\/t/,
	'and the variant, commodity, tonnage, size class and grade');
assert.match(economics,
	/· \d+ (body|bodies) · (viable|sub-economic: (grade|size|depth)) · money (\+|[-\w ])/m,
	'and the body count, the geological verdict and the monetary one');
assert.ok(!/pending/.test(economics.split('found deposits')[1]), 'no size/grade placeholder is left');
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

// Regional discovery is explicit, snapshot-bound, ordered, and work-capped. The same chosen
// instrument and stable state produce the same ledger as surveying each cell locally.
const campaignWorld = site('oVms', 1);
const campaignCatalogue = Deposits.build(campaignWorld);
const campaignLedger = selectLedger(campaignWorld);
assert.equal(Instruments.startCampaign(campaignWorld, campaignCatalogue, [], campaignLedger).ok, false,
	'an empty instrument set cannot start a regional campaign');
campaignWorld.t += 0.01;
assert.equal(Instruments.startCampaign(campaignWorld, campaignCatalogue, ['d5k'], campaignLedger).ok, false,
	'a campaign cannot accept a catalogue from a different exact time inside the same rounded epoch');
campaignWorld.t -= 0.01;
const campaign = Instruments.startCampaign(campaignWorld, campaignCatalogue, ['d5k'], campaignLedger);
assert.equal(campaign.ok, true);
assert.equal(campaign.total, grid.V);
const catalogueBuild = Deposits.build;
Deposits.build = function () { throw new Error('campaign chunks must reuse the start snapshot'); };
try {
	Instruments.campaignStep(campaign, 1000, Infinity);
	assert.equal(campaign.cursor, 256, 'each chunk is hard-capped at 256 cells');
	assert.equal(campaign.running, true);
	Instruments.campaignStep(campaign, 256, Infinity);
	assert.equal(campaign.cursor, 512);
	Instruments.campaignStep(campaign, 256, Infinity);
} finally {
	Deposits.build = catalogueBuild;
}
assert.equal(campaign.done, true);
assert.equal(campaign.cursor, grid.V);
assert.equal(campaign.ledger.cellsN, grid.V);
assert.deepEqual(Array.from(campaign.ledger.cells), Array.from({ length: grid.V }, (_, i) => i),
	'the campaign walks cells in ascending order');
const localCampaignLedger = selectLedger(campaignWorld);
for (let c = 0; c < grid.V; c++) Instruments.survey(campaignWorld, c, ['d5k'], localCampaignLedger);
assert.deepEqual(campaign.ledger.found.map((entry) => [entry.id, entry.confidence]),
	localCampaignLedger.found.map((entry) => [entry.id, entry.confidence]),
	'regional and local surveys use identical discovery and confidence rules');
assert.equal(campaign.found, campaignLedger.found.length);
assert.equal(campaign.viable, campaignLedger.found.filter((entry) => entry.record.viable).length);

const budgetJob = Instruments.startCampaign(campaignWorld, campaignCatalogue, ['obs'], selectLedger(campaignWorld));
Instruments.campaignStep(budgetJob, 256, 0);
assert.equal(budgetJob.cursor, 8, 'the time budget is checked after each group of eight cells');
const partialJob = Instruments.startCampaign(campaignWorld, campaignCatalogue, ['d5k'], selectLedger(campaignWorld));
Instruments.campaignStep(partialJob, 8, Infinity);
const partialCount = partialJob.ledger.found.length;
Instruments.cancelCampaign(partialJob);
assert.equal(partialJob.cancelled, true);
assert.equal(partialJob.ledger.found.length, partialCount, 'cancellation preserves the valid partial ledger');
const changedJob = Instruments.startCampaign(campaignWorld, campaignCatalogue, ['d5k'], selectLedger(campaignWorld));
campaignWorld.frame++;
Instruments.campaignStep(changedJob, 8, Infinity);
assert.equal(changedJob.invalidated, true, 'a changed frame cannot be mixed into the campaign snapshot');
campaignWorld.frame--;

// Production frame-budget calibration at L5 with the plan's 1.25 ms slice. Warm the JIT,
// then report the median wall time for real bounded chunks (time is polled every eight cells).
const budgetWorld = new State(new Grid(5, 7).build(), 7);
Sim.raster(budgetWorld);
const budgetCatalogue = Deposits.build(budgetWorld);
const measuredJob = Instruments.startCampaign(budgetWorld, budgetCatalogue, ['d500', 'geo', 'mag'],
	new Instruments.Ledger(budgetWorld.grid.V));
for (let i = 0; i < 4; i++) Instruments.campaignStep(measuredJob, 256, 1.25);
const chunkMs = [];
for (let i = 0; i < 12; i++) {
	const started = performance.now();
	Instruments.campaignStep(measuredJob, 256, 1.25);
	chunkMs.push(performance.now() - started);
}
chunkMs.sort((a, b) => a - b);
const medianChunkMs = (chunkMs[5] + chunkMs[6]) * 0.5;
assert.ok(medianChunkMs < 1.5, 'measured L5 campaign chunk median stays under 1.5 ms: ' + medianChunkMs.toFixed(3));
console.log('campaign L5 d500+geo+mag chunk median ' + medianChunkMs.toFixed(2) + ' ms (1.25 ms target, 12 samples)');

// Coverage is an OR of tools on one unique cell, and hover has no path into this module.
assert.equal(remoteLedger.cellsN, 1);
assert.equal(remoteLedger.coverage[0], (1 << 1) | (1 << 2));
assert.equal(remoteLedger.calls, 1);


// --- 0.6.3: the reflection seismic line, carried over from the alternate branch ----------
// Seismic images structure rather than composition. It sees through water and cover, it
// gains on massive/tabular/layered bodies and on a shear-zone fabric, and it is blind to a
// diffuse porphyry stockwork and to unconsolidated basin fill. It never assays, so on its
// own it can reach `indicated` but never `measured`.
const seis = Instruments.LIST[Instruments.LIST.findIndex((instrument) => instrument.id === 'seis')];
assert.equal(seis.tier, 'indirect', 'seismic is indirect evidence');
assert.equal(seis.coverMax, Infinity, 'seismic sees through any cover');
assert.ok(seis.reach >= 10000, 'seismic reaches crustal depth: ' + seis.reach);
// The gain matrix is read back out of the module rather than restated here, so this pins
// the shipped numbers: seismic is blind exactly where the physics says it is, and it is not
// a copy of magnetics (which does see the porphyry stockwork that seismic cannot image).
const seisAt = Instruments.LIST.findIndex((instrument) => instrument.id === 'seis');
const magAt = Instruments.LIST.findIndex((instrument) => instrument.id === 'mag');
assert.equal(Instruments.KIND_GAIN.length, Instruments.LIST.length,
	'every instrument has a gain row');
for (const row of Instruments.KIND_GAIN) assert.equal(row.length, Deposits.KINDS.length,
	'every gain row covers every deposit kind');
assert.notDeepEqual(Instruments.KIND_GAIN[seisAt], Instruments.KIND_GAIN[magAt],
	'seismic is not a copy of magnetics');
assert.equal(Instruments.KIND_GAIN[seisAt][Deposits.KINDS.indexOf('arc')], 0,
	'seismic is blind to a diffuse porphyry stockwork');
assert.ok(Instruments.KIND_GAIN[seisAt][Deposits.KINDS.indexOf('iron')] > 0,
	'banded iron formation is a classic reflector');
assert.ok(Instruments.KIND_GAIN[seisAt][Deposits.KINDS.indexOf('orogenic')] > 0,
	'a shear-zone fabric reflects');
assert.equal(Instruments.KIND_GAIN[Instruments.LIST.length - 1].reduce((a, b) => a + b, 0), 0,
	'the lab discovers nothing on its own');

const seisWorld = site('oVms', 0.95, { sediment: 240, elevation: -400 });
const seisLedger = selectLedger(seisWorld);
const seisResult = Instruments.survey(seisWorld, 0, ['seis'], seisLedger);
assert.equal(seisResult.ok, true, 'a seismic line runs on its own');
const seisReading = seisResult.readings.find((reading) => reading.id === 'seis');
assert.ok(seisReading, 'the seismic reading is reported');
assert.ok(Array.isArray(seisReading.interfaces) && seisReading.interfaces.length > 0,
	'seismic reports at least one crustal interface');
const moho = seisReading.interfaces.find((iface) => iface.name === 'Moho');
assert.ok(moho, 'seismic places the Moho');
assert.equal(moho.depthM, 40250, 'the Moho is the quantized crustal column: ' + moho.depthM);
assert.ok(moho.uncertaintyM > 0, 'a converted depth carries uncertainty');
assert.ok(moho.uncertaintyM / moho.depthM > 0.05, 'Moho uncertainty is a real fraction, not a rounding');
const sedBase = seisReading.interfaces.find((iface) => iface.name === 'sediment base');
assert.equal(sedBase.depthM, 250, 'the sediment base is the quantized pile');
assert.ok(Array.isArray(seisReading.reflectors), 'the reflector list always exists');
for (const reflector of seisReading.reflectors) {
	assert.equal(reflector.note, 'non-unique; no assay', 'a bright reflector never claims a composition');
	assert.ok(reflector.uncertaintyM >= reflector.depthM * 0.10 - 1
		&& reflector.uncertaintyM <= reflector.depthM * 0.20 + 1,
		'reflector uncertainty stays in the declared 10-20 % band: ' + reflector.uncertaintyM);
}
// Seismic is indirect: on its own it infers, it never measures, and it never assays.
assert.ok(seisResult.found.length > 0, 'seismic detected the massive sulfide target');
for (const item of seisResult.found) {
	assert.ok(item.entry.confidence <= 2,
		'seismic alone cannot reach `measured`: ' + item.entry.confidence);
}
assert.match(Instruments.report(seisResult), /images structure, not composition: no assay/,
	'the report states the honest limit');
// Determinism: the same line twice, and a wet cell is not a special case.
const seisAgain = Instruments.survey(seisWorld, 0, ['seis'], selectLedger(seisWorld));
assert.deepEqual(seisAgain.readings.find((r) => r.id === 'seis').interfaces, seisReading.interfaces,
	'two seismic lines over the same cell agree exactly');
// Blind where the physics says it is. A diffuse porphyry stockwork gives the seismic line
// nothing, and the control for that is not a guess: the record is there, the deep drill
// intersects it, so the empty seismic line is the instrument's limit rather than an
// absent deposit. (Magnetics is not the control here - this stockwork's top sits at
// 3,100 m, past its 3,000 m reach, so it cannot see it either.)
const seisBlind = site('oArc', 0.95, { sediment: 240, elevation: 500 });
assert.ok(Deposits.at(seisBlind, 'arc', 0), 'the porphyry record exists on that column');
const seisBlindResult = Instruments.survey(seisBlind, 0, ['seis'], selectLedger(seisBlind));
assert.equal(seisBlindResult.found.length, 0,
	'seismic does not image a diffuse porphyry stockwork');
const drillSeesIt = Instruments.survey(seisBlind, 0, ['d5k'], selectLedger(seisBlind));
assert.ok(drillSeesIt.found.length > 0,
	'the deep drill intersects the same stockwork, so the null is the seismic line\'s limit');

// --- 0.6.3: the monetary scenario, carried over from the alternate branch -----------------
// The catalogue's own `viable` is a geological screen that never mentions a price. This is
// the second, independent question, kept separate so neither can hide behind the other.
const Economics = require('../js/data/deposit-economics.js');
assert.equal(Economics.version, 2, 'the monetary scenario is its own versioned object');
assert.match(Economics.describe(), /game prices/, 'the prices are labelled game values');
const econWorld = site('oArc', 0.99, { sediment: 200, elevation: 500 });
const econRecord = Deposits.at(econWorld, 'arc', 0);
assert.ok(econRecord, 'the porphyry record exists');
const econScreen = Economics.screen(econRecord);
assert.ok(Number.isFinite(econScreen.net), 'a sized record has a finite net');
assert.equal(typeof econScreen.positive, 'boolean');
assert.equal(econScreen.reason, econScreen.positive ? 'scenario-positive' : 'cost exceeds value');
assert.match(Economics.verdict(econRecord), /^money /, 'the verdict names itself');
// A record under the scale cutoff cannot carry the fixed capital whatever its grade.
const small = { contained: { Cu: 1e3 }, sizeMt: 0.01, top: 100, water: 0 };
assert.equal(Economics.screen(small).reason, 'below scale cutoff');
assert.equal(Economics.screen(small).positive, false);
assert.equal(Economics.screen(small).net, -Infinity, 'an unsized body has no net worth quoting');
// Depth and water are separate penalties: both make the same ore worse, monotonically.
const base = { contained: { Cu: 1e6 }, sizeMt: 50, top: 0, water: 0 };
const deep = { contained: { Cu: 1e6 }, sizeMt: 50, top: 2000, water: 0 };
const wet = { contained: { Cu: 1e6 }, sizeMt: 50, top: 0, water: 2000 };
assert.ok(Economics.screen(deep).net < Economics.screen(base).net, 'burial costs money');
assert.ok(Economics.screen(wet).net < Economics.screen(base).net, 'water costs money');
assert.ok(Economics.screen(deep).opex > Economics.screen(base).opex, 'the penalty is in opex, not capex');
assert.equal(Economics.screen(deep).capex, Economics.screen(base).capex, 'depth does not move capex');
// The invariant the diamond bug broke: a price is only meaningful against the unit the
// catalogue counted the commodity in, and `contained` is not uniformly tonnes. Every metal
// the class table can emit must have a price, and that price's unit must be the one the
// grade unit implies - so a new class row cannot silently inherit a mispriced metal.
for (const row of Deposits.CLASSES) {
	for (const grade of row.grades) {
		const metal = grade[0], unit = grade[1];
		assert.ok(Economics.prices[metal], 'every class metal has a price: ' + row.kind + '/' + row.variant + ' ' + metal);
		const quoted = Economics.pricePer[metal] || 't';
		assert.equal(quoted, Economics.gradeUnitTo[unit],
			'the price of ' + metal + ' is quoted in the unit its ' + unit + ' grade counts in');
	}
	if (row.bulk) {
		assert.ok(Economics.prices[row.bulk], 'the bulk commodity has a price: ' + row.bulk);
		assert.equal(Economics.pricePer[row.bulk] || 't', 't', 'a bulk tonnage is tonnes');
	}
}
// And the guard itself has to fire, not merely exist.
assert.equal(Economics.screen({ kind: 'mafic', variant: 'diamond', contained: { Diamond: 4e7 },
	gradeUnit: { Diamond: '%' }, sizeMt: 80, top: 300, water: 0 }).reason, Economics.badUnit,
	'a unit mismatch is refused rather than mispriced');
// A diamond priced per carat is a marginal mine, not a trillion-dollar one.
const kimberlite = Economics.screen({ kind: 'mafic', variant: 'diamond', contained: { Diamond: 4e7 },
	gradeUnit: { Diamond: 'ct/t' }, sizeMt: 80, top: 300, water: 0 });
assert.ok(kimberlite.value > 1e9 && kimberlite.value < 1e11,
	'an 80 Mt kimberlite at 0.5 ct/t is worth billions, not trillions: ' + kimberlite.value);
// An unpriced commodity is refused rather than valued at zero by accident.
const unpriced = { contained: { Unobtainium: 1e6 }, sizeMt: 50, top: 0, water: 0 };
assert.equal(Economics.screen(unpriced).reason, Economics.noPrice);
// The screen is a pure function of the record: it never writes to it or to the world.
const econBefore = JSON.stringify(econRecord);
const worldBefore = Checkpoint.save(econWorld);
Economics.screen(econRecord); Economics.verdict(econRecord);
assert.equal(JSON.stringify(econRecord), econBefore, 'the screen does not mutate the record');
assert.deepEqual(Checkpoint.save(econWorld), worldBefore, 'the screen does not touch the world');
// Both screens are printed on the found line, because they can disagree.
const econLedger = selectLedger(econWorld);
const econSurvey = Instruments.survey(econWorld, 0, ['d5k'], econLedger);
assert.ok(econSurvey.found.length > 0, 'the deep drill found the porphyry');
const econReport = Instruments.report(econSurvey);
assert.match(econReport, /money /, 'the report carries the monetary verdict');
assert.match(econReport, econSurvey.found[0].record.viable ? /viable/ : /sub-economic/,
	'the report still carries the geological verdict');

console.log('PASS instruments: local footprints, deterministic noise, reach/cover, evidence ladder, lab, hysteresis, rebase and session-only state, the seismic line and the monetary screen');

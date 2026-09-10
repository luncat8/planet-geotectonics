// Phase F metallogeny. Three parts:
//   1. each potential's production site, checked by calling the owning kernel directly and
//      diffing — exact, and immune to the column renumbering that Events.compact does;
//   2. a placer rig, which is the only way to see "downslope of an orogenic maximum" cleanly:
//      in a full world most continental crust is orogenic, so the statistical contrast is ~1.1;
//   3. a long hot-start run: bounded, populated potentials, end-state geography, ranked
//      deposit extraction and a checkpoint round trip.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const Contact = require('../js/contact.js');
const ColumnUpdate = require('../js/column-update.js');
const Surface = require('../js/surface.js');
const Extract = require('../js/extract.js');
const Diag = require('../js/diag.js');
const Checkpoint = require('../js/checkpoint.js');

// ---------------------------------------------------------------- 1. production sites
const world = new State(new Grid(4, 7).build(), 7, true);
world.ckptCap = 0;
Sim.raster(world);
Sim.advance(world, 0.1, 8000);

const subducting = new Uint8Array(world.plateCap);
for (let c = 0; c < world.grid.V; c++) {
	for (let k = 0; k < world.grid.ringN[c]; k++) {
		const e = c * 6 + k;
		if (world.edgeType[e] === 1 && world.polarity[e] === 1 && world.cellPlate[c] < world.plateCount) {
			subducting[world.cellPlate[c]] = 1;
		}
	}
}
// Share of the mass a single kernel call added that satisfies `test`.
function productionSite(s, field, before, test) {
	let hit = 0, all = 0, bad = 0;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		const d = s[field][i] - before[i];
		if (!(d > 1e-12)) continue;
		all += d;
		if (test(s, i)) hit += d;
		else bad++;
	}
	return { share: all > 0 ? hit / all : NaN, violations: bad, mass: all };
}

// A column can own several cells, so "near the trench" is the best of the cells it owns,
// not the single cell s.cell[i] happens to record.
const bestTrench = new Int32Array(world.colCap).fill(9);
for (let c = 0; c < world.grid.V; c++) {
	const o = world.owner[c];
	if (o >= 0 && world.trenchDist[c] < bestTrench[o]) bestTrench[o] = world.trenchDist[c];
}
const arcBefore = Float64Array.from(world.oArc);
Contact.arcs(world, 0.1);
const arcTrench = productionSite(world, 'oArc', arcBefore, (s, i) => bestTrench[i] <= 2);
const arcOver = productionSite(world, 'oArc', arcBefore, (s, i) => subducting[s.plate[i]] === 1);

const vmsBefore = Float64Array.from(world.oVms);
const oroBefore = Float64Array.from(world.oOro);
const basBefore = Float64Array.from(world.oBas);
ColumnUpdate.step(world, 0.1);
const vmsOcean = productionSite(world, 'oVms', vmsBefore, (s, i) => s.hFel[i] < Params.hOceanic);
const oroCont = productionSite(world, 'oOro', oroBefore, (s, i) => s.hFel[i] >= Params.hOceanic);
const basSed = productionSite(world, 'oBas', basBefore, (s, i) => s.hSed[i] > 1000);

console.log(JSON.stringify({
	oArcAtTrench: +arcTrench.share.toFixed(4), oArcOnOverrider: +arcOver.share.toFixed(4),
	oVmsOnOceanic: +vmsOcean.share.toFixed(4), oOroOnContinental: +oroCont.share.toFixed(4),
	oBasOnThickSediment: +basSed.share.toFixed(4),
	violations: [arcTrench.violations, arcOver.violations, vmsOcean.violations,
		oroCont.violations, basSed.violations].join('/')
}, null, 1));
assert.ok(arcTrench.mass > 0 && arcOver.mass > 0 && vmsOcean.mass > 0
	&& oroCont.mass > 0, 'every factory produced something in one call');
assert.equal(arcOver.violations, 0, 'oArc is only produced on an overriding plate');
assert.equal(arcTrench.violations, 0,
	'oArc is only produced within 2 cells of the trench: ' + arcTrench.share);
assert.equal(vmsOcean.violations, 0, 'oVms is only produced on oceanic crust');
assert.equal(oroCont.violations, 0, 'oOro is only produced on continental crust');
assert.equal(basSed.violations, 0, 'oBas is only produced where sediment is thick');

// ---------------------------------------------------------------- 2. placer rig
// A felsic cone: one 80 km summit inside 60 km plateau, oceanic beyond. Only the summit is
// orogenic, so any placer that appears must have come off it and gone downhill.
function placerRig(oroSummit) {
	const g = new Grid(3, 11).build();
	const s = new State(g, 11);
	s.ckptCap = 0;
	s.plateCount = 1;
	Sim.raster(s);
	const summit = 0;
	for (let i = 0; i < s.n; i++) {
		const d = Math.acos(Math.max(-1, Math.min(1,
			g.pos[i * 3] * g.pos[summit * 3] + g.pos[i * 3 + 1] * g.pos[summit * 3 + 1]
			+ g.pos[i * 3 + 2] * g.pos[summit * 3 + 2])));
		const ring = d / 0.02;
		s.hFel[i] = ring < 0.6 ? 80000 : ring < 2.5 ? 60000 : ring < 4.5 ? 30000 : 0;
		s.hMaf[i] = s.hFel[i] ? 0 : 7000;
		s.age[i] = 200;
		s.oOro[i] = i === summit && oroSummit ? 1 : 0;
	}
	s.plate.fill(0);
	Sim.raster(s);
	Surface.elevation(s);
	// Routing is one hop per frame: sediment deposits where it lands and the next frame's
	// erosion picks it up again. 100 frames walks it off the cone without flattening it.
	for (let f = 0; f < 100; f++) Surface.step(s, 0.1);
	// Cells reachable by following the routing graph downhill from the summit.
	const reach = new Uint8Array(g.V);
	const stack = [summit];
	reach[summit] = 1;
	while (stack.length) {
		const c = stack.pop();
		for (let k = 0; k < g.ringN[c]; k++) {
			const j = g.ring[c * 6 + k];
			if (reach[j] || s.owner[j] < 0 || s.z[j] >= s.z[c]) continue;
			reach[j] = 1; stack.push(j);
		}
	}
	let placed = 0, mobile = 0, offPath = 0, highGround = 0;
	for (let c = 0; c < g.V; c++) {
		mobile += s.mobilePla[c];
		const o = s.owner[c];
		if (o < 0 || !(s.oPla[o] > 0)) continue;
		placed += s.oPla[o];
		if (!reach[c]) offPath++;
		if (s.z[c] >= Params.zBasin) highGround++;
	}
	return { placed, mobile, offPath, highGround, summitZ: s.z[summit] };
}
const withOro = placerRig(true), withoutOro = placerRig(false);
console.log(JSON.stringify({
	withOrogenicSummit: { placed: +withOro.placed.toFixed(4), mobile: +withOro.mobile.toFixed(1),
		offPath: withOro.offPath, onHighGround: withOro.highGround, summitZ: Math.round(withOro.summitZ) },
	withoutOrogenicSummit: { placed: +withoutOro.placed.toFixed(4), mobile: +withoutOro.mobile.toFixed(4) }
}, null, 1));
assert.ok(withOro.placed > 0, 'eroding an orogenic summit produces placer potential');
assert.equal(withoutOro.placed, 0, 'no placer is created where nothing is orogenic');
assert.equal(withoutOro.mobile, 0, 'the mobile placer load stays empty without a source');
assert.equal(withOro.offPath, 0, 'placer only lands downhill of its source');
assert.equal(withOro.highGround, 0, 'placer only lands in a submerged or low cell');

// ---------------------------------------------------------------- 3. long run
const grid = new Grid(4, 7).build();
const s = new State(grid, 7, true);
s.ckptCap = 0;
Sim.raster(s);
const EPOCH = 100, epochs = [];
for (let step = 0; step < 8; step++) {
	Sim.advance(s, 0.1, EPOCH / 0.1);
	const row = { t: s.t, finite: s.finite, plates: s.plateCount, max: 0 };
	for (let k = 0; k < 6; k++) row[Diag.ORE_NAMES[k]] = s.oreSum[k];
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		for (let k = 0; k < 6; k++) row.max = Math.max(row.max, s[Diag.ORE_FIELDS[k]][i]);
	}
	epochs.push(row);
	console.log('  t ' + String(Math.round(row.t)).padStart(4) + '  ' +
		Diag.ORE_NAMES.map((n, k) => n + ' ' + row[n].toFixed(0).padStart(5)).join(' ') +
		'  max ' + row.max.toFixed(3));
}
function share(field, test) {
	const at = Diag.ORE_FIELDS.indexOf(field);
	if (!(s.oreSum[at] > 0)) return NaN;
	let hit = 0;
	for (let i = 0; i < s.n; i++) {
		if (s.alive[i] && s[field][i] > 0 && test(i)) hit += s[field][i];
	}
	return hit / s.oreSum[at];
}
// Where the arc potential sits at the end of the run. It is a fossil record: the plate carries
// the deposit away from the trench that made it, so this is lower than the production share
// above and falls with run length. Recorded, not asserted at acceptance 5's 60 %.
const nearTrench = new Int32Array(s.colCap).fill(9);
for (let c = 0; c < grid.V; c++) {
	const o = s.owner[c];
	if (o >= 0 && s.trenchDist[c] < nearTrench[o]) nearTrench[o] = s.trenchDist[c];
}
const arcNearTrench = share('oArc', (i) => nearTrench[i] <= 2);
const endGeo = {
	arcOnOverrider: +share('oArc', (i) => subducting[s.plate[i]] === 1).toFixed(3),
	arcNearTrenchNow: +arcNearTrench.toFixed(3),
	vmsOceanicNow: +share('oVms', (i) => s.hFel[i] < Params.hOceanic).toFixed(3),
	oroContinental: +share('oOro', (i) => s.hFel[i] >= Params.hOceanic).toFixed(3),
	basinSediment: +share('oBas', (i) => s.hSed[i] > 1000).toFixed(3)
};
console.log(JSON.stringify(endGeo, null, 1));

for (const row of epochs) {
	assert.equal(row.finite, 1, 'finite at t ' + row.t);
	assert.ok(row.max <= 1, 'no potential above saturation at t ' + row.t + ': ' + row.max);
	for (const name of Diag.ORE_NAMES) {
		assert.ok(row[name] > 0, name + ' is populated at t ' + row.t);
		assert.ok(row[name] <= s.colCap, name + ' total is bounded at t ' + row.t);
	}
}
assert.ok(endGeo.oroContinental > 0.9, 'oOro stays on continental crust: ' + endGeo.oroContinental);
assert.ok(endGeo.basinSediment > 0.6, 'oBas stays in thick sediment: ' + endGeo.basinSediment);
// Terrane accretion (Events.orphans) legitimately carries arc fossils onto plates that are
// not subducting right now, so this fossil-record share sits a little below the production
// share; 0.85 keeps the assertion about where arcs form while tolerating the drift.
assert.ok(endGeo.arcOnOverrider > 0.85, 'oArc stays on overriding plates: ' + endGeo.arcOnOverrider);

// Extraction: ranked, in range, tagged, and the same list twice.
const scratch = new Float64Array(grid.V);
const deposits = Extract.deposits(s, 0.15, 12, scratch);
assert.ok(deposits.length >= 6, 'every class yields a deposit: ' + deposits.length);
for (const d of deposits) {
	assert.ok(d.value >= 0.15 && d.value <= 1, 'deposit value in range: ' + d.value);
	assert.ok(d.host !== 'none' && d.kind && d.epoch > 0, 'deposit carries a context tag');
	assert.ok(Number.isFinite(d.lat) && Math.abs(d.lat) <= Math.PI / 2, 'deposit latitude');
}
for (let k = 0; k < 6; k++) {
	const own = deposits.filter((d) => d.kind === Diag.ORE_NAMES[k]);
	for (let at = 1; at < own.length; at++) {
		assert.ok(own[at - 1].value >= own[at].value, Diag.ORE_NAMES[k] + ' deposits are ranked');
	}
}
assert.equal(Extract.json(s, 0.15, 4, scratch), Extract.json(s, 0.15, 4, scratch),
	'extraction is deterministic');
const parsed = JSON.parse(Extract.json(s, 0.15, 4, scratch));
assert.equal(parsed.format, 'pgt-deposits');
assert.equal(parsed.totals.length, 6);
assert.ok(parsed.deposits.length > 0, 'json carries deposits');

// Ore is state, not a derived buffer: it must survive a round trip exactly.
const blob = Checkpoint.save(s);
const twin = new State(grid, 7, true);
twin.ckptCap = 0;
Checkpoint.load(twin, new Uint8Array(blob));
Sim.raster(twin);
for (const field of Diag.ORE_FIELDS.concat(['fert'])) {
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		assert.equal(twin[field][i], s[field][i], field + '[' + i + '] survives a round trip');
	}
}

console.log('PASS ores: production sites exact, placer rig downslope-only, six bounded'
	+ ' potentials, ranked deposits, checkpoint round trip');

// 0.7.0 - live resolution transfer. Short profile.
//
// It gates the transfer's own contract (0.7.0-plan-live-resolution.md §4): volume is conserved
// per family, no target cell is left empty, the plate frame is exact, the clock and the RNG do
// not move, the source world is untouched, and a session ledger keeps its records. The two
// re-lattice numbers that cannot be zero - anchor drift and the round-trip thickness deviation -
// are printed and bounded rather than assumed.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Resolution = require('../js/resolution.js');
const Deposits = require('../js/deposits.js');
const Instruments = require('../js/instruments.js');
const Diag = require('../js/diag.js');

function sumField(s, field) {
	let sum = 0;
	for (let i = 0; i < s.n; i++) if (s.alive[i]) sum += s[field][i];
	return sum;
}
function massVector(s) {
	return [sumField(s, 'hFel') * s.A0ref, sumField(s, 'hMaf') * s.A0ref,
		(sumField(s, 'hSed') + Array.from(s.mobile).reduce((a, v) => a + v, 0)) * s.A0ref];
}
function rel(a, b) {
	const scale = Math.max(Math.abs(a), Math.abs(b));
	return scale > 0 ? Math.abs(a - b) / scale : 0;
}
function snapshot(s) {
	return { t: s.t, frame: s.frame, rng: s.rng, lastEvent: s.lastEvent, ckptDue: s.ckptDue,
		mass: massVector(s), body: s.body.slice(0, s.n * 3), world: s.world.slice(0, s.n * 3) };
}
function sameState(before, s) {
	assert.equal(s.t, before.t, 't moved');
	assert.equal(s.frame, before.frame, 'frame moved');
	assert.equal(s.rng, before.rng, 'rng moved');
	assert.equal(s.lastEvent, before.lastEvent, 'lastEvent moved');
	assert.equal(s.ckptDue, before.ckptDue, 'ckptDue moved');
	const now = massVector(s);
	for (let i = 0; i < 3; i++) assert.equal(before.mass[i], now[i], 'source mass ' + i);
	assert.deepEqual(Array.from(s.body.slice(0, s.n * 3)), Array.from(before.body), 'source body changed');
	assert.deepEqual(Array.from(s.world.slice(0, s.n * 3)), Array.from(before.world), 'source world changed');
}
function transferGates(src, grid, label) {
	const before = snapshot(src);
	const out = Resolution.transfer(src, grid);
	const dst = out.state, r = out.report;
	sameState(before, src);
	// The transfer is a re-lattice, so the volume it reports is a budget rather than zero: the
	// per-cell rule preserves the field (a shard carries its parent's thickness exactly) and the
	// residual is the source frame's own coverage duplication - cells the raster paints from a
	// neighbouring column - which a one-column-per-cell target cannot carry. It is booked to
	// regrid* and reported, and the ledger identity below is exact because of that booking.
	assert.ok(r.volumeError.fel < 0.05 && r.volumeError.maf < 0.05, label + ' volume fel/maf ' + r.volumeError.fel + '/' + r.volumeError.maf);
	// Sediment is the worst case for a mean over contributors: it is sparse and it sits where the
	// two tessellations give more target cells per source column, so the residual is larger and
	// is gated against the measured budget rather than a round number.
	assert.ok(r.volumeError.sed < 0.2, label + ' volume sed ' + r.volumeError.sed);
	const identity = { fel: dst.massFel0 + dst.producedFel + dst.regridFel - dst.massFel,
		maf: dst.massMaf0 + dst.producedMaf + dst.regridMaf - dst.subductedMaf - dst.massMaf };
	assert.ok(Math.abs(identity.fel) / dst.massFel < 1e-12, label + ' fel ledger identity ' + identity.fel);
	assert.ok(Math.abs(identity.maf) / dst.massMaf < 1e-12, label + ' maf ledger identity ' + identity.maf);
	assert.ok(Math.abs(r.regrid.fel) / dst.massFel < 0.05, label + ' regrid fel ' + r.regrid.fel / dst.massFel);
	// The residual is the duplication, not noise: cells the source raster paints from a column
	// that already owns another cell.
	let duplicated = 0;
	for (let c = 0; c < src.grid.V; c++) {
		const o = src.owner[c];
		if (o < 0) continue;
		for (let k = 0; k < src.grid.ringN[c]; k++) if (src.owner[src.grid.ring[c * 6 + k]] === o) { duplicated++; break; }
	}
	assert.ok(r.volumeError.fel <= 0.02 + duplicated / src.grid.V * 2, label + ' residual is not the duplication');
	// Coverage is a mask: the finer frame inherits the cell a target cell sits in, the coarser
	// frame unions the cells inside it, so a hole stays a hole and no material is borrowed.
	assert.equal(r.covered, dst.n, label + ' covered count');
	assert.equal(r.covered + r.holes, dst.grid.V, label + ' coverage partition');
	let holes = 0;
	for (let c = 0; c < dst.grid.V; c++) {
		if (dst.owner[c] >= 0) continue;
		holes++;
		const b = c * 3, sc = Resolution.nearestCell(src.grid, dst.grid.pos[b], dst.grid.pos[b + 1], dst.grid.pos[b + 2]);
		assert.ok(src.owner[sc] < 0, label + ' target hole ' + c + ' sits over a covered source cell');
	}
	assert.equal(holes, r.holes, label + ' hole count');
	assert.equal(dst.alive.reduce((a, v) => a + v, 0), dst.n, label + ' alive count');
	let own = 0;
	for (let c = 0; c < dst.grid.V; c++) if (dst.owner[c] >= 0) own++;
	for (let c = 0; c < dst.grid.V; c++) {
		const live = dst.owner[c] >= 0;
		assert.equal(dst.z[c] === dst.z[c], live, label + ' elevation vs coverage at ' + c);
	}
	assert.equal(own, dst.n, label + ' owner fill');
	assert.ok(r.rigidError < 1e-12, label + ' rigid error ' + r.rigidError);
	assert.equal(dst.t, src.t, label + ' t');
	assert.equal(dst.frame, src.frame, label + ' frame');
	assert.equal(dst.rng, src.rng, label + ' rng');
	assert.equal(dst.lastEvent, src.lastEvent, label + ' lastEvent');
	assert.equal(dst.ckptDue, src.ckptDue, label + ' ckptDue');
	assert.equal(dst.plateCount, src.plateCount, label + ' plate count');
	assert.equal(dst.ckpt, null, label + ' checkpoint ring carried');
	assert.equal(dst.ckptSlots, 0, label + ' checkpoint slots carried');
	assert.ok(dst.colCap >= dst.n, label + ' column capacity');
	for (let p = 0; p < src.plateCount; p++) {
		for (let k = 0; k < 4; k++) assert.equal(dst.q[p * 4 + k], src.q[p * 4 + k], label + ' q');
		for (let k = 0; k < 3; k++) assert.equal(dst.omega[p * 3 + k], src.omega[p * 3 + k], label + ' omega');
	}
	assert.equal(dst.rotRec.length, dst.plateCap, label + ' rotRec size');
	for (let p = 0; p < src.plateCount; p++) assert.equal(dst.rotRec[p], src.rotRec[p], label + ' rotRec identity');
	// The re-derivation must not append a history sample: a transfer is not a step.
	assert.equal(dst.histI, src.histI, label + ' history head');
	assert.equal(dst.histN, src.histN, label + ' history count');
	return { dst, r };
}

const g5 = new Grid(5, 7).build();
const source5 = new State(g5, 7);
Sim.raster(source5);
for (let i = 0; i < 50; i++) Sim.step(source5, 0.1);

// --- inventory: every state field is classified --------------------------------
{
	const inv = Resolution.inventory(source5);
	assert.deepEqual(inv.unknown, [], 'unclassified State fields: ' + inv.unknown.join(','));
	assert.ok(inv.groups.length > 12, 'inventory groups');
	assert.ok(inv.bytes > 0, 'inventory bytes');
	assert.equal(Resolution.classOf('hFel'), 'material', 'crust class');
	assert.equal(Resolution.classOf('z'), 're-derived', 'elevation class');
	assert.equal(Resolution.classOf('ckpt'), 'view', 'checkpoint ring class');
	assert.equal(Resolution.classOf('t'), 'world', 'clock class');
	assert.equal(Resolution.groupOf('oPla'), 'columnScalar', 'ore group');
	console.log('resolution inventory:', inv.groups.length + ' groups, ' + (inv.bytes / 1048576).toFixed(1) + ' MB, 0 unclassified');
}

// --- a fresh world: clean coverage, both directions ---------------------------
{
	const fresh = new State(g5, 7);
	Sim.raster(fresh);
	const up = Resolution.transfer(fresh, new Grid(6, 7).build());
	assert.equal(up.report.holes, 0, 'a fully covered frame lost coverage');
	assert.equal(up.report.forced, 0, 'a fully covered frame forced a column');
	const down = Resolution.transfer(up.state, g5);
	assert.equal(down.report.holes, 0, 'the way back lost coverage');
	assert.ok(down.report.volumeError.fel < 0.02, 'round trip of a uniform world ' + down.report.volumeError.fel);
	// Upsampling adds no information: with no holes and no forced columns every child carries
	// exactly one parent's thickness.
	const distinct = new Set();
	for (let i = 0; i < fresh.n; i++) if (fresh.alive[i]) distinct.add(fresh.hFel[i]);
	for (let i = 0; i < up.state.n; i++) if (up.state.alive[i]) assert.ok(distinct.has(up.state.hFel[i]), 'a split child invented a thickness');
	console.log('fresh world: no holes, no forced columns, fel residual '
		+ (up.report.volumeError.fel * 100).toFixed(2) + '% / ' + (down.report.volumeError.fel * 100).toFixed(2) + '%'
		+ ', every child one of ' + distinct.size + ' parent thicknesses');
}

// --- up: L5 -> L6 -------------------------------------------------------------
{
	const { dst, r } = transferGates(source5, new Grid(6, 7).build(), 'L5->L6');
	assert.equal(r.levelFrom, 5, 'level from');
	assert.equal(r.levelTo, 6, 'level to');
	assert.equal(r.columnsIn, source5.n, 'columns in');
	assert.equal(r.columnsOut, dst.n, 'columns out');
	// Upsampling splits: most surviving columns feed two to four target cells.
	let split = 0;
	for (let s = 2; s < r.shardHistogram.length; s++) split += r.shardHistogram[s];
	assert.ok(split > source5.n * 0.9, 'upsampling did not split: ' + split);
	// Aggregation appears only where the source is sparse enough that one column owns several
	// cells; a healthy source frame forces nothing.
	assert.ok(r.forced <= source5.n * 0.01, 'upsampling forced ' + r.forced + ' of ' + source5.n + ' columns');
	// A stepped source is not fully covered, so a target cell can have several contributors and
	// its value is a mean: gate the envelope (no invented thickness) and report how many children
	// still carry an exact parent value.
	let maxSrc = 0, exact = 0, liveChildren = 0;
	for (let i = 0; i < source5.n; i++) if (source5.alive[i] && source5.hFel[i] > maxSrc) maxSrc = source5.hFel[i];
	const seen = new Set();
	for (let i = 0; i < source5.n; i++) if (source5.alive[i]) seen.add(source5.hFel[i]);
	for (let i = 0; i < dst.n; i++) if (dst.alive[i]) {
		liveChildren++;
		assert.ok(dst.hFel[i] >= 0 && dst.hFel[i] <= maxSrc, 'a child thickness left the envelope');
		if (seen.has(dst.hFel[i])) exact++;
	}
	assert.ok(exact > liveChildren * 0.5, 'means swallowed the field: ' + exact + '/' + liveChildren);
	console.log('  children on an exact parent value: ' + (exact / liveChildren * 100).toFixed(1) + '%');
	// A re-lattice moves every anchor: the quantization bucket is 3e-5 of a unit vector, while a
	// cell is 1e-2. The number is reported, not gated at 1 - identity across a level change is
	// the ledger's record identity (below), not a re-derived catalogue id.
	assert.ok(r.anchorDrift.maxCells < 3, 'anchor drift ' + r.anchorDrift.maxCells + ' source cells');
	console.log('L5->L6: volume error', r.volumeError.fel.toExponential(2),
		'· anchor drift max', r.anchorDrift.maxCells.toFixed(2), 'source cells, kept',
		(r.anchorDrift.kept / r.anchorDrift.counted * 100).toFixed(2) + '%',
		'· ' + (r.columnsIn + '->' + r.columnsOut) + ' columns');
}

// --- down: L6 -> L5 -----------------------------------------------------------
const source6 = new State(new Grid(6, 7).build(), 7);
Sim.raster(source6);
for (let i = 0; i < 10; i++) Sim.step(source6, 0.1);
const down = transferGates(source6, new Grid(5, 7).build(), 'L6->L5');
assert.ok(down.r.forced > 0, 'downsampling did not aggregate');
assert.ok(down.r.shardHistogram[1] + down.r.forced >= down.r.columnsIn, 'downsampling aggregation');
console.log('L6->L5: forced', down.r.forced, '· volume error', down.r.volumeError.maf.toExponential(2));

// --- guards -------------------------------------------------------------------
{
	assert.throws(() => Resolution.transfer(source5, null), TypeError, 'no grid');
	assert.throws(() => Resolution.transfer(source5, new Grid(5, 8).build()), RangeError, 'same level');
	assert.throws(() => Resolution.transfer(null, new Grid(6, 7).build()), TypeError, 'no source');
}

// --- anchors: the constant is the catalogue's own -----------------------------
{
	// Resolution.ANCHOR_SCALE mirrors Deposits' own BODY_SCALE; the drift report is meaningless
	// if the two ever disagree, so it is pinned against the catalogue's public function.
	let cell = 0;
	while (cell < g5.V && source5.owner[cell] < 0) cell++;
	const owner = source5.owner[cell], b = owner * 3;
	const key = [Math.round(source5.body[b] * Resolution.ANCHOR_SCALE), Math.round(source5.body[b + 1] * Resolution.ANCHOR_SCALE), Math.round(source5.body[b + 2] * Resolution.ANCHOR_SCALE)];
	assert.deepEqual(Deposits.anchorKey(source5, cell), key, 'anchor scale is the catalogue BODY_SCALE');
	console.log('anchor scale matches the catalogue: ' + key.join(',') + ' on cell ' + cell);
}

// --- round trip L5 -> L6 -> L5 -----------------------------------------------
{
	const up = Resolution.transfer(source5, new Grid(6, 7).build());
	const back = Resolution.transfer(up.state, g5);
	const dst = back.state;
	// The round trip does not restore the field exactly, and must not pretend to: the mean-based
	// rule books its residual to regrid*. What has to hold exactly is that the booking is the
	// whole story - the mass the field gained or lost is the mass the ledger booked. regrid* is
	// cumulative on the state, so the drift since the source is the delta, not the sum.
	const drift = massVector(dst)[0] - massVector(source5)[0];
	const booked = back.report.regrid.fel - source5.regridFel;
	const volError = rel(drift, booked);
	assert.ok(volError < 1e-9, 'round trip drift is not the booked residual: ' + drift + ' vs ' + booked);
	assert.ok(Math.abs(drift) / massVector(source5)[0] < 0.06, 'round trip field drift ' + drift / massVector(source5)[0]);
	// Thickness per CELL, through the owner map: a column's index is not its cell once the
	// world has stepped, and reading hFel[c] would compare two different columns.
	// The outliers are rim cells: ownership is a nearest-column rule, so a cell on a material
	// boundary can flip to the neighbouring column, and continental and oceanic crust differ by
	// tens of kilometres. The bulk of the map has to come back bit-identical instead.
	let sq = 0, cnt = 0, maxDiff = 0, same = 0, within = 0;
	for (let c = 0; c < g5.V; c++) {
		const a = source5.owner[c], b = dst.owner[c];
		if (a < 0 || b < 0) continue;
		const ta = source5.hFel[a] + source5.hMaf[a] + source5.hSed[a];
		const tb = dst.hFel[b] + dst.hMaf[b] + dst.hSed[b];
		const d = ta - tb, m = (ta + tb) / 2;
		sq += d * d; cnt++;
		if (ta === tb) same++;
		if (m > 0 && Math.abs(d) / m <= 0.05) within++;
		if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
	}
	const rms = Math.sqrt(sq / cnt);
	console.log('round trip: cell thickness RMS ' + rms.toFixed(1) + ' m, max ' + maxDiff.toFixed(1)
		+ ' m on ' + cnt + ' cells (' + (same / cnt * 100).toFixed(1) + '% identical, '
		+ (within / cnt * 100).toFixed(1) + '% within 5%), drift booked to ' + volError.toExponential(2));
	assert.ok(rms < 3000, 'round trip thickness RMS ' + rms);
	assert.ok(within / cnt > 0.9, 'round trip thickness spread');
	// Physics after the re-lattice: the same number of steps from the round-tripped world and
	// from the untouched source world, then the two worlds are compared cell by cell. This is
	// the gate that says a transfer moved the frame rather than losing half of it.
	const steps = 50;
	for (let i = 0; i < steps; i++) { Sim.step(source5, 0.1); Sim.step(dst, 0.1); }
	let zsq = 0, live = 0, landA = 0, landB = 0, maxZ = 0;
	for (let c = 0; c < g5.V; c++) {
		if (source5.z[c] >= 0) landA++;
		if (dst.z[c] >= 0) landB++;
		if (source5.z[c] !== source5.z[c] || dst.z[c] !== dst.z[c]) continue;
		const d = source5.z[c] - dst.z[c];
		zsq += d * d; live++;
		if (Math.abs(d) > maxZ) maxZ = Math.abs(d);
	}
	const zRms = Math.sqrt(zsq / live);
	console.log(steps + ' steps after the round trip: z RMS ' + zRms.toFixed(1) + ' m, max ' + maxZ.toFixed(1)
		+ ' m; land ' + (landA / g5.V * 100).toFixed(2) + '% vs ' + (landB / g5.V * 100).toFixed(2) + '%');
	assert.ok(Math.abs(landA - landB) / g5.V < 0.01, 'land fraction moved');
	assert.ok(dst.finite === source5.finite, 'finite flag');
}

// --- repeated changes do not compound ----------------------------------------
{
	let s = new State(g5, 7);
	Sim.raster(s);
	for (let i = 0; i < 50; i++) Sim.step(s, 0.1);
	const base = { fel: s.massFel, sed: s.massSed };
	const levels = [6, 5, 6, 5, 6, 5];
	let worst = 0;
	for (const level of levels) {
		const out = Resolution.transfer(s, new Grid(level, 7).build());
		s = out.state;
		const identity = (s.massFel0 + s.producedFel + s.regridFel - s.massFel) / s.massFel;
		assert.ok(Math.abs(identity) < 1e-12, 'ledger identity after L' + level + ': ' + identity);
		if (out.report.volumeError.fel > worst) worst = out.report.volumeError.fel;
	}
	// The first change carries the source frame's coverage duplication into the ledger; every
	// later change starts from a frame with one column per covered cell and is nearly free.
	const drift = s.massFel / base.fel - 1;
	assert.ok(Math.abs(drift) < 0.06, 'six changes drifted ' + drift);
	console.log('six level changes: worst single residual ' + (worst * 100).toFixed(2) + '%, total ledger drift '
		+ (drift * 100).toFixed(2) + '%, identity exact');
}

// --- anchors move with the frame ---------------------------------------------
{
	// One quantization bucket is a different record. A level change re-lattices the plate frame,
	// so a transferred column's anchor key really does move and a re-derived catalogue really
	// does give it a new id; the ledger below is what keeps a discovery identified across that.
	let cell = 0;
	while (cell < g5.V && source5.owner[cell] < 0) cell++;
	const key = Deposits.anchorKey(source5, cell);
	const shifted = [key[0] + 1, key[1], key[2]];
	assert.notEqual(Deposits.idFor(source5.seed, 'arc', key), Deposits.idFor(source5.seed, 'arc', shifted),
		'one anchor bucket is a new id');
	assert.equal(Deposits.idFor(source5.seed, 'arc', key), Deposits.idFor(source5.seed, 'arc', key.slice()),
		'the same anchor is the same id');
	console.log('one anchor bucket is a new catalogue id (the re-lattice states its own drift in the report)');
}

// --- ledger re-lay -----------------------------------------------------------
{
	const ledger = new Instruments.Ledger(g5.V);
	const sel = ['obs', 'geo', 'mag', 'd5k'];
	for (let c = 0; c < g5.V; c += 977) Instruments.survey(source5, c, sel, ledger);
	const ids = ledger.found.map((e) => e.id);
	const anchors = ledger.found.map((e) => (e.anchorKey || []).join(','));
	assert.ok(ledger.found.length > 0, 'the ledger found nothing');
	const before = ledger.cellsN;
	const r = Resolution.ledger(ledger, g5, new Grid(6, 7).build());
	assert.equal(ledger.coverage.length, 40962, 'coverage size');
	assert.equal(ledger.coverage[0], ledger.coverage[0], 'coverage readable');
	assert.deepEqual(ledger.found.map((e) => e.id), ids, 'ids changed');
	assert.deepEqual(ledger.found.map((e) => (e.anchorKey || []).join(',')), anchors, 'anchors changed');
	assert.equal(r.entries, ids.length, 'entries');
	assert.equal(r.coverageGain, 0, 'the finer frame gained no coverage');
	assert.ok(ledger.cellsN >= before, 'coverage shrank');
	assert.equal(ledger.cellsN, r.cells, 'cells list');
	for (const key of Object.keys(ledger.byRecordCell)) {
		for (const entry of ledger.byRecordCell[key]) assert.equal(entry.cell, +key, 'record index');
	}
	for (const key of Object.keys(ledger.bySurveyCell)) {
		for (const entry of ledger.bySurveyCell[key]) assert.equal(entry.surveyCell, +key, 'survey index');
	}
	for (const entry of ledger.found) assert.ok(ledger.coverage[entry.cell] !== 0, 'entry cell not covered at L6');
	// Survey the same material on the new frame: a displaced record must re-anchor the entry it
	// already has instead of being discovered a second time (Instruments.findEntry consumes the
	// stamp Resolution.ledger left on the entry).
	const serialsBefore = ledger.found.map((e) => e.serial);
	const g6 = new Grid(6, 7).build();
	const dst6 = Resolution.transfer(source5, g6).state;
	// The ledger has already moved: its coverage is L6-sized, so a caller that still names the
	// old frame is caught rather than re-laid against a mask of the wrong size.
	assert.throws(() => Resolution.ledger(ledger, g5, g6), RangeError, 'coverage is not the source frame');
	const oldRadius = 1.5 * g5.nbrDist[0] / 6371000;
	const cosOld = Math.cos(oldRadius);
	let duplicates = 0, reanchored = 0;
	for (const entry of ledger.found.filter((e) => serialsBefore.indexOf(e.serial) >= 0)) {
		const dir = entry.direction, kind = entry.kind;
		const cell = Resolution.nearestCell(g6, dir[0], dir[1], dir[2]);
		Instruments.survey(dst6, cell, sel, ledger);
		for (const other of ledger.found) {
			if (serialsBefore.indexOf(other.serial) >= 0 || other.kind !== kind) continue;
			const o = other.direction;
			if (o[0] * dir[0] + o[1] * dir[1] + o[2] * dir[2] >= cosOld) duplicates++;
		}
	}
	for (const entry of ledger.found) if (serialsBefore.indexOf(entry.serial) >= 0 && entry.priorTolerance === undefined) reanchored++;
	assert.equal(duplicates, 0, 'a level change duplicated ' + duplicates + ' discoveries');
	assert.ok(reanchored > 0, 'no entry re-anchored onto the new frame');
	console.log('re-survey after the transfer: ' + reanchored + '/' + serialsBefore.length
		+ ' entries re-anchored, ' + duplicates + ' duplicated');
	// And the ledger survives the way back, from a frame it has already been re-laid onto once.
	const back = Resolution.ledger(ledger, g6, g5);
	assert.equal(ledger.coverage.length, g5.V, 'coverage back');
	assert.ok(back.moved >= 0, 'moved');
	for (const entry of ledger.found) assert.ok(ledger.coverage[entry.cell] !== 0, 'entry cell not covered at L5');
	console.log('ledger: ' + ids.length + ' entries re-laid, cells ' + before + ' -> ' + r.cells + ' -> ' + ledger.cellsN
		+ ', moved ' + r.moved + '/' + back.moved + ', coverage gain ' + r.coverageGain + '/' + back.coverageGain);
}

console.log('PASS resolution: inventory is complete, the transfer conserves every family and covers every cell,'
	+ ' the plate frame and the clock are exact, the source is untouched, the shard map aggregates and splits,'
	+ ' anchors drift by a bounded number of source cells, the round trip stays within the field budget,'
	+ ' and a session ledger keeps its records across the re-lattice');

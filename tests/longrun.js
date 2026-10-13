// Phase E long run: a hot start cooled for 1500 Myr at dt 0.1, and 300 Myr at dt 0.01 to show
// the world does not depend on the frame step. Acceptance 3 (plate speeds, continental area,
// cratons) and the plan's plate-count window are checked per epoch. Pass --release for
// acceptance 6's 4500 Myr / dt 0.1 and 500 Myr / dt 0.01 histories without making every
// development test run take that long.
// The continental share is read on a three-seed ensemble, not on the seed-7 world alone: it
// spreads over ~7 points between seeds at 1500 Myr, which is wider than the distance from the
// ensemble mean to the design band's floor (0.7.1-review-continental-area.md §2.1).
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const Deposits = require('../js/deposits.js');
const Core = require('../js/core.js');
const EPOCH = 100;
const RELEASE = process.argv.includes('--release');
const COARSE_MYR = RELEASE ? 4500 : 1500;
const FINE_MYR = RELEASE ? 500 : 300;
// Acceptance 3 is written at 1500 Myr (design §10.3) whatever the profile length, so the
// ensemble members run to that epoch and stop - the world is deterministic, so their 1500 Myr
// state is the 1500 Myr epoch of a longer run, at a third of the cost in --release.
const ACCEPT_MYR = 1500;
const ACCEPT_AT = Math.round(ACCEPT_MYR / EPOCH) - 1;
// Predeclared bounds. The measured spread over these three seeds is 0.070 shipped, and 0.024 /
// 0.053 / 0.036 on the three candidates measured at 0.7.1, so 0.12 is a guard against a model
// that turns wildly seed-sensitive, not a second acceptance band - three seeds estimate a
// spread badly, and the mean is the number the design's band is read on.
const ENSEMBLE = [7, 8, 11];
const SPREAD_MAX = 0.12;
// The history that carries every other check (catalogue, dt-independence, checkpoint ring).
const PRIMARY = 7;

function epochStats(s) {
	let n = 0, continental = 0, craton = 0;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		n++;
		if (s.hFel[i] > 20000) continental++;
		if (s.hFel[i] > 30000 && s.age[i] > 300) craton++;
	}
	return {
		t: s.t, plates: s.plateCount, columns: n, splits: s.splits, merges: s.merges,
		meanCm: s.meanSpeed / 10000, maxCm: s.maxSpeed / 10000, Tm: s.Tm,
		continental: continental / n, craton: craton / n,
		felResidual: (s.massFel0 + s.producedFel - s.massFel) / s.massFel,
		mafResidual: (s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf) / s.massMaf,
		finite: s.finite, rigid: s.rigidError, quat: s.quatError, snapshots: s.ckptN
	};
}
function history(dt, myr, seed) {
	seed = seed === undefined ? 7 : seed;
	const g = new Grid(5, seed).build();
	const s = new State(g, seed, 1);           // hot start
	Sim.raster(s);
	const epochs = [];
	const start = performance.now();
	for (let e = 0; e < Math.round(myr / EPOCH); e++) {
		Sim.advance(s, dt, Math.round(EPOCH / dt));
		epochs.push(epochStats(s));
	}
	return { s, epochs, seconds: (performance.now() - start) / 1000 };
}
function assertCoreCatalogue(s) {
	const catalogue = Deposits.build(s), byCell = new Map();
	for (const record of catalogue.records) {
		if (!byCell.has(record.cell)) byCell.set(record.cell, []);
		byCell.get(record.cell).push(record);
	}
	assert.ok(catalogue.records.length > 0, 'the evolved snapshot has catalogue deposits');
	let checkedBodies = 0;
	for (const [cell, records] of byCell) {
		const wet = s.z[cell] < Params.sea;
		const water = wet ? Math.max(0, Math.round((Params.sea - s.z[cell]) / 10) * 10) : 0;
		const maxBottom = records.reduce((bottom, record) => Math.max(bottom, record.bottom), 0);
		const section = Core.section(s, cell, water + maxBottom);
		assert.ok(section, 'every catalogue cell has a drillable core at cell ' + cell);
		const expectedBodies = records.reduce((count, record) => count + record.bodies.length, 0);
		assert.equal(section.intersections.length, expectedBodies,
			'core and catalogue agree on every body intersection at cell ' + cell);
		for (const record of records) {
			for (let bodyIndex = 0; bodyIndex < record.bodies.length; bodyIndex++) {
				const body = record.bodies[bodyIndex];
				const hit = section.intersections.find((item) => item.id === record.id && item.bodyIndex === bodyIndex);
				assert.ok(hit, 'catalogue body appears in the core: #' + record.id + '/' + bodyIndex);
				assert.equal(hit.bodyTop, water + body.top, 'wet body depth uses the sea-surface datum');
				assert.equal(hit.bodyBottom, water + body.bottom);
				const pieces = section.layers.filter((layer) => layer.oreRecords
					&& layer.oreRecords.some((ore) => ore.id === record.id && ore.bodyIndex === bodyIndex));
				let at = hit.from;
				for (const piece of pieces) {
					assert.equal(piece.top, at, 'ore overlay pieces are contiguous for #' + record.id);
					assert.ok(piece.bottom <= hit.to);
					at = piece.bottom;
				}
				assert.equal(at, hit.to, 'every ore body is completely represented in the host log');
				checkedBodies++;
			}
		}
	}
	Deposits.release();
	return checkedBodies;
}

const long = history(0.1, COARSE_MYR, PRIMARY);
console.log('dt 0.1, hot start, ' + COARSE_MYR + ' Myr in ' + long.seconds.toFixed(0) + ' s');
const coreBodies = assertCoreCatalogue(long.s);
console.log('PASS core/catalogue: ' + coreBodies + ' body intersections agree at the '
	+ COARSE_MYR + ' Myr evolved L5 snapshot');
for (const e of long.epochs) {
	console.log('  t ' + e.t.toFixed(0).padStart(4) + ' plates ' + String(e.plates).padStart(3)
		+ ' cols ' + String(e.columns).padStart(5) + ' cont ' + (e.continental * 100).toFixed(1).padStart(5) + '%'
		+ ' craton ' + (e.craton * 100).toFixed(2).padStart(5) + '% mean ' + e.meanCm.toFixed(2).padStart(5)
		+ ' cm/yr max ' + e.maxCm.toFixed(2).padStart(5) + ' Tm ' + e.Tm.toFixed(2)
		+ ' splits ' + String(e.splits).padStart(3) + ' merges ' + String(e.merges).padStart(3)
		+ ' snapshots ' + e.snapshots);
}
const last = long.epochs[long.epochs.length - 1];
const acceptance = long.epochs[ACCEPT_AT];
for (const e of long.epochs) {
	// finite covers NaN, plate ids outside the dense table, and a potential above saturation.
	assert.equal(e.finite, 1, 'state invariant (finite, plate ids, saturation) at t ' + e.t);
	assert.ok(e.rigid < 1e-9, 'rigid motion at t ' + e.t + ': ' + e.rigid);
	assert.ok(e.quat < 1e-9, 'unit quaternion at t ' + e.t + ': ' + e.quat);
	assert.ok(Math.abs(e.felResidual) < 0.01, 'hFel invariant at t ' + e.t + ': ' + e.felResidual);
	assert.ok(Math.abs(e.mafResidual) < 0.01, 'hMaf invariant at t ' + e.t + ': ' + e.mafResidual);
	assert.ok(e.plates >= 6 && e.plates <= 40, 'plate count at t ' + e.t + ': ' + e.plates);
}
const middle = long.epochs.filter(e => e.t >= 500 && e.t <= 1000);
const middleMean = middle.reduce((a, e) => a + e.meanCm, 0) / middle.length;
assert.ok(middleMean >= 1 && middleMean <= 10, 'middle epoch speed ' + middleMean.toFixed(2) + ' cm/yr');
// The ensemble: seed 7 is the primary history above, the rest are run to the acceptance epoch.
// Each one is a whole world, so each is checked for the invariants before its share is pooled.
const ensemble = ENSEMBLE.map(function (seed) {
	if (seed === PRIMARY) return { seed: seed, epoch: acceptance };
	const run = history(0.1, ACCEPT_MYR, seed);
	return { seed: seed, epoch: run.epochs[run.epochs.length - 1] };
});
for (const member of ensemble) {
	const e = member.epoch;
	console.log('  seed ' + member.seed + ': continental ' + (e.continental * 100).toFixed(1) + '%'
		+ ' cratons ' + (e.craton * 100).toFixed(2) + '% plates ' + e.plates
		+ ' columns ' + e.columns + ' at ' + ACCEPT_MYR + ' Myr');
	assert.equal(e.finite, 1, 'state invariant on seed ' + member.seed);
	assert.ok(Math.abs(e.felResidual) < 0.01, 'hFel invariant on seed ' + member.seed + ': ' + e.felResidual);
	assert.ok(Math.abs(e.mafResidual) < 0.01, 'hMaf invariant on seed ' + member.seed + ': ' + e.mafResidual);
	assert.ok(e.craton > 0, 'cratons must exist by ' + ACCEPT_MYR + ' Myr (seed ' + member.seed + ')');
	assert.ok(e.plates >= 6 && e.plates <= 40, 'plate count on seed ' + member.seed + ': ' + e.plates);
}
const shares = ensemble.map(member => member.epoch.continental);
const contMean = shares.reduce((a, b) => a + b, 0) / shares.length;
const contSpread = Math.max.apply(null, shares) - Math.min.apply(null, shares);
assert.ok(contMean >= 0.15 && contMean <= 0.4, 'continental area, ' + ENSEMBLE.length + '-seed mean '
	+ contMean.toFixed(4) + ' over ' + shares.map(s => s.toFixed(3)).join('/'));
assert.ok(contSpread <= SPREAD_MAX, 'continental area spread ' + contSpread.toFixed(4)
	+ ' over seeds ' + ENSEMBLE.join('/') + ' (bound ' + SPREAD_MAX + ')');
assert.ok(acceptance.splits >= 1 && acceptance.merges >= 1, 'a world that never rearranges is not plate tectonics');
assert.equal(last.snapshots, Params.ckptCap, 'the checkpoint ring fills up on a long run');
console.log('PASS longrun ' + COARSE_MYR + ' Myr: no NaN, invariants exact, plates 6-40, middle epoch '
	+ middleMean.toFixed(2) + ' cm/yr, ' + last.splits + ' splits and ' + last.merges + ' merges, and continental at '
	+ ACCEPT_MYR + ' Myr ' + (contMean * 100).toFixed(1) + '% as the ' + ENSEMBLE.length + '-seed mean (spread '
	+ (contSpread * 100).toFixed(1) + ' points; the design band is read on the mean because one seed '
	+ 'cannot decide it)');

const short = history(0.01, FINE_MYR);
const coarse = long.epochs[Math.round(FINE_MYR / EPOCH) - 1];
const fine = short.epochs[short.epochs.length - 1];
console.log('dt 0.01, ' + FINE_MYR + ' Myr in ' + short.seconds.toFixed(0)
	+ ' s vs the dt 0.1 run at ' + FINE_MYR + ' Myr:',
	{ plates: [coarse.plates, fine.plates], meanCm: [+coarse.meanCm.toFixed(2), +fine.meanCm.toFixed(2)],
		continental: [+coarse.continental.toFixed(3), +fine.continental.toFixed(3)],
		splits: [coarse.splits, fine.splits], merges: [coarse.merges, fine.merges] });
for (const e of short.epochs) {
	// finite covers NaN, plate ids outside the dense table, and a potential above saturation.
	assert.equal(e.finite, 1, 'state invariant (finite, plate ids, saturation) at t ' + e.t);
	assert.ok(Math.abs(e.felResidual) < 0.01, 'hFel invariant at dt 0.01: ' + e.felResidual);
	assert.ok(e.plates >= 6 && e.plates <= 40, 'plate count at dt 0.01: ' + e.plates);
}
assert.ok(Math.abs(fine.plates - coarse.plates) <= 6, 'plate count drifts with dt');
assert.ok(Math.abs(fine.meanCm - coarse.meanCm) < 0.25 * coarse.meanCm, 'speed drifts with dt');
assert.ok(Math.abs(fine.continental - coarse.continental) < 0.05, 'continental area drifts with dt');
console.log('PASS longrun: ' + FINE_MYR + ' Myr at dt 0.01 matches dt 0.1 at the statistics level');

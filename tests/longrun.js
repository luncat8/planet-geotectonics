// Phase E long run: a hot start cooled for 1500 Myr at dt 0.1, and 300 Myr at dt 0.01 to show
// the world does not depend on the frame step. Acceptance 3 (plate speeds, continental area,
// cratons) and the plan's plate-count window are checked per epoch; acceptance 6 (4500 Myr)
// and the Tm < 0.45 stagnant lid are Phase G work, since Tm only reaches 0.45 at 6.3 Gyr on
// this cooling schedule.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const EPOCH = 100;

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
function history(dt, myr) {
	const g = new Grid(5, 7).build();
	const s = new State(g, 7, 1);              // hot start
	Sim.raster(s);
	const epochs = [];
	const start = performance.now();
	for (let e = 0; e < Math.round(myr / EPOCH); e++) {
		Sim.advance(s, dt, Math.round(EPOCH / dt));
		epochs.push(epochStats(s));
	}
	return { s, epochs, seconds: (performance.now() - start) / 1000 };
}

const long = history(0.1, 1500);
console.log('dt 0.1, hot start, 1500 Myr in ' + long.seconds.toFixed(0) + ' s');
for (const e of long.epochs) {
	console.log('  t ' + e.t.toFixed(0).padStart(4) + ' plates ' + String(e.plates).padStart(3)
		+ ' cols ' + String(e.columns).padStart(5) + ' cont ' + (e.continental * 100).toFixed(1).padStart(5) + '%'
		+ ' craton ' + (e.craton * 100).toFixed(2).padStart(5) + '% mean ' + e.meanCm.toFixed(2).padStart(5)
		+ ' cm/yr max ' + e.maxCm.toFixed(2).padStart(5) + ' Tm ' + e.Tm.toFixed(2)
		+ ' splits ' + String(e.splits).padStart(3) + ' merges ' + String(e.merges).padStart(3)
		+ ' snapshots ' + e.snapshots);
}
const last = long.epochs[long.epochs.length - 1];
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
assert.ok(last.continental >= 0.15 && last.continental <= 0.4, 'continental area ' + last.continental);
assert.ok(last.craton > 0, 'cratons must exist by 1500 Myr');
assert.ok(last.splits >= 1 && last.merges >= 1, 'a world that never rearranges is not plate tectonics');
assert.equal(last.snapshots, Params.ckptCap, 'the checkpoint ring fills up on a long run');
console.log('PASS longrun 1500 Myr: no NaN, invariants exact, plates 6-40, middle epoch '
	+ middleMean.toFixed(2) + ' cm/yr, continental ' + (last.continental * 100).toFixed(1) + '%, '
	+ last.splits + ' splits and ' + last.merges + ' merges');

const short = history(0.01, 300);
const coarse = long.epochs[2];                 // the same 300 Myr on the 100 kyr step
const fine = short.epochs[short.epochs.length - 1];
console.log('dt 0.01, 300 Myr in ' + short.seconds.toFixed(0) + ' s vs the dt 0.1 run at 300 Myr:',
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
console.log('PASS longrun: 300 Myr at dt 0.01 matches dt 0.1 at the statistics level');

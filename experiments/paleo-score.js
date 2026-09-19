// Forward-reconstruction gate (0.4.5 plan §8): run a historical checkpoint pack to the
// present and track how close its drifting land mask gets to the modern map, as
// intersection-over-union of exposed-land masks on the same grid. This is the
// convergence evidence for the "start from today, stage the older checkpoints" roadmap:
// a checkpoint earns its place once a forward run from it stays finite and its IoU
// trajectory toward the modern mask is non-degenerate.
//
//   node experiments/paleo-score.js [--start=pangaea] [--myr=250] [--level=5] [--seed=7]
//                                   [--dt=0.1] [--preset=realistic] [--every=25]
//
// The modern reference is the committed present-day pack's own land mask (its coastline
// is the official 0 Ma reconstruction at the true 70.81% sea level). Run it on the
// owner rig for the full epoch; a full 250 Myr at L5/dt 0.1 is 2,500 steps (~1 min).
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Earth = require('../js/earth.js');
require('../js/data/earth-1deg.js');
require('../js/data/earth-250Ma.js');
require('../js/data/earth-200Ma.js');

const flag = (name, value) => {
	const arg = process.argv.find(a => a.startsWith('--' + name + '='));
	return arg === undefined ? value : arg.slice(name.length + 3);
};
const START = flag('start', 'pangaea');
const LEVEL = +flag('level', 5), SEED = +flag('seed', 7);
const DT = +flag('dt', 0.1), EVERY = +flag('every', 25);
const PRESET = flag('preset', 'realistic');

const startPack = Earth.pick(LEVEL, START);
const refPack = Earth.pick(LEVEL, 'earth');
if (!startPack || !refPack) { console.error('FAIL: missing pack for start=' + START); process.exit(1); }

const grid = new Grid(LEVEL, SEED).build();
const refMask = Earth.landFromPack(refPack, grid);
const refLand = Earth.fraction(refMask);

const t0 = Date.now();
const state = new State(grid, SEED);
Earth.apply(state, startPack, { realistic: PRESET === 'realistic' });
console.log('[*] paleo-score: ' + startPack.name + ' ' + startPack.w + 'x' + startPack.h
	+ ' (' + startPack.plates.count + ' plates, epoch ' + startPack.epoch + ' Ma) -> modern reference'
	+ ', L' + LEVEL + ' seed ' + SEED + ', dt ' + DT + ', preset ' + PRESET);
console.log('    reference modern mask: land ' + (100 * refLand).toFixed(2) + '% of ' + grid.V + ' cells');

function row(tag) {
	const m = Earth.landFromState(state);
	const iou = Earth.iou(m, refMask);
	const land = Earth.fraction(m);
	return tag + ' · ' + state.plateCount + ' plates · gaps ' + state.gaps
		+ ' · ' + (state.meanSpeed / 10000).toFixed(2) + ' cm/yr'
		+ ' · land ' + (100 * land).toFixed(2) + '%'
		+ ' · IoU ' + iou.iou.toFixed(4);
}

let failed = false;
let next = EVERY, bestIou = -1, bestT = 0;
{
	const iou0 = Earth.iou(Earth.landFromState(state), refMask);
	bestIou = iou0.iou; bestT = 0;
	console.log('t 0 Myr · ' + row(''));
}
while (state.t < startPack.epoch - DT / 2) {
	Sim.step(state, DT);
	if (!state.finite) {
		console.error('FAIL: world went non-finite at t ' + state.t.toFixed(1) + ' Myr');
		failed = true;
		break;
	}
	if (state.plateCount > state.plateCap || state.meanSpeed > 600000) {
		console.error('FAIL: plates ' + state.plateCount + ' / meanSpeed ' + state.meanSpeed + ' at t ' + state.t.toFixed(1) + ' Myr');
		failed = true;
		break;
	}
	if (state.t >= next - DT / 2) {
		const iou = Earth.iou(Earth.landFromState(state), refMask);
		if (iou.iou > bestIou) { bestIou = iou.iou; bestT = state.t; }
		console.log('t ' + state.t.toFixed(0) + ' Myr · ' + row(''));
		next += EVERY;
	}
}
const finalIou = Earth.iou(Earth.landFromState(state), refMask).iou;
console.log((failed ? 'FAIL' : 'PASS') + ' paleo-score: ' + startPack.name + ' -> present in '
	+ (Date.now() - t0) / 1000 + ' s · final t ' + state.t.toFixed(0) + ' Myr · final IoU ' + finalIou.toFixed(4)
	+ ' · best IoU ' + bestIou.toFixed(4) + ' at t ' + bestT.toFixed(0) + ' Myr'
	+ ' · trend ' + (finalIou >= bestIou - 1e-9 ? 'held' : (finalIou > 0.05 ? 'decayed' : 'collapsed')));
process.exit(failed ? 1 : 0);

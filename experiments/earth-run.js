// Earth start long-hold gate (0.4.0 plan §7): the short profile test runs 10 Myr from the
// committed 1° pack; this is the 100 Myr owner-rig gate - realistic preset, L5. Run on the
// real machine, not in the sandbox:
//   node experiments/earth-run.js [--myr=100] [--level=5] [--seed=7] [--preset=realistic]
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Earth = require('../js/earth.js');
require('../js/data/earth-1deg.js');

const flag = (name, value) => {
	const arg = process.argv.find(a => a.startsWith('--' + name + '='));
	return arg === undefined ? value : arg.slice(name.length + 3);
};
const LEVEL = +flag('level', 5), MYR = +flag('myr', 100), DT = +flag('dt', 0.1), SEED = +flag('seed', 7);
const PRESET = flag('preset', 'realistic');

const pack = Earth.pick(LEVEL);
if (!pack) { console.error('no Earth pack registered'); process.exit(1); }
const t0 = Date.now();
const state = new State(new Grid(LEVEL, SEED).build(), SEED);
Earth.apply(state, pack, { realistic: PRESET === 'realistic' });
console.log(Earth.describe(Earth.score(state, pack)) + ' · preset ' + PRESET);

function row() {
	let wet = 0, covered = 0;
	for (let c = 0; c < state.grid.V; c++) {
		const z = state.z[c];
		if (z !== z) continue;
		covered++;
		if (z < 0) wet++;
	}
	return 't ' + state.t.toFixed(0) + ' Myr · ' + state.plateCount + ' plates · gaps ' + state.gaps
		+ ' · ' + (state.meanSpeed / 10000).toFixed(2) + '/' + (state.maxSpeed / 10000).toFixed(2) + ' cm/yr mean/max'
		+ ' · wet ' + (100 * wet / covered).toFixed(2) + '% · cols ' + state.n;
}

let next = 10, failed = false;
while (state.t < MYR - DT / 2) {
	Sim.step(state, DT);
	if (!state.finite) { console.error('FAIL: world went non-finite at t ' + state.t.toFixed(1) + ' Myr'); failed = true; break; }
	if (state.t >= next - DT / 2) { console.log(row()); next += 10; }
}
if (!failed) {
	// Acceptance window: finite everywhere, mean speed below the pack's fastest pole
	// (Rivera, ~51 cm/yr) plus margin for event-born plates, no plate explosion.
	if (state.meanSpeed > 600000) { console.error('FAIL: mean speed ' + state.meanSpeed); failed = true; }
	if (state.plateCount > state.plateCap) { console.error('FAIL: plate count ' + state.plateCount); failed = true; }
}
console.log((failed ? 'FAIL' : 'PASS') + ' earth-run: ' + MYR + ' Myr from the ' + pack.w + 'x' + pack.h
	+ ' pack in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
process.exit(failed ? 1 : 0);

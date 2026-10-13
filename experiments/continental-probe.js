// Continental-area probe (acceptance 3, design §10.3): the L5 hot-start history that
// tests/longrun.js gates at 1500 Myr, column-side statistics per epoch.
//
// The 0.5.0 sediment mechanics changed three things at once (collision barrier, collapse,
// the accommodation cap), so this isolates them: each is a switch on the probe, not an edit
// of js/. The barrier switch is the one the design speaks to - §6 grows the barrier with
// continental hFel, the code grew it with hFel + hSed.
//
//   node experiments/continental-probe.js --myr=600 --seed=7 --barrier=fel
//
// switches (all default to the shipped code):
//   --barrier=fel   collision barrier reads hFel only (the design's form)
//   --cap=off       no accommodation limit at deposit or collision (pre-0.5.0 piles)
//   --sedflow=off   sediment does not take part in gravitational collapse
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Plates = require('../js/plates.js'), Contact = require('../js/contact.js');
const ColumnUpdate = require('../js/column-update.js'), Surface = require('../js/surface.js');
const Params = require('../js/params.js');

const EPOCH = 100;
const flag = (name, value) => {
	const arg = process.argv.find(a => a.startsWith('--' + name + '='));
	return arg === undefined ? value : arg.slice(name.length + 3);
};
const SEED = +flag('seed', 7), LEVEL = +flag('level', 5), MYR = +flag('myr', 1500), DT = +flag('dt', 0.1);
const BARRIER = flag('barrier', 'sed'), CAP = flag('cap', 'on'), SEDFLOW = flag('sedflow', 'on');

// A per-run zero array, swapped into s.hSed for the one kernel that should not see it, so
// a variant reads the same code path with the sediment term removed rather than a copy of it.
let zeroSed = null;
function withoutSed(s, fn) {
	const real = s.hSed;
	if (!zeroSed || zeroSed.length < real.length) zeroSed = new Float64Array(real.length);
	s.hSed = zeroSed;
	try { fn(); } finally { s.hSed = real; }
}
if (BARRIER === 'fel') {
	const forces = Plates.forces;
	Plates.forces = function (s, dt) { withoutSed(s, () => forces(s, dt)); };
}
if (SEDFLOW === 'off') {
	const collapse = ColumnUpdate.collapse;
	ColumnUpdate.collapse = function (s, dt) { withoutSed(s, () => collapse(s, dt)); };
}
if (CAP === 'off') {
	const receive = Contact.receiveSed;
	Contact.receiveSed = function (s, w, amount, A0) { return amount; };
}

function epochStats(s) {
	let n = 0, continental = 0, craton = 0, felSum = 0, sedSum = 0, thick = 0, area = 0;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		n++;
		area += s.A0ref;
		felSum += s.hFel[i]; sedSum += s.hSed[i];
		if (s.hFel[i] > 20000) continental++;
		if (s.hFel[i] + s.hSed[i] > Params.hCollapse) thick++;
		if (s.hFel[i] > 30000 && s.age[i] > 300) craton++;
	}
	// The felsic budget as global-equivalent thickness: how much crust the arcs made, how much
	// erosion moved into sediment, and what is left as crust. Continental area is a statement
	// about the distribution of what is left, so this separates "less made" from "spread thin".
	const km = 1 / (area * 1000);
	return { t: s.t, plates: s.plateCount, columns: n, splits: s.splits, merges: s.merges,
		meanCm: s.meanSpeed / 10000, Tm: s.Tm,
		continental: continental / n, craton: craton / n,
		felKm: felSum / n / 1000, sedKm: sedSum / n / 1000, thick: thick / n,
		prodFel: s.producedFel * km, erodFel: s.erodedFel * km, leftFel: s.massFel * km,
		leftSed: s.massSed * km, subSed: s.subductedSed * km,
		fel: (s.massFel0 + s.producedFel - s.massFel) / s.massFel,
		maf: (s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf) / s.massMaf };
}

console.log('continental probe · seed ' + SEED + ' L' + LEVEL + ' · ' + MYR + ' Myr at dt ' + DT
	+ ' · barrier=' + BARRIER + ' cap=' + CAP + ' sedflow=' + SEDFLOW);
const s = new State(new Grid(LEVEL, SEED).build(), SEED, 1);
s.ckptCap = 0;
Sim.raster(s);
const start = performance.now();
const epochs = [];
for (let e = 0; e < Math.round(MYR / EPOCH); e++) {
	Sim.advance(s, DT, Math.round(EPOCH / DT));
	epochs.push(epochStats(s));
}
for (const a of epochs) {
	console.log('  t ' + a.t.toFixed(0).padStart(4) + ' plates ' + String(a.plates).padStart(3)
		+ ' cols ' + String(a.columns).padStart(5) + ' cont ' + (a.continental * 100).toFixed(1).padStart(5) + '%'
		+ ' craton ' + (a.craton * 100).toFixed(2).padStart(5) + '%'
		+ ' hFel ' + a.felKm.toFixed(2).padStart(5) + ' km hSed ' + a.sedKm.toFixed(2).padStart(5) + ' km'
		+ ' over ' + (a.thick * 100).toFixed(1).padStart(4) + '%'
		+ ' mean ' + a.meanCm.toFixed(2).padStart(5) + ' cm/yr Tm ' + a.Tm.toFixed(2)
		+ ' cycle ' + a.splits + '/' + a.merges
		+ ' | arc ' + a.prodFel.toFixed(2).padStart(5) + ' ero ' + a.erodFel.toFixed(2).padStart(5)
		+ ' crust ' + a.leftFel.toFixed(2).padStart(5) + ' sed ' + a.leftSed.toFixed(2).padStart(5)
		+ ' sub ' + a.subSed.toFixed(2).padStart(5) + ' km'
		+ ' | resid ' + a.fel.toExponential(1));
}
console.log('  ' + ((performance.now() - start) / 1000).toFixed(0) + ' s');

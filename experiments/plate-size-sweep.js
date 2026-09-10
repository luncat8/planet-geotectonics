// Plate-size sweep: minPlateCells x absorb floor, 1 Gyr at L4 for both starts.
// The knob the plan names for plate-count balance (0.2-plan §E1); absorb floor is the
// other half of the size floor - fragments below it are re-absorbed each cycle.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Params = require('../js/params.js');
const Events = require('../js/events.js');

const LEVEL = 4, SEED = 7, MYR = 1000, DT = 0.1;
const CONFIGS = [
	{ min: 100, absorb: 0.5 },
	{ min: 100, absorb: 1.0 },
	{ min: 250, absorb: 0.5 },
	{ min: 250, absorb: 1.0 },
	{ min: 400, absorb: 1.0 }
];

function stats(s, g) {
	const sizes = [];
	for (let p = 0; p < s.plateCount; p++) if (!s.plateDead[p] && s.plateCells[p] > 0) sizes.push(s.plateCells[p]);
	sizes.sort((a, b) => a - b);
	let boundary = 0;
	for (let c = 0; c < g.V; c++) {
		for (let k = 0; k < g.ringN[c]; k++) if (s.edgeType[c * 6 + k] !== 0) { boundary++; break; }
	}
	const share = s.plateCount ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
	return { plates: s.plateCount, med: sizes[sizes.length >> 1] || 0, min: sizes[0] || 0,
		boundary: +(100 * boundary / g.V).toFixed(1), mean: Math.round(share), splits: s.splits, merges: s.merges };
}

for (const cfg of CONFIGS) {
	Params.minPlateCells = cfg.min;
	const realAbsorb = Events.absorb;
	Events.absorb = function (s) {
		const cap = s.plateCap, nP = s.plateCount, floor = Events.minCells(s) * cfg.absorb;
		for (var a = 0; a < nP; a++) {
			if (s.plateDead[a] || s.plateCells[a] >= floor) continue;
			var best = -1, bestLen = 0;
			for (var b = 0; b < nP; b++) {
				if (b === a || s.plateDead[b]) continue;
				var slot = (a < b ? a : b) * cap + (a < b ? b : a);
				if (s.pairLen[slot] <= bestLen) continue;
				bestLen = s.pairLen[slot]; best = b;
			}
			if (best >= 0) Events.merge(s, a, best);
		}
	};
	for (const hot of [false, true]) {
		const g = new Grid(LEVEL, SEED).build(), s = new State(g, SEED, hot);
		s.ckptCap = 0;
		Sim.raster(s);
		const t0 = Date.now();
		Sim.advance(s, DT, Math.round(MYR / DT));
		const r = stats(s, g);
		console.log(`min ${String(cfg.min).padStart(3)} absorb ${cfg.absorb.toFixed(1)} ${hot ? 'hot ' : 'map'}` +
			` | t ${s.t.toFixed(0)} plates ${String(r.plates).padStart(2)} med ${String(r.med).padStart(4)} min ${String(r.min).padStart(4)}` +
			` mean ${String(r.mean).padStart(4)} boundary ${String(r.boundary).padStart(5)}% splits ${String(r.splits).padStart(3)} merges ${String(r.merges).padStart(3)}` +
			` | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
	}
	Events.absorb = realAbsorb;
}

// Corridor geometry vs the damage threshold, on an unperturbed world (splitting switched off).
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Events = require('../js/events.js'), Params = require('../js/params.js');
const level = +(process.argv[2] || 4), myr = +(process.argv[3] || 300), hot = process.argv[4] === 'hot';
const g = new Grid(level, 7).build(), s = new State(g, 7, hot);
Events.split = function () {};
Sim.raster(s); Sim.advance(s, 0.1, myr / 0.1);
const min = Events.minCells(s);
const hist = new Float64Array(11);
for (let i = 0; i < s.n; i++) { if (!s.alive[i]) continue; hist[Math.min(10, Math.floor(s.damage[i] * 10))]++; }
console.log({ level, myr, hot, kDam: Params.kDam, minCells: min, plates: s.plateCount, Tm: +s.Tm.toFixed(3) });
console.log('damage hist', Array.from(hist).map(v => Math.round(v)).join(','));
for (const thr of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
	let splittable = 0, noCorridor = 0, fracSum = 0, over = 0;
	for (let plate = 0; plate < s.plateCount; plate++) {
		if (s.plateCells[plate] < 2 * min) continue;
		const nComp = Events.components(s, plate, thr);
		let cells = 0, corridor = 0;
		for (let c = 0; c < g.V; c++) { if (s.cellPlate[c] !== plate) continue; cells++; corridor += s.corridor[c]; }
		let big = 0;
		for (let i = 0; i < nComp; i++) if (s.compSize[i] >= min) big++;
		fracSum += corridor / Math.max(1, cells);
		if (big < 2) continue;
		if (corridor === 0) { noCorridor++; continue; }
		if (corridor * 2 > cells) continue;
		splittable++;
	}
	for (let i = 0; i < s.n; i++) if (s.alive[i] && s.damage[i] > thr) over++;
	console.log('thr', thr, 'corridorFrac', (fracSum / s.plateCount).toFixed(3), 'colFracOver', (over / s.n).toFixed(4),
		'splittable', splittable, 'fragmentedOnly', noCorridor);
}

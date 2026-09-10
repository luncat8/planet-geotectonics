// Plate fragmentation probe: run to 1 Gyr and sample plate count/size distribution and
// the share of the map that is boundary (any cell with a non-interior edge), per type.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Params = require('../js/params.js');
const level = +(process.argv[2] || 5), hot = process.argv[3] === 'hot';
const seed = +(process.argv[4] || 7);
const g = new Grid(level, seed).build(), s = new State(g, seed, hot);
s.ckptCap = 0;
Sim.raster(s);
console.log(`level ${level} ${hot ? 'hot' : 'map'} seed ${seed}  V=${g.V}`);
console.log('t[Myr] plates medCell minCell p<300c boundary% subd% ridge% trans% coll% splits merges cols');
function sample() {
	const nP = s.plateCount, sizes = [];
	for (let p = 0; p < nP; p++) if (!s.plateDead[p] && s.plateCells[p] > 0) sizes.push(s.plateCells[p]);
	sizes.sort((a, b) => a - b);
	const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
	const min = sizes.length ? sizes[0] : 0;
	const small = sizes.filter(v => v < 300).length;
	let boundary = 0, subd = 0, ridge = 0, trans = 0, coll = 0, edges = 0;
	const byLen = [0, 0, 0, 0];
	for (let c = 0; c < g.V; c++) {
		let kind = 0;
		for (let k = 0; k < g.ringN[c]; k++) {
			const e = c * 6 + k, t = s.edgeType[e];
			if (t === 0 || e % 6 > 0 && s.edgeType[c * 6 + 0] === -1) continue;
			if (t !== 0) {
				byLen[t] += g.edgeLen[e]; edges += g.edgeLen[e];
				if (t === 1) kind = Math.max(kind, s.polarity[e] === 2 ? 4 : 3);
				else kind = Math.max(kind, t);
			}
		}
		if (kind > 0) boundary++;
		if (kind === 3 || kind === 4) subd++;
		else if (kind === 2) ridge++;
		else if (kind === 1) trans++;
		else if (kind === 4) coll++;
	}
	const pct = v => (100 * v / g.V).toFixed(1).padStart(5);
	const lenPct = v => (100 * v / edges).toFixed(1).padStart(5);
	console.log(`${s.t.toFixed(0).padStart(6)} ${String(nP).padStart(6)} ${String(med).padStart(7)} ${String(min).padStart(7)} ${String(small).padStart(6)}` +
		` ${pct(boundary)} ${lenPct(byLen[1])} ${lenPct(byLen[2])} ${lenPct(byLen[3])} ${pct(0)} ${String(s.splits).padStart(6)} ${String(s.merges).padStart(6)} ${String(s.n).padStart(6)}`);
}
for (let e = 0; e < 20; e++) {
	sample();
	Sim.advance(s, 0.1, 500);
}
sample();

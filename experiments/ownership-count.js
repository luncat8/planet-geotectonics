// Throwaway measurement for the Phase H port: how often does a column own more than one
// cell (the only case where a per-cell pass writing into column state is order-sensitive),
// and how often does the overlap scan see exact distance ties?
const Grid = require('../js/geodesics.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');

const grid = new Grid(5, 7).build();
const s = new State(grid, 7, true);
Sim.raster(s);
let multi = 0, owners = 0, tieOverlap = 0, pairChecks = 0;
for (let f = 0; f < 600; f++) {
	Sim.step(s, 0.1);
	if (f % 10 === 0) {
		const count = new Uint32Array(s.colCap);
		for (let c = 0; c < grid.V; c++) if (s.owner[c] >= 0) count[s.owner[c]]++;
		let m = 0, o = 0;
		for (let i = 0; i < s.colCap; i++) { if (count[i] > 0) o++; if (count[i] > 1) m++; }
		multi += m; owners += o;
	}
	// overlap ties: exact equal squared distances between distinct foreign columns
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		const c = s.cell[i];
		const seen = new Map();
		for (let k = -1; k < grid.ringN[c]; k++) {
			const bin = k < 0 ? c : grid.ring[c * 6 + k];
			for (let at = s.offset[bin]; at < s.offset[bin + 1]; at++) {
				const j = s.entries[at];
				if (j === i || s.plate[j] === s.plate[i]) continue;
				const d = (s.world[j*3]-s.world[i*3])**2 + (s.world[j*3+1]-s.world[i*3+1])**2 + (s.world[j*3+2]-s.world[i*3+2])**2;
				pairChecks++;
				if (seen.has(d)) tieOverlap++;
				seen.set(d, j);
			}
		}
	}
}
console.log('columns owning >1 cell (sampled):', multi, '/', owners, '=', (100*multi/owners).toFixed(3) + '%');
console.log('exact distance ties in overlap scan:', tieOverlap, '/', pairChecks, '=', (100*tieOverlap/pairChecks).toFixed(4) + '%');

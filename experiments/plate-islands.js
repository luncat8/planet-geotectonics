// Where do plate-map islands come from? For each plate keep its largest connected cell
// component; every cell outside it is an island. Histogram islands by the owning column's
// crust type and age: young oceanic => ridge spawn misassignment, old continental => the
// interleave came from collision/merge geometry.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const level = +(process.argv[2] || 5), hot = process.argv[3] === 'hot';
const myr = +(process.argv[4] || 1000);
const g = new Grid(level, 7).build(), s = new State(g, 7, hot);
s.ckptCap = 0;
Sim.raster(s);
Sim.advance(s, 0.1, Math.round(myr / 0.1));
const comp = new Int32Array(g.V).fill(-1);
const queue = new Int32Array(g.V);
let next = 0;
const compSize = [], compPlate = [];
for (let c = 0; c < g.V; c++) {
	if (comp[c] >= 0 || s.cellPlate[c] === 65535) continue;
	const id = next++, plate = s.cellPlate[c];
	let head = 0, tail = 0, size = 0;
	queue[tail++] = c; comp[c] = id;
	while (head < tail) {
		const cur = queue[head++]; size++;
		for (let k = 0; k < g.ringN[cur]; k++) {
			const j = g.ring[cur * 6 + k];
			if (j < 0 || comp[j] >= 0 || s.cellPlate[j] !== plate) continue;
			comp[j] = id; queue[tail++] = j;
		}
	}
	compSize.push(size); compPlate.push(plate);
}
// largest component per plate
const main = new Map();
for (let id = 0; id < compSize.length; id++) {
	const p = compPlate[id];
	if (!main.has(p) || compSize[id] > compSize[main.get(p)]) main.set(p, id);
}
let islandCells = 0, covered = 0;
const ocean = 14000;
const buckets = { youngOcean: 0, midOcean: 0, oldOcean: 0, youngCont: 0, oldCont: 0 };
for (let c = 0; c < g.V; c++) {
	const p = s.cellPlate[c];
	if (p === 65535) continue;
	covered++;
	if (comp[c] === main.get(p)) continue;
	islandCells++;
	const o = s.owner[c];
	const cont = o >= 0 && s.hFel[o] >= ocean;
	const age = o >= 0 ? s.age[o] : 0;
	if (cont) { if (age > 100) buckets.oldCont++; else buckets.youngCont++; }
	else if (age > 300) buckets.oldOcean++;
	else if (age > 50) buckets.midOcean++;
	else buckets.youngOcean++;
}
console.log(`t=${s.t.toFixed(0)} plates=${main.size} components=${compSize.length} covered=${covered}`);
console.log(`island cells (outside their plate's main component): ${islandCells} = ${(100 * islandCells / covered).toFixed(1)}%`);
console.log('island crust:', JSON.stringify(buckets));
// how fragmented is each plate: cells in non-main components per plate
const perPlate = new Map();
for (let c = 0; c < g.V; c++) {
	const p = s.cellPlate[c];
	if (p === 65535 || comp[c] === main.get(p)) continue;
	perPlate.set(p, (perPlate.get(p) || 0) + 1);
}
const rows = [...perPlate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('worst plates (plate, islandCells):', rows.map(r => r[0] + ':' + r[1]).join(' '));

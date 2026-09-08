// Phase C rifting: one continent pulled apart at prescribed ω. The divergent margin must thin
// from 35 km to rift-valley thickness over a few cells, then start producing oceanic crust,
// without leaving holes inside either plate. The far side of the sphere closes again and
// collides, which is why the statistics are taken around the rift pole only.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Params = require('../js/params.js');
const g = new Grid(4, 7).build();
const R = 6371000;
const s = new State(g, 7);
s.prescribedOmega = 1;
s.plateCount = 2;
s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
for (let i = 0; i < s.n; i++) {
	s.plate[i] = g.pos[i * 3 + 2] >= 0 ? 0 : 1;
	s.hFel[i] = 35000; s.hMaf[i] = 0; s.age[i] = 500;
}
const W = 25000 / R;   // 5 cm/yr of opening at the rift pole
s.omega.fill(0); s.omega[0] = W; s.omega[3] = -W;
Sim.raster(s);
s.rebase();
// Mean crust thickness per graph distance from the plate boundary, around the rift pole.
function profile() {
	const dist = new Int32Array(g.V).fill(-1), queue = new Int32Array(g.V);
	let head = 0, tail = 0;
	for (let c = 0; c < g.V; c++) {
		let foreign = false;
		for (let k = 0; k < g.ringN[c]; k++) if (s.cellPlate[g.ring[c * 6 + k]] !== s.cellPlate[c]) foreign = true;
		if (foreign) { dist[c] = 0; queue[tail++] = c; }
	}
	while (head < tail) {
		const c = queue[head++];
		for (let k = 0; k < g.ringN[c]; k++) {
			const j = g.ring[c * 6 + k];
			if (dist[j] >= 0 || s.cellPlate[j] !== s.cellPlate[c]) continue;
			dist[j] = dist[c] + 1; queue[tail++] = j;
		}
	}
	const bands = [[], [], [], [], [], []];
	for (let c = 0; c < g.V; c++) {
		if (g.pos[c * 3 + 1] < 0.5) continue;
		const o = s.owner[c];
		if (o < 0 || dist[c] < 0) continue;
		bands[Math.min(5, dist[c])].push(s.hFel[o]);
	}
	return bands.map(b => b.reduce((x, y) => x + y, 0) / (b.length || 1) / 1000);
}
Sim.advance(s, 0.1, 400);   // 40 Myr: the margin is thinning but the ocean is still young
const margin = profile();
const rounded = margin.map(v => +v.toFixed(2));
let reaches15 = -1, backTo35 = -1;
for (let b = 0; b < 6; b++) {
	if (reaches15 < 0 && margin[b] <= 15) reaches15 = b;
	if (backTo35 < 0 && margin[b] >= 30) backTo35 = b;
}
Sim.advance(s, 0.1, 1100);  // 150 Myr in total: a wide passive margin with oceanic crust
let oceanic = 0, interiorHoles = 0, gapCells = 0, oldestGap = 0;
for (let i = 0; i < s.n; i++) if (s.alive[i] && s.hFel[i] === 0 && s.hMaf[i] > 5000) oceanic++;
for (let c = 0; c < g.V; c++) {
	if (s.owner[c] >= 0) continue;
	gapCells++;
	if (s.gapTime[c] > oldestGap) oldestGap = s.gapTime[c];
	let covered = 0, same = 0, plate = -1;
	for (let k = 0; k < g.ringN[c]; k++) {
		const o = s.owner[g.ring[c * 6 + k]];
		if (o < 0) continue;
		covered++;
		if (plate < 0) plate = s.plate[o];
		if (s.plate[o] === plate) same++;
	}
	if (covered >= 4 && same === covered) interiorHoles++;
}
const felResidual = Math.abs(s.massFel0 + s.producedFel - s.massFel) / s.massFel0;
console.log({
	myr: +s.t.toFixed(0), columns: s.n, gaps: gapCells, interiorHoles, oceanicColumns: oceanic,
	spawned: [s.plateSpawned[0], s.plateSpawned[1]], lost: [s.plateLost[0], s.plateLost[1]],
	hFelByRiftDistanceAt40Myr: rounded, reaches15KmAtCell: reaches15, undeformedAtCell: backTo35,
	felResidual
});
assert.equal(s.finite, 1);
assert.ok(s.rigidError < 1e-12, 'rigid ' + s.rigidError);
assert.ok(s.quatError < 1e-12, 'quat ' + s.quatError);
assert.ok(margin[5] >= 30, 'craton interior must stay at 35 km, got ' + margin[5].toFixed(1));
assert.ok(reaches15 >= 0, 'the margin must thin below 15 km');
assert.ok(backTo35 - reaches15 <= 4, 'thinning must span at most 4 cells, got ' + (backTo35 - reaches15));
for (let b = 1; b < 6; b++) assert.ok(margin[b] >= margin[b - 1] - 1e-9, 'crust thins monotonically toward the rift');
assert.ok(oceanic > 20, 'oceanic crust must appear, got ' + oceanic);
// A hole may sit out one fillDelay while the crust repacks; none may outlive it.
assert.ok(oldestGap < Params.fillDelay + 0.1, 'a gap outlived the fill delay: ' + oldestGap);
assert.ok(interiorHoles <= 4, 'interior holes ' + interiorHoles);
assert.ok(felResidual < 1e-6, 'hFel ledger ' + felResidual);
console.log('PASS rift: 35 -> ' + rounded[reaches15] + ' km within ' + (backTo35 - reaches15)
	+ ' cells, oceanic crust forms, no interior gaps');

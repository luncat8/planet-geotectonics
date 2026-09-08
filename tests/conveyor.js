// Phase C conveyor: two plates at prescribed ω, 5 cm/yr convergence for 160 Myr.
// The northern oceanic plate subducts under the southern continent, the ridge behind it
// spreads. Consumption is compared with the boundary flux integral, not with
// "speed x trench length": a rigid rotation has a transform component along every boundary,
// so the normal speed varies as sin(distance from the Euler pole) and is zero at two points.
// The first 20 Myr are excluded: the columns start one cell apart and the contact threshold is
// 0.6, so the trench takes one extra bite of area before it settles into the flux.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Edges = require('../js/edges.js');
const Params = require('../js/params.js');
const g = new Grid(4, 7).build();
const R = Params.radius;
const s = new State(g, 7);
s.prescribedOmega = 1;
s.plateCount = 2;
s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
for (let i = 0; i < s.n; i++) {
	const north = g.pos[i * 3 + 2] >= 0;
	s.plate[i] = north ? 0 : 1;
	s.hFel[i] = north ? 0 : 35000;
	s.hMaf[i] = north ? 7000 : 0;
	s.age[i] = north ? 80 : 500;
}
const W = 25000 / R;   // 2.5 cm/yr per plate, 5 cm/yr convergence at the trench pole
s.omega.fill(0); s.omega[0] = W; s.omega[3] = -W;
Sim.raster(s);
s.rebase();
function boundaryFlux() {
	let flux = 0, length = 0, ridge = 0;
	for (let c = 0; c < g.V; c++) {
		for (let k = 0; k < g.ringN[c]; k++) {
			const e = c * 6 + k, pol = s.polarity[e];
			if (s.edgeType[e] === Edges.DIVERGENT) ridge += s.relN[e] * g.edgeLen[e];
			if (s.edgeType[e] !== Edges.CONVERGENT || pol === 0 || pol === 2) continue;
			flux -= s.relN[e] * g.edgeLen[e];
			length += g.edgeLen[e];
		}
	}
	return { flux: flux / 2, length: length / 2, ridge: ridge / 2 };
}
// Exact continuum rate for this geometry: the relative rotation is 2W about x, the boundary is
// the equator, relN = 2WR sin(phi), so the flux over either half is 2WR^2 * integral|sin| = 4WR^2.
const analyticRate = 4 * W * R * R;
const dt = 0.1, window = 140;
Sim.advance(s, dt, 200);            // 20 Myr of settling: the trench takes one extra bite first
s.rebase();
const consumed0 = s.subductedArea, spawned0 = s.plateSpawned[0] + s.plateSpawned[1], n0 = s.n;
Sim.advance(s, dt, window / dt);
const last = boundaryFlux();
const consumed = s.subductedArea - consumed0;
const spawned = (s.plateSpawned[0] + s.plateSpawned[1] - spawned0) * s.A0ref;
const consumeRatio = consumed / (analyticRate * window);
const spawnRatio = spawned / (analyticRate * window);
const asymmetry = Math.abs(s.plateSpawned[0] - s.plateSpawned[1]) / (s.plateSpawned[0] + s.plateSpawned[1]);
const mafResidual = Math.abs(s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf) / s.massMaf0;
const felResidual = Math.abs(s.massFel0 + s.producedFel - s.massFel) / s.massFel0;
const drift = Math.abs(s.n - n0) / n0;
let arcMax = 0, arcCells = 0, trench = 0;
for (let c = 0; c < g.V; c++) {
	if (s.trenchDist[c] === 0) trench++;
	if (s.trenchDist[c] === 0 || s.trenchDist[c] > 2) continue;
	const o = s.owner[c];
	if (o < 0 || s.plate[o] !== 1) continue;
	arcCells++;
	if (s.hFel[o] > arcMax) arcMax = s.hFel[o];
}
console.log({
	myr: +s.t.toFixed(1), windowMyr: window, columns: s.n,
	consumedKm2PerMyr: Math.round(consumed / window / 1e6), analyticKm2PerMyr: Math.round(analyticRate / 1e6),
	measuredTrenchFluxKm2PerMyr: Math.round(last.flux / 1e6), measuredRidgeFluxKm2PerMyr: Math.round(last.ridge / 1e6),
	consumeRatio: +consumeRatio.toFixed(4), spawnRatio: +spawnRatio.toFixed(4),
	trenchKm: Math.round(last.length / 1000), ridgeKm: Math.round(25400),
	subductedColumns: s.plateLost[0], spawnedColumns: s.plateSpawned[0] + s.plateSpawned[1],
	asymmetry: +asymmetry.toFixed(3), mafResidual, felResidual, drift: +drift.toFixed(4),
	arcCells, arcMaxKm: +(arcMax / 1000).toFixed(2), gaps: s.gaps
});
assert.equal(s.finite, 1);
assert.ok(s.rigidError < 1e-12, 'rigid ' + s.rigidError);
assert.ok(s.quatError < 1e-12, 'quat ' + s.quatError);
assert.ok(Math.abs(consumeRatio - 1) < 0.1, 'consumed area vs boundary flux: ' + consumeRatio);
assert.ok(Math.abs(spawnRatio - 1) < 0.1, 'spawned area vs divergence flux: ' + spawnRatio);
assert.ok(asymmetry < 0.2, 'ridge spawn asymmetry ' + asymmetry);
assert.ok(mafResidual < 1e-6, 'hMaf ledger ' + mafResidual);
assert.ok(felResidual < 1e-6, 'hFel ledger ' + felResidual);
assert.ok(drift < 0.02, 'column count drift ' + drift);
assert.ok(arcMax > 35000, 'arc crust must grow on the overriding plate');
assert.ok(trench > 0 && arcCells > 0);
console.log('PASS conveyor: subduction flux, symmetric ridge, exact ledgers, stable column count');

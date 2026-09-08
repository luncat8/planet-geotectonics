const { assert, Grid, State, Sim } = require('./helpers.js');
const Edges = require('../js/edges.js');
const g = new Grid(5, 7).build();
for (const dt of [0.1, 0.01]) {
	const s = new State(g, 7);
	const frames = 5000;
	const start = performance.now();
	Sim.advance(s, dt, frames);
	const cm = s.meanSpeed / 10000, maxCm = s.maxSpeed / 10000;
	let conv = 0, div = 0, trans = 0;
	for (let e = 0; e < s.edgeType.length; e++) {
		if (s.edgeType[e] === Edges.CONVERGENT) conv++;
		else if (s.edgeType[e] === Edges.DIVERGENT) div++;
		else if (s.edgeType[e] === Edges.TRANSFORM) trans++;
	}
	console.log({ dt, Myr: s.t, cm, maxCm, conv, div, trans, rigid: s.rigidError, quat: s.quatError, finite: s.finite, msPerFrame: (performance.now() - start) / frames });
	assert.equal(s.finite, 1);
	assert.ok(s.rigidError < 1e-12);
	assert.ok(s.quatError < 1e-12);
	assert.ok(cm >= 1 && cm <= 10, 'mean speed ' + cm);
	assert.ok(maxCm <= 20);
	assert.ok(conv > 0 && div > 0);
}
console.log('PASS kinematics: 16 plates, rigid v, speeds 1–10 cm/yr, mixed boundaries');

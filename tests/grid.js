const { assert, Grid } = require('./helpers.js');
for (const level of [0, 3, 5]) {
	const g = new Grid(level, 7).build();
	assert.equal(g.V, 10 * 4 ** level + 2);
	assert.equal(g.ringN.filter(n => n === 5).length, 12);
	assert.equal(g.cellC, undefined);
	let area = 0;
	for (let c = 0; c < g.V; c++) {
		area += g.A0[c];
		assert.ok(Math.abs(Math.hypot(...g.pos.subarray(c * 3, c * 3 + 3)) - 1) < 1e-14);
		for (let k = 0; k < 6; k++) {
			const e = c * 6 + k, j = g.ring[e];
			if (k >= g.ringN[c]) { assert.equal(j, -1); continue; }
			assert.ok(g.ring.subarray(j * 6, j * 6 + 6).includes(c));
			const n = g.faceN.subarray(e * 3, e * 3 + 3);
			const t = g.faceT.subarray(e * 3, e * 3 + 3);
			assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-14);
			assert.ok(Math.abs(Math.hypot(...t) - 1) < 1e-14);
			assert.ok(Math.abs(n[0] * g.pos[c * 3] + n[1] * g.pos[c * 3 + 1] + n[2] * g.pos[c * 3 + 2]) < 1e-12);
			assert.ok(Math.abs(t[0] * n[0] + t[1] * n[1] + t[2] * n[2]) < 1e-12);
			const scale = 0.5 * g.edgeLen[e] / g.A0[c];
			assert.ok(Math.abs(g.fluxN[e * 3] - n[0] * scale) < 1e-18);
			const back = g.ring.subarray(j * 6, j * 6 + g.ringN[j]).indexOf(c);
			assert.ok(back >= 0);
			assert.equal(g.collapseWeight[e], g.collapseWeight[j * 6 + back]);
		}
	}
	if (level === 5) assert.ok(Math.abs(area / (4 * Math.PI * 6371000 ** 2) - 1) < 0.001);
	console.log('PASS grid L' + level + ': ' + g.V + ' cells');
}

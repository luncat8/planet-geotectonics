const { assert, Grid, State } = require('./helpers.js');
const Mantle = require('../js/mantle.js');
const Params = require('../js/params.js');
const g = new Grid(5, 7).build();
const s = new State(g, 7);
s.plumeCount = 0;
Mantle.update(s);
let mean = 0, polDiv = 0, rigDiv = 0;
const scratch = s.scratch, R = Params.radius, Ox = 0.01, Oy = -0.02, Oz = 0.015;
function divOf(field) {
	let rms = 0;
	for (let c = 0; c < g.V; c++) {
		let flux = 0;
		for (let k = 0; k < g.ringN[c]; k++) {
			const e = c * 6 + k, j = g.ring[e], b = c * 3, jb = j * 3;
			const ux = field[jb] - field[b], uy = field[jb + 1] - field[b + 1], uz = field[jb + 2] - field[b + 2];
			flux += 0.5 * (ux * g.faceN[e * 3] + uy * g.faceN[e * 3 + 1] + uz * g.faceN[e * 3 + 2]) * g.edgeLen[e];
		}
		const d = flux / g.A0[c];
		rms += d * d;
	}
	return Math.sqrt(rms / g.V);
}
const pol = new Float64Array(g.V * 3), rigid = new Float64Array(g.V * 3);
const speed = Params.U0 * Math.pow(s.Tm, 2.5);
for (let c = 0; c < g.V; c++) {
	const b = c * 3, mag = Math.hypot(s.uMantle[b], s.uMantle[b + 1], s.uMantle[b + 2]);
	mean += mag;
	Mantle.rawAt(s, g.pos[b], g.pos[b + 1], g.pos[b + 2], scratch, 0, 1);
	const px = scratch[0] * s.mantleScale * speed, py = scratch[1] * s.mantleScale * speed, pz = scratch[2] * s.mantleScale * speed;
	pol[b] = px; pol[b + 1] = py; pol[b + 2] = pz;
	const x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2];
	rigid[b] = R * (Oy * z - Oz * y);
	rigid[b + 1] = R * (Oz * x - Ox * z);
	rigid[b + 2] = R * (Ox * y - Oy * x);
}
mean /= g.V; polDiv = divOf(pol); rigDiv = divOf(rigid);
assert.ok(Math.abs(mean / speed - 1) < 1e-9, 'mean |u| should match U0 Tm^2.5 at t=0');
assert.ok(polDiv > 100 * rigDiv, 'poloidal divergence must be far above a rigid rotation');
assert.ok(polDiv > 1e-4);
s.t = 250; Mantle.update(s);
let later = 0;
for (let c = 0; c < g.V; c++) later += Math.hypot(s.uMantle[c * 3], s.uMantle[c * 3 + 1], s.uMantle[c * 3 + 2]);
later /= g.V;
const laterSpeed = Params.U0 * Math.pow(Mantle.Tm(250), 2.5);
assert.ok(later / laterSpeed > 0.85 && later / laterSpeed < 1.15, 'precession should keep mean speed');
const n = 256, samples = new Float64Array(n);
for (let i = 0; i < n; i++) {
	const lon = i / n * Math.PI * 2;
	Mantle.rawAt(s, Math.cos(lon), 0, Math.sin(lon), scratch, 0);
	samples[i] = scratch[0] * s.mantleScale;
}
function power(k) {
	let re = 0, im = 0;
	for (let i = 0; i < n; i++) {
		const a = 2 * Math.PI * k * i / n;
		re += samples[i] * Math.cos(a); im += samples[i] * Math.sin(a);
	}
	return re * re + im * im;
}
let low = 0, high = 0;
for (let k = 1; k <= 12; k++) low += power(k);
for (let k = 40; k <= 80; k++) high += power(k);
assert.ok(low > 40 * high, 'analytic mantle field must not have grid-scale banding');
console.log('PASS mantle:', { mean, polDiv, rigDiv, laterRatio: later / laterSpeed, lowOverHigh: low / high });

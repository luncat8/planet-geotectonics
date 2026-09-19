// earth.js tests (0.4.0): synthetic-pack decode/sampling/apply, then the committed 1° Earth
// pack against the plan §7 acceptance thresholds.
const { assert, Grid, State, Sim, equal } = require('./helpers.js');
const Water = require('../js/water.js');
const Earth = require('../js/earth.js');

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
function dir(latDeg, lonDeg) {
	const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
	return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)];
}

// --- synthetic pack ------------------------------------------------------------------
// An asymmetric smooth periodic field (so the antimeridian test is meaningful), land where
// z > 0, two hemispheric plates. Not K9-consistent on purpose: decode must clamp, not crash.
function synthPack() {
	const W = 8, H = 4, n = W * H;
	const z = new Int16Array(n), age = new Uint8Array(n), sed = new Uint8Array(n);
	const kind = new Uint8Array(n), ids = new Uint8Array(n);
	for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
		const lon = (-180 + (c + 0.5) * 360 / W) * Math.PI / 180;
		const lat = (-90 + (r + 0.5) * 180 / H) * Math.PI / 180;
		const i = r * W + c;
		const v = Math.round(2500 * Math.cos(lon - 0.35) * Math.cos(lat) - 300);
		z[i] = v; age[i] = 60; sed[i] = 5;
		kind[i] = (v > 0 ? 1 : 0) | (2 << 1);
		ids[i] = lon < 0 ? 0 : 1;
	}
	return {
		name: 'synth', epoch: 0, w: W, h: H, source: 'synthetic', datum: 0, ocean: 0.5,
		scale: { z: 1, age: 1, sed: 0.1 },
		banks: { z: b64(new Uint8Array(z.buffer)), age: b64(age), sed: b64(sed), kind: b64(kind) },
		plates: {
			count: 2, ids: b64(ids),
			seeds: [[1, 0, 0], [-1, 0, 0]],
			poles: [[0, 0, 1, 0.002], [0, 0, 1, -0.002]]
		}
	};
}

const pk = synthPack();
const d = Earth.decode(pk);
assert.equal(Earth.decode(pk), d, 'decode is cached on the pack');
assert.equal(d.z.length, pk.w * pk.h);
assert.equal(d.plate.length, pk.w * pk.h);
assert.equal(d.poles.length, 2 * 4);
// Geographic z-up -> sim y-up swizzle: pole (0,0,1)geo is the north pole, (0,1,0)sim.
assert.deepEqual([...d.poles.slice(0, 3)], [0, 1, 0], 'pole axis swizzled to y-up');
assert.ok(Math.abs(d.poles[3] - 0.002) < 1e-12, 'omega kept');
// The decode-time inversion is the bake's: a synthetic -300 m "oceanic" cell clamps to the
// hMaf floor, a land cell inverts to felsic crust only.
for (let i = 0; i < d.z.length; i++) {
	if (d.kind[i] & 1) assert.ok(d.hMaf[i] === 0 && d.hFel[i] > 0, 'continental inverts to felsic');
	else assert.ok(d.hFel[i] === 0 && d.hMaf[i] >= 2000 && d.hMaf[i] <= 35000, 'oceanic stays in the envelope');
}

// Antimeridian: 179.99E and -180.01 are the same meridian, expressed on opposite sides of
// the seam - sampling them must agree exactly, which only the longitude wrap achieves.
const sc = new Float64Array(5), sc2 = new Float64Array(5);
Earth.coords(pk.w, pk.h, ...dir(0, 179.99), sc);
Earth.sample(d, pk.w, pk.h, sc[0], sc[1], sc);
Earth.coords(pk.w, pk.h, ...dir(0, -180.01), sc2);
Earth.sample(d, pk.w, pk.h, sc2[0], sc2[1], sc2);
for (let k = 0; k < 4; k++) {
	assert.ok(Math.abs(sc[k] - sc2[k]) < 1e-9 * Math.max(1, Math.abs(sc[k])), 'antimeridian wrap bank ' + k);
}
// And the field itself is continuous across the seam: points eps apart on either side agree
// within the bilinear slope (no seam jump).
Earth.coords(pk.w, pk.h, ...dir(0, -179.99), sc2);
Earth.sample(d, pk.w, pk.h, sc2[0], sc2[1], sc2);
for (let k = 0; k < 4; k++) {
	assert.ok(Math.abs(sc[k] - sc2[k]) < 5e-4 * Math.max(1, Math.abs(sc[k])), 'antimeridian continuity bank ' + k);
}
// Poles: latitude clamps to the edge row, so anything at/past 70N (the last row centre is
// 67.5N at H=4) samples identically, NaN-free; mirrored at the south pole.
for (const [over, under] of [[90, 70], [-90, -70]]) {
	Earth.coords(pk.w, pk.h, ...dir(over, 37), sc);
	Earth.sample(d, pk.w, pk.h, sc[0], sc[1], sc);
	Earth.coords(pk.w, pk.h, ...dir(under, 37), sc2);
	Earth.sample(d, pk.w, pk.h, sc2[0], sc2[1], sc2);
	for (let k = 0; k < 4; k++) {
		assert.ok(Number.isFinite(sc[k]), 'pole sample is finite');
		assert.equal(sc2[k], sc[k], 'latitude clamp at ' + over);
	}
}

// Apply + determinism + ledgers + a short run on the synthetic pack (L3).
function synthState(seed, opts) {
	const g = new Grid(3, seed).build();
	const s = new State(g, seed);
	Earth.apply(s, pk, opts || {});
	return s;
}
const sa = synthState(11), sb = synthState(11);
equal(sa, sb);
assert.equal(sa.plateCount, 2);
for (let i = 0; i < sa.n; i++) {
	assert.ok(sa.plate[i] < sa.plateCount, 'plate id within plateCount');
	assert.ok(Number.isFinite(sa.hFel[i] + sa.hMaf[i] + sa.hSed[i] + sa.age[i] + sa.fert[i]));
}
assert.equal(sa.producedFel, 0, 'rebase zeroes the ledgers');
assert.ok(sa.massFel0 > 0 && sa.massMaf0 > 0, 'rebase anchors the Earth masses');
Sim.advance(sa, 0.1, 30);
Sim.advance(sb, 0.1, 30);
equal(sa, sb);
assert.equal(sa.finite, 1, 'synthetic run stays finite');

// --- the committed 1° pack -------------------------------------------------------------
require('../js/data/earth-1deg.js');
const pack = Earth.pick(5);
assert.equal(pack.w, 360, 'L5 gets the 1° pack');
assert.equal(Earth.pick(7).w >= 360, true);
const g = new Grid(5, 7).build();
const t0 = Date.now();
const s = new State(g, 7);
Earth.apply(s, pack, { realistic: true });
assert.ok(Date.now() - t0 < 5000, 'apply is fast');
assert.equal(s.plateCount, pack.plates.count);
assert.equal(s.prescribedOmega, 1, 'realistic holds the poles');
assert.equal(s.cooling, 0, 'realistic pins the thermal budget');
// Every plate carries its NNR-MORVEL pole, swizzled to y-up and un-clamped.
const dp = Earth.decode(pack);
for (let p = 0; p < s.plateCount; p++) {
	const wb = p * 3, pb = p * 4, om = dp.poles[pb + 3];
	assert.ok(om > 0, 'plate ' + p + ' has a pole');
	assert.ok(Math.abs(s.omega[wb] - dp.poles[pb] * om) < 1e-12
		&& Math.abs(s.omega[wb + 1] - dp.poles[pb + 1] * om) < 1e-12
		&& Math.abs(s.omega[wb + 2] - dp.poles[pb + 2] * om) < 1e-12, 'plate ' + p + ' carries the pack pole');
}
const distinct = new Set();
for (let i = 0; i < s.n; i++) {
	assert.ok(s.plate[i] < s.plateCount, 'plate id in range');
	distinct.add(s.plate[i]);
}
assert.ok(distinct.size >= 20, 'most plates survive the L5 resample: ' + distinct.size);

const score = Earth.score(s, pack);
console.log('  ' + Earth.describe(score));
assert.ok(Math.abs(score.wetFraction - 0.7081) <= 0.015, 'wet fraction ' + score.wetFraction.toFixed(4));
assert.ok(score.meanLand > 650 && score.meanLand < 950, 'mean land ' + score.meanLand.toFixed(0));
assert.ok(score.meanOcean > -4200 && score.meanOcean < -3500, 'mean ocean ' + score.meanOcean.toFixed(0));
assert.ok(score.rms <= 250, 'round-trip RMS ' + score.rms.toFixed(1) + ' m');
let maxFel = 0, maxMaf = 0;
for (let i = 0; i < s.n; i++) { maxFel = Math.max(maxFel, s.hFel[i]); maxMaf = Math.max(maxMaf, s.hMaf[i]); }
assert.ok(maxFel <= 80000 && maxMaf <= 35000, 'thicknesses inside the bake clamps');
const water = Water.fromElevations(s.z, 1);
assert.ok(Math.abs(water.level) <= Water.WIDTH, 'water tie-in: level in the 0 bucket');

// Determinism: same pack + seed -> bit-identical world.
const s2 = new State(new Grid(5, 7).build(), 7);
Earth.apply(s2, pack, { realistic: true });
equal(s, s2);

// 10 Myr stability from the realistic start (>= 10 event cycles).
Sim.advance(s, 0.1, 100);
assert.equal(s.finite, 1, 'Earth run stays finite');
assert.ok(s.meanSpeed > 0 && s.meanSpeed < 600000, 'speed inside the pole window: ' + (s.meanSpeed / 10000).toFixed(2) + ' cm/yr');

// Game preset: mantle-driven rotations, real continents.
const sg = new State(new Grid(5, 7).build(), 7);
Earth.apply(sg, pack, {});
assert.equal(sg.prescribedOmega, 0, 'game preset lets K10 drive');
assert.equal(sg.cooling, 1, 'game preset keeps cooling');
let sumOmega = 0;
for (let p = 0; p < sg.plateCount; p++) sumOmega += Math.hypot(sg.omega[p * 3], sg.omega[p * 3 + 1], sg.omega[p * 3 + 2]);
assert.ok(sumOmega > 0, 'boot raster derived non-zero rotations');
Sim.advance(sg, 0.1, 20);
assert.equal(sg.finite, 1, 'game run stays finite');

// Jitter: deterministic per seed, and it actually perturbs the oceanic ages.
const j1 = new State(new Grid(3, 7).build(), 7);
const j2 = new State(new Grid(3, 7).build(), 7);
Earth.apply(j1, pack, { jitter: true });
Earth.apply(j2, pack, { jitter: true });
equal(j1, j2);
const plain = new State(new Grid(3, 7).build(), 7);
Earth.apply(plain, pack, {});
let ageDiff = 0;
for (let i = 0; i < j1.n; i++) if (j1.hMaf[i] > 0) ageDiff += Math.abs(j1.age[i] - plain.age[i]);
assert.ok(ageDiff > 0, 'jitter perturbs oceanic ages');

console.log('PASS earth: synthetic decode/wrap/poles/determinism, real-pack hypsometry, datum tie-in, presets');

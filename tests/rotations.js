// tests/rotations.js - the PALEOMAP rotation table and its two senses (0.4.6).
//
// The one thing this test exists to catch is a sign or order flip. Both are silent: a mirrored
// rotation model still interpolates, still composes, still produces finite quaternions, and the
// world simply drifts the wrong way. So the gates here are physical - present-day plate
// bearings, and agreement with the independent MORVEL NNR model the repo already ships - plus
// the algebraic identities that tie the three accessors together.
const { assert } = require('./helpers.js');
const Quat = require('../js/quat.js');
const Rotations = require('../js/rotations.js');

const DEG = 180 / Math.PI;
const angle = (a, p, b, q) => Quat.angleBetween(a, p, b, q) * DEG;

// --- the table -----------------------------------------------------------------------------
assert.equal(Rotations.count, 258, 'every plate in the .rot is carried');
assert.equal(Rotations.tMin, 0);
assert.equal(Rotations.tMax, 515);
assert.equal(Rotations.plates.filter((p) => p.n > 1).length, 122, 'plates with a history');
assert.equal(Rotations.plates.filter((p) => p.n < 2).length, 136, 'present-day microplates');
for (const p of Rotations.plates) {
	assert.equal(p.n, p.t.length);
	assert.equal(p.n * 4, p.q.length);
	for (let i = 0; i < p.n; i++) {
		assert.ok(Math.abs(Math.hypot(p.q[i * 4], p.q[i * 4 + 1], p.q[i * 4 + 2], p.q[i * 4 + 3]) - 1) < 1e-12,
			p.id + ' sample ' + i + ' is a unit quaternion');
	}
}
assert.equal(Rotations.find('NAM'), Rotations.of('101'));
assert.equal(Rotations.of('000'), null, 'the frame root is not a plate');

// --- what the ingest proved about the file -------------------------------------------------
const checks = Rotations.metadata.checks;
// Re-deriving the file's own pair rotations from the absolutes is what pins the composition
// order: with the anchor applied second, 269 of these pairs miss by more than a degree.
assert.ok(checks.chainRederivedDeg < 1e-3, 'chain re-derivation ' + checks.chainRederivedDeg);
assert.ok(checks.chainPairs > 900, 'the check covers the file, not a sample of it');
assert.deepEqual(checks.identityNon, ['198:83.70'], 'one microplate is not at identity today');
assert.ok(checks.anchorCycleMinT > Rotations.tMax, 'cut anchor cycles are outside the emitted range');

// A plate with no history has no rate, and 136 of them exist - a NaN here would poison s.omega
// and every column riding that plate.
const scratchW = new Float64Array(3), scratchLL = new Float64Array(2);
for (const p of Rotations.plates) {
	for (const t of [0, 10, 50, 100, 250, 500]) {
		Rotations.pole(p, t, scratchW, 0);
		assert.ok(Number.isFinite(scratchW[0] + scratchW[1] + scratchW[2]), p.id + ' at ' + t + ' has a finite omega');
		Rotations.place(p, t, 10, 20, scratchLL, 0);
		assert.ok(Number.isFinite(scratchLL[0] + scratchLL[1]), p.id + ' at ' + t + ' places a point');
	}
}

// --- identity today ------------------------------------------------------------------------
for (const code of ['NAM', 'SAM', 'EUR', 'AFR', 'IND', 'AUS', 'ANT', 'PAC']) {
	const q = new Float64Array(4);
	Rotations.at(Rotations.find(code), 0, q, 0);
	assert.ok(angle(q, 0, new Float64Array([0, 0, 0, 1]), 0) < 1e-9, code + ' is at identity at 0 Ma');
}

// --- the handedness gate: known present-day motion -----------------------------------------
// Bearings are compass degrees, 0 = north, 90 = east. These are the textbook directions; a
// conjugated model returns the antipode of every one of them.
const motion = [
	['NAM', 45, -100, 3.24, 233],   // North America drifts WSW off the Atlantic ridge
	['SAM', -15, -50, 2.15, 268],   // South America due west
	['IND', 20, 78, 4.34, 1],       // India north into Asia
	['AUS', -25, 135, 6.62, 19],    // Australia NNE, the fastest continent
	['PAC', 0, -150, 10.59, 301],   // the Pacific WNW towards the Aleutians
	['ANT', -80, 0, 1.25, 191],
	['EUR', 50, 10, 1.51, 345]
];
for (const [code, lat, lon, cmYr, bearing] of motion) {
	const p = Rotations.find(code);
	const got = Rotations.speed(p, 0, lat, lon), dir = Rotations.bearing(p, 0, lat, lon);
	assert.ok(Math.abs(got - cmYr) < 0.25, code + ' speed ' + got.toFixed(2) + ' vs ' + cmYr);
	const d = Math.abs(((dir - bearing + 540) % 360) - 180);
	assert.ok(d < 12, code + ' bearing ' + dir.toFixed(1) + ' vs ' + bearing);
}

// --- agreement with the independent NNR model ----------------------------------------------
// The two models sit in different absolute frames, so only relative motion is comparable.
// Comparing omega vectors directly is useless here - the slow plates have near-zero vectors
// whose direction is noise - so this compares the surface velocity they actually imply.
const nnr = require('../data/earth/nnr-morvel56.json');
const nnrByCode = {};
for (const row of nnr.plates) nnrByCode[row.code] = row;
const omegaOf = (row) => {
	const v = row.pole_vector, w = v[3];
	return [v[0] * w, v[1] * w, v[2] * w];
};
const eastNorth = (w, lat, lon) => {
	const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
	const x = Math.cos(la) * Math.cos(lo), y = Math.cos(la) * Math.sin(lo), z = Math.sin(la);
	const cx = w[1] * z - w[2] * y, cy = w[2] * x - w[0] * z, cz = w[0] * y - w[1] * x;
	const east = [-Math.sin(lo), Math.cos(lo), 0];
	const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
	const k = Rotations.radius * 0.1;
	return [(cx * east[0] + cy * east[1] + cz * east[2]) * k, (cx * north[0] + cy * north[1] + cz * north[2]) * k];
};
const afrPaleo = new Float64Array(3), afrNnr = omegaOf(nnrByCode.nb);
Rotations.pole(Rotations.of('701'), 0, afrPaleo, 0);
// MORVEL's Eurasia spans PALEOMAP's Europe/Siberia/Kazakh/Sunda plates, so 'eu' is not a
// one-to-one pair and is deliberately left out.
const pairs = [['sa', '201', -20, -20], ['au', '801', -20, 120], ['pa', '901', 0, -150],
	['an', '802', -70, 60], ['in', '501', 10, 70]];
for (const [code, id, lat, lon] of pairs) {
	const w = new Float64Array(3);
	Rotations.pole(Rotations.of(id), 0, w, 0);
	const a = eastNorth([w[0] - afrPaleo[0], w[1] - afrPaleo[1], w[2] - afrPaleo[2]], lat, lon);
	const n = eastNorth(omegaOf(nnrByCode[code]).map((v, i) => v - afrNnr[i]), lat, lon);
	const mag = (v) => Math.hypot(v[0], v[1]);
	const dir = (v) => (Math.atan2(v[0], v[1]) * DEG + 360) % 360;
	const d = Math.abs(((dir(a) - dir(n) + 540) % 360) - 180);
	assert.ok(d < 35, code + ' relative bearing ' + dir(a).toFixed(0) + ' vs NNR ' + dir(n).toFixed(0));
	assert.ok(Math.abs(mag(a) - mag(n)) < 0.4 * mag(n),
		code + ' relative speed ' + mag(a).toFixed(2) + ' vs NNR ' + mag(n).toFixed(2));
}

// --- the three accessors are one model -----------------------------------------------------
// Plates.integrate left-multiplies the step built from s.omega into s.q, and Columns.move
// applies s.q. So integrating Rotations.pole across a stage has to land on Rotations.relative
// between the same two epochs, or a world driven by omega would not follow the model.
const qStep = new Float64Array(4), qDirect = new Float64Array(4);
let stages = 0, worstEnd = 0, worstMid = 0, where = '';
for (const p of Rotations.plates) {
	for (let i = 0; i < p.n - 1; i++) {
		const older = p.t[i + 1], younger = p.t[i], dt = older - younger;
		Rotations.pole(p, older - dt / 2, scratchW, 0);
		qStep.set([0, 0, 0, 1]);
		Quat.integrate(qStep, 0, scratchW, 0, dt);
		Rotations.relative(p, younger, older, qDirect, 0);
		const eEnd = angle(qStep, 0, qDirect, 0);
		qStep.set([0, 0, 0, 1]);
		Quat.integrate(qStep, 0, scratchW, 0, dt / 2);
		Rotations.relative(p, older - dt / 2, older, qDirect, 0);
		const eMid = angle(qStep, 0, qDirect, 0);
		stages++;
		if (eEnd > worstEnd) { worstEnd = eEnd; where = p.id + ' [' + older + ',' + younger + ']'; }
		if (eMid > worstMid) worstMid = eMid;
	}
}
assert.equal(stages, 583, 'every stage in the table');
assert.ok(worstEnd < 1e-3, 'stage end agrees to ' + worstEnd.toExponential(2) + ' deg at ' + where);
assert.ok(worstMid < 1e-2, 'mid-stage agrees to ' + worstMid.toExponential(2) + ' deg');

// Reconstructing to an epoch and rotating back by the inverse of that epoch's rotation returns
// the point exactly - which is what makes an exact backtrack possible instead of a re-simulation.
const ll = new Float64Array(2), back = new Float64Array(4), fwd = new Float64Array(4);
const both = new Float64Array(4), conj = new Float64Array(4);
const unit = new Float64Array([0, 0, 0, 1]);
const spin = (q, lat, lon) => {
	const v = new Float64Array(6);
	Rotations.toXYZ(lat, lon, v, 3);
	Quat.rotate(v, 0, q, 0, v, 3);
	return Rotations.toLatLon(v[0], v[1], v[2], v, 0);
};
for (const code of ['NAM', 'IND', 'AUS', 'AFR']) {
	const p = Rotations.find(code);
	Rotations.at(p, 150, fwd, 0);
	conj[0] = -fwd[0]; conj[1] = -fwd[1]; conj[2] = -fwd[2]; conj[3] = fwd[3];
	Quat.mul(both, 0, fwd, 0, conj, 0);
	// 1e-4 deg is 11 m on the surface and 50x looser than the 1.7e-6 deg that acos costs near
	// dot = 1; a tolerance tighter than that would be testing the cosine, not the rotation.
	Rotations.relative(p, 0, 150, back, 0);
	assert.ok(angle(both, 0, unit, 0) < 1e-4, code + ' R(t) inverts');
	assert.ok(angle(back, 0, conj, 0) < 1e-4, code + ' relative(0, t) is R(t) inverse');
	Rotations.place(p, 150, 20, 40, ll, 0);
	const home = spin(back, ll[0], ll[1]);
	assert.ok(Math.abs(home[0] - 20) < 1e-6 && Math.abs(home[1] - 40) < 1e-6, code + ' round trip');
}

// --- existence windows: the model is silent about plates that were not distinct yet ---------
// at() clamps past the end of a plate's samples instead of failing, so a caller that
// reconstructs an epoch has to ask first - otherwise it silently rotates South America by its
// 143.8 Ma rotation and calls the result Pangaea.
const window = [['NAM', 515], ['EUR', 515], ['AFR', 515], ['IND', 206], ['ANT', 166],
	['SAM', 143.8], ['AUS', 94], ['PAC', 84]];
for (const [code, oldest] of window) {
	const p = Rotations.find(code);
	assert.equal(p.t[p.n - 1], oldest, code + ' oldest sample');
	assert.ok(Rotations.has(p, 0), code + ' exists today');
	assert.ok(Rotations.has(p, oldest), code + ' exists at its oldest sample');
	assert.ok(!Rotations.has(p, oldest + 1), code + ' has nothing older than ' + oldest + ' Ma');
}
assert.ok(!Rotations.has(Rotations.find('AUS'), 250), 'Australia is undefined at 250 Ma');
assert.ok(Rotations.has(Rotations.find('AFR'), 250), 'Africa is defined at 250 Ma');
// The coarsest sample gaps, which bound the interpolation error at an epoch: NAM 175 -> 306 Ma
// and EUR 255 -> 425 Ma both straddle 250 Ma, so a 250 Ma reconstruction of those two is an
// arc across a 131 and an 80 Myr gap respectively.
assert.equal(Rotations.find('NAM').t[Rotations.bracket(Rotations.find('NAM'), 250)], 175);
assert.equal(Rotations.find('EUR').t[Rotations.bracket(Rotations.find('EUR'), 250)], 175);

// --- the geography those rotations imply ---------------------------------------------------
// Australia was against Antarctica 50 Ma ago; North America was 50 degrees closer to Africa.
Rotations.place(Rotations.find('AUS'), 50, -25, 135, ll, 0);
assert.ok(ll[0] < -45 && ll[0] > -55, 'Australia at 50 Ma is at ' + ll[0].toFixed(1) + 'S');
Rotations.place(Rotations.find('NAM'), 150, 45, -100, ll, 0);
assert.ok(ll[1] > -55 && ll[1] < -40, 'North America at 150 Ma is at ' + ll[1].toFixed(1) + 'E');
Rotations.place(Rotations.find('IND'), 100, 20, 78, ll, 0);
assert.ok(ll[0] < 0, 'India was south of the equator at 100 Ma (' + ll[0].toFixed(1) + ')');

console.log('PASS rotations: 258 plates, bearings and NNR agreement, ' + stages
	+ ' stages consistent to ' + worstEnd.toExponential(1) + ' deg');

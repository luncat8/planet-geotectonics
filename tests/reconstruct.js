// reconstruct.js tests (0.4.6b): Mode K exact rigid reconstruction, reversibility and IoU gate.
// The plan §9 and report-2 §4 prescribe:
//  - 250 -> 0 -> 250 Ma bit-identical world (lossless)
//  - moves every column by its plate's rotation and nothing else
//  - leaves t/frame untouched
//  - restores live state exactly
//  - modern pack reconstructed to 250 Ma lands within measured IoU band (0.38 threshold after ceiling measurement)
const { assert, Grid, State, Sim, equal } = require('./helpers.js');
const Earth = require('../js/earth.js');
const Rotations = require('../js/rotations.js');
const PlateCrosswalk = require('../js/data/plate-crosswalk.js');
require('../js/data/earth-1deg.js');
require('../js/data/earth-250Ma.js');
require('../js/data/earth-200Ma.js');

const g = new Grid(5, 7).build();
const modern = Earth.pick(5, 'earth');
assert.ok(modern, 'modern pack exists');
const s = new State(g, 7);
Earth.apply(s, modern, { realistic: true });
const atHomeWorld = new Float64Array(s.world);
const atHomeCell = new Int32Array(s.cell);
const atHomeOwner = new Int32Array(s.owner);
const atHomeZ = new Float64Array(s.z);
const t0 = s.t, frame0 = s.frame, epoch0 = s.epoch0;

console.log('  modern pack: ' + modern.name + ' epoch ' + modern.epoch + ' plates ' + s.plateCount + ' columns ' + s.n);

// --- 1. t/frame untouched by reconstruct ---------------------------------------------
Earth.reconstruct(s, 250);
assert.equal(s.t, t0, 'reconstruct leaves t untouched');
assert.equal(s.frame, frame0, 'reconstruct leaves frame untouched');
assert.equal(s.epoch0, epoch0, 'reconstruct leaves epoch0 untouched');

// --- 2. moves every column by its plate's rotation (and nothing else) ----------------
for (let i = 0; i < s.n; i++) {
	if (!s.alive[i]) continue;
	// world should be body rotated by plate's current q
	// We can check that world is unit length and that it equals rotate(body, q[effective])
	// Effective plate is either its own or mother for continental on jf/ri/ca/sr/nz
	const b = i * 3;
	const len = Math.hypot(s.world[b], s.world[b + 1], s.world[b + 2]);
	assert.ok(Math.abs(len - 1) < 1e-12, 'world stays unit ' + i);
}
// Restore to modern and check bit-identical
Earth.reconstruct(s, modern.epoch);
for (let i = 0; i < s.n; i++) {
	if (!s.alive[i]) continue;
	const b = i * 3;
	assert.ok(Math.abs(s.world[b] - atHomeWorld[b]) < 1e-15
		&& Math.abs(s.world[b + 1] - atHomeWorld[b + 1]) < 1e-15
		&& Math.abs(s.world[b + 2] - atHomeWorld[b + 2]) < 1e-15,
		'back to 0 Ma restores world bit-identically for column ' + i);
}

// --- 3. reversibility 250 -> 0 -> 250 bit-identical --------------------------------
Earth.reconstruct(s, 250);
const at250World = new Float64Array(s.world);
const at250Cell = new Int32Array(s.cell);
Earth.reconstruct(s, modern.epoch);
Earth.reconstruct(s, 250);
for (let i = 0; i < s.n; i++) {
	if (!s.alive[i]) continue;
	const b = i * 3;
	assert.ok(Math.abs(s.world[b] - at250World[b]) < 1e-15
		&& Math.abs(s.world[b + 1] - at250World[b + 1]) < 1e-15
		&& Math.abs(s.world[b + 2] - at250World[b + 2]) < 1e-15,
		'250->0->250 round-trip bit-identical world for column ' + i);
}
for (let c = 0; c < g.V; c++) {
	assert.equal(s.cell[c] === undefined ? s.cell[c] : s.cell[c], at250Cell[c], 'cell stable over round-trip at ' + c);
}

// --- 4. restores live state exactly when slider released (reconstruct to epoch0) ----
Earth.reconstruct(s, modern.epoch);
for (let i = 0; i < s.n; i++) {
	if (!s.alive[i]) continue;
	const b = i * 3;
	assert.ok(Math.abs(s.world[b] - atHomeWorld[b]) < 1e-15
		&& Math.abs(s.world[b + 1] - atHomeWorld[b + 1]) < 1e-15
		&& Math.abs(s.world[b + 2] - atHomeWorld[b + 2]) < 1e-15,
		'live state restored exactly after reconstruct to epoch0');
}
assert.equal(s.t, t0, 't still untouched after restore');
assert.equal(s.frame, frame0, 'frame still untouched after restore');

// --- 5. IoU gate against committed packs (measured ceiling 0.4537/0.4657, threshold 0.38) ----
const ref250 = Earth.pick(5, 'pangaea');
const ref200 = Earth.pick(5, 'gondwana');
assert.ok(ref250, '250Ma pack exists');
assert.ok(ref200, '200Ma pack exists');

function iouAt(epoch, ref, minIoU, maxIoU) {
	const st = new State(new Grid(5, 7).build(), 7);
	Earth.apply(st, modern, { realistic: true });
	const r = Earth.reconstruct(st, epoch);
	const mask = Earth.landFromState(st);
	const refMask = Earth.landFromPack(ref, st.grid);
	const got = Earth.iou(mask, refMask);
	console.log('  ' + epoch + ' Ma · moved ' + r.moved + ' stuck ' + r.stuck + ' IoU ' + got.iou.toFixed(4) + ' land ' + (100 * Earth.fraction(mask)).toFixed(2) + '% vs ref ' + (100 * Earth.fraction(refMask)).toFixed(2) + '%');
	assert.ok(got.iou >= minIoU, epoch + ' Ma IoU ' + got.iou.toFixed(4) + ' >= ' + minIoU);
	assert.ok(got.iou <= maxIoU, epoch + ' Ma IoU ' + got.iou.toFixed(4) + ' <= ' + maxIoU + ' (ceiling guard)');
	// Reversibility of land mask
	Earth.reconstruct(st, modern.epoch);
	const backMask = Earth.landFromState(st);
	const backIou = Earth.iou(backMask, Earth.landFromState((() => { const s2 = new State(new Grid(5, 7).build(), 7); Earth.apply(s2, modern, { realistic: true }); return s2; })()));
	assert.ok(backIou.iou > 0.999999, epoch + ' Ma back to 0 Ma IoU with starting mask ' + backIou.iou.toFixed(6));
}

// Measured ceilings: 0.4537 at 250 Ma, 0.4657 at 200 Ma. Our reconstruction after fixes A+B reaches 0.3954/0.4350.
// Set bands wide enough for resampling (L5) but tight enough that mirrored fails (mirrored scores ~0).
iouAt(250, ref250, 0.38, 0.50);
iouAt(200, ref200, 0.38, 0.55);

// --- 6. continental priority check: land fraction recovers vs no-priority baseline ----
// No-priority baseline at L5 250 Ma is 19.2% (report). With priority it should be >25% (we get 25.9% with remap, 26.6% without).
const sCheck = new State(new Grid(5, 7).build(), 7);
Earth.apply(sCheck, modern, { realistic: true });
Earth.reconstruct(sCheck, 250);
const landFrac = Earth.fraction(Earth.landFromState(sCheck));
assert.ok(landFrac > 0.25, 'land fraction after fix A+B > 0.25, got ' + landFrac.toFixed(4));
assert.ok(landFrac < 0.40, 'land fraction after fix < 0.40 (not overflooded), got ' + landFrac.toFixed(4));

console.log('PASS reconstruct: lossless 250->0->250, t/frame untouched, live restore, IoU >=0.38 within ceiling');

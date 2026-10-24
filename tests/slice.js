// The globe-side section cutter (0.8.1): circle construction, the cell-run walker and the
// pgt-slice-pack v2 writer over one captured snapshot. What is pinned here:
//   1. circleThrough builds the canonical circle, refuses coincident/antipodal points and
//      keeps full precision (the codec quantises only its own copy, so repeated exports of
//      an unchanged path keep one path checksum);
//   2. a rotated-view click round trip: MapView.direction + Quat.rotateInv identifies the
//      world point MapView.project draws, and the walked first run is that point's cell;
//   3. walks at L5/L6/L7: legal ring adjacency for every transition, strictly increasing
//      starts that tile the whole arc, a pentagon cell on its own circle, the seam and the
//      poles, and spans the codec keeps distinct after six-significant-digit quantisation;
//   4. pack semantics against a hand-edited state: owner/plate distinction, host law,
//      potential order, wet flags, canonical gap rows, all five boundary conversions with
//      the directed ring slot proven, and signed vt / non-negative vp;
//   5. repeated writes from one unchanged snapshot are byte-identical in identity;
//   6. a writer failure leaves the state, its diagnostic counters and the clock untouched.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Slice = require('../js/slice.js');
const SP = require('../port/slice-format.js');
const Resolution = require('../js/resolution.js');
const Diag = require('../js/diag.js');
const Quat = require('../js/quat.js');
const Renderer = require('../js/render.js');
const MapView = Renderer.MapView;

const nearest = Resolution.nearestCell;
const R_KM = Slice.radiusKm();
const SEA = { mode: 'level', levelM: 1000, volScale: 1.25 };
const PROV = { pack: 'procedural-map', epochMa: 0, rotModel: 'procedural', built: '2026-10-13T12:00:00.000Z' };
const LICENSE = 'Synthetic world · planet-geotectonics map start · no Earth data';

function dir(lat, lon) {
	const out = new Float64Array(3);
	SP.directionAt({ kind: 'circle', closes: true, arcKm: 1, cellKm: 1, lat0: lat, lon0: lon, az0: 0 }, 0, out);
	return out;
}
function isNeighbour(grid, c, j) {
	for (let k = 0; k < grid.ringN[c]; k++) if (grid.ring[c * 6 + k] === j) return true;
	return false;
}
function near(actual, expected, eps, label) {
	assert.ok(Math.abs(actual - expected) <= (eps || 1e-5), label + ': ' + actual + ' vs ' + expected);
}
// The structural invariants every walk owes: strictly increasing starts from zero, positive
// spans the codec keeps distinct, exact tiling of the arc, and same-cell-or-neighbour
// transitions all the way around the ring.
function checkWalk(grid, runs, label) {
	assert.ok(runs.n >= 2, label + ': at least two runs');
	assert.equal(runs.starts[0], 0, label + ': the ring starts at zero arc');
	let sum = 0;
	for (let i = 0; i < runs.n; i++) {
		const next = runs.cells[(i + 1) % runs.n];
		assert.ok(next === runs.cells[i] || isNeighbour(grid, runs.cells[i], next),
			label + ': run ' + i + ' joins ' + runs.cells[i] + ' -> ' + next + ' legally');
		const end = i + 1 < runs.n ? runs.starts[i + 1] : runs.arcKm;
		const span = end - runs.starts[i];
		assert.ok(span > 0, label + ': positive span at ' + i);
		assert.ok(span >= 0.95 * 1.5 * Math.pow(10, Math.floor(Math.log(runs.arcKm) / Math.LN10) - 5),
			label + ': span at ' + i + ' survives sKm quantisation (' + span + ' km)');
		assert.ok(span <= Slice.cellKmFor(grid) * 1.5, label + ': span at ' + i + ' within the cell budget');
		sum += span;
	}
	assert.ok(Math.abs(sum - runs.arcKm) < 1e-9, label + ': the runs tile the whole arc');
}

// --- 1. circle construction ----------------------------------------------------------------
const equator = Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([0, 0, 1]), R_KM, 7000);
assert.equal(equator.kind, 'circle');
assert.ok(equator.closes);
assert.equal(equator.lat0, 0);
assert.equal(equator.lon0, 0);
assert.equal(equator.az0, 90, 'the equator heads east from (lat 0, lon 0)');
assert.ok(Math.abs(equator.arcKm - 2 * Math.PI * R_KM) < 1e-6);
const meridian = Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), R_KM, 7000);
assert.equal(meridian.az0, 0, 'the pole circle heads north from (lat 0, lon 0)');
assert.throws(function () {
	Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([1, 0, 0]), R_KM, 7000);
}, /coincident/, 'a coincident second point is refused');
assert.throws(function () {
	Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([-1, 0, 0]), R_KM, 7000);
}, /antipodal/, 'an antipodal second point is refused');
assert.throws(function () {
	Slice.circleThrough(new Float64Array([1, 0, 1e-9]), new Float64Array([-1, 0, 1e-9]), R_KM, 7000);
}, /antipodal|coincident/, 'a numerically antipodal second point is refused');
// Just outside the tolerance the circle is legal: the codec's 1e-7 rad is the boundary.
const barely = Slice.circleThrough(new Float64Array([1, 0, 1e-5]), new Float64Array([-1, 0, 1e-5]), R_KM, 7000);
assert.ok(Number.isFinite(barely.az0), 'a near-antipodal pair past the tolerance still cuts');
const stableA = new Float64Array([0.3, -0.5, 0.8]), stableB = new Float64Array([-0.9, 0.2, 0.4]);
const firstPath = Slice.circleThrough(stableA, stableB, R_KM, 223.2);
const firstChecksum = SP.pathChecksum(firstPath);
for (let repeat = 0; repeat < 3; repeat++) {
	const again = Slice.circleThrough(stableA, stableB, R_KM, 223.2);
	assert.equal(SP.pathChecksum(again), firstChecksum, 'an unchanged path has one canonical checksum');
	assert.equal(again.lat0, firstPath.lat0, 'the editing representation is deterministic');
}
assert.equal(SP.pathChecksum(Slice.circleThrough(stableA, stableB, R_KM, 111.6)), firstChecksum,
	'the cell budget is not geographic identity: one path checksum at any resolution');
const movedPath = Slice.circleThrough(stableA, stableB, R_KM, 223.2);
movedPath.lat0 += 0.5;
assert.notEqual(SP.pathChecksum(movedPath), firstChecksum, 'moving the line changes its geographic identity');

// --- 2. the rotated-view click round trip ---------------------------------------------------
const W = 1024, H = 512;
const viewQ = new Float64Array([0, 0, 0, 1]);
const dragFrom = new Float64Array(3), dragTo = new Float64Array(3);
MapView.direction(dragFrom, 300, 200, W, H);
MapView.direction(dragTo, 460, 260, W, H);
MapView.drag(viewQ, dragFrom[0], dragFrom[1], dragFrom[2], dragTo[0], dragTo[1], dragTo[2]);
MapView.direction(dragFrom, 800, 100, W, H);
MapView.direction(dragTo, 120, 420, W, H);
MapView.drag(viewQ, dragFrom[0], dragFrom[1], dragFrom[2], dragTo[0], dragTo[1], dragTo[2]);
const displayed = new Float64Array(3), world = new Float64Array(3), projected = new Float64Array(2);
// Pole-row pixels are singular in the equirectangular projection (the whole top edge is one
// point), so the round trip is pinned on ordinary map pixels - what a click can actually be.
for (const [px, py] of [[2, 3], [W - 3, 3], [512, 256], [17, 431], [1000, 400], [300, 100], [7, 509]]) {
	MapView.direction(displayed, px, py, W, H);
	Quat.rotateInv(world, 0, viewQ, 0, displayed, 0);
	MapView.project(projected, world[0], world[1], world[2], viewQ, W, H);
	assert.ok(Math.abs(projected[0] - px) < 0.01 && Math.abs(projected[1] - py) < 0.01,
		'the click round trip returns pixel (' + px + ', ' + py + '), got ('
		+ projected[0].toFixed(2) + ', ' + projected[1].toFixed(2) + ')');
}
// The chain the page runs: two clicked pixels become a world-space circle whose first run is
// the first click's own cell, and whose through-point run is the second click's cell.
const grid5 = new Grid(5, 7).build();
const state5 = new State(grid5, 7);
Sim.raster(state5);
Sim.advance(state5, 0.1, 30);
function clickedWorld(px, py) {
	MapView.direction(displayed, px, py, W, H);
	Quat.rotateInv(world, 0, viewQ, 0, displayed, 0);
	const l = Math.hypot(world[0], world[1], world[2]);
	world[0] /= l; world[1] /= l; world[2] /= l;
	return new Float64Array(world);
}
const clickA = clickedWorld(140, 260), clickB = clickedWorld(760, 190);
const clickPath = Slice.circleThrough(clickA, clickB, R_KM, Slice.cellKmFor(grid5));
const clickRuns = Slice.walk(grid5, clickPath, nearest);
checkWalk(grid5, clickRuns, 'clicked circle');
assert.equal(clickRuns.cells[0], nearest(grid5, clickA[0], clickA[1], clickA[2]),
	'the first run is the origin click\'s cell');
const throughAngle = Math.acos(Math.max(-1, Math.min(1, clickA[0] * clickB[0] + clickA[1] * clickB[1] + clickA[2] * clickB[2])));
const throughS = throughAngle / (2 * Math.PI) * clickPath.arcKm;
const throughDir = new Float64Array(3);
SP.directionAt(clickPath, throughS, throughDir);
assert.equal(nearest(grid5, throughDir[0], throughDir[1], throughDir[2]), nearest(grid5, clickB[0], clickB[1], clickB[2]),
	'the circle passes through the second click');

// --- 3. walks at L5, L6 and L7 --------------------------------------------------------------
function pseudoRandom(seed) {
	let a = seed;
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = pseudoRandom(20261013);
const measurements = [];
for (const level of [5, 6, 7]) {
	const grid = new Grid(level, 7).build();
	let pentagon = -1;
	for (let c = 0; c < grid.V && pentagon < 0; c++) if (grid.ringN[c] === 5) pentagon = c;
	const pentDir = new Float64Array([grid.pos[pentagon * 3], grid.pos[pentagon * 3 + 1], grid.pos[pentagon * 3 + 2]]);
	const cases = [
		[new Float64Array([1, 0, 0]), new Float64Array([0, 0, 1]), 'equator (seam at lon 180)'],
		[new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 'polar meridian'],
		[pentDir, new Float64Array([0, -1, 0.3]), 'pentagon vicinity']
	];
	for (let i = 0; i < 4; i++) {
		const a = new Float64Array(3), b = new Float64Array(3);
		for (let k = 0; k < 3; k++) { a[k] = rand() * 2 - 1; b[k] = rand() * 2 - 1; }
		cases.push([a, b, 'random ' + i]);
	}
	const t0 = Date.now();
	let runsTotal = 0, maxRuns = 0;
	for (const [a, b, label] of cases) {
		const path = Slice.circleThrough(a, b, R_KM, Slice.cellKmFor(grid));
		const runs = Slice.walk(grid, path, nearest);
		checkWalk(grid, runs, 'L' + level + ' ' + label);
		runsTotal += runs.n;
		maxRuns = Math.max(maxRuns, runs.n);
		if (label === 'pentagon vicinity')
			assert.ok(runs.cells.indexOf(pentagon) >= 0, 'a circle through the pentagon cell crosses it');
	}
	measurements.push('L' + level + ': ' + cases.length + ' circles · ' + (Date.now() - t0) + ' ms · runs avg '
		+ Math.round(runsTotal / cases.length) + ' max ' + maxRuns);
}

// --- 4. pack semantics against a hand-edited snapshot ---------------------------------------
// The equator walk on the advanced L5 world: fields are pinned by editing the exact cells
// and columns the walk names, so every mapping (owner, plate, slot, order) is proven.
const path5 = Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([0, 0, 1]), R_KM, Slice.cellKmFor(grid5));
const runs5 = Slice.walk(grid5, path5, nearest);
checkWalk(grid5, runs5, 'L5 equator');
// One live run to pin: prefer an interior run whose next run is a different cell.
let pin = -1;
for (let i = 0; i < runs5.n && pin < 0; i++) {
	if (state5.owner[runs5.cells[i]] >= 0 && runs5.cells[(i + 1) % runs5.n] !== runs5.cells[i]) pin = i;
}
assert.ok(pin >= 0, 'the equator crosses at least one live boundary run');
const pinCell = runs5.cells[pin], pinNext = runs5.cells[(pin + 1) % runs5.n];
const pinOwner = state5.owner[pinCell];
let pinSlot = -1;
for (let k = 0; k < grid5.ringN[pinCell]; k++) if (grid5.ring[pinCell * 6 + k] === pinNext) pinSlot = k;
assert.ok(pinSlot >= 0, 'the pinned run ends in a ring neighbour');
// Directed boundary conversion on that one slot, one kind at a time.
const KINDS = [
	[0, 0, 0, 0], [3, 0, 1, 0], [2, 0, 2, 0], [1, -1, 3, -1], [1, 1, 3, 1], [1, 2, 4, 0]
];
for (const [type, polarity, bnd, pol] of KINDS) {
	state5.edgeType[pinCell * 6 + pinSlot] = type;
	state5.polarity[pinCell * 6 + pinSlot] = polarity;
	const result = Slice.pack(state5, path5, SEA, PROV, LICENSE);
	assert.equal(result.pack.bnd[pin], bnd, 'globe edge ' + type + '/' + polarity + ' converts to ' + bnd);
	assert.equal(result.pack.pol[pin], pol, 'and carries polarity ' + pol);
}
// Field mapping: the run reads its owner column, the cell's own z and velocity, in that order.
state5.hFel[pinOwner] = 12345.6;
state5.hMaf[pinOwner] = 4321.0;
state5.hSed[pinOwner] = 0;
state5.age[pinOwner] = 77.5;
state5.fert[pinOwner] = 0.6789;
state5.damage[pinOwner] = 0.1234;
state5.z[pinCell] = 999.4;
state5.plate[pinOwner] = 2;
const potentials = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66];
for (let f = 0; f < 6; f++) state5[Diag.ORE_FIELDS[f]][pinOwner] = potentials[f];
state5.vel[pinCell * 3] = 40000;
state5.vel[pinCell * 3 + 1] = -25000;
state5.vel[pinCell * 3 + 2] = 12000;
const pinned = Slice.pack(state5, path5, SEA, PROV, LICENSE).pack;
assert.equal(pinned.hFelM[pin], 12346, 'felsic thickness reads the owner column, rounded to metres');
assert.equal(pinned.hMafM[pin], 4321);
assert.equal(pinned.hSedM[pin], 0);
near(pinned.ageMyr[pin], 77.5, 1e-4, 'age reads the owner column');
near(pinned.fert[pin], 0.6789, 1e-6, 'fertility reads the owner column');
near(pinned.damage[pin], 0.1234, 1e-6, 'damage reads the owner column');
assert.equal(pinned.zM[pin], 999, 'elevation reads the cell, not the column');
assert.equal(pinned.wet[pin], 1, 'z below the sea level is wet');
assert.equal(pinned.plate[pin], 2, 'the plate id reads the owner column');
assert.equal(pinned.host[pin], 2, '12346 m felsic is continental');
assert.equal(pinned.alive[pin], 1);
for (let f = 0; f < 6; f++)
	near(pinned.pot[pin * 6 + f], potentials[f], 1e-6, 'potentials keep the declared ' + Diag.ORE_FIELDS[f] + ' order');
// vt/vp: signed along-cut projection and its non-negative complement at the run midpoint.
const tangent = new Float64Array(3);
const pinEnd = pin + 1 < runs5.n ? runs5.starts[pin + 1] : runs5.arcKm;
SP.tangentAt(path5, (runs5.starts[pin] + pinEnd) / 2, tangent);
const vtExpected = 40000 * tangent[0] - 25000 * tangent[1] + 12000 * tangent[2];
// vt/vp are f32 fields: the comparison tolerance is that storage, not the walk.
near(pinned.vt[pin], vtExpected, 1e-5 * Math.abs(vtExpected), 'vt is the tangent projection at the run midpoint');
assert.ok(pinned.vp[pin] >= 0, 'vp is non-negative');
near(pinned.vt[pin] * pinned.vt[pin] + pinned.vp[pin] * pinned.vp[pin],
	40000 * 40000 + 25000 * 25000 + 12000 * 12000, 1e-5 * 2.369e9, 'vt and vp decompose the cell velocity');
// A wet/dry boundary case at exactly the level: strictly below is wet.
state5.z[pinCell] = 1000;
assert.equal(Slice.pack(state5, path5, SEA, PROV, LICENSE).pack.wet[pin], 0, 'z equal to the level is dry');
state5.z[pinCell] = 999.4;
// The host law across its five codes, on the same run.
for (const [fel, maf, sed, host] of [[0, 0, 0, 0], [100, 200, 0, 1], [9000, 0, 0, 2], [50000, 0, 0, 3], [100, 100, 3000, 4]]) {
	state5.hFel[pinOwner] = fel; state5.hMaf[pinOwner] = maf; state5.hSed[pinOwner] = sed;
	assert.equal(Slice.pack(state5, path5, SEA, PROV, LICENSE).pack.host[pin], host,
		'host ' + host + ' for (' + fel + ', ' + maf + ', ' + sed + ')');
}
state5.hFel[pinOwner] = 12345.6; state5.hMaf[pinOwner] = 4321; state5.hSed[pinOwner] = 0;

// Gap rows: an ownerless cell canonicalises through the shared rule, never a neighbour.
const gapCell = runs5.cells[(pin + 3) % runs5.n];
const gapAt = (pin + 3) % runs5.n;
state5.owner[gapCell] = -1;
const gapped = Slice.pack(state5, path5, SEA, PROV, LICENSE).pack;
assert.equal(gapped.alive[gapAt], 0, 'an ownerless cell is a gap row');
assert.equal(gapped.host[gapAt], 0);
assert.equal(gapped.plate[gapAt], 0);
assert.equal(gapped.bnd[gapAt], 0);
assert.equal(gapped.zM[gapAt], Math.round(SP.round(SEA.levelM)), 'the gap row sits at the rounded sea level');
assert.equal(gapped.hFelM[gapAt], 0);
assert.equal(gapped.vt[gapAt], 0);
assert.equal(gapped.pot[gapAt * 6 + 2], 0);
assert.equal(gapped.wet[gapAt], 0);
// The plate table: live counts only, ascending ids, and the synthetic gap id 0 when no live
// sample carries it (every live run here was pinned onto plate 2 or keeps its own).
const liveIds = [];
for (let i = 0; i < runs5.n; i++) if (i !== gapAt && liveIds.indexOf(gapped.plate[i]) < 0) liveIds.push(gapped.plate[i]);
assert.deepEqual(gapped.plates.map(function (p) { return p.id; }), liveIds.slice().sort(function (a, b) { return a - b; }),
	'the table lists the live sample plate ids in ascending order');
for (const plate of gapped.plates) {
	let count = 0;
	for (let i = 0; i < gapped.n; i++) if (gapped.alive[i] && gapped.plate[i] === plate.id) count++;
	assert.equal(plate.n, count, 'plate ' + plate.id + ' counts live samples only');
	near(plate.wx, state5.omega[plate.id * 3], 1e-5 * Math.abs(state5.omega[plate.id * 3]) + 1e-9,
		'the angular velocity reads the plate table at six significant digits');
}
// Every live run forced onto plate 2: the gap row references id 0, so the table must add it.
for (let i = 0; i < runs5.n; i++) {
	const owner = state5.owner[runs5.cells[i]];
	if (owner >= 0) state5.plate[owner] = 2;
}
const forced = Slice.pack(state5, path5, SEA, PROV, LICENSE).pack;
let forcedLive = 0;
for (let i = 0; i < forced.n; i++) if (forced.alive[i]) forcedLive++;
assert.deepEqual(forced.plates.map(function (p) { return [p.id, p.n]; }), [[0, 0], [2, forcedLive]],
	'a gap row without live plate 0 gets the canonical id-0 row');
assert.equal(SP.validate(forced), '', 'the forced-plate pack still validates');

// --- 5. repeated writes are identical --------------------------------------------------------
const again = Slice.pack(state5, path5, SEA, PROV, LICENSE);
assert.equal(again.checksum, forced.checksum, 'an unchanged snapshot and path give one full checksum');
assert.equal(again.pathChecksum, SP.pathChecksum(path5));
for (const field of ['sKm', 'zM', 'hFelM', 'plate', 'bnd', 'pol', 'vt', 'vp', 'pot']) {
	assert.equal(Buffer.compare(Buffer.from(again.pack[field].buffer), Buffer.from(forced[field].buffer)), 0,
		field + ' is identical across writes');
}
assert.equal(path5.lat0, 0, 'the full-precision editing path is never quantised by a write');
const encoded = SP.encode(forced);
const decoded = SP.decode(encoded);
assert.equal(decoded.checksum, forced.checksum, 'the encoded pack survives the strict reader');

// --- 6. a writer failure leaves the snapshot untouched --------------------------------------
// A cell budget far below the real spans makes seal refuse the pack after the walk.
const before = {
	t: state5.t, frame: state5.frame, rng: state5.rng, histI: state5.histI, maxClimb: state5.maxClimb,
	owner: Buffer.from(state5.owner.buffer), z: Buffer.from(state5.z.buffer),
	hFel: Buffer.from(state5.hFel.buffer), plate: Buffer.from(state5.plate.buffer),
	edgeType: Buffer.from(state5.edgeType.buffer), polarity: Buffer.from(state5.polarity.buffer),
	vel: Buffer.from(state5.vel.buffer), omega: Buffer.from(state5.omega.buffer),
	world: Buffer.from(state5.world.buffer), climbHistogram: Buffer.from(state5.climbHistogram.buffer)
};
const tinyBudget = Slice.circleThrough(new Float64Array([1, 0, 0]), new Float64Array([0, 0, 1]), R_KM, 0.001);
assert.throws(function () { Slice.pack(state5, tinyBudget, SEA, PROV, LICENSE); },
	/wider than the declared cell budget|span/, 'a sub-span budget is refused by the seal');
assert.equal(state5.t, before.t, 'a failed write does not move the clock');
assert.equal(state5.frame, before.frame);
assert.equal(state5.rng, before.rng, 'the RNG-facing state is untouched');
assert.equal(state5.histI, before.histI, 'no diagnostic pass ran');
assert.equal(state5.maxClimb, before.maxClimb, 'no climb diagnostics were written');
for (const key of ['owner', 'z', 'hFel', 'plate', 'edgeType', 'polarity', 'vel', 'omega', 'world', 'climbHistogram'])
	assert.equal(Buffer.compare(Buffer.from(state5[key].buffer), before[key]), 0, key + ' is untouched by a failed write');

// --- 7. display-side snap modifier (0.8.5 A3) -----------------------------------------------
// Snap moves only the pending second point before circleThrough, preserves the origin and
// angular separation, is reversible in one step ('none'), and never touches state.
assert.deepEqual(Slice.SNAP_MODES, ['none', 'boundary', 'motion']);
const snapA = new Float64Array([grid5.pos[pinCell * 3], grid5.pos[pinCell * 3 + 1], grid5.pos[pinCell * 3 + 2]]);
const snapRawB = new Float64Array([0, 0.7071067811865476, 0.7071067811865476]);
const snapNone = Slice.snapSecond(state5, snapA, snapRawB, 'none');
assert.deepEqual(Array.from(snapNone), Array.from(snapRawB), 'none returns the unsnapped second point bit-for-bit');
const snapMotion = Slice.snapSecond(state5, snapA, snapRawB, 'motion');
const snapBoundary = Slice.snapSecond(state5, snapA, snapRawB, 'boundary');
const rawDot = snapA[0] * snapRawB[0] + snapA[1] * snapRawB[1] + snapA[2] * snapRawB[2];
near(snapA[0] * snapMotion[0] + snapA[1] * snapMotion[1] + snapA[2] * snapMotion[2], rawDot, 1e-12,
	'motion snap preserves the angular separation between origin and second point');
near(snapA[0] * snapBoundary[0] + snapA[1] * snapBoundary[1] + snapA[2] * snapBoundary[2], rawDot, 1e-12,
	'boundary snap preserves the angular separation between origin and second point');
const motionPath = Slice.circleThrough(snapA, snapMotion, R_KM, Slice.cellKmFor(grid5));
const motionTan = new Float64Array(3);
SP.tangentAt(motionPath, 0, motionTan);
const vx0 = state5.vel[pinCell * 3], vy0 = state5.vel[pinCell * 3 + 1], vz0 = state5.vel[pinCell * 3 + 2];
const va0 = vx0 * snapA[0] + vy0 * snapA[1] + vz0 * snapA[2];
const vtx0 = vx0 - va0 * snapA[0], vty0 = vy0 - va0 * snapA[1], vtz0 = vz0 - va0 * snapA[2];
const vtl0 = Math.hypot(vtx0, vty0, vtz0);
near(Math.abs(motionTan[0] * vtx0 + motionTan[1] * vty0 + motionTan[2] * vtz0) / vtl0, 1, 1e-9,
	'motion snap aligns the initial circle tangent with the origin cell tangent velocity');
const boundaryPath = Slice.circleThrough(snapA, snapBoundary, R_KM, Slice.cellKmFor(grid5));
assert.equal(SP.validate(Slice.pack(state5, boundaryPath, SEA, PROV, LICENSE).pack), '',
	'a boundary-snapped circle packs and validates cleanly');
assert.deepEqual(Array.from(Slice.snapSecond(state5, snapA, snapRawB, 'none')), Array.from(snapRawB),
	're-applying none restores the original unsnapped second point');
assert.equal(state5.t, before.t, 'snapSecond never touches state.t');
assert.equal(state5.rng, before.rng, 'snapSecond never touches state.rng');
for (const key of ['owner', 'z', 'hFel', 'plate', 'edgeType', 'polarity', 'vel', 'omega', 'world', 'climbHistogram'])
	assert.equal(Buffer.compare(Buffer.from(state5[key].buffer), before[key]), 0, key + ' is untouched by snapSecond');

// Measured walk facts for the release record (no guessed numbers are acceptance evidence).
console.log('walk measurements: ' + measurements.join(' · '));
console.log('PASS slice cutter: circle, view round trip, L5-L7 walks, pack semantics, identity, purity, snap');

// 0.6.0 deposit catalogue: tiling, deterministic identity across access paths, bounded
// records, seam/pole queries, resource formulas, intersections and the import contract.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Deposits = require('../js/deposits.js');
const Models = require('../js/data/deposit-models.js');
const Checkpoint = require('../js/checkpoint.js');
const Params = require('../js/params.js');

const world = new State(new Grid(3, 7).build(), 7, true);
world.ckptCap = 0;
Sim.raster(world);
Sim.advance(world, 0.1, 6000);

const stateBefore = Buffer.from(Checkpoint.save(world));
const rngBefore = world.rng;
const snap = Deposits.snapshot(world, 'test');
assert.equal(Buffer.compare(stateBefore, Buffer.from(Checkpoint.save(world))), 0, 'snapshotting leaves the world untouched');
assert.equal(world.rng, rngBefore, 'snapshotting draws nothing from the simulation RNG');
assert.equal(Deposits.snapshot(world, 'test').checksum, snap.checksum, 'a second snapshot of the same world has the same checksum');

// ---------------------------------------------------------------- 1. tiling
const N = Models.tileN, TILES = Deposits.tileCount();
assert.equal(TILES, 6 * N * N);
const tmp = [0, 0, 0];
let seed = 12345;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
for (let k = 0; k < 4000; k++) {
	const tile = Math.floor(random() * TILES);
	const fu = Deposits.ANCHOR_MARGIN + random() * (1 - 2 * Deposits.ANCHOR_MARGIN);
	const fv = Deposits.ANCHOR_MARGIN + random() * (1 - 2 * Deposits.ANCHOR_MARGIN);
	Deposits.dirOf(tile, fu, fv, tmp);
	assert.ok(Math.abs(Math.hypot(tmp[0], tmp[1], tmp[2]) - 1) < 1e-12, 'unit direction');
	assert.equal(Deposits.tileOf(tmp[0], tmp[1], tmp[2]), tile, 'an anchor belongs to exactly the tile it was drawn in');
}
const seen = new Uint8Array(TILES);
for (let k = 0; k < 200000; k++) {
	const z = random() * 2 - 1, a = random() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
	seen[Deposits.tileOf(r * Math.cos(a), z, r * Math.sin(a))] = 1;
}
assert.ok(seen.reduce((n, v) => n + v, 0) > TILES * 0.98, 'random directions reach almost every tile');
let areaMin = Infinity, areaMax = 0;
for (let tile = 0; tile < TILES; tile += 7) {
	const a = Deposits.dirOf(tile, 0.02, 0.02, [0, 0, 0]), b = Deposits.dirOf(tile, 0.98, 0.02, [0, 0, 0]);
	const c = Deposits.dirOf(tile, 0.02, 0.98, [0, 0, 0]);
	const area = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
	areaMin = Math.min(areaMin, area); areaMax = Math.max(areaMax, area);
}
assert.ok(areaMax / areaMin < 2, 'tiles are within a factor of two in area: ' + areaMax / areaMin);

// ---------------------------------------------------------------- 2. identity across access paths
const scan = Deposits.scenario(snap, 1);
Deposits.scan(scan, 0, TILES);
assert.ok(scan.complete);
const reference = Deposits.json(scan);
const bodies = Deposits.allBodies(scan);
console.log(JSON.stringify({ tiles: TILES, bodies: bodies.length, jsonKB: Math.round(reference.length / 1024) }));
assert.ok(bodies.length > 100, 'the grown world has a catalogue');
assert.equal(new Set(bodies.map((b) => b.id)).size, bodies.length, 'no duplicate ids, so none at tile edges');
assert.deepEqual(new Set(bodies.map((b) => b.family)), new Set(['vms', 'arc', 'orogenic']), 'the three calibrated families generate');

// A shuffled "click order" visit, generating only a tile at a time, matches the full scan.
const shuffled = Deposits.scenario(Deposits.snapshot(world, 'test'), 1);
const order = Array.from({ length: TILES }, (_, i) => i);
for (let i = TILES - 1; i > 0; i--) {
	const j = Math.floor(random() * (i + 1));
	[order[i], order[j]] = [order[j], order[i]];
}
for (const tile of order) Deposits.tileBodies(shuffled, tile);
assert.equal(Deposits.json(shuffled), reference, 'click order does not change the catalogue');
const chunked = Deposits.scenario(snap, 1);
for (let at = 0; at < TILES;) at = Deposits.scan(chunked, at, 997);
assert.equal(Deposits.json(chunked), reference, 'chunk size does not change the catalogue');

const other = Deposits.scenario(snap, 2);
Deposits.scan(other, 0, 500);
assert.notEqual(Deposits.allBodies(other).map((b) => b.id + b.axesM[0]).join(), Deposits.allBodies(scan).filter((b) => b.tile < 500).map((b) => b.id + b.axesM[0]).join(),
	'another seed gives another catalogue');

// Changing one cell's potential never rerolls bodies anchored elsewhere.
const bumped = Deposits.snapshot(world, 'test');
const hot = Deposits.nearestCell(bumped.grid, 0, 1, 0);
for (let k = 0; k < 6; k++) bumped.pot[k * bumped.cells + hot] = 0.9;
const changed = Deposits.scenario(bumped, 1);
Deposits.scan(changed, 0, TILES);
const before = new Map(bodies.map((b) => [b.id, JSON.stringify(b)]));
const anchorCell = (b) => {
	const d = Deposits.dirOf(b.tile, b.fu, b.fv, [0, 0, 0]);
	return Deposits.nearestCell(snap.grid, d[0], d[1], d[2]);
};
let compared = 0;
for (const b of Deposits.allBodies(changed)) {
	if (anchorCell(b) === hot) continue;
	assert.equal(JSON.stringify(b), before.get(b.id), 'a body away from the changed cell is identical: ' + b.id);
	compared++;
}
assert.ok(compared > 100);

// ---------------------------------------------------------------- 3. bounded, valid records
for (const b of bodies) {
	assert.equal(Deposits.validate(b), '', b.id);
	assert.ok(Deposits.topAltitudeM(b) <= b.surfaceAltM, 'the top is at or below the solid surface');
	assert.ok(b.waterDepthM === Math.max(0, -b.surfaceAltM) || Math.abs(b.waterDepthM + b.surfaceAltM) < 1e-3 * b.waterDepthM + 1e-6);
	for (const m of b.commodities) assert.ok(m.grade > 0 && m.grade < (m.unit === '%' ? 100 : 1000), b.id + ' grade ' + m.grade);
}

// ---------------------------------------------------------------- 4. seam, pole and corner queries
const probes = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
	[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, -1], [1, 1, 0], [0, 1, 1], [-1, 0, 1], [0.5, 0.5, 0.0001]];
for (let k = 0; k < 40; k++) probes.push([random() - 0.5, random() - 0.5, random() - 0.5]);
// Every anchor of the catalogue is also a probe: a query centred on a body must return it.
for (let k = 0; k < bodies.length; k += 23) probes.push(Deposits.dirOf(bodies[k].tile, bodies[k].fu, bodies[k].fv, [0, 0, 0]));
for (const p of probes) {
	const len = Math.hypot(p[0], p[1], p[2]), x = p[0] / len, y = p[1] / len, z = p[2] / len;
	for (const radius of [0, 15000, Deposits.MAX_QUERY_M]) {
		const got = Deposits.near(scan, x, y, z, radius).map((b) => b.id);
		const want = bodies.filter((b) => {
			const d = Deposits.dirOf(b.tile, b.fu, b.fv, [0, 0, 0]);
			const gap = Math.acos(Math.min(1, d[0] * x + d[1] * y + d[2] * z)) * Params.radius - Math.max(...b.axesM);
			return gap <= radius;
		}).map((b) => b.id);
		assert.deepEqual(got, want, 'query agrees with a brute-force scan at ' + p + ' r=' + radius);
		assert.equal(new Set(got).size, got.length, 'no duplicates');
	}
}
assert.throws(() => Deposits.near(scan, 1, 0, 0, Deposits.MAX_QUERY_M + 1), RangeError);
// A scenario that generates lazily answers a query with the same bodies as the full scan.
const lazy = Deposits.scenario(snap, 1), probe = [0.3, 0.9, 0.2], plen = Math.hypot(...probe);
const lazyGot = Deposits.near(lazy, probe[0] / plen, probe[1] / plen, probe[2] / plen, 30000);
assert.ok(lazy.tiles.size < 12, 'a query generates only the tiles it touches');
assert.deepEqual(lazyGot, Deposits.near(scan, probe[0] / plen, probe[1] / plen, probe[2] / plen, 30000));

// ---------------------------------------------------------------- 5. resource formulas
assert.equal(Deposits.metalTonnes(1e6, 2, '%'), 20000, 'percent grade');
assert.equal(Deposits.metalTonnes(1e6, 5, 'g/t'), 5, 'g/t grade: 1 Mt at 5 g/t is 5 t');
assert.equal(Deposits.recoverableTonnes(20000, 0.85), 17000);
assert.ok(Math.abs(Deposits.volumeOf([100, 100, 100]) - 4188790.2) < 1);
for (const b of bodies.slice(0, 50)) {
	assert.ok(Math.abs(b.oreTonnes - Deposits.volumeOf(b.axesM) * b.rockDensityTm3 * b.oreFraction) < 2e-5 * b.oreTonnes, 'ore = volume x density x ore fraction');
}

// ---------------------------------------------------------------- 6. vertical intersections
const out = [0, 0];
const sphere = { axesM: [100, 100, 100], strikeDeg: 30, dipDeg: 50, burialTopM: 40 };
assert.ok(Deposits.verticalIntersection(sphere, 0, 0, out));
assert.ok(Math.abs(out[0] - 40) < 1e-9 && Math.abs(out[1] - 240) < 1e-9, 'sphere through its centre: ' + out);
assert.ok(Deposits.verticalIntersection(sphere, 60, 0, out));
assert.ok(Math.abs(out[1] - out[0] - 160) < 1e-9, 'off-centre chord of a sphere is 2 x 80 m');
assert.ok(!Deposits.verticalIntersection(sphere, 100, 0, out) && !Deposits.verticalIntersection(sphere, 90, 90, out), 'a miss is not an intersection');
const sheet = { axesM: [200, 120, 10], strikeDeg: 0, dipDeg: 0, burialTopM: 30 };
assert.ok(Deposits.verticalIntersection(sheet, 100, 0, out));
assert.ok(Math.abs(out[0] - (40 - 10 * Math.sqrt(1 - (100 / 120) ** 2))) < 1e-9, 'a flat sheet is thinner off its centre');
const lode = { axesM: [300, 100, 5], strikeDeg: 0, dipDeg: 90, burialTopM: 10 };
assert.ok(Deposits.verticalIntersection(lode, 0, 0, out) && Math.abs(out[0] - 10) < 1e-9 && Math.abs(out[1] - 210) < 1e-9, 'a vertical lode spans its down-dip axis: ' + out);
assert.ok(!Deposits.verticalIntersection(lode, 6, 0, out), 'a drill 6 m off a 5 m-thick vertical lode misses');
const target = bodies.find((b) => b.axesM[2] > 20);
const centre = Deposits.dirOf(target.tile, target.fu, target.fv, [0, 0, 0]), off = [0, 0];
Deposits.offsetFrom(target, centre[0], centre[1], centre[2], off);
assert.ok(Math.abs(off[0]) < 1e-6 && Math.abs(off[1]) < 1e-6, 'zero offset at the anchor');
assert.ok(Deposits.verticalIntersection(target, 0, 0, out) && out[0] >= target.burialTopM - 1e-6, 'a hole through the anchor cuts the body below its top');

// ---------------------------------------------------------------- 7. export and import
const rec = Deposits.parse(reference);
const imported = Deposits.fromExport(rec);
assert.equal(Deposits.json(imported), reference, 'import then export is byte-identical');
assert.deepEqual(Deposits.near(imported, 0, 1, 0, 30000), Deposits.near(scan, 0, 1, 0, 30000), 'an imported catalogue answers queries');
const partial = Deposits.scenario(snap, 1);
Deposits.scan(partial, 0, 300);
const partialText = Deposits.json(partial);
assert.equal(JSON.parse(partialText).complete, false);
const partialImport = Deposits.fromExport(Deposits.parse(partialText));
assert.throws(() => Deposits.tileBodies(partialImport, 5000), /not in this imported catalogue/);
const fresh = Deposits.scenario(snap, 1);
Deposits.adopt(fresh, Deposits.parse(partialText));
Deposits.scan(fresh, 0, TILES);
assert.equal(Deposits.json(fresh), reference, 'adopted tiles agree with regenerated ones');

const mutate = (change) => {
	const copy = JSON.parse(reference);
	change(copy);
	return JSON.stringify(copy);
};
assert.throws(() => Deposits.parse(mutate((r) => { r.generator.version = Models.version + 1; })), /generator version/);
assert.throws(() => Deposits.parse(mutate((r) => { r.format = 'x'; })), /not a deposit catalogue/);
assert.throws(() => Deposits.parse(mutate((r) => { r.bodies[0].axesM[0] += 1; })), /checksum/);
assert.throws(() => Deposits.parse(mutate((r) => { r.generator.tileN = 32; })), /tile grid/);
const guard = Deposits.scenario(snap, 1);
Deposits.scan(guard, 0, 100);
const sizeBefore = guard.tiles.size;
const other99 = Deposits.scenario(snap, 99);
Deposits.scan(other99, 0, 50);
const foreign = Deposits.parse(Deposits.json(other99));
assert.throws(() => Deposits.adopt(guard, foreign), /another scenario/);
assert.equal(guard.tiles.size, sizeBefore, 'a refused import leaves the scenario unchanged');
const summary = Deposits.summary(scan, 3);
assert.ok(summary.split('\n').length === 4 && summary.includes(snap.checksum));

// A world with no covered cells yields no bodies: nothing hides under a gap.
const empty = Deposits.snapshot(world, 'test');
empty.host.fill(0); empty.pot.fill(0);
const nothing = Deposits.scenario(empty, 1);
Deposits.scan(nothing, 0, 2000);
assert.equal(Deposits.allBodies(nothing).length, 0);
console.log('PASS deposits: tiling, access-order identity, bounded records, seam and pole queries, resource formulas, intersections, export/import contract');

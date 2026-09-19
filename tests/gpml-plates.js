// tests/gpml-plates.js - the plate polygons land the right plate on the right cell (0.4.6).
//
// This is the check that would catch a mirrored reconstruction with real geometry behind it:
// the polygons are reconstructed with js/rotations.js and rasterized on bake_earth.py's own
// lattice, so a wrong handedness, a wrong coordinate order or a wrong cell convention moves
// continents into oceans and the landmarks below fail.
const { assert } = require('./helpers.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tool = path.join(__dirname, '../tools/earth/gpml_plates.js');
const raster = (epoch) => {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgt-')), 'p.bin');
	execFileSync(process.execPath, [tool, '--epoch=' + epoch, '--out=' + out], { stdio: 'pipe' });
	const b = fs.readFileSync(out);
	const w = b.readUInt16LE(0), h = b.readUInt16LE(2), nP = b.readUInt16LE(6), n = w * h;
	const grid = new Int16Array(b.buffer.slice(b.byteOffset + 8, b.byteOffset + 8 + 2 * n));
	const ids = [], claimed = [];
	for (let i = 0; i < nP; i++) {
		ids.push(String(b.readUInt16LE(8 + 2 * n + i * 26)).padStart(3, '0'));
		claimed.push(b.readUInt32LE(8 + 2 * n + i * 26 + 2));
	}
	// bake_earth.py: r = 0 is the southernmost row, index = r * w + c.
	const at = (lat, lon) => {
		const r = Math.floor((lat + 90) / (180 / h)), c = Math.floor((lon + 180) / (360 / w));
		return grid[r * w + c] < 0 ? null : ids[grid[r * w + c]];
	};
	let assigned = 0;
	for (let i = 0; i < n; i++) if (grid[i] >= 0) assigned++;
	return {
		w: w, h: h, plates: nP, assigned: assigned, cells: n, at: at, ids: ids, grid: grid,
		claimed: claimed
	};
};

// --- present day: the polygons must put each continent on its own plate --------------------
const now = raster(0);
assert.equal(now.w, 360);
assert.equal(now.h, 180);
assert.ok(now.plates > 200, 'present day carries ' + now.plates + ' plates');
assert.ok(now.assigned / now.cells > 0.9, 'ocean floor is covered too: '
	+ (100 * now.assigned / now.cells).toFixed(1) + '%');
for (const [lat, lon, id, what] of [[0, 20, '701', 'Africa'], [45, -100, '101', 'North America'],
	[-25, 135, '801', 'Australia'], [-60, 0, '802', 'Antarctica'], [30, 80, '501', 'India'],
	[-15, -55, '201', 'South America'], [0, -150, '901', 'the Pacific']]) {
	assert.equal(now.at(lat, lon), id, what + ' at ' + lat + 'N ' + lon + 'E');
}

// --- 250 Ma: Pangaea, and the continents that were welded together -------------------------
const then = raster(250);
assert.ok(then.plates > 60 && then.plates < 150, '250 Ma carries ' + then.plates + ' plates');
// Only continental polygons are that old - the ocean floor of 250 Ma is all subducted - so the
// coverage is a quarter of the sphere, not three quarters.
assert.ok(then.assigned / then.cells > 0.18 && then.assigned / then.cells < 0.35,
	'continental coverage at 250 Ma is ' + (100 * then.assigned / then.cells).toFixed(1) + '%');
// North America and Africa were sutured: a cell in what is now the central Atlantic sits on a
// Laurussian or African plate, not on ocean.
assert.notEqual(then.at(30, -20), null, 'the central Atlantic was continental crust at 250 Ma');
// Plate centroids at 250 Ma, measured from the rasterization: Siberia 61N 52E, Africa 49S 1W,
// North America 21N 21W, South America 21S 21W, Antarctica 27S 86E, Australia 28S 134E,
// India 0N 72E. Pangaea is not a shape, it is a statement about adjacency, so the test walks
// great circles between the plates that were sutured and asks whether any of the path is ocean.
// Only continental polygons are active at 250 Ma, so an uncovered cell IS ocean.
const DEG = Math.PI / 180;
const centroid = (id) => {
	let n = 0, lat = 0, x = 0, y = 0;
	for (let r = 0; r < then.h; r++) {
		const la = -90 + (r + 0.5) * (180 / then.h);
		for (let c = 0; c < then.w; c++) {
			if (then.ids[then.grid[r * then.w + c]] !== id) continue;
			const lo = -180 + (c + 0.5) * (360 / then.w);
			n++; lat += la; x += Math.cos(lo * DEG); y += Math.sin(lo * DEG);
		}
	}
	assert.ok(n > 50, 'plate ' + id + ' has ' + n + ' cells at 250 Ma');
	return [lat / n, Math.atan2(y, x) / DEG];
};
const covered = (a, b, steps) => {
	const toXYZ = ([la, lo]) => {
		const l = la * DEG, o = lo * DEG, cl = Math.cos(l);
		return [cl * Math.cos(o), cl * Math.sin(o), Math.sin(l)];
	};
	const p = [toXYZ(a), toXYZ(b)];
	const dot = p[0][0] * p[1][0] + p[0][1] * p[1][1] + p[0][2] * p[1][2];
	const om = Math.acos(Math.max(-1, Math.min(1, dot))), sn = Math.sin(om);
	let hit = 0;
	for (let i = 0; i <= steps; i++) {
		const f = i / steps;
		const s0 = sn < 1e-9 ? 1 - f : Math.sin((1 - f) * om) / sn;
		const s1 = sn < 1e-9 ? f : Math.sin(f * om) / sn;
		const x = p[0][0] * s0 + p[1][0] * s1, y = p[0][1] * s0 + p[1][1] * s1, z = p[0][2] * s0 + p[1][2] * s1;
		if (then.at(Math.asin(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG)) hit++;
	}
	return hit / (steps + 1);
};
const C = {};
for (const id of ['101', '201', '701', '802', '801', '501', '401']) C[id] = centroid(id);
// The sutures of Pangaea and Gondwana, measured at 100, 100, 100 and 97 %.
for (const [a, b, min, label] of [['101', '701', 0.95, 'North America to Africa'],
	['201', '701', 0.95, 'South America to Africa'], ['501', '802', 0.95, 'India to Antarctica'],
	['801', '802', 0.9, 'Australia to Antarctica']]) {
	assert.ok(covered(C[a], C[b], 60) >= min, label + ' had ocean between them at 250 Ma');
}
// Control: Siberia and Australia were separated by the Tethys and the Palaeo-Pacific, so this
// path must NOT be fully covered - without it the sutures above would pass on a rasterized
// blob that covered everything.
assert.ok(covered(C['401'], C['801'], 60) < 0.85, 'the Siberia-Australia control is covered too');

// --- the grid and the table have to agree about index space --------------------------------
// The bug this pins: the grid holds indices in plate-id order, so a consumer reading the grid
// and then the table only gets the right plate if the table is in the same order.
const counted = new Int32Array(then.plates);
for (let i = 0; i < then.grid.length; i++) if (then.grid[i] >= 0) counted[then.grid[i]]++;
for (let i = 0; i < then.plates; i++) {
	assert.equal(counted[i], then.claimed[i], 'plate ' + then.ids[i] + ' cell count');
}
console.log('PASS gpml-plates: ' + now.plates + ' plates today with '
	+ (100 * now.assigned / now.cells).toFixed(1) + '% coverage, ' + then.plates + ' at 250 Ma with '
	+ (100 * then.assigned / then.cells).toFixed(1) + '%, every plate count matching its grid');

#!/usr/bin/env node
/* tools/earth/gpml_plates.js - PALEOMAP plate polygons -> real plate ids per cell (0.4.6).

   The companion of PALEOMAP_PlateModel.rot: PALEOMAP_PlatePolygons.gpml holds 469 features,
   503 rings, 26,936 vertices, each tagged with the plate id its ring rides and a time window.
   Reconstructing a ring to an epoch with the same rotation model and rasterizing it gives a
   real plate id per raster cell - which is what plan 0.4.6 s4 wanted and could not have,
   because backtracking the modern pack's ids only ever recovers the plates that still exist.

   GPML conventions, all read off the file rather than assumed:
     - coordinates in gml:posList are LATITUDE LONGITUDE pairs (19.54 -155.2 is Hawaii);
     - the plate id is gpml:reconstructionPlateId, which is the id the .rot keys on;
     - the window is [DISAPPEARA, APPEARANCE] in Ma-ago, DISAPPEARA = -999 meaning "still
       there". So (0, 0) is a present-day-only feature - 215 of them are modern ocean floor -
       (4500, -999) is a craton, and (999, 600) is a plate extinct since 600 Ma;
     - 240 of the 241 ids appear in the .rot (the 241st is 0, meaning "no plate"), and 18 of
       the .rot's 258 plates have no polygon at all - mostly microplates.

   Cell (r, c) is lat = -90 + (r + 0.5) * 180/h, lon = -180 + (c + 0.5) * 360/w, index
   r * w + c - exactly bake_earth.py's raster, so the output lines up with a pack.

   Usage:
     node tools/earth/gpml_plates.js --epoch=250 [--width=360] [--height=180]
                                     [--gpml=data/earth/PALEOMAP_PlatePolygons.gpml]
                                     [--out=data/earth/paleo/plates-250Ma.bin]
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Quat = require('../../js/quat.js');
const Rotations = require('../../js/rotations.js');

const arg = (name, def) => {
	const at = process.argv.indexOf('--' + name);
	const eq = process.argv.find((x) => x.startsWith('--' + name + '='));
	if (eq !== undefined) return eq.slice(name.length + 3);
	if (at >= 0 && at + 1 < process.argv.length && !process.argv[at + 1].startsWith('--')) return process.argv[at + 1];
	return def;
};
const EPOCH = +arg('epoch', 250);
const W = +arg('width', 360), H = +arg('height', 180);
const GPML = arg('gpml', 'data/earth/PALEOMAP_PlatePolygons.gpml');
const OUT = arg('out', null);
const DEG = Math.PI / 180;

// --- parse ---------------------------------------------------------------------------------
const src = fs.readFileSync(GPML, 'utf8');
const chunks = src.split('<gml:featureMember>').slice(1);
const attr = (f, key) => {
	const m = f.match(new RegExp('<gpml:key>' + key + '</gpml:key>[\\s\\S]*?<gpml:value>([^<]*)</gpml:value>'));
	return m ? m[1].trim() : null;
};
const feats = [];
let skipped = 0, ringsParsed = 0, vertsParsed = 0;
for (const f of chunks) {
	const idm = f.match(/<gpml:reconstructionPlateId>[\s\S]*?<gpml:value>(\d+)<\/gpml:value>/);
	const appear = attr(f, 'APPEARANCE'), vanish = attr(f, 'DISAPPEARA');
	if (!idm || appear === null || vanish === null) { skipped++; continue; }
	const rings = [];
	for (const m of f.matchAll(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)) {
		const v = m[1].trim().split(/\s+/).map(Number);
		if (v.length < 6 || v.some((x) => !Number.isFinite(x))) { skipped++; continue; }
		rings.push(v);
		ringsParsed++;
		vertsParsed += v.length / 2;
	}
	if (!rings.length) continue;
	feats.push({
		id: idm[1].padStart(3, '0'),
		from: +vanish === -999 ? -Infinity : +vanish,      // younger bound, Ma ago
		to: +appear,                                       // older bound, Ma ago
		rings: rings
	});
}
console.log('[*] ' + GPML + ': ' + chunks.length + ' features, ' + feats.length + ' usable, '
	+ ringsParsed + ' rings, ' + vertsParsed + ' vertices (' + skipped + ' skipped)');

// --- select and reconstruct ----------------------------------------------------------------
const q = new Float64Array(4), v = new Float64Array(6), out = new Float64Array(2);
const active = [];
const missing = new Map();
for (const f of feats) {
	if (EPOCH < f.from || EPOCH > f.to) continue;
	const p = Rotations.of(f.id);
	if (!p) { missing.set(f.id, (missing.get(f.id) || 0) + 1); continue; }
	const rings = [];
	for (const r of f.rings) {
		const geo = new Float64Array(r.length);
		let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
		for (let i = 0; i < r.length; i += 2) {
			Rotations.toXYZ(r[i], r[i + 1], v, 3);
			Rotations.at(p, EPOCH, q, 0);
			Quat.rotate(v, 0, q, 0, v, 3);
			Rotations.toLatLon(v[0], v[1], v[2], out, 0);
			geo[i] = out[0]; geo[i + 1] = out[1];
			if (out[0] < latMin) latMin = out[0];
			if (out[0] > latMax) latMax = out[0];
			if (out[1] < lonMin) lonMin = out[1];
			if (out[1] > lonMax) lonMax = out[1];
		}
		// Shoelace area on the lat/lon plane, only ever used to rank rings against each other.
		let area = 0;
		for (let i = 0, j = geo.length - 2; i < geo.length - 1; j = i, i += 2) {
			area += (geo[j + 1] - geo[i + 1]) * (geo[j] + geo[i]);
		}
		rings.push(geo);
		active.push({
			id: f.id, ring: geo, area: Math.abs(area) / 2,
			latMin: latMin, latMax: latMax, lonMin: lonMin, lonMax: lonMax
		});
	}
}
if (missing.size) {
	console.log('    ' + missing.size + ' plate ids have polygons but no rotation: '
		+ [...missing.keys()].join(' '));
}
console.log('    ' + active.length + ' rings active at ' + EPOCH + ' Ma');
if (!active.length) throw new Error('no polygon is active at ' + EPOCH + ' Ma - check the window convention');

// --- rasterize -----------------------------------------------------------------------------
// Bucketed so a cell only tests the rings that could contain it; longitude wraps.
const BUCKET = 5, BW = Math.ceil(360 / BUCKET), BH = Math.ceil(180 / BUCKET);
const buckets = new Array(BW * BH);
for (const a of active) {
	const r0 = Math.max(0, Math.floor((a.latMin + 90) / BUCKET));
	const r1 = Math.min(BH - 1, Math.floor((a.latMax + 90) / BUCKET));
	// A ring wider than half the globe is treated as global in longitude: unwrapping its
	// bbox would otherwise drop cells on the far side of the antimeridian.
	const global = a.lonMax - a.lonMin > 180;
	const c0 = global ? 0 : Math.floor((a.lonMin + 180) / BUCKET);
	const c1 = global ? BW - 1 : Math.floor((a.lonMax + 180) / BUCKET);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			const k = r * BW + ((c % BW) + BW) % BW;
			(buckets[k] || (buckets[k] = [])).push(a);
		}
	}
}
const inside = (lon, lat, ring) => {
	let cross = 0;
	const n = ring.length;
	for (let i = 0, j = n - 2; i < n - 1; j = i, i += 2) {
		const la1 = ring[j], lo1 = ring[j + 1], la2 = ring[i], lo2 = ring[i + 1];
		if ((la1 > lat) === (la2 > lat)) continue;
		let d1 = lo1 - lon, d2 = lo2 - lon;
		while (d1 > 180) d1 -= 360; while (d1 < -180) d1 += 360;
		while (d2 > 180) d2 -= 360; while (d2 < -180) d2 += 360;
		if (d1 + (lat - la1) / (la2 - la1) * (d2 - d1) > 0) cross++;
	}
	return (cross & 1) === 1;
};
const grid = new Int16Array(W * H).fill(-1);
const areaOf = new Float64Array(W * H);
const ids = [...new Set(active.map((a) => a.id))].sort();
const indexOf = new Map(ids.map((id, i) => [id, i]));
let hits = 0, overlaps = 0;
const dLat = 180 / H, dLon = 360 / W;
for (let r = 0; r < H; r++) {
	const lat = -90 + (r + 0.5) * dLat;
	const bk = Math.max(0, Math.min(BH - 1, Math.floor((lat + 90) / BUCKET)));
	for (let c = 0; c < W; c++) {
		const lon = -180 + (c + 0.5) * dLon;
		const list = buckets[bk * BW + Math.floor((lon + 180) / BUCKET)];
		if (!list) continue;
		for (const a of list) {
			if (!inside(lon, lat, a.ring)) continue;
			hits++;
			// Overlapping rings are real (microplates sit inside the plates they were cut
			// from), so the smaller ring wins: it is the more specific claim. Taking the file
			// order instead would make the answer depend on the order of the archive.
			if (grid[r * W + c] >= 0) {
				overlaps++;
				if (areaOf[r * W + c] <= a.area) continue;
			}
			grid[r * W + c] = indexOf.get(a.id);
			areaOf[r * W + c] = a.area;
		}
	}
}
// Counts come from the finished grid, not from the hits during rasterizing: a cell that was
// overwritten must not still be charged to the plate that lost it.
const cells = new Int32Array(ids.length);
let assigned = 0;
for (let i = 0; i < grid.length; i++) if (grid[i] >= 0) { cells[grid[i]]++; assigned++; }
console.log('    ' + ids.length + ' plates, ' + assigned + ' of ' + W * H + ' cells assigned ('
	+ (100 * assigned / (W * H)).toFixed(1) + '%), ' + overlaps + ' overlapping hits');

// Per-plate seed (the cell farthest from the plate's own centroid direction is unnecessary -
// the area centroid is what bake_earth.py uses a seed for) and the real omega at the epoch.
const seedSum = new Float64Array(ids.length * 3);
for (let r = 0; r < H; r++) {
	const lat = (-90 + (r + 0.5) * dLat) * DEG, cl = Math.cos(lat);
	for (let c = 0; c < W; c++) {
		const p = grid[r * W + c];
		if (p < 0) continue;
		const lon = (-180 + (c + 0.5) * dLon) * DEG, b = p * 3;
		seedSum[b] += cl * Math.cos(lon); seedSum[b + 1] += cl * Math.sin(lon); seedSum[b + 2] += Math.sin(lat);
	}
}
const om = new Float64Array(3);
// The table is in the SAME order as the grid's indices (by plate id), because a consumer that
// reads the grid and then the table has no other way to line them up. Sorting is for the
// printed report only.
const table = ids.map((id, i) => {
	const p = Rotations.of(id), b = i * 3;
	const m = Math.hypot(seedSum[b], seedSum[b + 1], seedSum[b + 2]) || 1;
	Rotations.pole(p, EPOCH, om, 0);
	return {
		index: i, id: id, code: p.code, cells: cells[i],
		seedLat: Math.asin(seedSum[b + 2] / m) / DEG, seedLon: Math.atan2(seedSum[b + 1], seedSum[b]) / DEG,
		omegaDegPerMa: Math.hypot(om[0], om[1], om[2]) / DEG,
		history: Rotations.has(p, EPOCH)
	};
});
const byCells = [...table].sort((a, b) => b.cells - a.cells);
const noHistory = table.filter((t) => !t.history);
console.log('    top plates: ' + byCells.slice(0, 8).map((t) => t.code + '/' + t.id + ' ' + t.cells).join(', '));
if (noHistory.length) {
	console.log('    ' + noHistory.length + ' plates have polygons at ' + EPOCH
		+ ' Ma but no rotation there (held at their oldest sample): '
		+ noHistory.slice(0, 8).map((t) => t.code + '/' + t.id).join(', '));
}

// --- emit ----------------------------------------------------------------------------------
if (OUT) {
	// [w:u16][h:u16][epoch:u16][plates:u16] grid:i16[w*h], then 26 bytes per plate:
	// id:u16, cells:u32, seedLat:f32, seedLon:f32, omega 3xf32 (rad/Myr vector).
	const nP = table.length;
	const buf = Buffer.alloc(8 + W * H * 2 + nP * 26);
	let o = 0;
	buf.writeUInt16LE(W, o); buf.writeUInt16LE(H, o + 2); buf.writeUInt16LE(EPOCH, o + 4);
	buf.writeUInt16LE(nP, o + 6); o += 8;
	for (let i = 0; i < W * H; i++) buf.writeInt16LE(grid[i], o + i * 2);
	o += W * H * 2;
	for (const t of table) {
		Rotations.pole(Rotations.of(t.id), EPOCH, om, 0);
		buf.writeUInt16LE(+t.id, o); buf.writeUInt32LE(t.cells, o + 2);
		buf.writeFloatLE(t.seedLat, o + 6); buf.writeFloatLE(t.seedLon, o + 10);
		buf.writeFloatLE(om[0], o + 14); buf.writeFloatLE(om[1], o + 18); buf.writeFloatLE(om[2], o + 22);
		o += 26;
	}
	fs.mkdirSync(path.dirname(OUT) || '.', { recursive: true });
	fs.writeFileSync(OUT, buf);
	console.log('[+] ' + OUT + ' (' + buf.length + ' bytes, ' + nP + ' plates)');
}
console.log('PASS gpml_plates: ' + EPOCH + ' Ma, ' + assigned + ' cells, ' + table.length + ' plates');

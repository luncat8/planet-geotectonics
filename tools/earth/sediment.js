/* tools/earth/sediment.js — modern-pack sediment contract (0.4.8).
 *
 * Not loaded by the page. The bake calls --apply after a present-day pack is written;
 * tests require the functions. Two correction paths, one envelope:
 *
 *   raster  CRUST1.0 (or a later extract in the same bin) replaces the sediment bank.
 *           z stays unless the loader's invert hits a thickness bound at that sediment
 *           (oceanic hMaf 2–35 km, continental hFel 1–80 km). Those cells take the
 *           clamped elevation, which round-trips. A smoothstep residual with no bound
 *           hit is labelled and kept: the 5-iteration invert does not close it locally,
 *           and a distant integer that does would rewrite the shelf. Historical packs
 *           are refused. A second apply is a fixed point of this rule.
 *   points  a validated observation table, same crust class only, inverse-distance
 *           inside an explicit radius. z is frozen: sediment is pulled back toward the
 *           prior until the loader's inversion reproduces z. Holdouts are not applied.
 *
 * Sediment stays in the pack's 100 m units. kind bit 4 is the elevation/age prior and
 * is not reused as a sediment flag — erosion overwrites hSed within a step, so a
 * per-column "this is still the model" label would lie. Provenance is the pack source
 * string and the bake report.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Earth = require('../../js/earth.js');

const RADIUS_M = 6371000;
const SED_STEP = 100;
const SED_MAX = 255 * SED_STEP;
const ROUND_M = 1;
const DEFAULT_RADIUS_M = 400000;
const MAGIC = Buffer.from('PGTSED01');
// The distance prior bake_paleo applied before this increment, of the extract's
// pre-datum elevation. Exposed land 2000 m, flooded shelf 6000 m, ocean
// 1000 + 4000*exp(-distDeg/4) capped at 5000. Quantized to 100 m on the way out.
// distDeg is chebyshev cell steps, not spherical distance. Kept so a re-bake can
// be recognised, not so it can be treated as a measurement.
const PRIOR = {
	exposedM: 2000,
	shelfM: 6000,
	oceanFloorM: 1000,
	oceanMarginM: 4000,
	oceanCapM: 5000,
	oceanDecayDeg: 4
};

function quantizeSed(metres) {
	if (!(metres >= 0)) return 0;
	const q = Math.round(metres / SED_STEP);
	if (q <= 0) return 0;
	if (q >= 255) return SED_MAX;
	return q * SED_STEP;
}

function elevation(hFel, hMaf, hSed, age) {
	const ci = Earth.smoothstep(hFel, 5000, 20000);
	const thermal = (1 - ci) * 350 * Math.sqrt(Math.min(age, 80)) + ci * 2091;
	return -3342 + hFel / 6 + (hMaf * 350 + hSed * 900) / 3300 - thermal;
}

// The elevation the loader will derive from this (z, sed) pair. Continental age is
// 500, matching Earth.decode, not the age bank (the bake stored 255 there).
function derivedZ(z, age, sed, cont) {
	const inv = { fel: 0, maf: 0 };
	Earth.invert(z, cont ? 500 : age, sed, cont, inv);
	return elevation(inv.fel, inv.maf, sed, cont ? 500 : age);
}

function roundTrips(z, age, sed, cont) {
	return Math.abs(derivedZ(z, age, sed, cont) - z) <= ROUND_M;
}

// Continental invert always stores maf = 0. That is the branch, not a clamp.
function thicknessBound(inv, cont) {
	if (cont) return inv.fel <= 1000 || inv.fel >= 80000;
	return inv.maf <= 2000 || inv.maf >= 35000;
}

// z for one cell after the sediment replacement. Moved only on a bound hit the stored
// elevation cannot carry. Residuals are the |derived - z| left when z is kept.
function envelopeZ(z0, age, sed, cont) {
	const inv = { fel: 0, maf: 0 };
	Earth.invert(z0, cont ? 500 : age, sed, cont, inv);
	const e = elevation(inv.fel, inv.maf, sed, cont ? 500 : age);
	const gap = Math.abs(e - z0);
	if (thicknessBound(inv, cont) && gap > ROUND_M) {
		let z1 = Math.round(e);
		if (z1 < -32768) z1 = -32768;
		if (z1 > 32767) z1 = 32767;
		return { z: z1, moved: true, residual: 0 };
	}
	return { z: z0, moved: false, residual: gap > ROUND_M ? gap : 0 };
}

function cellLatLon(w, h, i) {
	const r = Math.floor(i / w), c = i - r * w;
	return [-90 + (r + 0.5) * (180 / h), -180 + (c + 0.5) * (360 / w)];
}

function priorSed(cont, zPreDatum, distDeg) {
	if (cont) return zPreDatum < 0 ? PRIOR.shelfM : PRIOR.exposedM;
	const ocean = PRIOR.oceanFloorM + PRIOR.oceanMarginM * Math.exp(-distDeg / PRIOR.oceanDecayDeg);
	return Math.min(PRIOR.oceanCapM, ocean);
}

// CRUST1.0 order: row 0 is the 89.5 N cell, col 0 is -179.5 E. The model's own
// index (floor(90 - lat), floor(180 + lon)) is the containing 1° cell, so a 1°
// pack centre lands on the model cell and a 0.5° pair shares it.
function loadCrust1(file) {
	const buf = fs.readFileSync(file);
	if (buf.length < 16 || !buf.subarray(0, 8).equals(MAGIC)) {
		throw new Error('not a PGTSED01 sediment extract: ' + file);
	}
	const w = buf.readUInt16LE(8), h = buf.readUInt16LE(10);
	if (w !== 360 || h !== 180) throw new Error('CRUST1.0 sediment extract must be 360x180');
	const n = w * h;
	if (buf.length !== 16 + n * 2) throw new Error('sediment extract length ' + buf.length + ' != ' + (16 + n * 2));
	const sed = new Uint16Array(n);
	for (let i = 0; i < n; i++) sed[i] = buf.readUInt16LE(16 + i * 2);
	return { w: w, h: h, sed: sed };
}

function writeCrust1(file, w, h, metres) {
	const n = w * h;
	const buf = Buffer.alloc(16 + n * 2);
	MAGIC.copy(buf, 0);
	buf.writeUInt16LE(w, 8);
	buf.writeUInt16LE(h, 10);
	for (let i = 0; i < n; i++) {
		const v = Math.round(metres[i]);
		if (!Number.isFinite(v) || v < 0 || v > 65535) {
			throw new Error('sediment cell ' + i + ' is outside uint16 metres');
		}
		buf.writeUInt16LE(v, 16 + i * 2);
	}
	fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
	fs.writeFileSync(file, buf);
}

function sampleCrust1(grid, lat, lon) {
	let ilat = Math.floor(90 - lat);
	const ilon = ((Math.floor(180 + lon) % grid.w) + grid.w) % grid.w;
	if (ilat < 0) ilat = 0;
	if (ilat >= grid.h) ilat = grid.h - 1;
	return grid.sed[ilat * grid.w + ilon];
}

// Sediment from the extract, containing 1° cell, quantized to the pack's 100 m step.
// z moves only on a thickness-bound hit (envelopeZ). A pack this function has already
// written is a fixed point: bound cells round-trip, unbound residuals are not chased.
function applyRaster(decoded, w, h, grid) {
	const n = w * h;
	const sed = new Uint8Array(n);
	const z = new Int16Array(n);
	let moved = 0, flips = 0, capped = 0, residual = 0, maxResidual = 0;
	for (let i = 0; i < n; i++) {
		const ll = cellLatLon(w, h, i);
		const raw = sampleCrust1(grid, ll[0], ll[1]);
		if (raw > SED_MAX) capped++;
		const q = quantizeSed(raw);
		const cont = decoded.kind[i] & 1;
		const env = envelopeZ(decoded.z[i], decoded.age[i], q, cont);
		if (env.moved) {
			moved++;
			if ((decoded.z[i] < 0) !== (env.z < 0)) flips++;
		} else if (env.residual > 0) {
			residual++;
			if (env.residual > maxResidual) maxResidual = env.residual;
		}
		sed[i] = q / SED_STEP;
		z[i] = env.z;
	}
	return {
		sed: sed, z: z, moved: moved, flips: flips, capped: capped,
		residual: residual, maxResidual: maxResidual
	};
}

function haversineM(lat1, lon1, lat2, lon2) {
	const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
	const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
	const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * RADIUS_M * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
}

// Point path. z is not an output: sediment is pulled back until the stored z
// round-trips. Holdout rows and the other crust class do not contribute.
function correctPoints(grid, observations, opts) {
	opts = opts || {};
	const validation = validateObservations({ observations: observations });
	if (!validation.ok) throw new Error(validation.errors.join('\n'));
	const w = grid.w, h = grid.h, n = w * h;
	const radius = opts.radiusM === undefined ? DEFAULT_RADIUS_M : opts.radiusM;
	if (!Number.isFinite(radius) || radius <= 0) throw new Error('radiusM must be finite and positive');
	const sed = new Float64Array(n);
	let pulled = 0, touched = 0;
	const usable = [];
	for (let k = 0; k < observations.length; k++) {
		const o = observations[k];
		// Unknown is not a measured zero and must not enter either IDW sum.
		if (!o.holdout && o.value !== null) usable.push(o);
	}
	for (let i = 0; i < n; i++) {
		const cont = grid.kind[i] & 1;
		const ll = cellLatLon(w, h, i);
		let wsum = 0, vsum = 0;
		for (let k = 0; k < usable.length; k++) {
			const o = usable[k];
			if ((o.crust === 'continental') !== !!cont) continue;
			const reach = o.radius_m || radius;
			const d = haversineM(ll[0], ll[1], o.lat, o.lon);
			if (d > reach) continue;
			const weight = 1 / (d * d + 1);
			wsum += weight;
			vsum += weight * o.value;
		}
		const prior = quantizeSed(grid.sed[i]);
		if (wsum === 0) { sed[i] = prior; continue; }
		touched++;
		let q = quantizeSed(vsum / wsum);
		if (!roundTrips(grid.z[i], grid.age[i], q, cont)) {
			const step = q >= prior ? SED_STEP : -SED_STEP;
			let cursor = q;
			while (cursor !== prior && !roundTrips(grid.z[i], grid.age[i], cursor, cont)) cursor -= step;
			if (cursor !== q) pulled++;
			q = cursor;
		}
		sed[i] = q;
	}
	return { sed: sed, pulled: pulled, touched: touched };
}

function need(obj, key, errors, id) {
	if (typeof obj[key] !== 'string' || !obj[key].trim()) errors.push(id + ': missing ' + key + ' (nonempty string required)');
}

function validateObservations(doc) {
	const errors = [];
	if (!doc || !Array.isArray(doc.observations)) {
		return { ok: false, errors: ['observations array required'] };
	}
	const seen = Object.create(null);
	const rows = doc.observations;
	for (let i = 0; i < rows.length; i++) {
		const o = rows[i];
		const id = o && o.id ? String(o.id) : '#' + i;
		if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(id + ': not an object'); continue; }
		need(o, 'id', errors, id);
		if (o.id !== undefined) {
			if (seen[o.id]) errors.push(id + ': duplicate id');
			seen[o.id] = 1;
		}
		if (!Number.isFinite(o.lat) || o.lat < -90 || o.lat > 90) errors.push(id + ': lat out of range');
		if (!Number.isFinite(o.lon) || o.lon < -180 || o.lon > 180) errors.push(id + ': lon out of range');
		if (o.field !== 'sediment_thickness') errors.push(id + ': field must be sediment_thickness');
		if (o.crust !== 'continental' && o.crust !== 'oceanic') errors.push(id + ': crust class required');
		if (o.role !== 'observed' && o.role !== 'interpreted' && o.role !== 'prior') errors.push(id + ': role required');
		if (typeof o.holdout !== 'boolean') errors.push(id + ': holdout boolean required');
		need(o, 'source_id', errors, id);
		need(o, 'dataset_version', errors, id);
		need(o, 'extraction', errors, id);
		need(o, 'record', errors, id);
		if (!Number.isFinite(o.footprint_m) || o.footprint_m < 0) errors.push(id + ': footprint_m required');
		if (o.value === null) {
			need(o, 'unknown_reason', errors, id);
		} else if (!Number.isFinite(o.value) || o.value < 0) {
			errors.push(id + ': value must be metres or null');
		} else {
			if (o.unit !== 'm') errors.push(id + ': unit must be m');
			// null >= 0 is true in JS, so a missing uncertainty must be rejected by type.
			if (o.value === 0 && !(Number.isFinite(o.uncertainty_m) && o.uncertainty_m >= 0)) {
				errors.push(id + ': zero is not unknown; give uncertainty_m');
			}
		}
		if (o.uncertainty_m !== null && o.uncertainty_m !== undefined && (!Number.isFinite(o.uncertainty_m) || o.uncertainty_m < 0)) {
			errors.push(id + ': uncertainty_m must be finite and >= 0 or null');
		}
		if (o.radius_m !== undefined && (!Number.isFinite(o.radius_m) || o.radius_m <= 0)) errors.push(id + ': radius_m must be finite and positive');
	}
	return { ok: errors.length === 0, errors: errors };
}

function areaStats(z, sedMetres, kind, w, h) {
	let area = 0, sedA = 0, wetA = 0, landA = 0, landS = 0, oceA = 0, oceS = 0;
	let minS = Infinity, maxS = -Infinity;
	for (let r = 0; r < h; r++) {
		const lat = -90 + (r + 0.5) * (180 / h);
		const weight = Math.cos(lat * Math.PI / 180);
		for (let c = 0; c < w; c++) {
			const i = r * w + c;
			const s = sedMetres[i], zz = z[i];
			if (s < minS) minS = s;
			if (s > maxS) maxS = s;
			area += weight;
			sedA += s * weight;
			if (zz < 0) { wetA += weight; oceA += weight; oceS += zz * weight; }
			else { landA += weight; landS += zz * weight; }
		}
	}
	return {
		cells: w * h,
		sedMin: minS, sedMax: maxS,
		sedAreaMean: sedA / area,
		wet: wetA / area,
		meanLand: landA ? landS / landA : 0,
		meanOcean: oceA ? oceS / oceA : 0
	};
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

function banksOf(decoded, w, h) {
	const n = w * h;
	const zBuf = Buffer.alloc(n * 2);
	const sedBuf = Buffer.alloc(n);
	for (let i = 0; i < n; i++) {
		zBuf.writeInt16LE(Math.round(decoded.z[i]), i * 2);
		sedBuf[i] = Math.round(decoded.sed[i] / SED_STEP);
	}
	return { z: zBuf, sed: sedBuf };
}

function replaceQuoted(text, key, value) {
	const token = key + ": '";
	const at = text.indexOf(token);
	if (at < 0) throw new Error('pack field not found: ' + key);
	const start = at + token.length;
	const end = text.indexOf("'", start);
	if (end < 0) throw new Error('pack field unterminated: ' + key);
	if (text.indexOf(token, end) >= 0) throw new Error('pack field repeated: ' + key);
	return text.slice(0, start) + value + text.slice(end);
}

function replaceOcean(text, wet) {
	const token = '\t\tocean: ';
	const at = text.indexOf(token);
	if (at < 0) throw new Error('pack ocean field not found');
	const start = at + token.length;
	const end = text.indexOf(',', start);
	return text.slice(0, start) + wet.toFixed(4) + text.slice(end);
}

// Rewrite sed, and z where the envelope moved, plus the source string and the
// header wet fraction. age, kind and the plate table are not touched.
function wetFraction(z, w) {
	const n = z.length, h = n / w;
	let wet = 0, area = 0;
	for (let r = 0; r < h; r++) {
		const weight = Math.cos((-90 + (r + 0.5) * (180 / h)) * Math.PI / 180);
		for (let c = 0; c < w; c++) {
			area += weight;
			if (z[r * w + c] < 0) wet += weight;
		}
	}
	return wet / area;
}

function patchPackTextAt(text, applied, w, sourceNote) {
	const zBuf = Buffer.alloc(applied.z.length * 2);
	for (let i = 0; i < applied.z.length; i++) zBuf.writeInt16LE(applied.z[i], i * 2);
	let out = replaceQuoted(text, '\t\t\tz', zBuf.toString('base64'));
	out = replaceQuoted(out, '\t\t\tsed', Buffer.from(applied.sed).toString('base64'));
	const sourceAt = out.indexOf("\tsource: '");
	const sourceEnd = out.indexOf("'", sourceAt + 10);
	const source = out.slice(sourceAt + 10, sourceEnd);
	if (source.indexOf(sourceNote) < 0) out = replaceQuoted(out, '\tsource', source + sourceNote);
	out = replaceOcean(out, wetFraction(applied.z, w));
	return out;
}

function loadPack(file) {
	const g = typeof global !== 'undefined' ? global : globalThis;
	const prev = g.EarthPacks;
	g.EarthPacks = [];
	const resolved = require.resolve(path.resolve(file));
	delete require.cache[resolved];
	require(resolved);
	const pack = g.EarthPacks[0];
	g.EarthPacks = prev;
	if (!pack) throw new Error('no pack in ' + file);
	delete pack._decoded;
	return pack;
}

function assertModern(pack) {
	if (pack.name !== 'earth' || pack.epoch !== 0) {
		throw new Error('sediment correction is modern packs only, refused ' + pack.name + ' epoch ' + pack.epoch);
	}
}

function applyFile(packFile, sedimentFile) {
	const pack = loadPack(packFile);
	assertModern(pack);
	const decoded = Earth.decode(pack);
	const grid = loadCrust1(sedimentFile);
	const applied = applyRaster(decoded, pack.w, pack.h, grid);
	const text = fs.readFileSync(packFile, 'utf8');
	const ageKey = "\t\t\tage: '";
	const kindKey = "\t\t\tkind: '";
	// Pack provenance only. Erosion overwrites hSed within a step, so this string is not
	// a live-column label and the inspector must keep reporting state.hSed.
	const next = patchPackTextAt(text, applied, pack.w, ' + CRUST1.0 sediment (not GlobSed)');
	if (next.indexOf(text.slice(text.indexOf(ageKey), text.indexOf("'", text.indexOf(ageKey) + ageKey.length) + 1)) < 0) {
		throw new Error('age bank was not preserved');
	}
	if (next.indexOf(text.slice(text.indexOf(kindKey), text.indexOf("'", text.indexOf(kindKey) + kindKey.length) + 1)) < 0) {
		throw new Error('kind bank was not preserved');
	}
	fs.writeFileSync(packFile, next);
	return {
		pack: pack.name, w: pack.w, h: pack.h, moved: applied.moved, flips: applied.flips,
		capped: applied.capped, residual: applied.residual, maxResidual: applied.maxResidual,
		wet: wetFraction(applied.z, pack.w)
	};
}

// bnds: 180 x 360 x 9 boundary elevations, km, row-major north-first, one cell per line.
// Sediment is the three sedimentary layers only — water and ice are not hSed.
function extractBnds(bndsFile, outFile) {
	const lines = fs.readFileSync(bndsFile, 'utf8').trim().split(/\n/);
	if (lines.length !== 180 * 360) throw new Error('expected 64800 bnds rows, got ' + lines.length);
	const metres = new Float64Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const b = lines[i].trim().split(/\s+/).map(Number);
		if (b.length !== 9) throw new Error('bnds row ' + i + ' has ' + b.length + ' values');
		if (!b.every(Number.isFinite)) throw new Error('bnds row ' + i + ' has nonfinite values');
		for (let j = 1; j < b.length; j++) {
			if (b[j] > b[j - 1]) throw new Error('bnds row ' + i + ' boundaries must descend');
		}
		metres[i] = (b[2] - b[5]) * 1000;
	}
	writeCrust1(outFile, 360, 180, metres);
	let min = metres[0], max = metres[0];
	for (let i = 1; i < metres.length; i++) {
		if (metres[i] < min) min = metres[i];
		if (metres[i] > max) max = metres[i];
	}
	return { cells: metres.length, min: min, max: max };
}

function flag(name) {
	const i = process.argv.indexOf('--' + name);
	if (i < 0) return null;
	return process.argv[i + 1];
}

function main() {
	const observationsFile = flag('validate-observations');
	if (observationsFile) {
		const doc = JSON.parse(fs.readFileSync(observationsFile, 'utf8'));
		const validation = validateObservations(doc);
		console.log(JSON.stringify(validation, null, 2));
		if (!validation.ok) process.exitCode = 1;
		return;
	}
	const bnds = flag('extract-bnds');
	if (bnds) {
		const out = flag('out');
		if (!out) throw new Error('--out required');
		const r = extractBnds(bnds, out);
		console.log('[+] ' + out + ' cells ' + r.cells + ' sed ' + r.min.toFixed(0) + '..' + r.max.toFixed(0) + ' m');
		return;
	}
	const packFile = flag('pack');
	const sedimentFile = flag('sediment');
	if (process.argv.indexOf('--apply') >= 0) {
		if (!packFile || !sedimentFile) throw new Error('--apply needs --pack and --sediment');
		const r = applyFile(packFile, sedimentFile);
		console.log('[+] ' + packFile + ' sediment replaced; envelope moved ' + r.moved
			+ ' cells, sign flips ' + r.flips + ', unbound residual ' + r.residual
			+ ' (max ' + r.maxResidual.toFixed(1) + ' m), wet ' + r.wet.toFixed(4));
		return;
	}
	if (process.argv.indexOf('--report') >= 0) {
		if (!packFile) throw new Error('--report needs --pack');
		const pack = loadPack(packFile);
		const d = Earth.decode(pack);
		const sedM = new Float64Array(d.sed.length);
		for (let i = 0; i < sedM.length; i++) sedM[i] = d.sed[i];
		const stats = areaStats(d.z, sedM, d.kind, pack.w, pack.h);
		const banks = banksOf(d, pack.w, pack.h);
		console.log(JSON.stringify({
			pack: packFile, name: pack.name, epoch: pack.epoch, w: pack.w, h: pack.h, source: pack.source,
			stats: stats, zSha256: sha256(banks.z), sedSha256: sha256(banks.sed)
		}, null, 2));
		return;
	}
	console.error('usage: sediment.js --apply --pack <js> --sediment <bin>');
	console.error('       sediment.js --report --pack <js>');
	console.error('       sediment.js --validate-observations <json>');
	console.error('       sediment.js --extract-bnds <crust1.bnds> --out <bin>');
	process.exit(1);
}

module.exports = {
	PRIOR: PRIOR, SED_STEP: SED_STEP, DEFAULT_RADIUS_M: DEFAULT_RADIUS_M, RADIUS_M: RADIUS_M,
	quantizeSed: quantizeSed, elevation: elevation, derivedZ: derivedZ, roundTrips: roundTrips,
	thicknessBound: thicknessBound, envelopeZ: envelopeZ,
	priorSed: priorSed, loadCrust1: loadCrust1, sampleCrust1: sampleCrust1, applyRaster: applyRaster,
	correctPoints: correctPoints, validateObservations: validateObservations, areaStats: areaStats,
	wetFraction: wetFraction, cellLatLon: cellLatLon, loadPack: loadPack, sha256: sha256
};

if (require.main === module) main();

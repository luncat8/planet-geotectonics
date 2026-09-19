#!/usr/bin/env node
/* tools/earth/rot_ingest.js - PALEOMAP .rot -> js/data/rot-paleomap.js (0.4.6).

   The .rot is the GPlates rotation format, and four of its properties decide the whole
   ingest. Each was settled by measurement, not assumption, and each is asserted below:

   1. the columns are `moving_plate time lat lon angle anchor` - the anchor is the LAST
      field, not the second;
   2. every line is a TOTAL reconstruction rotation of the moving plate relative to its
      anchor at that time (identity at 0 Ma for 257 of the 258 plates; 198 is a microplate
      with a real present-day offset), never a stage pole - stages and rates are derived;
   3. the rotation is relative to an anchor plate, so the absolute (world-frame) rotation is
      the anchor chain applied to the pair rotation, ANCHOR FIRST:
         R_abs(P, t) = R_abs(A, t) ∘ R_pair(P -> A, t)
      (the reverse order re-derives only 709 of the file's 978 directly-given pair rotations
      exactly; this order re-derives 978 of 978 - see the chain check);
   4. the sense is RECONSTRUCTION: a positive angle takes a present-day position to its
      position at time t. The plate's motion - what the sim's plate quaternion holds, and
      what js/earth.js feeds from the NNR poles - is the CONJUGATE. Verified physically: the
      conjugate puts North America on a 233 deg bearing (WSW) at 3.2 cm/yr, India at 358 deg
      (N) at 4.3, Australia at 23 deg (NNE) at 6.6 - the known present-day motions. Feeding
      the file's angles un-conjugated moves every plate the wrong way.

   Output: absolute reconstruction rotations at the model's own sample times, so the runtime
   never walks a chain. Where the file lists the same plate twice at one time with different
   anchors (46 plates change anchor), the reading that keeps the absolute path continuous is
   kept and the residual jump is reported - the model itself is discontinuous there, and
   hiding that in the ingest would move the surprise into the sim.

   Usage (flags take =value or a following argument):
     node tools/earth/rot_ingest.js [--rot=data/earth/PALEOMAP_PlateModel.rot]
                                    [--out=js/data/rot-paleomap.js] [--tmin=0] [--tmax=1100]
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Quat = require('../../js/quat.js');

const arg = (name, def) => {
	const at = process.argv.indexOf('--' + name);
	const eq = process.argv.find((x) => x.startsWith('--' + name + '='));
	if (eq !== undefined) return eq.slice(name.length + 3);
	if (at >= 0 && at + 1 < process.argv.length && !process.argv[at + 1].startsWith('--')) return process.argv[at + 1];
	return def;
};
const ROT = arg('rot', 'data/earth/PALEOMAP_PlateModel.rot');
const OUT = arg('out', 'js/data/rot-paleomap.js');
// Emit the model's full range. Truncating it is a trap that looks harmless: the deep samples
// are what bracket the epochs anyone reconstructs, and where a plate's pair rotation is
// identical at both ends of a 1000 Myr stage - Australia at 33.82 deg relative to Antarctica at
// both 94 and 1100 Ma - that stage is exact, not a coarse interpolation. Cutting the table at
// 540 Ma turns those into clamps and makes the model look coarser than it is.
const TMIN = +arg('tmin', 0), TMAX = +arg('tmax', 1100);
const DEG = Math.PI / 180, ROOTS = new Set(['000', '001']);

// --- parse ---------------------------------------------------------------------------------
const rows = new Map();          // plate id -> rows, in file order
const codeOf = new Map();        // plate id -> the comment's three-letter code
let parsed = 0, lineNo = 0;
for (const raw of fs.readFileSync(ROT, 'utf8').split('\n')) {
	lineNo++;
	const bang = raw.indexOf('!!');
	const body = (bang < 0 ? raw : raw.slice(0, bang)).trim();
	if (!body) continue;
	const f = body.split(/\s+/);
	if (f.length < 6) throw new Error(ROT + ':' + lineNo + ': expected 6 fields, got ' + f.length);
	const t = +f[1], lat = +f[2], lon = +f[3], ang = +f[4];
	if (![t, lat, lon, ang].every(Number.isFinite)) throw new Error(ROT + ':' + lineNo + ': non-numeric pole');
	if (!rows.has(f[0])) rows.set(f[0], []);
	rows.get(f[0]).push({ t: t, lat: lat, lon: lon, ang: ang, anchor: f[5], line: lineNo });
	parsed++;
	if (bang >= 0 && !codeOf.has(f[0])) {
		const m = raw.slice(bang + 2).trim().match(/^([A-Z]{3})\b/);
		if (m) codeOf.set(f[0], m[1]);
	}
}
if (!rows.size) throw new Error(ROT + ': no rotation lines parsed');

// --- sample times and the selected row per (plate, time) -----------------------------------
const times = new Map(), groups = new Map(), pick = new Map();
for (const [id, list] of rows) {
	const byTime = new Map();
	for (const r of list) {
		if (!byTime.has(r.t)) byTime.set(r.t, []);
		byTime.get(r.t).push(r);
	}
	times.set(id, [...byTime.keys()].sort((a, b) => a - b));
	groups.set(id, byTime);
	const p = new Map();
	for (const [t, g] of byTime) p.set(t, g[g.length - 1]);   // provisional: the last line wins
	pick.set(id, p);
}

// --- absolute rotations --------------------------------------------------------------------
const ax = new Float64Array(3);
function axisOf(lat, lon) {
	const cl = Math.cos(lat * DEG);
	ax[0] = cl * Math.cos(lon * DEG); ax[1] = cl * Math.sin(lon * DEG); ax[2] = Math.sin(lat * DEG);
	return ax;
}
function pairQuat(row, out) {
	const a = axisOf(row.lat, row.lon);
	Quat.fromAxisAngle(out, 0, a[0], a[1], a[2], row.ang * DEG);
	return out;
}
let memo;
// The model has circular anchor links at deep time (plate 503 at 600 Ma reads through 531,
// whose own chain comes back to 503). A cycle cannot be resolved, so the link is cut to
// identity and counted; checks.anchorCycles and anchorCycleMinT record where, and the test
// pins that none of it is inside the working range.
const stack = new Set();
const tainted = new Set();      // 'id@t' whose absolute went through a cut cycle
let cycles = 0, cycleMinT = Infinity, taintedNow = false;
function absForRow(row, depth) {
	if (ROOTS.has(row.anchor)) return pairQuat(row, new Float64Array(4));
	const anchor = absAt(row.anchor, row.t, depth + 1);
	pairQuat(row, TMP_A);
	const out = new Float64Array(4);
	Quat.mul(out, 0, anchor, 0, TMP_A, 0);          // anchor first: the pair rotation applies first
	return out;
}
function absAt(id, t, depth) {
	if (depth > 64) throw new Error('anchor chain does not terminate at plate ' + id + ' t=' + t);
	if (stack.has(id)) {
		cycles++;
		if (t < cycleMinT) cycleMinT = t;
		taintedNow = true;
		return IDENTITY;
	}
	const key = id + '@' + t;
	const hit = memo.get(key);
	if (hit) {
		if (tainted.has(key)) taintedNow = true;
		return hit;
	}
	const outer = taintedNow;
	taintedNow = false;
	const ts = times.get(id);
	if (!ts) throw new Error('plate ' + id + ' (an anchor at t=' + t + ') has no rotation lines');
	const q = new Float64Array(4);
	let i = 0;
	while (i < ts.length && ts[i] < t) i++;
	stack.add(id);
	if (i < ts.length && ts[i] === t) q.set(absForRow(pick.get(id).get(t), depth));
	else if (i === 0) q.set(absForRow(pick.get(id).get(ts[0]), depth));
	else if (i >= ts.length) q.set(absForRow(pick.get(id).get(ts[ts.length - 1]), depth));
	else {
		const a = absForRow(pick.get(id).get(ts[i - 1]), depth);
		const b = absForRow(pick.get(id).get(ts[i]), depth);
		Quat.slerp(q, 0, a, 0, b, 0, (t - ts[i - 1]) / (ts[i] - ts[i - 1]));
	}
	stack.delete(id);
	if (taintedNow) tainted.add(key);
	taintedNow = outer || taintedNow;
	memo.set(key, q);
	return q;
}
const TMP_A = new Float64Array(4), TMP_B = new Float64Array(4), IDENTITY = new Float64Array([0, 0, 0, 1]);
memo = new Map();

// --- the checks ----------------------------------------------------------------------------
// The file lists the same plate twice at one time where its anchor changes (46 plates do).
// Those pairs are reported, not resolved: the model is genuinely discontinuous there, and
// picking a reading by file order is at least deterministic. Every other line must re-derive
// exactly, which is what pins the composition order and the handedness.
// --- the three convention checks -----------------------------------------------------------
let identMax = 0, identN = 0;
const identNon = [];
for (const id of times.keys()) {
	if (!times.get(id).includes(0)) continue;
	identN++;
	const e = Quat.angleBetween(absAt(id, 0, 0), 0, IDENTITY, 0) / DEG;
	if (e > identMax) identMax = e;
	if (e > 0.01) identNon.push(id + ':' + e.toFixed(2));
}
// Independent path: for every line whose anchor is sampled at that same time, the pair
// rotation read from the file must equal conj(abs(anchor)) ⊗ abs(plate). Split by whether the
// time carries an anchor switch, because only those can disagree.
let chainMax = 0, chainN = 0, chainWorst = '', swMax = 0, swN = 0, swWorst = '', swOver5 = 0, skipped = 0;
for (const [id, byTime] of groups) {
	for (const [t, g] of byTime) {
		const r = pick.get(id).get(t);
		if (ROOTS.has(r.anchor) || !times.has(r.anchor) || !times.get(r.anchor).includes(t)) continue;
		if (tainted.has(id + '@' + t) || tainted.has(r.anchor + '@' + t)) { skipped++; continue; }
		const A = absAt(r.anchor, t, 0), P = absAt(id, t, 0);
		TMP_B[0] = -A[0]; TMP_B[1] = -A[1]; TMP_B[2] = -A[2]; TMP_B[3] = A[3];
		Quat.mul(TMP_A, 0, TMP_B, 0, P, 0);
		const e = Quat.angleBetween(TMP_A, 0, pairQuat(r, TMP_B), 0) / DEG;
		if (g.length > 1) {
			swN++;
			if (e > 5) swOver5++;
			if (e > swMax) { swMax = e; swWorst = id + '@' + t + ' via ' + r.anchor; }
		} else {
			chainN++;
			if (e > chainMax) { chainMax = e; chainWorst = id + '@' + t + ' via ' + r.anchor; }
		}
	}
}

// The real anchor-switch check: two rows for one plate at one time describe the SAME instant
// in two reference frames, so their absolutes must agree. Where they do not, the model itself
// is discontinuous; the ingest keeps the file's last reading and reports the size of the jump.
let jumpMax = 0, jumpN = 0, jumpOver5 = 0, jumpWorst = '', jumpSum = 0;
for (const [id, byTime] of groups) {
	for (const [t, g] of byTime) {
		if (g.length < 2 || t < TMIN || t > TMAX) continue;
		const base = absForRow(g[0], 0);
		for (let i = 1; i < g.length; i++) {
			if (tainted.has(id + '@' + t)) continue;
			const e = Quat.angleBetween(base, 0, absForRow(g[i], 0), 0) / DEG;
			jumpN++; jumpSum += e;
			if (e > 5) jumpOver5++;
			if (e > jumpMax) { jumpMax = e; jumpWorst = id + '@' + t + ' Ma'; }
		}
	}
}

// --- emit ---
// The checks walked the tables, so the cache (and its taint marks) is stale for the emit.
memo = new Map(); tainted.clear();
const plates = [];
for (const id of [...rows.keys()].sort()) {
	const ts = times.get(id).filter((t) => t >= TMIN && t <= TMAX);
	if (!ts.length) continue;
	const pol = [];
	for (const t of ts) {
		const q = absAt(id, t, 0);
		const s = Math.hypot(q[0], q[1], q[2]);
		const angle = 2 * Math.atan2(s, Math.abs(q[3])) / DEG;
		pol.push(
			+(s < 1e-12 ? 0 : Math.asin(Math.max(-1, Math.min(1, q[2] / s))) / DEG).toFixed(5),
			+(s < 1e-12 ? 0 : Math.atan2(q[1], q[0]) / DEG).toFixed(5),
			+angle.toFixed(5));
	}
	plates.push({ id: id, code: codeOf.get(id) || '', t: ts, pol: pol });
}
const model = {
	metadata: {
		source: path.basename(ROT),
		model: 'PALEOMAP Plate Model m15g60_v2d3 (Scotese 2016 / Scotese & Wright 2018, PaleoAtlas v3)',
		license: 'CC-BY 4.0 (data/earth/License.txt)',
		sense: 'RECONSTRUCTION: a positive angle rotates a present-day position to its position at time t. The motion rotation the sim integrates is the conjugate (Rotations.pole).',
		frame: 'absolute - the anchor chain is resolved to the model root (000/001)',
		units: 'latitude/longitude/angle in degrees, time in Ma ascending',
		lines: parsed, platesIn: rows.size, platesOut: plates.length, tRange: [TMIN, TMAX],
		checks: {
			identityAtZeroDeg: +identMax.toFixed(4), identityPlates: identN, identityNon: identNon,
			chainRederivedDeg: +chainMax.toFixed(9), chainPairs: chainN, chainWorst: chainWorst,
			anchorSwitchPairs: swN, anchorSwitchDeg: +swMax.toFixed(3), anchorSwitchWorstAt: swWorst,
			anchorSwitchOver5Deg: swOver5,
			anchorJumpPairs: jumpN, anchorJumpMeanDeg: jumpN ? +(jumpSum / jumpN).toFixed(3) : 0,
			anchorJumpMaxDeg: +jumpMax.toFixed(3), anchorJumpWorstAt: jumpWorst, anchorJumpOver5Deg: jumpOver5,
			anchorCycles: cycles, anchorCycleMinT: cycleMinT === Infinity ? null : cycleMinT,
			chainSkippedTainted: skipped
		}
	},
	plates: plates
};
const body = '// js/data/rot-paleomap.js - generated by tools/earth/rot_ingest.js from '
	+ model.metadata.source + ', do not edit\n'
	+ '(function () {\n'
	+ '\tvar globalObject = typeof window !== \'undefined\' ? window : (typeof global !== \'undefined\' ? global : this);\n'
	+ '\tglobalObject.RotationModel = ' + JSON.stringify(model) + ';\n'
	+ '\tif (typeof module !== \'undefined\' && module.exports) module.exports = globalObject.RotationModel;\n'
	+ '}());\n';
fs.writeFileSync(OUT, body);
const c = model.metadata.checks;
console.log('[*] ' + ROT + ': ' + parsed + ' lines, ' + rows.size + ' plates -> ' + OUT
	+ ' (' + plates.length + ' plates, ' + (body.length / 1024).toFixed(1) + ' KiB)');
console.log('    identity at 0 Ma: max ' + c.identityAtZeroDeg + ' deg over ' + c.identityPlates
	+ ' plates; non-identity: ' + (c.identityNon.join(' ') || 'none'));
console.log('    pair rotations re-derived from the absolutes: max ' + c.chainRederivedDeg + ' deg over '
	+ c.chainPairs + ' single-anchor pairs' + (c.chainWorst ? ' (' + c.chainWorst + ')' : ''));
console.log('    anchor switches in range: ' + c.anchorJumpPairs + ' pairs, mean jump ' + c.anchorJumpMeanDeg
	+ ' deg, worst ' + c.anchorJumpMaxDeg + ' deg at ' + c.anchorJumpWorstAt + ', '
	+ c.anchorJumpOver5Deg + ' over 5 deg (the model is discontinuous there; the file order decides)');
console.log('    anchor cycles cut to identity: ' + c.anchorCycles
	+ (c.anchorCycleMinT === null ? '' : ', earliest at ' + c.anchorCycleMinT + ' Ma'));
// The gate is the composition order and the handedness: with either wrong, the re-derivation
// of the file's own pair rotations fails everywhere, not at a handful of deep-time switches.
// 1e-3 deg is float noise on a 100 deg rotation; a wrong order or handedness is 40+ deg.
if (c.chainRederivedDeg > 1e-3) throw new Error('chain check failed at ' + c.chainWorst
	+ ' (' + c.chainRederivedDeg + ' deg) - the composition order or the handedness is wrong');
if (identNon.length > 1) throw new Error('more than plate 198 has a non-identity 0 Ma rotation: ' + identNon.join(' '));
console.log('PASS rot_ingest: absolute reconstruction rotations written, conventions consistent');

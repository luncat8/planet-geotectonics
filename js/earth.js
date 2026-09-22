/* earth.js - real-Earth start loader (0.4.0, plan §5).
 *
 * Decodes baked EarthPacks (js/data/*.js from tools/earth/bake_earth.py), resamples the
 * equirectangular raster onto the geodesic grid and initializes the columns. Earth data is
 * an initial condition only - the crust stays Lagrangian, nothing is advected on the grid.
 *
 * Two conventions the pack and the sim do NOT share, resolved once at decode/coords time:
 *  - the pack's seeds/poles are geographic z-up unit vectors, the sim is y-up, so decode
 *    swizzles (x, y, z) -> (x, z, y);
 *  - the pack's raster is cell-centred (row 0 = 90S), so sampling offsets by half a cell
 *    and wraps in longitude instead of scaling to W-1.
 */
var EarthParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var EarthGrid = typeof module !== 'undefined' && module.exports ? require('./geodesics.js') : Grid;
var EarthSim = typeof module !== 'undefined' && module.exports ? require('./sim.js') : Sim;
var EarthRotations = typeof module !== 'undefined' && module.exports ? require('./rotations.js') : Rotations;
var EarthCrosswalk = typeof module !== 'undefined' && module.exports ? require('./data/plate-crosswalk.js') : PlateCrosswalk;
var Earth = {
	packs: function () {
		var g = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
		return g.EarthPacks || [];
	},
	// Best registered pack for a grid level and start value: 'earth' (present day) gets
	// the 0.5deg raster (w >= 720) at L7+ and the 1.0deg baseline below; the historical
	// checkpoints (0.4.5) name their 1.0deg epoch pack directly. A missing pack is null
	// and the caller falls back to the procedural map start.
	pick: function (level, start) {
		var packs = Earth.packs();
		start = start || 'earth';
		var want = start === 'pangaea' ? 'earth-250Ma' : (start === 'gondwana' ? 'earth-200Ma' : null);
		var wide = level >= 7, fallback = null;
		for (var i = 0; i < packs.length; i++) {
			var p = packs[i];
			if (want) {
				if (p.name === want) return p;
			} else if (p.name === 'earth') {
				if ((p.w >= 720) === wide) return p;
				if (!fallback) fallback = p;
			}
		}
		return fallback;
	},
	decodeBase64: function (text) {
		// Node: Buffer can pool, so copy into an owned buffer (Int16 views need the offset 0).
		if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
		var bin = atob(text), out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	},
	decode: function (pack) {
		if (pack._decoded) return pack._decoded;
		var n = pack.w * pack.h, scale = pack.scale || { z: 1, age: 1, sed: 0.1 };
		var zb = new Int16Array(Earth.decodeBase64(pack.banks.z).buffer);
		var ab = Earth.decodeBase64(pack.banks.age);
		var sb = Earth.decodeBase64(pack.banks.sed);
		var z = new Float64Array(n), age = new Float64Array(n), sed = new Float64Array(n);
		var sqrtAge = new Float64Array(n);
		for (var i = 0; i < n; i++) {
			z[i] = zb[i] * scale.z;
			age[i] = ab[i] * scale.age;
			sed[i] = sb[i] * scale.sed * 1000;   // 0.1 km units -> metres
			sqrtAge[i] = Math.sqrt(Math.min(age[i], 80));
		}
		// Invert every raster cell once, with the bake's exact clamps. Apply then interpolates
		// the thickness banks, not z: the deepest expressible depth depends on age
		// (z_min = -3342 + 212 - thermal), so interpolating raw (z, age) pairs crosses the
		// hMaf floor and slabs clamp a kilometre off; interpolated thicknesses stay in the
		// envelope by construction.
		var kind = Earth.decodeBase64(pack.banks.kind);
		var hFel = new Float64Array(n), hMaf = new Float64Array(n), inv = { fel: 0, maf: 0 };
		for (var c = 0; c < n; c++) {
			var cont = kind[c] & 1;
			Earth.invert(z[c], cont ? 500 : age[c], sed[c], cont, inv);
			hFel[c] = inv.fel; hMaf[c] = inv.maf;
		}
		var pl = pack.plates, count = pl.count;
		var seeds = new Float64Array(count * 3), poles = new Float64Array(count * 4);
		for (var p = 0; p < count; p++) {
			var s3 = pl.seeds[p], p4 = pl.poles[p], sOff = p * 3, pOff = p * 4;
			seeds[sOff] = s3[0]; seeds[sOff + 1] = s3[2]; seeds[sOff + 2] = s3[1];
			poles[pOff] = p4[0]; poles[pOff + 1] = p4[2]; poles[pOff + 2] = p4[1]; poles[pOff + 3] = p4[3];
		}
		pack._decoded = {
			z: z, age: age, sed: sed, sqrtAge: sqrtAge, hFel: hFel, hMaf: hMaf, kind: kind,
			plate: Earth.decodeBase64(pack.plates.ids),
			seeds: seeds, poles: poles
		};
		return pack._decoded;
	},
	smoothstep: function (x, lo, hi) {
		var t = (x - lo) / (hi - lo);
		t = Math.max(0, Math.min(1, t));
		return t * t * (3 - 2 * t);
	},
	// K9 inversion, exact mirror of tools/earth/bake_earth.py invert_thickness (same clamps),
	// so the runtime elevation round-trips the baked datum within quantization. The crust-type
	// flag, never the sign of z, picks the branch - the shelf rule (plan §1.1).
	invert: function (z, age, sed, cont, out) {
		if (!cont) {
			var thermal = 350 * Math.sqrt(Math.min(age, 80));
			var hMaf = ((z + 3342 + thermal) * 3300 - sed * 900) / 350;
			out.fel = 0;
			out.maf = Math.max(2000, Math.min(35000, hMaf));
			return;
		}
		var hFel = (z + 3342 + 2091 - sed * 900 / 3300) * 6;
		var ci = Earth.smoothstep(hFel, 5000, 20000);
		for (var k = 0; k < 5 && ci < 1; k++) {
			var th = (1 - ci) * 350 * Math.sqrt(Math.min(age, 80)) + ci * 2091;
			hFel = (z + 3342 + th - sed * 900 / 3300) * 6;
			ci = Earth.smoothstep(hFel, 5000, 20000);
		}
		out.fel = Math.max(1000, Math.min(80000, hFel));
		out.maf = 0;
	},
	// Cell-centred equirectangular coordinates (plan §5) of a sim unit vector (y-up).
	coords: function (W, H, x, y, z, out) {
		var phi = Math.asin(Math.max(-1, Math.min(1, y)));
		var u = (Math.atan2(z, x) + Math.PI) * (W / (2 * Math.PI)) - 0.5;
		u = u % W;
		if (u < 0) u += W;
		var v = (phi + Math.PI / 2) * (H / Math.PI) - 0.5;
		out[0] = u;
		out[1] = Math.max(0, Math.min(H - 1, v));
	},
	// Bilinear for the thickness/sqrtAge/sed banks (longitude wrap, latitude clamp),
	// nearest-centre for the discrete index. Age travels as sqrt(min(age, 80)): K9's ocean
	// elevation is linear in that coordinate, so interpolating it keeps the derived elevation
	// on the pack's surface (raw-age interpolation sags up to ~800 m across ridge-flank
	// gradients). Writes out[0..3] = hFel/hMaf/sqrtAge/sed, out[4] = nearest cell index.
	sample: function (d, W, H, u, v, out) {
		var u0 = Math.floor(u), fu = u - u0, u1 = (u0 + 1) % W;
		var v0 = Math.floor(v), fv = v - v0, v1 = Math.min(v0 + 1, H - 1);
		var r0 = v0 * W, r1 = v1 * W;
		var a = (1 - fu) * (1 - fv), b = fu * (1 - fv), c = (1 - fu) * fv, e = fu * fv;
		out[0] = d.hFel[r0 + u0] * a + d.hFel[r0 + u1] * b + d.hFel[r1 + u0] * c + d.hFel[r1 + u1] * e;
		out[1] = d.hMaf[r0 + u0] * a + d.hMaf[r0 + u1] * b + d.hMaf[r1 + u0] * c + d.hMaf[r1 + u1] * e;
		out[2] = d.sqrtAge[r0 + u0] * a + d.sqrtAge[r0 + u1] * b + d.sqrtAge[r1 + u0] * c + d.sqrtAge[r1 + u1] * e;
		out[3] = d.sed[r0 + u0] * a + d.sed[r0 + u1] * b + d.sed[r1 + u0] * c + d.sed[r1 + u1] * e;
		out[4] = Math.min(H - 1, Math.round(v)) * W + Math.round(u) % W;
	},
	// Bilinear pack-z sample for the score's round-trip RMS (the render's reference).
	sampleZ: function (d, W, H, u, v) {
		var u0 = Math.floor(u), fu = u - u0, u1 = (u0 + 1) % W;
		var v0 = Math.floor(v), fv = v - v0, v1 = Math.min(v0 + 1, H - 1);
		var r0 = v0 * W, r1 = v1 * W;
		var a = (1 - fu) * (1 - fv), b = fu * (1 - fv), c = (1 - fu) * fv, e = fu * fv;
		return d.z[r0 + u0] * a + d.z[r0 + u1] * b + d.z[r1 + u0] * c + d.z[r1 + u1] * e;
	},
	// Initialize one column per cell from the pack, then boot-raster and rebase the ledgers
	// (plan §5). opts: realistic (held NNR-MORVEL poles, pinned Tm), jitter (seeded noise).
	apply: function (s, pack, opts) {
		opts = opts || {};
		var d = Earth.decode(pack), g = s.grid, W = pack.w, H = pack.h, p = EarthParams;
		var count = pack.plates.count;
		if (count > s.plateCap) throw new RangeError('pack plate count exceeds plateCap');
		s.plateCount = count;
		var scratch = new Float64Array(5);
		var jitter = opts.jitter ? EarthGrid.mulberry32((s.seed ^ 0xE4717) >>> 0) : null;
		for (var i = 0; i < s.n; i++) {
			var b = i * 3;
			Earth.coords(W, H, g.pos[b], g.pos[b + 1], g.pos[b + 2], scratch);
			Earth.sample(d, W, H, scratch[0], scratch[1], scratch);
			var at = scratch[4], k = d.kind[at], cont = k & 1;
			var ageS = cont ? 500 : scratch[2] * scratch[2];
			var fert = p.fertLo + (1 - p.fertLo) * ((k >> 1) & 7) / 7;
			if (jitter) {
				fert += (jitter() - 0.5) * 0.05;
				if (!cont) ageS = Math.max(0, ageS + (jitter() - 0.5) * 4);
			}
			s.hFel[i] = scratch[0]; s.hMaf[i] = scratch[1]; s.hSed[i] = scratch[3];
			s.age[i] = ageS; s.fert[i] = Math.max(p.fertLo, Math.min(1, fert));
			s.plate[i] = d.plate[at]; s.cell[i] = i; s.alive[i] = 1; s.area[i] = g.A0[i];
		}
	s.body.set(g.pos); s.world.set(g.pos);
	// Historical packs (0.4.5) carry no Euler poles - no NNR model exists for past epochs.
	// With every pole zero, 'realistic' would hold zero omega and freeze the world, so the
	// prescription is dropped and K10 drives the plates like the game preset. The thermal
	// pin of the realistic preset (cooling = 0) is kept either way.
	var sumOm = 0;
	for (var p2 = 3; p2 < d.poles.length; p2 += 4) sumOm += Math.abs(d.poles[p2]);
	var prescribe = opts.realistic && sumOm > 0;
	for (var q = 0; q < count; q++) {
		var qb = q * 4, wb = q * 3, pb = q * 4;
		s.q[qb] = 0; s.q[qb + 1] = 0; s.q[qb + 2] = 0; s.q[qb + 3] = 1;
		s.seeds[wb] = d.seeds[wb]; s.seeds[wb + 1] = d.seeds[wb + 1]; s.seeds[wb + 2] = d.seeds[wb + 2];
		var om = prescribe ? d.poles[pb + 3] : 0;
		s.omega[wb] = d.poles[pb] * om; s.omega[wb + 1] = d.poles[pb + 1] * om; s.omega[wb + 2] = d.poles[pb + 2] * om;
		s.omegaTarget[wb] = s.omega[wb]; s.omegaTarget[wb + 1] = s.omega[wb + 1]; s.omegaTarget[wb + 2] = s.omega[wb + 2];
	}
	s.prescribedOmega = prescribe ? 1 : 0;
	s.epoch0 = pack.epoch || 0;
	if (opts.realistic) s.cooling = 0;
	EarthSim.raster(s);
	s.rebase();
	return s;
},
	// Mode K (0.4.6): put every column where the rotation model says it was at `epoch`, by
	// exact rigid rotation. No dt, no physics, and nothing is advected on the grid - each
	// column's world direction is recomputed from its body direction and its plate's quaternion,
	// which is why the transform is reversible to floating-point error.
	//
	// The plate's quaternion becomes the MOTION rotation from the pack's own epoch to `epoch`,
	// not the file's reconstruction rotation: Columns.move does world = rotate(body, q) and
	// body is the pack's geography at its bake epoch, so q has to be R(epoch) ∘ R(epoch0)^-1.
	// Plates the crosswalk cannot justify (4 of the modern 25, all small ocean plates) keep the
	// identity and are counted, so the cost of a gap is a number rather than a shrug.
	reconstruct: function (s, epoch) {
		var q = new Float64Array(4), moved = 0, stuck = 0, stuckPlates = 0;
		var counts = s.reconCounts || (s.reconCounts = new Int32Array(s.plateCap));
		counts.fill(0);
		for (var i = 0; i < s.n; i++) if (s.alive[i]) counts[s.plate[i]]++;
		for (var p = 0; p < s.plateCount; p++) {
			var pb = p * 4, id = EarthCrosswalk.ids[p];
			var plate = id ? EarthRotations.of(id) : null;
			if (!plate) {
				s.q[pb] = 0; s.q[pb + 1] = 0; s.q[pb + 2] = 0; s.q[pb + 3] = 1;
				stuck += counts[p];
				if (counts[p]) stuckPlates++;
				continue;
			}
			EarthRotations.relative(plate, epoch, s.epoch0, q, 0);
			EarthRotations.toSim(q, s.q, pb);
			moved += counts[p];
		}
		s.reconEpoch = epoch;
		EarthSim.raster(s);
		return { epoch: epoch, moved: moved, stuck: stuck, stuckPlates: stuckPlates };
	},
	// Wet fraction, mean land/ocean and the round-trip RMS of derived z vs the pack's z bank,
	// resampled at the same cell positions (plan §7 acceptance).
	score: function (s, pack) {
		var d = Earth.decode(pack), g = s.grid, W = pack.w, H = pack.h;
		var wet = 0, dry = 0, sumLand = 0, sumOcean = 0, sq = 0, cnt = 0;
		var scratch = new Float64Array(2);
		for (var c = 0; c < g.V; c++) {
			var z = s.z[c];
			if (z !== z) continue;
			if (z < 0) { wet++; sumOcean += z; } else { dry++; sumLand += z; }
			var b = c * 3;
			Earth.coords(W, H, g.pos[b], g.pos[b + 1], g.pos[b + 2], scratch);
			var dz = z - Earth.sampleZ(d, W, H, scratch[0], scratch[1]);
			sq += dz * dz; cnt++;
		}
		return {
			pack: pack,
			wetFraction: wet / (wet + dry),
			meanLand: dry ? sumLand / dry : 0,
			meanOcean: wet ? sumOcean / wet : 0,
			rms: cnt ? Math.sqrt(sq / cnt) : 0
		};
	},
	describe: function (sc) {
		var pk = sc.pack;
		return pk.name + ' ' + pk.w + 'x' + pk.h + ' (' + pk.source + ') · epoch ' + pk.epoch
			+ ' · datum ' + pk.datum + ' m · wet ' + (sc.wetFraction * 100).toFixed(2) + '%'
			+ ' · land ' + Math.round(sc.meanLand) + ' m · ocean ' + Math.round(sc.meanOcean)
			+ ' m · rms ' + Math.round(sc.rms) + ' m';
	},
	// --- 0.4.5 checkpoint scoring ----------------------------------------------------
	// The forward-reconstruction gate (plan §8): run from a historical pack, measure how
	// close the drifted continents get to a reference land mask. All masks are one byte
	// per grid cell over the same icosphere grid, so IoU is a plain count.
	// Exposed-land mask (z >= 0) of a live state; NaN columns (gaps) read as ocean.
	landFromState: function (s) {
		var m = new Uint8Array(s.grid.V);
		for (var c = 0; c < s.grid.V; c++) m[c] = (s.z[c] === s.z[c] && s.z[c] >= 0) ? 1 : 0;
		return m;
	},
	// Exposed-land mask a pack draws (continental crust at or above its calibrated sea
	// level), resampled onto the grid by nearest-centre kind, the same sampling the
	// loader uses for the crust type. Flooded shelf cells stay water, like the map.
	landFromPack: function (pack, grid) {
		var d = Earth.decode(pack);
		var m = new Uint8Array(grid.V);
		var scratch = new Float64Array(2);
		for (var c = 0; c < grid.V; c++) {
			var b = c * 3;
			Earth.coords(pack.w, pack.h, grid.pos[b], grid.pos[b + 1], grid.pos[b + 2], scratch);
			var at = Math.min(pack.h - 1, Math.round(scratch[1])) * pack.w
				+ ((Math.round(scratch[0]) % pack.w) + pack.w) % pack.w;
			m[c] = ((d.kind[at] & 1) && d.z[at] >= 0) ? 1 : 0;
		}
		return m;
	},
	// Intersection-over-union of two equal-length land masks.
	iou: function (a, b) {
		var inter = 0, union = 0;
		for (var i = 0; i < a.length; i++) {
			if (a[i] && b[i]) inter++;
			if (a[i] || b[i]) union++;
		}
		return { inter: inter, union: union, iou: union ? inter / union : 1 };
	},
	fraction: function (m) {
		var n = 0;
		for (var i = 0; i < m.length; i++) n += m[i];
		return m.length ? n / m.length : 0;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Earth;

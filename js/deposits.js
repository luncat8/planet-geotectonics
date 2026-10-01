var DepositsExtract = typeof module !== 'undefined' && module.exports ? require('./extract.js') : Extract;
var DepositsDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var DepositsModels = typeof module !== 'undefined' && module.exports ? require('./data/deposit-models.js') : DepositModels;
var DepositsParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// Synthetic deposit catalogue (0.6.0, plan 0.6.x section 3). Not part of the simulation: it
// reads a paused world once and never writes to it or draws from its RNG.
//
//   snapshot  frozen copy of the geology the catalogue is conditioned on, with a checksum;
//   scenario  seed + generator version + snapshot; its bodies are a pure function of those;
//   tiles     a fixed cube-sphere tiling (independent of the sim and render grids). A body
//             belongs to the tile of its anchor, and every random draw is keyed by
//             (seed, version, tile, family, ordinal, draw index), so a click, a whole-world
//             scan and a re-import yield the same bodies in any order.
//
// Bodies are ellipsoids; one body model serves maps, drill intersections and resources.
var Deposits = {
	FORMAT: 'pgt-deposit-catalogue',
	HOSTS: ['none', 'oceanic', 'continental', 'thick continental', 'sediment'],
	FACES: 6,
	// Face normal, then the two tangent axes of the face's (u, v) plane.
	FACE_AXES: new Float64Array([
		1, 0, 0, 0, 0, 1, 0, 1, 0,
		-1, 0, 0, 0, 0, 1, 0, 1, 0,
		0, 1, 0, 1, 0, 0, 0, 0, 1,
		0, -1, 0, 1, 0, 0, 0, 0, 1,
		0, 0, 1, 1, 0, 0, 0, 1, 0,
		0, 0, -1, 1, 0, 0, 0, 1, 0
	]),
	// Anchors stay this far from a tile edge so that tileOf(dirOf(anchor)) always round-trips.
	ANCHOR_MARGIN: 0.02,
	MAX_QUERY_M: 40000,
	MAX_DRAWS: 40,

	// ------------------------------------------------------------------ hashing and draws
	mix32: function (h) {
		h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
		h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
		return (h ^ (h >>> 16)) >>> 0;
	},
	combine: function (h, key) {
		return Deposits.mix32((h ^ (key + 0x9e3779b9 + (h << 6) + (h >>> 2))) | 0);
	},
	// Fills `draws` with uniform (0,1) numbers keyed by the candidate alone, so a body's
	// geometry never depends on which other candidates were visited or accepted.
	drawCandidate: function (sc, tile, familyIndex, ordinal, draws) {
		var h = Deposits.combine(Deposits.combine(sc.seed, sc.version), tile);
		h = Deposits.combine(Deposits.combine(h, familyIndex), ordinal);
		for (var k = 0; k < Deposits.MAX_DRAWS; k++) {
			draws[k] = (Deposits.combine(h, k + 1) + 0.5) / 4294967296;
		}
		return draws;
	},
	// Normal score from two uniforms, truncated: the priors are truncated distributions.
	truncatedNormal: function (u1, u2) {
		var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		var limit = DepositsModels.truncationSigma;
		return Math.max(-limit, Math.min(limit, z));
	},
	// Stored numbers carry six significant digits, so JSON round trips are exact.
	round: function (v) {
		return +v.toPrecision(6);
	},
	hex: function (hi, lo) {
		return ('0000000' + hi.toString(16)).slice(-8) + ('0000000' + lo.toString(16)).slice(-8);
	},
	// Two interleaved FNV-1a lanes over bytes: a 64-bit identity, not a security hash.
	fnvBytes: function (bytes, lanes) {
		var a = lanes[0], b = lanes[1];
		for (var i = 0; i < bytes.length; i++) {
			a = Math.imul(a ^ bytes[i], 16777619);
			b = Math.imul(b ^ bytes[i] ^ 0x5a, 0x01000193 + 2);
		}
		lanes[0] = a >>> 0; lanes[1] = b >>> 0;
		return lanes;
	},
	fnvText: function (text) {
		var a = 0x811c9dc5, b = 0x9747b28c;
		for (var i = 0; i < text.length; i++) {
			var c = text.charCodeAt(i);
			a = Math.imul(a ^ c, 16777619);
			b = Math.imul(b ^ c ^ 0x5a, 0x01000193 + 2);
		}
		return Deposits.hex(a >>> 0, b >>> 0);
	},

	// ------------------------------------------------------------------ cube-sphere tiles
	tileCount: function () {
		return Deposits.FACES * DepositsModels.tileN * DepositsModels.tileN;
	},
	faceOf: function (x, y, z) {
		var ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
		if (ax >= ay && ax >= az) return x > 0 ? 0 : 1;
		if (ay >= az) return y > 0 ? 2 : 3;
		return z > 0 ? 4 : 5;
	},
	// Equiangular face coordinates in [-1, 1) for a direction on `face`.
	faceCoords: function (face, x, y, z, out) {
		var f = Deposits.FACE_AXES, o = face * 9;
		var m = x * f[o] + y * f[o + 1] + z * f[o + 2];
		var u = (x * f[o + 3] + y * f[o + 4] + z * f[o + 5]) / m;
		var v = (x * f[o + 6] + y * f[o + 7] + z * f[o + 8]) / m;
		out[0] = Math.atan(u) * 4 / Math.PI; out[1] = Math.atan(v) * 4 / Math.PI;
		return out;
	},
	tileOf: function (x, y, z) {
		var n = DepositsModels.tileN, face = Deposits.faceOf(x, y, z);
		var c = Deposits.faceCoords(face, x, y, z, Deposits.scratchUv);
		var i = Math.min(n - 1, Math.floor((c[0] + 1) / 2 * n));
		var j = Math.min(n - 1, Math.floor((c[1] + 1) / 2 * n));
		return (face * n + j) * n + i;
	},
	// Unit direction of the point (fu, fv) in [0, 1)^2 inside a tile.
	dirOf: function (tile, fu, fv, out) {
		var n = DepositsModels.tileN, i = tile % n, j = Math.floor(tile / n) % n, face = Math.floor(tile / (n * n));
		var u = Math.tan(((i + fu) / n * 2 - 1) * Math.PI / 4), v = Math.tan(((j + fv) / n * 2 - 1) * Math.PI / 4);
		var f = Deposits.FACE_AXES, o = face * 9;
		var x = f[o] + u * f[o + 3] + v * f[o + 6], y = f[o + 1] + u * f[o + 4] + v * f[o + 7];
		var z = f[o + 2] + u * f[o + 5] + v * f[o + 8], len = Math.sqrt(x * x + y * y + z * z);
		out[0] = x / len; out[1] = y / len; out[2] = z / len;
		return out;
	},
	// East, north and up unit vectors at a direction (the sim's +y is north). At a pole east
	// is arbitrary but fixed.
	frame: function (x, y, z, out) {
		var ex = z, ey = 0, ez = -x, len = Math.sqrt(ex * ex + ez * ez);
		if (len < 1e-12) { ex = 1; ez = 0; len = 1; }
		ex /= len; ez /= len;
		out[0] = ex; out[1] = ey; out[2] = ez;
		out[3] = y * ez - z * ey; out[4] = z * ex - x * ez; out[5] = x * ey - y * ex;
		out[6] = x; out[7] = y; out[8] = z;
		return out;
	},
	nearestCell: function (grid, x, y, z) {
		var w = grid.lookupW, h = grid.lookupH;
		var col = Math.min(w - 1, Math.floor((Math.atan2(z, x) / (2 * Math.PI) + 0.5) * w));
		var row = Math.min(h - 1, Math.floor((Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI + 0.5) * h));
		var cell = grid.lookup[row * w + col], pos = grid.pos;
		var best = pos[cell * 3] * x + pos[cell * 3 + 1] * y + pos[cell * 3 + 2] * z;
		for (var moved = true; moved;) {
			moved = false;
			for (var k = 0; k < grid.ringN[cell]; k++) {
				var j = grid.ring[cell * 6 + k], dot = pos[j * 3] * x + pos[j * 3 + 1] * y + pos[j * 3 + 2] * z;
				if (dot <= best) continue;
				best = dot; cell = j; moved = true;
			}
		}
		return cell;
	},

	// ------------------------------------------------------------------ snapshot and scenario
	// Everything the generator reads about the world, frozen. Potentials are the one-cell blur
	// the extraction diagnostic uses, so an uncovered cell cannot hide a deposit.
	snapshot: function (s, source) {
		var g = s.grid, V = g.V, fields = DepositsDiag.ORE_FIELDS, blurred = new Float64Array(V);
		var snap = {
			level: g.level, gridSeed: g.seed, simSeed: s.seed, t: s.t, epoch0: s.epoch0,
			source: source || '', grid: g, cells: V,
			pot: new Float32Array(fields.length * V), host: new Uint8Array(V),
			alt: new Float32Array(V), thick: new Float32Array(V), age: new Float32Array(V), checksum: ''
		};
		for (var k = 0; k < fields.length; k++) {
			DepositsExtract.blur(s, s[fields[k]], blurred);
			snap.pot.set(blurred, k * V);
		}
		for (var c = 0; c < V; c++) {
			var o = s.owner[c];
			snap.host[c] = Deposits.HOSTS.indexOf(DepositsExtract.host(s, c));
			if (o < 0) continue;
			snap.alt[c] = s.z[c]; snap.age[c] = s.age[o];
			snap.thick[c] = s.hFel[o] + s.hMaf[o] + s.hSed[o];
		}
		snap.checksum = Deposits.snapshotChecksum(snap);
		return snap;
	},
	snapshotChecksum: function (snap) {
		var head = new Float64Array([snap.level, snap.gridSeed, snap.simSeed, snap.t, snap.epoch0, snap.cells]);
		var lanes = Deposits.fnvBytes(new Uint8Array(head.buffer), [0x811c9dc5, 0x9747b28c]);
		var parts = [snap.pot, snap.host, snap.alt, snap.thick, snap.age];
		for (var i = 0; i < parts.length; i++) {
			var p = parts[i];
			Deposits.fnvBytes(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), lanes);
		}
		return Deposits.hex(lanes[0], lanes[1]);
	},
	describeSnapshot: function (snap) {
		return {
			level: snap.level, gridSeed: snap.gridSeed, simSeed: snap.simSeed, t: +snap.t.toFixed(3),
			epoch0: snap.epoch0, source: snap.source, cells: snap.cells, checksum: snap.checksum
		};
	},
	scenario: function (snap, seed) {
		return {
			seed: seed >>> 0, version: DepositsModels.version, snapshot: snap,
			meta: Deposits.describeSnapshot(snap), tiles: new Map(), complete: false
		};
	},

	// ------------------------------------------------------------------ bodies
	axisUnits: function (strikeDeg, dipDeg, out) {
		var st = strikeDeg * Math.PI / 180, dp = dipDeg * Math.PI / 180;
		var sinS = Math.sin(st), cosS = Math.cos(st), sinD = Math.sin(dp), cosD = Math.cos(dp);
		// East-north-up unit axes: along strike, down dip, across (the cross product).
		out[0] = sinS; out[1] = cosS; out[2] = 0;
		out[3] = cosS * cosD; out[4] = -sinS * cosD; out[5] = -sinD;
		out[6] = out[1] * out[5] - out[2] * out[4]; out[7] = out[2] * out[3] - out[0] * out[5];
		out[8] = out[0] * out[4] - out[1] * out[3];
		return out;
	},
	// Half the vertical extent of the oriented ellipsoid.
	verticalHalfExtent: function (axes, units) {
		var sum = 0;
		for (var k = 0; k < 3; k++) sum += axes[k] * axes[k] * units[k * 3 + 2] * units[k * 3 + 2];
		return Math.sqrt(sum);
	},
	metalTonnes: function (oreTonnes, grade, unit) {
		return oreTonnes * grade / (unit === '%' ? 100 : 1e6);
	},
	recoverableTonnes: function (metalTonnes, recovery) {
		return metalTonnes * recovery;
	},
	volumeOf: function (axes) {
		return 4 * Math.PI * axes[0] * axes[1] * axes[2] / 3;
	},
	// Anchor, host and favourability of one candidate, or null when the slot stays empty.
	// `draws` holds the candidate's uniforms: 0 acceptance, 1-2 anchor, 3-4 tonnage score.
	site: function (sc, tile, family, draws) {
		var snap = sc.snapshot, V = snap.cells, dir = Deposits.scratchDir;
		// Rounded here, so the sampled anchor is exactly the stored one.
		var fu = Deposits.round(Deposits.ANCHOR_MARGIN + (1 - 2 * Deposits.ANCHOR_MARGIN) * draws[1]);
		var fv = Deposits.round(Deposits.ANCHOR_MARGIN + (1 - 2 * Deposits.ANCHOR_MARGIN) * draws[2]);
		Deposits.dirOf(tile, fu, fv, dir);
		var cell = Deposits.nearestCell(snap.grid, dir[0], dir[1], dir[2]);
		var host = Deposits.HOSTS[snap.host[cell]];
		if (family.hosts.indexOf(host) < 0) return null;
		var potential = snap.pot[DepositsDiag.ORE_FIELDS.indexOf(family.potential) * V + cell];
		var floor = DepositsModels.potentialFloor;
		if (potential < floor) return null;
		var accept = family.maxAccept * Math.pow(Math.min(1, (potential - floor) / (1 - floor)), family.acceptGamma);
		if (draws[0] >= accept) return null;
		return { fu: fu, fv: fv, cell: cell, host: host, potential: potential };
	},
	grades: function (family, zTonnage, draws, out) {
		for (var c = 0; c < family.commodities.length; c++) {
			var m = family.commodities[c], rho = m.tonnageGradeCorr;
			var eps = Deposits.truncatedNormal(draws[5 + 2 * c], draws[6 + 2 * c]);
			out[c] = m.median * Math.exp(m.sigmaLn * (rho * zTonnage + Math.sqrt(1 - rho * rho) * eps));
		}
		return out;
	},
	formationAge: function (family, site, crustAge, draw) {
		var lo = family.ageMa.min, hi = family.ageMa.max;
		// Oceanic crust cannot host a deposit older than itself; continents carry no such bound.
		if (site.host === 'oceanic') hi = Math.max(lo, Math.min(hi, crustAge));
		var age = lo + (hi - lo) * draw, width = Math.max(1, 0.1 * age);
		return [Deposits.round(Math.max(0, age - width)), Deposits.round(age + width)];
	},
	candidate: function (sc, tile, familyIndex, ordinal) {
		var family = DepositsModels.families[familyIndex], snap = sc.snapshot;
		var draws = Deposits.drawCandidate(sc, tile, familyIndex, ordinal, Deposits.scratchDraws);
		var site = Deposits.site(sc, tile, family, draws);
		if (!site) return null;
		var model = DepositsModels, cell = site.cell, units = Deposits.scratchUnits;
		var zTonnage = Deposits.truncatedNormal(draws[3], draws[4]);
		var tonnage = family.tonnage;
		var oreTarget = Math.exp(Math.log(tonnage.median) + tonnage.sigmaLn * zTonnage + tonnage.favourGain * (site.potential - 0.5));
		var gradeValues = Deposits.grades(family, zTonnage, draws, Deposits.scratchGrades);
		var ratioSd = family.axisRatioSigmaLn;
		var rb = family.axisRatio[0] * Math.exp(ratioSd * Deposits.truncatedNormal(draws[22], draws[23]));
		var rc = family.axisRatio[1] * Math.exp(ratioSd * Deposits.truncatedNormal(draws[24], draws[25]));
		var volumeTarget = oreTarget / (family.rockDensity * family.oreFraction);
		var a = Math.cbrt(3 * volumeTarget / (4 * Math.PI * rb * rc));
		var strike = 360 * draws[20], dip = family.dipDeg[0] + (family.dipDeg[1] - family.dipDeg[0]) * draws[21];
		var axes = [Deposits.round(a), Deposits.round(a * rb), Deposits.round(a * rc)];
		if (Math.max(axes[0], axes[1], axes[2]) > model.maxExtentM) return null;
		Deposits.axisUnits(strike, dip, units);
		var vertical = 2 * Deposits.verticalHalfExtent(axes, units);
		var crust = snap.thick[cell], room = 0.9 * crust - vertical;
		if (room < 0) return null;
		var burial = Math.min(room, family.burial.median * Math.exp(family.burial.sigmaLn * Deposits.truncatedNormal(draws[26], draws[27])));
		return Deposits.assemble(sc, tile, familyIndex, ordinal, site, {
			axes: axes, strike: strike, dip: dip, burial: burial, grades: gradeValues,
			age: Deposits.formationAge(family, site, snap.age[cell], draws[28])
		});
	},
	// Rounds the drawn parameters, then derives every dependent quantity from the rounded
	// values, so the stored body reproduces its own resources exactly.
	assemble: function (sc, tile, familyIndex, ordinal, site, drawn) {
		var family = DepositsModels.families[familyIndex], snap = sc.snapshot, cell = site.cell, round = Deposits.round;
		var dir = Deposits.dirOf(tile, site.fu, site.fv, Deposits.scratchDir);
		var alt = snap.alt[cell];
		var volume = round(Deposits.volumeOf(drawn.axes));
		var ore = round(volume * family.rockDensity * family.oreFraction);
		var body = {
			id: 'D' + ('0000' + tile).slice(-5) + '-' + family.key + '-' + ordinal,
			tile: tile, family: family.key, fu: site.fu, fv: site.fv,
			lat: +(Math.asin(dir[1]) * 180 / Math.PI).toFixed(4), lon: +(Math.atan2(dir[2], dir[0]) * 180 / Math.PI).toFixed(4),
			host: site.host, surfaceAltM: round(alt), waterDepthM: round(Math.max(0, -alt)),
			crustThicknessM: round(snap.thick[cell]), potential: round(site.potential),
			burialTopM: round(drawn.burial), strikeDeg: round(drawn.strike), dipDeg: round(drawn.dip),
			axesM: drawn.axes, volumeM3: volume, rockDensityTm3: family.rockDensity, oreFraction: family.oreFraction,
			oreTonnes: ore, commodities: [], ageMa: drawn.age, confidence: 'synthetic', status: family.status
		};
		for (var c = 0; c < family.commodities.length; c++) {
			var m = family.commodities[c], grade = round(drawn.grades[c]);
			body.commodities.push({ id: m.id, grade: grade, unit: m.unit, metalTonnes: round(Deposits.metalTonnes(ore, grade, m.unit)) });
		}
		return body;
	},
	// Reasons a body is not a valid catalogue record; '' when it is.
	validate: function (b) {
		var family = DepositsModels.families.find(function (f) { return f.key === b.family; });
		if (!family) return 'unknown family ' + b.family;
		if (!(b.axesM.length === 3 && b.axesM.every(function (v) { return v > 0 && v <= DepositsModels.maxExtentM; }))) return 'axes';
		if (!(b.burialTopM >= 0 && b.waterDepthM >= 0)) return 'burial or water depth';
		if (family.hosts.indexOf(b.host) < 0) return 'host ' + b.host;
		if (!(b.rockDensityTm3 > 0 && b.oreFraction > 0 && b.oreFraction <= 1)) return 'density or ore fraction';
		if (b.commodities.length !== family.commodities.length) return 'commodity count';
		if (!(b.ageMa[0] >= 0 && b.ageMa[1] >= b.ageMa[0])) return 'age range';
		if (!(b.fu > 0 && b.fu < 1 && b.fv > 0 && b.fv < 1)) return 'anchor';
		if (Deposits.tileOf.apply(null, Deposits.dirOf(b.tile, b.fu, b.fv, [0, 0, 0])) !== b.tile) return 'anchor outside its tile';
		var units = Deposits.axisUnits(b.strikeDeg, b.dipDeg, Deposits.scratchUnits);
		if (b.burialTopM + 2 * Deposits.verticalHalfExtent(b.axesM, units) > b.crustThicknessM * 0.9 + 1) return 'deeper than the crust';
		var ore = Deposits.round(Deposits.round(Deposits.volumeOf(b.axesM)) * b.rockDensityTm3 * b.oreFraction);
		if (Math.abs(ore - b.oreTonnes) > 1e-5 * ore) return 'ore tonnes disagree with the envelope';
		for (var c = 0; c < b.commodities.length; c++) {
			var m = b.commodities[c];
			if (!(Number.isFinite(m.grade) && m.grade > 0 && m.id === family.commodities[c].id && m.unit === family.commodities[c].unit)) return 'grade';
			var metal = Deposits.metalTonnes(b.oreTonnes, m.grade, m.unit);
			if (Math.abs(metal - m.metalTonnes) > 1e-5 * metal) return 'metal tonnes disagree with grade';
		}
		return '';
	},
	topAltitudeM: function (b) {
		return b.surfaceAltM - b.burialTopM;
	},

	// ------------------------------------------------------------------ catalogue queries
	tileBodies: function (sc, tile) {
		var cached = sc.tiles.get(tile);
		if (cached) return cached;
		if (!sc.snapshot) throw new Error('tile ' + tile + ' is not in this imported catalogue');
		var bodies = [], families = DepositsModels.families;
		for (var f = 0; f < families.length; f++) {
			for (var o = 0; o < DepositsModels.slots; o++) {
				var body = Deposits.candidate(sc, tile, f, o);
				if (body) bodies.push(body);
			}
		}
		sc.tiles.set(tile, bodies);
		if (sc.tiles.size === Deposits.tileCount()) sc.complete = true;
		return bodies;
	},
	// Generates tiles [from, from + count) in index order; returns the next index. A job loops
	// on this with its own progress and cancel checks, and never publishes a partial result.
	scan: function (sc, from, count) {
		var end = Math.min(Deposits.tileCount(), from + count);
		for (var tile = from; tile < end; tile++) Deposits.tileBodies(sc, tile);
		return end;
	},
	// Tiles within `radiusM` of a point: the point's own tile plus those reached by stepping
	// to the corners and edge midpoints of the query square, which is smaller than any tile.
	tilesNear: function (x, y, z, radiusM, out) {
		var f = Deposits.frame(x, y, z, Deposits.scratchFrame), r = radiusM / DepositsParams.radius;
		out.length = 0;
		for (var dn = -1; dn <= 1; dn++) {
			for (var de = -1; de <= 1; de++) {
				var px = x + r * (de * f[0] + dn * f[3]), py = y + r * (de * f[1] + dn * f[4]), pz = z + r * (de * f[2] + dn * f[5]);
				var tile = Deposits.tileOf(px, py, pz);
				if (out.indexOf(tile) < 0) out.push(tile);
			}
		}
		return out.sort(function (a, b) { return a - b; });
	},
	// Bodies whose ellipsoid may come within `radiusM` of a point, sorted by id.
	near: function (sc, x, y, z, radiusM) {
		if (radiusM > Deposits.MAX_QUERY_M) throw new RangeError('query radius above ' + Deposits.MAX_QUERY_M + ' m');
		var reach = radiusM + DepositsModels.maxExtentM, tiles = Deposits.tilesNear(x, y, z, reach, []);
		var found = [], pos = [0, 0, 0];
		for (var i = 0; i < tiles.length; i++) {
			var bodies = Deposits.tileBodies(sc, tiles[i]);
			for (var k = 0; k < bodies.length; k++) {
				var b = bodies[k];
				Deposits.dirOf(b.tile, b.fu, b.fv, pos);
				var dot = Math.max(-1, Math.min(1, pos[0] * x + pos[1] * y + pos[2] * z));
				var gap = Math.acos(dot) * DepositsParams.radius - Math.max(b.axesM[0], b.axesM[1], b.axesM[2]);
				if (gap <= radiusM) found.push(b);
			}
		}
		return found.sort(Deposits.compareId);
	},
	compareId: function (a, b) {
		return a.tile !== b.tile ? a.tile - b.tile : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	},
	allBodies: function (sc) {
		var tiles = Array.from(sc.tiles.keys()).sort(function (a, b) { return a - b; }), all = [];
		for (var i = 0; i < tiles.length; i++) all.push.apply(all, sc.tiles.get(tiles[i]));
		return all.sort(Deposits.compareId);
	},
	// Local east/north offset in metres of a direction from a body's anchor.
	offsetFrom: function (b, x, y, z, out) {
		var a = Deposits.dirOf(b.tile, b.fu, b.fv, Deposits.scratchDir);
		var f = Deposits.frame(a[0], a[1], a[2], Deposits.scratchFrame), R = DepositsParams.radius;
		var dx = x - a[0], dy = y - a[1], dz = z - a[2];
		out[0] = R * (dx * f[0] + dy * f[1] + dz * f[2]);
		out[1] = R * (dx * f[3] + dy * f[4] + dz * f[5]);
		return out;
	},
	// Depth interval [top, bottom] below the solid surface where a vertical line through
	// (east, north) metres from the body's centre cuts its ellipsoid; false when it misses.
	verticalIntersection: function (b, east, north, out) {
		var u = Deposits.axisUnits(b.strikeDeg, b.dipDeg, Deposits.scratchUnits), qa = 0, qb = 0, qc = -1;
		for (var k = 0; k < 3; k++) {
			var inv = 1 / (b.axesM[k] * b.axesM[k]), h = east * u[k * 3] + north * u[k * 3 + 1], up = u[k * 3 + 2];
			qa += up * up * inv; qb += 2 * h * up * inv; qc += h * h * inv;
		}
		var disc = qb * qb - 4 * qa * qc;
		if (!(disc > 0)) return false;
		var root = Math.sqrt(disc), centre = b.burialTopM + Deposits.verticalHalfExtent(b.axesM, u);
		// u is height above the centre; depth is the centre's depth minus u.
		out[0] = centre - (-qb + root) / (2 * qa); out[1] = centre - (-qb - root) / (2 * qa);
		return true;
	},

	// ------------------------------------------------------------------ export and import
	identity: function (sc) {
		return { seed: sc.seed, version: sc.version, tileN: DepositsModels.tileN, snapshot: sc.meta };
	},
	json: function (sc) {
		var bodies = Deposits.allBodies(sc), tiles = Array.from(sc.tiles.keys()).sort(function (a, b) { return a - b; });
		var body = JSON.stringify(bodies);
		return JSON.stringify({
			format: Deposits.FORMAT, generator: Deposits.identity(sc), complete: sc.complete,
			tiles: tiles, count: bodies.length, checksum: Deposits.fnvText(body), bodies: bodies
		});
	},
	// Parses and validates an export without touching any scenario; throws before returning.
	parse: function (text) {
		var rec = JSON.parse(text), gen = rec.generator;
		if (rec.format !== Deposits.FORMAT) throw new Error('not a deposit catalogue');
		if (!gen || gen.version !== DepositsModels.version) throw new Error('generator version ' + (gen && gen.version) + ' is not ' + DepositsModels.version);
		if (gen.tileN !== DepositsModels.tileN) throw new Error('tile grid ' + gen.tileN + ' is not ' + DepositsModels.tileN);
		if (rec.bodies.length !== rec.count || Deposits.fnvText(JSON.stringify(rec.bodies)) !== rec.checksum) throw new Error('catalogue checksum mismatch');
		var tileSet = new Set(rec.tiles);
		for (var i = 0; i < rec.bodies.length; i++) {
			var why = Deposits.validate(rec.bodies[i]);
			if (why) throw new Error(rec.bodies[i].id + ': ' + why);
			if (!tileSet.has(rec.bodies[i].tile)) throw new Error(rec.bodies[i].id + ': tile not listed');
		}
		return rec;
	},
	groupByTile: function (rec) {
		var tiles = new Map();
		for (var t = 0; t < rec.tiles.length; t++) tiles.set(rec.tiles[t], []);
		for (var i = 0; i < rec.bodies.length; i++) tiles.get(rec.bodies[i].tile).push(rec.bodies[i]);
		return tiles;
	},
	// A catalogue without its snapshot: answers queries for the tiles it carries.
	fromExport: function (rec) {
		var gen = rec.generator;
		return { seed: gen.seed, version: gen.version, snapshot: null, meta: gen.snapshot, tiles: Deposits.groupByTile(rec), complete: rec.complete };
	},
	// Fills a scenario's cache from a validated export of the same scenario. A foreign
	// export is refused before the scenario changes.
	adopt: function (sc, rec) {
		var gen = rec.generator;
		if (gen.seed !== sc.seed || gen.snapshot.checksum !== sc.meta.checksum) throw new Error('export belongs to another scenario');
		var tiles = Deposits.groupByTile(rec);
		tiles.forEach(function (bodies, tile) { sc.tiles.set(tile, bodies); });
		if (sc.tiles.size === Deposits.tileCount()) sc.complete = true;
	},
	// Short text for the debug view: counts per family and the largest contained metal.
	summary: function (sc, top) {
		var all = Deposits.allBodies(sc), counts = {}, lines = [];
		for (var i = 0; i < all.length; i++) counts[all[i].family] = (counts[all[i].family] || 0) + 1;
		lines.push(sc.tiles.size + ' of ' + Deposits.tileCount() + ' tiles, ' + all.length + ' synthetic bodies '
			+ JSON.stringify(counts) + ' · snapshot ' + sc.meta.checksum);
		var ranked = all.slice().sort(function (a, b) { return b.oreTonnes - a.oreTonnes; });
		for (var k = 0; k < top && k < ranked.length; k++) {
			var b = ranked[k], grades = b.commodities.map(function (m) { return m.id + ' ' + m.grade + m.unit; }).join(', ');
			lines.push(b.id + '  ' + (b.oreTonnes / 1e6).toFixed(1) + ' Mt  ' + grades + '  burial ' + Math.round(b.burialTopM)
				+ ' m  ' + b.host + '  ' + b.lat + ', ' + b.lon);
		}
		return lines.join('\n');
	}
};
Deposits.scratchUv = [0, 0];
Deposits.scratchDir = [0, 0, 0];
Deposits.scratchFrame = new Float64Array(9);
Deposits.scratchUnits = new Float64Array(9);
Deposits.scratchDraws = new Float64Array(Deposits.MAX_DRAWS);
Deposits.scratchGrades = new Float64Array(4);
if (typeof module !== 'undefined' && module.exports) module.exports = Deposits;

/* slice-format.js — pgt-slice-pack v2: pure schema, canonical identities and path geometry.
 * Shared-identical with planet-tectonics-2d-slice through port/PORT.json. No DOM, engine,
 * state or platform byte order enters this file. A decoder proves the raw JSON shape before
 * converting a single field to a typed array.
 */
'use strict';

var SlicePack = (function () {
	var FORMAT = 'pgt-slice-pack', VERSION = 2, R_KM = 6371;
	var MAX_SAMPLES = 1 << 20, MIN_CIRCLE_ANGLE = 1e-7;
	var HOSTS = ['none', 'oceanic', 'continental', 'thick continental', 'sediment'];
	var POTENTIALS = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];
	var EDGE = { none: 0, neutral: 1, open: 2, subduct: 3, collide: 4 };
	var GLOBE_EDGE = { interior: 0, convergent: 1, divergent: 2, transform: 3 };
	var FIELDS = [
		{ name: 'sKm', dtype: 'f64', unit: 'km', what: 'arc length at the start of the run' },
		{ name: 'zM', dtype: 'i32', unit: 'm', what: 'displayed surface elevation' },
		{ name: 'hFelM', dtype: 'i32', unit: 'm', what: 'felsic crust thickness' },
		{ name: 'hMafM', dtype: 'i32', unit: 'm', what: 'mafic crust thickness' },
		{ name: 'hSedM', dtype: 'i32', unit: 'm', what: 'sediment thickness' },
		{ name: 'ageMyr', dtype: 'f32', unit: 'Myr', what: 'lithosphere thermal age' },
		{ name: 'fert', dtype: 'f32', unit: '-', what: 'ore fertility' },
		{ name: 'damage', dtype: 'f32', unit: '-', what: 'accumulated weakening' },
		{ name: 'host', dtype: 'u8', unit: 'code', what: 'index into HOSTS' },
		{ name: 'plate', dtype: 'u16', unit: 'id', what: 'snapshot-local globe plate id' },
		{ name: 'bnd', dtype: 'u8', unit: 'code', what: 'EDGE code toward the next run' },
		{ name: 'pol', dtype: 'i8', unit: 'sign', what: 'subduction polarity' },
		{ name: 'alive', dtype: 'u8', unit: 'flag', what: 'source cell has an owner column' },
		{ name: 'wet', dtype: 'u8', unit: 'flag', what: 'below the displayed sea level' },
		{ name: 'vt', dtype: 'f32', unit: 'm/Myr', what: 'velocity along the cut' },
		{ name: 'vp', dtype: 'f32', unit: 'm/Myr', what: 'out-of-plane speed magnitude' },
		{ name: 'pot', dtype: 'f32', unit: '-', stride: 6, what: 'ore potentials in POTENTIALS order' }
	];
	var DTYPE = {
		f32: Float32Array, f64: Float64Array,
		i8: Int8Array, u8: Uint8Array, u16: Uint16Array, i32: Int32Array
	};
	var LIMITS = {
		i8: [-128, 127], u8: [0, 255], u16: [0, 65535], i32: [-2147483648, 2147483647]
	};
	var TOP_KEYS = ['format', 'version', 'source', 'path', 'planet', 'sea', 'plates', 'n'];
	for (var fieldAt = 0; fieldAt < FIELDS.length; fieldAt++) TOP_KEYS.push(FIELDS[fieldAt].name);
	TOP_KEYS.push('license', 'checksum');
	var SOURCE_KEYS = ['repo', 'commit', 'pack', 'epochMa', 'rotModel', 'built', 'tMyr', 'level', 'gridSeed', 'simSeed'];
	var CIRCLE_KEYS = ['kind', 'closes', 'arcKm', 'cellKm', 'lat0', 'lon0', 'az0'];
	var POLYLINE_KEYS = ['kind', 'closes', 'arcKm', 'cellKm', 'verts'];
	var PLANET_KEYS = ['rKm'], SEA_KEYS = ['mode', 'levelM', 'volScale'];
	var PLATE_KEYS = ['id', 'n', 'wx', 'wy', 'wz'];
	var own = Object.prototype.hasOwnProperty;
	var DEG = 180 / Math.PI;
	var d0 = new Float64Array(3), t0 = new Float64Array(3), point = new Float64Array(3);
	var segmentScratch = { lat: 0, lon: 0, az: 0, offset: 0 };

	function round6(value) {
		if (!Number.isFinite(value) || value === 0) return value === 0 ? 0 : value;
		var rounded = +value.toPrecision(6);
		return rounded === 0 ? 0 : rounded;
	}
	function finite(value) {
		return typeof value === 'number' && Number.isFinite(value);
	}
	function object(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
	}
	function exactKeys(value, expected, label) {
		if (!object(value)) return label + ' must be an object';
		var keys = Object.keys(value), i;
		for (i = 0; i < expected.length; i++) if (!own.call(value, expected[i])) return label + ' is missing ' + expected[i];
		for (i = 0; i < keys.length; i++) if (expected.indexOf(keys[i]) < 0) return label + ' has unknown field ' + keys[i];
		return '';
	}
	function stringField(value, label, allowEmpty) {
		if (typeof value !== 'string') return label + ' must be a string';
		if (!allowEmpty && !value.length) return label + ' must not be empty';
		if (value.length > 4096) return label + ' is too long';
		return '';
	}
	function uint32(value) {
		return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
	}
	function closeEnough(a, b) {
		return Math.abs(a - b) <= Math.max(1e-6, Math.max(Math.abs(a), Math.abs(b)) * 2e-6);
	}
	function wrap180(value) {
		value = (value + 180) % 360;
		if (value < 0) value += 360;
		value -= 180;
		return value === 0 ? 0 : value;
	}
	function dirAt(latDeg, lonDeg, out) {
		var lat = latDeg / DEG, lon = lonDeg / DEG, c = Math.cos(lat);
		out[0] = c * Math.cos(lon);
		out[1] = Math.sin(lat);
		out[2] = c * Math.sin(lon);
		return out;
	}
	function initialTangent(latDeg, lonDeg, azDeg, out) {
		var lat = latDeg / DEG, lon = lonDeg / DEG, az = azDeg / DEG;
		var cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lon), so = Math.sin(lon);
		var ca = Math.cos(az), sa = Math.sin(az);
		out[0] = -sl * co * ca - so * sa;
		out[1] = cl * ca;
		out[2] = -sl * so * ca + co * sa;
		return out;
	}
	function stepFrom(latDeg, lonDeg, azDeg, theta, out) {
		dirAt(latDeg, lonDeg, d0);
		initialTangent(latDeg, lonDeg, azDeg, t0);
		var c = Math.cos(theta), s = Math.sin(theta);
		out[0] = d0[0] * c + t0[0] * s;
		out[1] = d0[1] * c + t0[1] * s;
		out[2] = d0[2] * c + t0[2] * s;
		return out;
	}
	function arcKmBetween(latA, lonA, latB, lonB, radiusKm) {
		dirAt(latA, lonA, d0);
		dirAt(latB, lonB, t0);
		var dot = Math.max(-1, Math.min(1, d0[0] * t0[0] + d0[1] * t0[1] + d0[2] * t0[2]));
		return Math.acos(dot) * (radiusKm === undefined ? R_KM : radiusKm);
	}
	function azimuthBetween(latA, lonA, latB, lonB) {
		var lat1 = latA / DEG, lat2 = latB / DEG, delta = (lonB - lonA) / DEG;
		var y = Math.sin(delta) * Math.cos(lat2);
		var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta);
		return wrap180(Math.atan2(y, x) * DEG);
	}
	function polylineArc(path, radiusKm) {
		var verts = path.verts, total = 0;
		for (var i = 0; i + 3 < verts.length; i += 2)
			total += arcKmBetween(verts[i], verts[i + 1], verts[i + 2], verts[i + 3], radiusKm);
		if (path.closes)
			total += arcKmBetween(verts[verts.length - 2], verts[verts.length - 1], verts[0], verts[1], radiusKm);
		return total;
	}
	function pathReason(path, radiusKm) {
		if (!object(path)) return 'path must be an object';
		var keys = path.kind === 'circle' ? CIRCLE_KEYS : path.kind === 'polyline' ? POLYLINE_KEYS : null;
		if (!keys) return 'path.kind must be circle or polyline';
		var bad = exactKeys(path, keys, 'path');
		if (bad) return bad;
		if (typeof path.closes !== 'boolean') return 'path.closes must be boolean';
		if (!finite(path.arcKm) || !(path.arcKm > 0)) return 'path.arcKm must be positive and finite';
		if (!finite(path.cellKm) || !(path.cellKm > 0)) return 'path.cellKm must be positive and finite';
		if (path.kind === 'circle') {
			if (!path.closes) return 'a circle path must close';
			if (!finite(path.lat0) || path.lat0 < -90 || path.lat0 > 90) return 'path.lat0 must be in [-90, 90]';
			if (!finite(path.lon0) || path.lon0 < -180 || path.lon0 >= 180) return 'path.lon0 must be in [-180, 180)';
			if (!finite(path.az0) || path.az0 < -180 || path.az0 >= 180) return 'path.az0 must be in [-180, 180)';
			if (radiusKm !== undefined && !closeEnough(path.arcKm, 2 * Math.PI * radiusKm))
				return 'circle path.arcKm does not match planet.rKm';
			return '';
		}
		if (!Array.isArray(path.verts) || path.verts.length < 6 || path.verts.length % 2)
			return 'path.verts must contain at least three latitude/longitude pairs';
		for (var i = 0; i < path.verts.length; i += 2) {
			if (!finite(path.verts[i]) || path.verts[i] < -90 || path.verts[i] > 90)
				return 'path.verts latitude is invalid at ' + i;
			if (!finite(path.verts[i + 1]) || path.verts[i + 1] < -180 || path.verts[i + 1] >= 180)
				return 'path.verts longitude is invalid at ' + (i + 1);
		}
		var segments = path.verts.length / 2 - 1 + (path.closes ? 1 : 0);
		for (i = 0; i < segments; i++) {
			var a = (i * 2) % path.verts.length, b = ((i + 1) * 2) % path.verts.length;
			var angle = arcKmBetween(path.verts[a], path.verts[a + 1], path.verts[b], path.verts[b + 1], 1);
			if (!(angle >= MIN_CIRCLE_ANGLE) || Math.PI - angle < MIN_CIRCLE_ANGLE)
				return 'path.verts has a coincident or antipodal segment at ' + i;
		}
		if (radiusKm !== undefined && !closeEnough(path.arcKm, polylineArc(path, radiusKm)))
			return 'polyline path.arcKm does not match its vertices';
		return '';
	}
	function sourceReason(source) {
		var bad = exactKeys(source, SOURCE_KEYS, 'source');
		if (bad) return bad;
		for (var i = 0; i < SOURCE_KEYS.length; i++) {
			var key = SOURCE_KEYS[i];
			if (key === 'epochMa' || key === 'tMyr' || key === 'level' || key === 'gridSeed' || key === 'simSeed') continue;
			bad = stringField(source[key], 'source.' + key, false);
			if (bad) return bad;
		}
		if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(source.built)
			|| !Number.isFinite(Date.parse(source.built))) return 'source.built must be an ISO-8601 UTC timestamp';
		if (!finite(source.epochMa) || source.epochMa < 0) return 'source.epochMa must be non-negative and finite';
		if (!finite(source.tMyr) || source.tMyr < 0) return 'source.tMyr must be non-negative and finite';
		if (!Number.isInteger(source.level) || source.level < 0 || source.level > 30) return 'source.level must be an integer in [0, 30]';
		if (!uint32(source.gridSeed)) return 'source.gridSeed must be a uint32';
		if (!uint32(source.simSeed)) return 'source.simSeed must be a uint32';
		return '';
	}
	function fieldReason(pack, raw) {
		for (var k = 0; k < FIELDS.length; k++) {
			var field = FIELDS[k], values = pack[field.name];
			if (raw && !Array.isArray(values)) return 'field ' + field.name + ' must be a JSON array';
			if (!raw && !Array.isArray(values) && !ArrayBuffer.isView(values)) return 'field ' + field.name + ' must be an array';
			var expected = pack.n * (field.stride || 1);
			if (values.length !== expected) return 'field ' + field.name + ' has ' + values.length + ' values for n = ' + pack.n;
			var limits = LIMITS[field.dtype];
			for (var i = 0; i < values.length; i++) {
				var value = values[i];
				if (!finite(value)) return 'field ' + field.name + ' is not finite at ' + i;
				if (limits && (!Number.isInteger(value) || value < limits[0] || value > limits[1]))
					return 'field ' + field.name + ' is not a ' + field.dtype + ' at ' + i;
			}
		}
		return '';
	}
	function plateReason(pack) {
		if (!Array.isArray(pack.plates) || !pack.plates.length) return 'plates must be a non-empty array';
		if (pack.plates.length > 65536) return 'plates has too many rows';
		var counts = Object.create(null), ids = Object.create(null), i, plate, bad;
		for (i = 0; i < pack.n; i++) if (pack.alive[i] === 1) counts[pack.plate[i]] = (counts[pack.plate[i]] || 0) + 1;
		var previous = -1;
		for (i = 0; i < pack.plates.length; i++) {
			plate = pack.plates[i];
			bad = exactKeys(plate, PLATE_KEYS, 'plates[' + i + ']');
			if (bad) return bad;
			if (!Number.isInteger(plate.id) || plate.id < 0 || plate.id > 65535) return 'plates[' + i + '].id must be a u16';
			if (plate.id <= previous) return 'plates must be ordered by ascending unique id';
			if (!Number.isInteger(plate.n) || plate.n < 0 || plate.n > pack.n) return 'plates[' + i + '].n is invalid';
			if (!finite(plate.wx) || !finite(plate.wy) || !finite(plate.wz)) return 'plates[' + i + '] angular velocity is not finite';
			if (plate.n !== (counts[plate.id] || 0)) return 'plates[' + i + '].n does not match live samples';
			previous = plate.id;
			ids[plate.id] = 1;
			delete counts[plate.id];
		}
		for (var id in counts) return 'live sample plate ' + id + ' is absent from plates';
		for (i = 0; i < pack.n; i++) if (!ids[pack.plate[i]]) return 'sample plate ' + pack.plate[i] + ' is absent from plates at ' + i;
		return '';
	}
	function sampleReason(pack) {
		var starts = pack.sKm, i, p;
		if (starts[0] !== 0) return 'sKm must start at 0';
		for (i = 1; i < pack.n; i++) if (!(starts[i] > starts[i - 1])) return 'sKm is not increasing at ' + i;
		for (i = 0; i < pack.n; i++) {
			var end = i + 1 < pack.n ? starts[i + 1] : pack.path.arcKm;
			if (!(end > starts[i])) return 'sample span is not positive at ' + i;
			if (end - starts[i] > pack.path.cellKm * 1.5 + 1e-6) return 'sample span is wider than the declared cell budget at ' + i;
			if (pack.hFelM[i] < 0 || pack.hMafM[i] < 0 || pack.hSedM[i] < 0) return 'a negative thickness at ' + i;
			if (pack.ageMyr[i] < 0) return 'a negative age at ' + i;
			if (pack.host[i] >= HOSTS.length) return 'host code ' + pack.host[i] + ' at ' + i;
			if (pack.alive[i] && pack.host[i] !== hostCode(pack.hFelM[i], pack.hMafM[i], pack.hSedM[i]))
				return 'host code does not match carried thicknesses at ' + i;
			if (pack.bnd[i] > EDGE.collide) return 'boundary code ' + pack.bnd[i] + ' at ' + i;
			if (pack.pol[i] < -1 || pack.pol[i] > 1) return 'polarity ' + pack.pol[i] + ' at ' + i;
			if (pack.alive[i] > 1 || pack.wet[i] > 1) return 'a flag is not 0/1 at ' + i;
			if (pack.vp[i] < 0) return 'vp must be non-negative at ' + i;
			if (Math.abs(pack.zM[i]) > 1000000) return 'elevation is outside +/-1000 km at ' + i;
			if (pack.bnd[i] === EDGE.subduct) {
				if (pack.pol[i] !== -1 && pack.pol[i] !== 1) return 'subduction polarity must be -1 or +1 at ' + i;
			} else if (pack.pol[i] !== 0) return 'only subduction may carry polarity at ' + i;
			if (pack.alive[i]) continue;
			if (pack.host[i] !== 0 || pack.plate[i] !== 0 || pack.bnd[i] !== 0 || pack.pol[i] !== 0 || pack.wet[i] !== 0)
				return 'gap row has non-canonical codes at ' + i;
			if (pack.zM[i] !== Math.round(round6(pack.sea.levelM))) return 'gap row elevation does not match rounded sea level at ' + i;
			if (pack.hFelM[i] || pack.hMafM[i] || pack.hSedM[i] || pack.ageMyr[i] || pack.fert[i]
				|| pack.damage[i] || pack.vt[i] || pack.vp[i]) return 'gap row has non-zero material or scalar at ' + i;
			for (p = 0; p < POTENTIALS.length; p++) if (pack.pot[i * POTENTIALS.length + p] !== 0)
				return 'gap row has non-zero potential at ' + i;
		}
		return '';
	}
	function validateCore(pack, raw, requireChecksum) {
		var bad = exactKeys(pack, TOP_KEYS, 'pack');
		if (bad) return bad;
		if (pack.format !== FORMAT) return 'not a ' + FORMAT + ' (' + pack.format + ')';
		if (pack.version !== VERSION) return 'pack version ' + pack.version + ', this build reads ' + VERSION;
		if (!Number.isInteger(pack.n) || pack.n < 2 || pack.n > MAX_SAMPLES) return 'n must be an integer in [2, ' + MAX_SAMPLES + ']';
		bad = sourceReason(pack.source);
		if (bad) return bad;
		bad = exactKeys(pack.planet, PLANET_KEYS, 'planet');
		if (bad) return bad;
		if (!finite(pack.planet.rKm) || pack.planet.rKm < 1 || pack.planet.rKm > 10000000) return 'planet.rKm is invalid';
		bad = pathReason(pack.path, pack.planet.rKm);
		if (bad) return bad;
		bad = exactKeys(pack.sea, SEA_KEYS, 'sea');
		if (bad) return bad;
		if (pack.sea.mode !== 'level' && pack.sea.mode !== 'volume') return 'sea.mode must be level or volume';
		if (!finite(pack.sea.levelM) || Math.abs(pack.sea.levelM) > 1000000) return 'sea.levelM is invalid';
		if (!finite(pack.sea.volScale) || pack.sea.volScale < 0) return 'sea.volScale is invalid';
		bad = stringField(pack.license, 'license', false);
		if (bad) return bad;
		if (requireChecksum && (typeof pack.checksum !== 'string' || !/^[0-9a-f]{16}$/.test(pack.checksum)))
			return 'checksum must be 16 lowercase hex digits';
		if (!requireChecksum && typeof pack.checksum !== 'string') return 'checksum must be a string';
		bad = fieldReason(pack, raw);
		if (bad) return bad;
		bad = sampleReason(pack);
		if (bad) return bad;
		return plateReason(pack);
	}
	function quantizePath(path) {
		path.arcKm = round6(path.arcKm);
		path.cellKm = round6(path.cellKm);
		if (path.kind === 'circle') {
			path.lat0 = round6(path.lat0);
			path.lon0 = round6(path.lon0);
			path.az0 = round6(path.az0);
			return;
		}
		for (var i = 0; i < path.verts.length; i++) path.verts[i] = round6(path.verts[i]);
	}
	function quantize(pack) {
		quantizePath(pack.path);
		pack.source.epochMa = round6(pack.source.epochMa);
		pack.source.tMyr = round6(pack.source.tMyr);
		pack.planet.rKm = round6(pack.planet.rKm);
		pack.sea.levelM = round6(pack.sea.levelM);
		pack.sea.volScale = round6(pack.sea.volScale);
		for (var i = 0; i < pack.plates.length; i++) {
			pack.plates[i].wx = round6(pack.plates[i].wx);
			pack.plates[i].wy = round6(pack.plates[i].wy);
			pack.plates[i].wz = round6(pack.plates[i].wz);
		}
		for (var k = 0; k < FIELDS.length; k++) {
			var field = FIELDS[k];
			if (field.dtype !== 'f32' && field.dtype !== 'f64') continue;
			var values = pack[field.name];
			for (i = 0; i < values.length; i++) values[i] = round6(values[i]);
		}
		return pack;
	}
	function normalize(pack) {
		for (var k = 0; k < FIELDS.length; k++) {
			var field = FIELDS[k], Type = DTYPE[field.dtype];
			if (pack[field.name].constructor !== Type) pack[field.name] = new Type(pack[field.name]);
		}
		return pack;
	}
	function plainPath(path, identity) {
		var out = { kind: path.kind, closes: path.closes, arcKm: round6(path.arcKm) };
		if (!identity) out.cellKm = round6(path.cellKm);
		if (path.kind === 'circle') {
			out.lat0 = round6(path.lat0);
			out.lon0 = round6(path.lon0);
			out.az0 = round6(path.az0);
		} else {
			out.verts = [];
			for (var i = 0; i < path.verts.length; i++) out.verts.push(round6(path.verts[i]));
		}
		return out;
	}
	function plainArray(values, floats) {
		var out = new Array(values.length);
		for (var i = 0; i < values.length; i++) out[i] = floats ? round6(values[i]) : values[i];
		return out;
	}
	function plainSource(source, built) {
		var out = {
			repo: source.repo, commit: source.commit, pack: source.pack,
			epochMa: round6(source.epochMa), rotModel: source.rotModel
		};
		if (built) out.built = source.built;
		out.tMyr = round6(source.tMyr);
		out.level = source.level;
		out.gridSeed = source.gridSeed;
		out.simSeed = source.simSeed;
		return out;
	}
	function canonical(pack, built, stamp) {
		var out = {
			format: FORMAT,
			version: VERSION,
			source: plainSource(pack.source, built),
			path: plainPath(pack.path, false),
			planet: { rKm: round6(pack.planet.rKm) },
			sea: { mode: pack.sea.mode, levelM: round6(pack.sea.levelM), volScale: round6(pack.sea.volScale) },
			plates: [],
			n: pack.n
		};
		for (var i = 0; i < pack.plates.length; i++) {
			var plate = pack.plates[i];
			out.plates.push({ id: plate.id, n: plate.n, wx: round6(plate.wx), wy: round6(plate.wy), wz: round6(plate.wz) });
		}
		for (var k = 0; k < FIELDS.length; k++) {
			var field = FIELDS[k];
			out[field.name] = plainArray(pack[field.name], field.dtype === 'f32' || field.dtype === 'f64');
		}
		out.license = pack.license;
		if (stamp) out.checksum = pack.checksum;
		return out;
	}
	function utf8(text) {
		var out = [], i, code;
		for (i = 0; i < text.length; i++) {
			code = text.charCodeAt(i);
			if (code < 0x80) out.push(code);
			else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
			else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
				var low = text.charCodeAt(i + 1);
				if (low >= 0xdc00 && low <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
					i++;
					out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
					continue;
				}
				out.push(0xef, 0xbf, 0xbd);
			} else if (code >= 0xdc00 && code <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
			else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		}
		return out;
	}
	function fnvText(domain, value) {
		var bytes = utf8(domain + '\n' + JSON.stringify(value));
		var a = 0x811c9dc5, b = 0x9747b28c;
		for (var i = 0; i < bytes.length; i++) {
			a = Math.imul(a ^ bytes[i], 16777619);
			b = Math.imul(b ^ bytes[i] ^ 0x5a, 0x01000195);
		}
		return ('0000000' + (a >>> 0).toString(16)).slice(-8)
			+ ('0000000' + (b >>> 0).toString(16)).slice(-8);
	}
	function checksum(pack) {
		return fnvText('pgt-slice-pack-v2', canonical(pack, false, false));
	}
	function pathChecksum(path) {
		var bad = pathReason(path);
		if (bad) throw new RangeError(bad);
		return fnvText('pgt-slice-path-v2', plainPath(path, true));
	}
	function make(n, path) {
		var pack = {
			format: FORMAT,
			version: VERSION,
			source: { repo: '', commit: '', pack: '', epochMa: 0, rotModel: '', built: '', tMyr: 0, level: 0, gridSeed: 0, simSeed: 0 },
			path: path || { kind: 'circle', closes: true, arcKm: 0, cellKm: 0, lat0: 0, lon0: 0, az0: 0 },
			planet: { rKm: R_KM },
			sea: { mode: 'level', levelM: 0, volScale: 1 },
			plates: [],
			n: n,
			license: '',
			checksum: ''
		};
		for (var k = 0; k < FIELDS.length; k++) {
			var field = FIELDS[k];
			pack[field.name] = new DTYPE[field.dtype](n * (field.stride || 1));
		}
		return pack;
	}
	function seal(pack) {
		var bad = validateCore(pack, false, false);
		if (bad) throw new RangeError(bad);
		normalize(pack);
		quantize(pack);
		bad = validateCore(pack, false, false);
		if (bad) throw new RangeError(bad);
		pack.checksum = checksum(pack);
		return pack;
	}
	function validate(pack) {
		return validateCore(pack, false, true);
	}
	function verify(pack) {
		return checksum(pack) === pack.checksum ? '' : 'checksum mismatch: the pack was edited or truncated';
	}
	function encode(pack) {
		var bad = validate(pack) || verify(pack);
		if (bad) throw new RangeError(bad);
		return JSON.stringify(canonical(pack, true, true));
	}
	function decode(text) {
		if (typeof text !== 'string') throw new TypeError('slice pack input must be JSON text');
		var pack;
		try { pack = JSON.parse(text); }
		catch (error) { throw new SyntaxError('slice pack is not valid JSON: ' + error.message); }
		var bad = validateCore(pack, true, true);
		if (bad) throw new RangeError(bad);
		normalize(pack);
		quantize(pack);
		bad = validate(pack) || verify(pack);
		if (bad) throw new RangeError(bad);
		return pack;
	}
	function hostCode(hFelM, hMafM, hSedM) {
		if (hSedM > 2000 && hSedM > hFelM && hSedM > hMafM) return 4;
		if (hFelM >= 8000) return hFelM > 45000 ? 3 : 2;
		return hFelM + hMafM + hSedM > 0 ? 1 : 0;
	}
	function edgeCode(globeType, polarity) {
		if (globeType === GLOBE_EDGE.convergent) {
			if (polarity === 2) return EDGE.collide;
			if (polarity === -1 || polarity === 1) return EDGE.subduct;
			throw new RangeError('convergent edge polarity must be -1, +1 or 2');
		}
		if (globeType === GLOBE_EDGE.divergent) return EDGE.open;
		if (globeType === GLOBE_EDGE.transform) return EDGE.neutral;
		if (globeType === GLOBE_EDGE.interior) return EDGE.none;
		throw new RangeError('unknown globe edge type ' + globeType);
	}
	function edgePolarity(globeType, polarity) {
		return edgeCode(globeType, polarity) === EDGE.subduct ? polarity : 0;
	}
	function setGap(pack, index) {
		if (!pack || !Number.isInteger(index) || index < 0 || index >= pack.n) throw new RangeError('gap row index is invalid');
		pack.zM[index] = Math.round(round6(pack.sea.levelM));
		pack.hFelM[index] = 0;
		pack.hMafM[index] = 0;
		pack.hSedM[index] = 0;
		pack.ageMyr[index] = 0;
		pack.fert[index] = 0;
		pack.damage[index] = 0;
		pack.host[index] = 0;
		pack.plate[index] = 0;
		pack.bnd[index] = 0;
		pack.pol[index] = 0;
		pack.alive[index] = 0;
		pack.wet[index] = 0;
		pack.vt[index] = 0;
		pack.vp[index] = 0;
		for (var i = 0; i < POTENTIALS.length; i++) pack.pot[index * POTENTIALS.length + i] = 0;
		return pack;
	}
	function circleThrough(a, b, radiusKm, cellKm) {
		if (!a || !b || a.length < 3 || b.length < 3) throw new TypeError('circle endpoints must be 3D directions');
		if (!finite(radiusKm) || !(radiusKm > 0)) throw new RangeError('circle radius must be positive');
		if (!finite(cellKm) || !(cellKm > 0)) throw new RangeError('circle cell budget must be positive');
		var al = Math.hypot(a[0], a[1], a[2]), bl = Math.hypot(b[0], b[1], b[2]);
		if (!(al > 0) || !(bl > 0)) throw new RangeError('circle endpoint direction is zero');
		var ax = a[0] / al, ay = a[1] / al, az = a[2] / al;
		var bx = b[0] / bl, by = b[1] / bl, bz = b[2] / bl;
		var dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
		var angle = Math.acos(dot);
		if (angle < MIN_CIRCLE_ANGLE || Math.PI - angle < MIN_CIRCLE_ANGLE)
			throw new RangeError('circle points must be neither coincident nor antipodal');
		var tx = bx - dot * ax, ty = by - dot * ay, tz = bz - dot * az;
		var tl = Math.hypot(tx, ty, tz);
		tx /= tl; ty /= tl; tz /= tl;
		var lat = Math.asin(Math.max(-1, Math.min(1, ay))), lon = Math.atan2(az, ax);
		var northX = -Math.sin(lat) * Math.cos(lon), northY = Math.cos(lat), northZ = -Math.sin(lat) * Math.sin(lon);
		var eastX = -Math.sin(lon), eastZ = Math.cos(lon);
		var north = tx * northX + ty * northY + tz * northZ;
		var east = tx * eastX + tz * eastZ;
		return {
			kind: 'circle', closes: true, arcKm: 2 * Math.PI * radiusKm, cellKm: cellKm,
			lat0: lat * DEG, lon0: wrap180(lon * DEG), az0: wrap180(Math.atan2(east, north) * DEG)
		};
	}
	function segmentAt(path, sKm, radiusKm) {
		var atEnd = sKm >= path.arcKm;
		var verts = path.verts, s = Math.max(0, Math.min(path.arcKm, sKm)), at = 0;
		var segments = verts.length / 2 - 1 + (path.closes ? 1 : 0);
		for (var i = 0; i < segments; i++) {
			var a = (i * 2) % verts.length, b = ((i + 1) * 2) % verts.length;
			var length = arcKmBetween(verts[a], verts[a + 1], verts[b], verts[b + 1], radiusKm);
			if (s <= at + length || i === segments - 1) {
				segmentScratch.lat = verts[a];
				segmentScratch.lon = verts[a + 1];
				segmentScratch.az = azimuthBetween(verts[a], verts[a + 1], verts[b], verts[b + 1]);
				segmentScratch.offset = atEnd && i === segments - 1 ? length : s - at;
				return segmentScratch;
			}
			at += length;
		}
		return null;
	}
	function directionAt(value, sKm, out) {
		var path = value.path || value, radiusKm = value.planet ? value.planet.rKm : R_KM;
		out = out || new Float64Array(3);
		if (path.kind === 'circle') {
			var s = Math.max(0, Math.min(path.arcKm, sKm));
			return stepFrom(path.lat0, path.lon0, path.az0, 2 * Math.PI * s / path.arcKm, out);
		}
		var segment = segmentAt(path, sKm, radiusKm);
		return stepFrom(segment.lat, segment.lon, segment.az, segment.offset / radiusKm, out);
	}
	function tangentAt(value, sKm, out) {
		var path = value.path || value, radiusKm = value.planet ? value.planet.rKm : R_KM;
		out = out || new Float64Array(3);
		var lat, lon, az, theta;
		if (path.kind === 'circle') {
			lat = path.lat0; lon = path.lon0; az = path.az0;
			theta = 2 * Math.PI * Math.max(0, Math.min(path.arcKm, sKm)) / path.arcKm;
		} else {
			var segment = segmentAt(path, sKm, radiusKm);
			lat = segment.lat; lon = segment.lon; az = segment.az; theta = segment.offset / radiusKm;
		}
		dirAt(lat, lon, d0);
		initialTangent(lat, lon, az, t0);
		var c = Math.cos(theta), s = Math.sin(theta);
		out[0] = -d0[0] * s + t0[0] * c;
		out[1] = -d0[1] * s + t0[1] * c;
		out[2] = -d0[2] * s + t0[2] * c;
		return out;
	}
	function latLonAt(value, sKm, out) {
		out = out || new Float64Array(2);
		directionAt(value, sKm, point);
		out[0] = Math.asin(Math.max(-1, Math.min(1, point[1]))) * DEG;
		out[1] = wrap180(Math.atan2(point[2], point[0]) * DEG);
		return out;
	}

	return {
		FORMAT: FORMAT,
		VERSION: VERSION,
		R_KM: R_KM,
		DEG: DEG,
		MAX_SAMPLES: MAX_SAMPLES,
		MIN_CIRCLE_ANGLE: MIN_CIRCLE_ANGLE,
		HOSTS: HOSTS,
		POTENTIALS: POTENTIALS,
		EDGE: EDGE,
		GLOBE_EDGE: GLOBE_EDGE,
		FIELDS: FIELDS,
		DTYPE: DTYPE,
		round: round6,
		make: make,
		seal: seal,
		validateRaw: function (pack) { return validateCore(pack, true, true); },
		validate: validate,
		verify: verify,
		checksum: checksum,
		pathChecksum: pathChecksum,
		encode: encode,
		decode: decode,
		hostCode: hostCode,
		edgeCode: edgeCode,
		edgePolarity: edgePolarity,
		setGap: setGap,
		circleThrough: circleThrough,
		arcKmBetween: arcKmBetween,
		azimuthBetween: azimuthBetween,
		polylineArc: polylineArc,
		directionAt: directionAt,
		tangentAt: tangentAt,
		latLonAt: latLonAt
	};
}());

if (typeof module !== 'undefined' && module.exports) module.exports = SlicePack;

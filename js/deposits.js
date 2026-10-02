var DepositParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var DepositDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var DepositExtract = typeof module !== 'undefined' && module.exports ? require('./extract.js') : Extract;

// Local, on-demand deposit candidates. The cell grid is only a sampling frame; identity comes
// from the column's plate-frame position, so a rigidly moving column does not reroll a prospect.
var Deposits = (function () {
	var FIELDS = DepositDiag.ORE_FIELDS;
	var KINDS = DepositDiag.ORE_NAMES;
	var DEPTH_BANDS = [[0, 2000], [0, 2000], [300, 3000], [500, 3500], [30, 2000], [0, 30]];
	var DEPTH_STEP = 50, BODY_SCALE = 32768, POTENTIAL_BUCKETS = 255;
	var TAU = Math.PI * 2;

	function kindIndex(kind) {
		if (Number.isInteger(kind) && kind >= 0 && kind < KINDS.length) return kind;
		return KINDS.indexOf(kind);
	}
	function potential(value) {
		return Math.floor(Math.max(0, Math.min(1, value)) * POTENTIAL_BUCKETS) / POTENTIAL_BUCKETS;
	}
	function anchorKey(s, cell) {
		var owner = s.owner[cell];
		if (owner < 0 || owner >= s.n || !s.alive[owner]) return null;
		var b = owner * 3;
		return [Math.round(s.body[b] * BODY_SCALE), Math.round(s.body[b + 1] * BODY_SCALE),
			Math.round(s.body[b + 2] * BODY_SCALE)];
	}
	function hash32(seed, kind, key) {
		var k = kindIndex(kind);
		if (k < 0 || !key || key.length < 3) return 0;
		var h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
		for (var i = 0; i < 3; i++) {
			h = Math.imul(h ^ (key[i] | 0), 0x85ebca6b);
			h ^= h >>> 13;
		}
		h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
		h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
		return (h ^ (h >>> 16)) >>> 0;
	}
	function hex32(value) {
		return ('00000000' + (value >>> 0).toString(16)).slice(-8);
	}
	function idFor(seed, kind, key) {
		return hex32(hash32(seed, kind, key));
	}
	function blurAt(s, kind, cell) {
		var k = kindIndex(kind), g = s.grid, owner = s.owner[cell];
		if (k < 0 || owner < 0 || owner >= s.n || !s.alive[owner]) return 0;
		var field = s[FIELDS[k]], sum = field[owner], count = 1;
		for (var n = 0; n < g.ringN[cell]; n++) {
			var neighbor = g.ring[cell * 6 + n], adjacent = s.owner[neighbor];
			if (adjacent < 0 || adjacent >= s.n || !s.alive[adjacent]) continue;
			sum += field[adjacent]; count++;
		}
		return potential(sum / count);
	}
	function isPeak(s, kind, cell, value) {
		var g = s.grid;
		for (var n = 0; n < g.ringN[cell]; n++) {
			var neighbor = g.ring[cell * 6 + n], other = blurAt(s, kind, neighbor);
			if (other > value || (other === value && neighbor < cell)) return false;
		}
		return true;
	}
	function currentDirection(s, cell, owner) {
		var b = owner * 3, x = s.world[b], y = s.world[b + 1], z = s.world[b + 2];
		var length = Math.hypot(x, y, z);
		if (!(length > 0) || !Number.isFinite(length)) {
			b = cell * 3; x = s.grid.pos[b]; y = s.grid.pos[b + 1]; z = s.grid.pos[b + 2];
			length = Math.hypot(x, y, z) || 1;
		}
		return [x / length, y / length, z / length];
	}
	function recordAt(s, kind, cell) {
		var k = kindIndex(kind);
		if (k < 0) return null;
		var value = blurAt(s, k, cell);
		if (value < DepositParams.depositMin || !isPeak(s, k, cell, value)) return null;
		var owner = s.owner[cell], key = anchorKey(s, cell);
		if (!key) return null;
		var hash = hash32(s.seed, k, key), band = DEPTH_BANDS[k];
		var maxBucket = Math.floor((band[1] - band[0]) / DEPTH_STEP);
		var emplacement = band[0] + (hash % (maxBucket + 1)) * DEPTH_STEP;
		var cover = Math.max(0, Math.round(s.hSed[owner] / DEPTH_STEP) * DEPTH_STEP);
		var direction = currentDirection(s, cell, owner);
		var lat = Math.asin(Math.max(-1, Math.min(1, direction[1])));
		var lon = Math.atan2(direction[2], direction[0]);
		var surfaceZ = s.z[cell];
		return {
			id: hex32(hash), kind: KINDS[k], kindIndex: k, cell: cell, owner: owner,
			anchorKey: key, direction: direction, potential: value,
			host: DepositExtract.host(s, cell), ageMyr: Math.round(s.age[owner]),
			epochMyr: Math.round(s.t * 10) / 10, plate: s.plate[owner],
			lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
			cover: cover, surfaceZ: Number.isFinite(surfaceZ) ? Math.round(surfaceZ / 10) * 10 : 0,
			top: emplacement + cover
		};
	}

	return {
		KINDS: KINDS,
		FIELDS: FIELDS,
		TRACE_MIN: DepositParams.traceMin,
		DEPOSIT_MIN: DepositParams.depositMin,
		HYSTERESIS: DepositParams.depositHysteresis,
		POTENTIAL_BUCKETS: POTENTIAL_BUCKETS,
		potential: potential,
		blurAt: blurAt,
		anchorKey: anchorKey,
		hash32: hash32,
		idFor: idFor,
		isPeak: isPeak,
		at: recordAt
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Deposits;

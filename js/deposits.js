var DepositParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var DepositDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var DepositExtract = typeof module !== 'undefined' && module.exports ? require('./extract.js') : Extract;
// The monetary scenario (0.6.3). It reads a finished record and never writes one, so the
// dependency is one way: the catalogue does not know a price exists, and changing a
// price cannot change a record or its identity.
var DepositMoney = typeof module !== 'undefined' && module.exports ? require('./data/deposit-economics.js') : DepositEconomics;

// The deposit catalogue (0.6.1). Local, on-demand records: the cell grid is only a sampling
// frame, identity comes from the column's plate-frame position, so a rigidly moving column does
// not reroll a prospect. Every number is a function of integer buckets (stability contract S1)
// and of an integer hash of (seed, class, anchorKey) - never of the clock or of Math.random (S2).
var Deposits = (function () {
	var FIELDS = DepositDiag.ORE_FIELDS;
	// `iron` is derived, not stored (design §8): it has no potential of its own and rides the
	// blurred value of the mafic / VMS / basin fields where mafic crust is exposed.
	var KINDS = DepositDiag.ORE_NAMES.concat(['iron']);
	var IRON = KINDS.length - 1, K_VMS = 0, K_MAFIC = 1, K_BASIN = 4;
	// Exposed mafic crust, the design §8 rule that derives iron: felsic cover under 2 km, above
	// sea level. It is the BIF/supergene setting, not the basin threshold that happens to share
	// the number.
	// Design §8 derives iron from two settings: exposed mafic crust (felsic cover under 2 km,
	// above sea level - the supergene/Algoma case) and `oBas` in old basins (the Superior-type
	// BIF that supplies most of Earth's iron). The second is why a planet has more than a
	// handful of iron records.
	var IRON_FEL_MAX = 2000, IRON_BASIN_SED = 2000, IRON_BASIN_AGE = 500;
	// The six potentials do not share a scale. `oPla` is a transported load rather than a
	// saturating accumulator: on the L5 1500 Myr calibration history its blurred field tops out
	// at 0.144, so on the common `depositMin` it would never produce a single record and the
	// placer half of the prospector would be dead code. FIELD_SCALE maps each kind's own field
	// onto the shared 0..1 deposit scale before quantization, so one threshold still means one
	// thing. It is measured (experiments/deposit-calibration.js prints each field's maximum)
	// and 1.0 wherever a field already uses the range.
	var FIELD_SCALE = [1, 1, 1, 1, 1, 7, 1];
	var DEPTH_STEP = 50, COVER_CAP = 4000, BODY_SCALE = 32768, POTENTIAL_BUCKETS = 255;
	var SHARE_UNITS = 1024;
	// Independent draws from one anchor: each is its own salted hash, so adding a draw later
	// cannot shift the ones already committed.
	var SALT_SIZE = 1, SALT_BODIES = 2, SALT_VARIANT = 3, SALT_EMPLACE = 4;
	var SALT_SHARE = 10, SALT_ASPECT = 30, SALT_GAP = 50, SALT_GRADE = 70;
	var SALT_STRIKE = 90, SALT_DIP = 110, SALT_ELONG = 130, SALT_OFFSET = 150, SALT_COLLISION = 210;
	var CONFIDENCE_NONE = 'ok', DEG = Math.PI / 180, _units = [0, 0, 0, 0, 0, 0, 0, 0, 0];

	// The class table. `ladder` is a percentile ladder in the row's `unit`, not a range:
	// [min, T10, T50, T90, max], so a size class can be checked against published percentiles.
	// `grades` are [metal, unit, lo, hi] log-uniform bands; the first metal is the principal and
	// the only one the economic screen looks at. `aspect` is k = thickness / sqrt(area), the one
	// shape degree of freedom - a second footprint band could contradict the tonnage ladder.
	// `dip` is the emplacement attitude band [lo, hi] in degrees for 3D ellipsoid bodies.
	// Sources are named in 0.6.1-plan-deposit-catalogue.md §2; a published band written "0-x"
	// gets a small positive floor here because the draw is log-uniform.
	var CLASSES = [
		{ kind: 'vms', variant: 'sulfide', hosted: 'basement', commodity: 'Cu-Zn-Pb-Ag', unit: 'Mt',
			ladder: [0.5, 2, 10, 40, 150], rho: 3.0, bodies: [1, 8], aspect: [0.1, 0.6], dip: [15, 55], emplace: [0, 2000],
			grades: [['Cu', '%', 0.2, 6], ['Zn', '%', 0.3, 12], ['Pb', '%', 0.02, 2], ['Ag', 'g/t', 5, 120], ['Au', 'g/t', 0.02, 3]],
			screen: { type: 'sum', weights: [1, 1, 0.5], cutOff: 1.5, label: 'Cu+Zn+½Pb ≥ 1.5 %' },
			minSize: 2, maxTop: 2500, anchorMedian: 2, source: '904-deposit VMS compilation; Manitoba VMS short course' },
		{ kind: 'mafic', variant: 'sulfide', hosted: 'basement', commodity: 'Ni-Cu-PGE', unit: 'Mt',
			ladder: [0.5, 3, 20, 120, 600], rho: 3.0, bodies: [1, 5], aspect: [0.1, 0.6], dip: [10, 45], emplace: [0, 2000],
			grades: [['Ni', '%', 0.2, 3.5], ['Cu', '%', 0.1, 2], ['PGE', 'g/t', 0.05, 8]],
			screen: { type: 'grade', cutOff: 0.4, label: '0.4 % Ni' },
			minSize: 3, maxTop: 2000, anchorMedian: null, source: 'USGS SIR 2010-5070-i' },
		{ kind: 'mafic', variant: 'diamond', hosted: 'basement', commodity: 'Diamond', unit: 'Mt',
			ladder: [5, 20, 80, 300, 900], rho: 2.5, bodies: [1, 3], aspect: [0.3, 1.5], dip: [75, 88], emplace: [0, 800],
			grades: [['Diamond', 'ct/t', 0.05, 2]],
			screen: { type: 'grade', cutOff: 0.15, label: '0.15 ct/t' },
			minSize: 5, maxTop: 1000, anchorMedian: null, source: 'cratonic kimberlite literature' },
		{ kind: 'arc', variant: 'porphyry', hosted: 'basement', commodity: 'Cu-Mo-Au', unit: 'Mt',
			ladder: [20, 60, 220, 800, 3000], rho: 2.6, bodies: [1, 6], aspect: [0.2, 0.8], dip: [55, 85], emplace: [300, 3000],
			grades: [['Cu', '%', 0.15, 1.2], ['Mo', '%', 0.002, 0.08], ['Au', 'g/t', 0.01, 1.2], ['Ag', 'g/t', 0.5, 20]],
			screen: { type: 'grade', cutOff: 0.25, label: '0.25 % Cu' },
			minSize: 20, maxTop: 2500, anchorMedian: 220, source: 'USGS OFR 2007-1214 §5 table 5.1-1; USGS OFR 95-0831 model 17' },
		{ kind: 'arc', variant: 'epithermal', hosted: 'basement', commodity: 'Au-Ag', unit: 'Mt',
			ladder: [5, 10, 25, 60, 150], rho: 2.6, bodies: [1, 4], aspect: [0.05, 0.3], dip: [60, 88], emplace: [100, 1200],
			grades: [['Au', 'g/t', 0.8, 8], ['Ag', 'g/t', 2, 60]],
			screen: { type: 'grade', cutOff: 0.8, label: '0.8 g/t Au' },
			minSize: 5, maxTop: 500, anchorMedian: 15, source: 'low-sulfidation Au vein models' },
		{ kind: 'orogenic', variant: 'vein', hosted: 'basement', commodity: 'Au-W', unit: 'Mt',
			ladder: [0.5, 2, 8, 40, 200], rho: 2.7, bodies: [1, 6], aspect: [0.005, 0.05], dip: [50, 85], emplace: [500, 3500],
			grades: [['Au', 'g/t', 1.5, 15], ['Ag', 'g/t', 0.5, 20]],
			screen: { type: 'grade', cutOff: 1.0, label: '1.0 g/t Au' },
			minSize: 1, maxTop: 2500, anchorMedian: 1, source: 'USGS OFR 94-250 (Archean Au-quartz veins)' },
		{ kind: 'orogenic', variant: 'sedhost', hosted: 'sediment', commodity: 'Au', unit: 'Mt',
			ladder: [1, 5, 20, 80, 300], rho: 2.5, bodies: [1, 4], aspect: [0.01, 0.1], dip: [10, 40], emplace: [100, 1200],
			grades: [['Au', 'g/t', 0.5, 6]],
			screen: { type: 'grade', cutOff: 0.6, label: '0.6 g/t Au' },
			minSize: 5, maxTop: 1500, anchorMedian: 7.1, source: 'USGS OFR 2014-1074 (sediment-hosted Au)' },
		{ kind: 'basin', variant: 'uranium', hosted: 'sediment', commodity: 'U', unit: 't U3O8',
			ladder: [200, 1000, 9500, 30000, 100000], rho: 2.2, bodies: [1, 6], aspect: [0.005, 0.05], dip: [2, 18], emplace: [30, 800],
			grades: [['U3O8', '%', 0.05, 0.45]],
			screen: { type: 'grade', cutOff: 0.05, label: '0.05 % U₃O₈' },
			minSize: 500, maxTop: 1200, anchorMedian: 9500, source: 'IAEA classification; New Mexico Grants district' },
		{ kind: 'basin', variant: 'coal', hosted: 'sediment', commodity: 'Coal', unit: 'Mt',
			ladder: [50, 200, 800, 2500, 5000], rho: 1.4, bodies: [1, 4], aspect: [0.0002, 0.003], dip: [1, 12], emplace: [20, 1000],
			grades: [], bulk: 'Coal',
			screen: { type: 'seam', cutOff: 1, label: '≥ 1 m seam' },
			minSize: 100, maxTop: 1000, anchorMedian: null, source: 'game assumption - no published grade-tonnage model' },
		{ kind: 'basin', variant: 'potash', hosted: 'sediment', commodity: 'K2O', unit: 'Mt',
			ladder: [100, 250, 700, 2000, 5000], rho: 2.1, bodies: [1, 3], aspect: [0.001, 0.02], dip: [1, 10], emplace: [200, 2000],
			grades: [['K2O', '%', 15, 30]],
			screen: { type: 'grade', cutOff: 15, label: '15 % K₂O' },
			minSize: 100, maxTop: 2000, anchorMedian: 392, source: 'USGS 2014 potash overview; Russell deposit' },
		{ kind: 'placer', variant: 'gold', hosted: 'sediment', commodity: 'Au', unit: 'Mt',
			ladder: [0.5, 2, 10, 50, 200], rho: 2.0, bodies: [1, 5], aspect: [0.002, 0.03], dip: [0, 5], emplace: [0, 30],
			grades: [['Au', 'g/t', 0.02, 0.5]],
			screen: { type: 'grade', cutOff: 0.05, label: '0.05 g/t Au, 0.3 t contained' }, minContained: 0.3,
			minSize: 1, maxTop: 60, anchorMedian: null, source: 'USGS Bulletin 1693 model 39b (g/m³ at 2.0 t/m³)' },
		{ kind: 'iron', variant: 'bif', hosted: 'sediment', commodity: 'Fe', unit: 'Mt',
			ladder: [100, 500, 2500, 12000, 50000], rho: 3.1, bodies: [1, 3], aspect: [0.01, 0.1], dip: [5, 30], emplace: [0, 400],
			grades: [['Fe', '%', 25, 62]],
			screen: { type: 'grade', cutOff: 30, label: '30 % Fe' },
			minSize: 300, maxTop: 500, anchorMedian: null, source: 'Hamersley / Superior-type BIF literature' },
		{ kind: 'iron', variant: 'algoma', hosted: 'basement', commodity: 'Fe', unit: 'Mt',
			ladder: [20, 80, 300, 1200, 5000], rho: 3.2, bodies: [1, 4], aspect: [0.02, 0.2], dip: [25, 70], emplace: [0, 600],
			grades: [['Fe', '%', 25, 55]],
			screen: { type: 'grade', cutOff: 30, label: '30 % Fe' },
			minSize: 50, maxTop: 500, anchorMedian: null, source: 'Algoma-type BIF in greenstone belts' }
	];
	var SIZE_CLASSES = ['small', 'medium', 'large', 'giant'];
	// q buckets that select the ladder segment (plan §3.3). Below the first there is no record.
	var BAND_Q = [77, 115, 179, 230];

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
	function salted(seed, k, key, salt) {
		return hash32((seed ^ Math.imul(salt + 1, 0x27d4eb2f)) >>> 0, k, key);
	}
	// Every draw is one byte of its own salted hash, so a record is a function of integers only.
	function draw(seed, k, key, salt) {
		return (salted(seed, k, key, salt) & 255) / 255;
	}
	function hex32(value) {
		return ('00000000' + (value >>> 0).toString(16)).slice(-8);
	}
	function idFor(seed, kind, key) {
		return hex32(hash32(seed, kind, key));
	}
	function ironExposed(s, owner, cell) {
		return s.hFel[owner] < IRON_FEL_MAX && s.z[cell] > 0;
	}
	function ironBasin(s, owner) {
		return s.hSed[owner] >= IRON_BASIN_SED && s.age[owner] > IRON_BASIN_AGE;
	}
	function ironAt(s, owner, cell) {
		var best = 0;
		if (ironExposed(s, owner, cell)) {
			var mafic = blurAt(s, K_MAFIC, cell), vms = blurAt(s, K_VMS, cell);
			best = mafic > vms ? mafic : vms;
		}
		if (!ironBasin(s, owner)) return best;
		var basin = blurAt(s, K_BASIN, cell);
		return basin > best ? basin : best;
	}
	function blurAt(s, kind, cell) {
		var k = kindIndex(kind), g = s.grid, owner = s.owner[cell];
		if (k < 0 || owner < 0 || owner >= s.n || !s.alive[owner]) return 0;
		if (k === IRON) return ironAt(s, owner, cell);
		var field = s[FIELDS[k]], sum = field[owner], count = 1;
		for (var n = 0; n < g.ringN[cell]; n++) {
			var neighbor = g.ring[cell * 6 + n], adjacent = s.owner[neighbor];
			if (adjacent < 0 || adjacent >= s.n || !s.alive[adjacent]) continue;
			sum += field[adjacent]; count++;
		}
		return potential(sum / count * FIELD_SCALE[k]);
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

	// --- the class row -------------------------------------------------------------------
	// Contexts are exclusive wherever the geology is exclusive (a craton is not an ordinary
	// mafic host, a thick sedimentary pile is not a quartz-vein host), so the same cell always
	// names the same commodity. Only the basin variants genuinely overlap, and there the row
	// is picked by hash among the ones the cell qualifies for. A kind with no qualifying
	// variant emits nothing: the same geology then yields a different commodity, which is
	// the point.
	function variantOk(row, s, cell, owner, latitude) {
		if (row.kind === 'mafic') {
			var craton = s.hFel[owner] > DepositParams.hOro && s.age[owner] > 300;
			return row.variant === 'diamond' ? craton : !craton;
		}
		if (row.kind === 'arc') {
			var island = s.hFel[owner] < DepositParams.hOceanic;
			return row.variant === 'epithermal' ? island : !island;
		}
		if (row.kind === 'orogenic') {
			var covered = s.hSed[owner] >= 500;
			return row.variant === 'sedhost' ? covered : !covered;
		}
		if (row.kind === 'iron') {
			// Superior-type BIF is the basin fill itself; Algoma-type sits in the exposed
			// volcanic pile. The basin takes precedence where a cell could be either.
			return row.variant === 'bif' ? ironBasin(s, owner) : !ironBasin(s, owner);
		}
		if (row.kind !== 'basin') return true;
		var wet = s.z[cell] < DepositParams.sea;
		if (row.variant === 'potash') return wet && Math.abs(latitude) < 40 * Math.PI / 180;
		if (row.variant === 'coal') return s.z[cell] > -200;
		return s.hFel[owner] >= DepositParams.hOceanic && s.hSed[owner] >= 300;
	}
	function rowsOf(k) {
		var out = [];
		for (var i = 0; i < CLASSES.length; i++) if (CLASSES[i].kind === KINDS[k]) out.push(CLASSES[i]);
		return out;
	}
	var ROWS_BY_KIND = (function () {
		var table = [];
		for (var k = 0; k < KINDS.length; k++) table.push(rowsOf(k));
		return table;
	}());
	function pickRow(s, k, cell, owner, key, latitude) {
		var rows = ROWS_BY_KIND[k], eligible = null, count = 0, only = null;
		for (var i = 0; i < rows.length; i++) {
			if (!variantOk(rows[i], s, cell, owner, latitude)) continue;
			count++;
			if (count === 1) { only = rows[i]; continue; }
			if (!eligible) eligible = [only];
			eligible.push(rows[i]);
		}
		if (count <= 1) return only;
		return eligible[salted(s.seed, k, key, SALT_VARIANT) % eligible.length];
	}

	// --- numbers -------------------------------------------------------------------------
	function logLerp(lo, hi, u) {
		return Math.pow(10, Math.log10(lo) + u * (Math.log10(hi) - Math.log10(lo)));
	}
	function sig2(value) {
		return value > 0 ? +value.toPrecision(2) : 0;
	}
	function sig3(value) {
		return value > 0 ? +value.toPrecision(3) : 0;
	}
	// The 1-2-5 tonnage ladder: the snap is what makes a size insensitive to sub-bucket drift.
	function snap125(value, lo, hi) {
		var exponent = Math.floor(Math.log10(value)), scale = Math.pow(10, exponent);
		var mantissa = value / scale, steps = [1, 2, 5, 10], best = 1;
		for (var i = 0; i < steps.length; i++) {
			if (Math.abs(Math.log(steps[i] / mantissa)) < Math.abs(Math.log(best / mantissa))) best = steps[i];
		}
		return Math.min(hi, Math.max(lo, +(best * scale).toPrecision(6)));
	}
	function bandOf(q) {
		for (var i = BAND_Q.length - 1; i >= 0; i--) if (q >= BAND_Q[i]) return i;
		return -1;
	}
	function sizeClassOf(row, size) {
		if (size < row.ladder[1]) return SIZE_CLASSES[0];
		if (size < row.ladder[2]) return SIZE_CLASSES[1];
		if (size < row.ladder[3]) return SIZE_CLASSES[2];
		return SIZE_CLASSES[3];
	}
	function depthStep(span) {
		return span >= 500 ? DEPTH_STEP : 10;
	}
	function bandDepth(row, hash) {
		var span = row.emplace[1] - row.emplace[0], step = depthStep(span);
		return row.emplace[0] + (hash % (Math.floor(span / step) + 1)) * step;
	}
	// Broken stick in 1/1024ths: shares are integers that sum exactly, so the volume ledger of
	// §8.4 closes without a floating residue.
	function shareOf(seed, k, key, count, out) {
		var weights = 0, i;
		for (i = 0; i < count; i++) {
			out[i] = (count - i) + 0.5 + draw(seed, k, key, SALT_SHARE + i);
			weights += out[i];
		}
		var used = 0;
		for (i = 0; i < count; i++) {
			out[i] = Math.max(1, Math.round(out[i] / weights * SHARE_UNITS));
			used += out[i];
		}
		out[0] += SHARE_UNITS - used;
		return out;
	}
	function containedOf(row, grade, oreTonnes, out) {
		if (!row.grades.length) { out[row.bulk] = sig3(oreTonnes); return out; }
		for (var i = 0; i < row.grades.length; i++) {
			var metal = row.grades[i][0], unit = row.grades[i][1], value = grade[metal];
			var factor = unit === '%' ? 0.01 : unit === 'g/t' ? 1e-6 : 1;
			out[metal] = sig3(oreTonnes * value * factor);
		}
		return out;
	}
	function screenGrade(row, grade, bodies) {
		var screen = row.screen;
		if (screen.type === 'seam') {
			var thickest = 0;
			for (var i = 0; i < bodies.length; i++) if (bodies[i].thicknessM > thickest) thickest = bodies[i].thicknessM;
			return thickest >= screen.cutOff;
		}
		if (screen.type === 'sum') {
			var total = 0;
			for (var w = 0; w < screen.weights.length; w++) total += screen.weights[w] * grade[row.grades[w][0]];
			return total >= screen.cutOff;
		}
		return grade[row.grades[0][0]] >= screen.cutOff;
	}
	// 3D oriented ellipsoid basis and vertical ray-solid intersection (recovered from the
	// 0.6.1 continuous-ellipsoid branch). Strike is clockwise from north; dip is down from
	// horizontal to the right of strike, in local East-North-Up coordinates.
	function axisUnits(strikeDeg, dipDeg, out) {
		var target = out || [0, 0, 0, 0, 0, 0, 0, 0, 0];
		var s = (strikeDeg || 0) * DEG, d = (dipDeg || 0) * DEG;
		var sinS = Math.sin(s), cosS = Math.cos(s), sinD = Math.sin(d), cosD = Math.cos(d);
		target[0] = sinS; target[1] = cosS; target[2] = 0;
		target[3] = cosS * cosD; target[4] = -sinS * cosD; target[5] = -sinD;
		target[6] = cosS * sinD; target[7] = -sinS * sinD; target[8] = cosD;
		return target;
	}
	function verticalHalfExtent(axes, u) {
		var units = u || _units;
		return Math.hypot(axes[0] * units[2], axes[1] * units[5], axes[2] * units[8]);
	}
	function verticalIntersection(body, east, north, out) {
		var target = out || [0, 0];
		if (!body) return false;
		var dx = (east || 0) - (body.eastM || 0), dy = (north || 0) - (body.northM || 0);
		var axes = body.axesM;
		if (!axes || axes.length < 3) {
			if (dx !== 0 || dy !== 0) return false;
			target[0] = body.top || 0; target[1] = body.bottom || 0;
			return target[1] > target[0];
		}
		var u = axisUnits(body.strikeDeg, body.dipDeg, _units);
		var topM = body.top !== undefined ? body.top : body.burialTopM || 0;
		var h0 = (dx * u[0] + dy * u[1]) / axes[0];
		var h1 = (dx * u[3] + dy * u[4]) / axes[1], up1 = u[5] / axes[1];
		var h2 = (dx * u[6] + dy * u[7]) / axes[2], up2 = u[8] / axes[2];
		var qa = up1 * up1 + up2 * up2;
		var qb = 2 * (h1 * up1 + h2 * up2);
		var qc = h0 * h0 + h1 * h1 + h2 * h2 - 1;
		var disc = qb * qb - 4 * qa * qc;
		if (disc <= 0 || !(qa > 0)) return false;
		var root = Math.sqrt(disc);
		if (body.bottom === undefined) {
			var center = topM + verticalHalfExtent(axes, u);
			var z0 = (-qb - root) / (2 * qa), z1 = (-qb + root) / (2 * qa);
			target[0] = center - Math.max(z0, z1);
			target[1] = center - Math.min(z0, z1);
			return target[1] > target[0];
		}
		var span = body.bottom - topM;
		if (!(span > 0)) return false;
		var halfZ = span * 0.5, mid = topM + halfZ;
		var chordHalf = halfZ * Math.sqrt(Math.max(0, Math.min(1, disc / (4 * qa))));
		var vHalf = verticalHalfExtent(axes, u);
		var shift = vHalf > 0 ? (qb / (2 * qa)) * (halfZ / vHalf) : 0;
		var maxShift = Math.max(0, halfZ - chordHalf);
		if (shift > maxShift) shift = maxShift;
		else if (shift < -maxShift) shift = -maxShift;
		target[0] = mid + shift - chordHalf;
		target[1] = mid + shift + chordHalf;
		return target[1] > target[0];
	}

	function buildRecord(s, k, cell, value) {
		var owner = s.owner[cell], key = anchorKey(s, cell);
		if (!key) return null;
		var direction = currentDirection(s, cell, owner);
		var lat = Math.asin(Math.max(-1, Math.min(1, direction[1]))), lon = Math.atan2(direction[2], direction[0]);
		var row = pickRow(s, k, cell, owner, key, lat);
		if (!row) return null;
		var q = Math.round(value * POTENTIAL_BUCKETS), band = bandOf(q);
		if (band < 0) return null;

		var w = draw(s.seed, k, key, SALT_SIZE);
		var size = snap125(logLerp(row.ladder[band], row.ladder[band + 1], w), row.ladder[0], row.ladder[4]);
		var grade = {}, gradeUnit = {}, gi;
		for (gi = 0; gi < row.grades.length; gi++) {
			var metal = row.grades[gi];
			// The 0.25·(1 − w) term reproduces the published negative grade-tonnage correlation
			// (r ≈ −0.35…−0.49) without carrying a distribution object.
			var u = 0.75 * draw(s.seed, k, key, SALT_GRADE + gi) + 0.25 * (1 - w);
			grade[metal[0]] = sig2(logLerp(metal[2], metal[3], u));
			gradeUnit[metal[0]] = metal[1];
		}
		// A `t`-unit ladder counts contained metal, so the ore tonnage it implies is what the
		// geometry has to carry; a `Mt` ladder is already the ore tonnage.
		var oreMt = size;
		if (row.unit !== 'Mt') oreMt = size / 1e6 / (grade[row.grades[0][0]] * 0.01);

		var spread = 1 + 7 * q / POTENTIAL_BUCKETS;   // a strong anomaly is a bigger cluster
		var drawn = 1 + Math.floor(draw(s.seed, k, key, SALT_BODIES) * spread);
		var count = Math.max(row.bodies[0], Math.min(row.bodies[1], drawn));
		var shares = shareOf(s.seed, k, key, count, []);
		var bodies = [], offsets = [], stack = 0, step = depthStep(row.emplace[1] - row.emplace[0]), b;
		var dipBand = row.dip || [10, 45];
		for (b = 0; b < count; b++) {
			var k3 = +logLerp(row.aspect[0], row.aspect[1], draw(s.seed, k, key, SALT_ASPECT + b)).toPrecision(3);
			var volume = shares[b] / SHARE_UNITS * oreMt * 1e6 / row.rho;
			var area = Math.pow(volume / k3, 2 / 3);
			var thickness = Math.max(1, Math.round(k3 * Math.sqrt(area)));
			var strikeDeg = (salted(s.seed, k, key, SALT_STRIKE + b) % 72) * 5;
			var dipDeg = Math.round(dipBand[0] + (dipBand[1] - dipBand[0]) * draw(s.seed, k, key, SALT_DIP + b));
			var elong = 1.2 + 1.2 * draw(s.seed, k, key, SALT_ELONG + b);
			var rEq = Math.sqrt(area / Math.PI);
			var aAxis = Math.max(2, Math.round(rEq * Math.sqrt(elong)));
			var bAxis = Math.max(2, Math.round(rEq / Math.sqrt(elong)));
			var cAxis = Math.max(1, Math.round(thickness * 0.5));
			var eastM = 0, northM = 0;
			if (b > 0) {
				var ang = 2 * Math.PI * draw(s.seed, k, key, SALT_OFFSET + b * 2);
				var frac = 0.15 + 0.35 * draw(s.seed, k, key, SALT_OFFSET + b * 2 + 1);
				var sinS = Math.sin(strikeDeg * DEG), cosS = Math.cos(strikeDeg * DEG);
				var sinD = Math.sin(dipDeg * DEG), cosD = Math.cos(dipDeg * DEG);
				var rAcross = Math.hypot(bAxis * cosD, cAxis * sinD);
				var along = frac * aAxis * Math.cos(ang), across = frac * rAcross * Math.sin(ang);
				eastM = Math.round(along * sinS + across * cosS);
				northM = Math.round(along * cosS - across * sinS);
			}
			var gap = b ? (salted(s.seed, k, key, SALT_GAP + b) % 5) * step : 0;
			offsets.push(stack + gap);
			bodies.push({
				top: 0, bottom: 0, footprintKm2: sig3(area / 1e6), thicknessM: thickness,
				share: shares[b] / SHARE_UNITS, aspect: k3,
				strikeDeg: strikeDeg, dipDeg: dipDeg, axesM: [aAxis, bAxis, cAxis],
				eastM: eastM, northM: northM
			});
			stack += gap + thickness;
		}
		// Cover is what lies above the shallowest body, and that depends on where the class
		// sits. A basement-hosted body (porphyry, vein, massive sulfide, BIF) is buried by the
		// whole sediment pile; a sediment-hosted one (placer, coal, potash, roll front,
		// Carlin-style Au) is *inside* that pile, so adding the pile on top of it would bury
		// every one of them below its own mining depth.
		var sediment = Math.min(COVER_CAP, Math.max(0, Math.round(s.hSed[owner] / DEPTH_STEP) * DEPTH_STEP));
		var buried = row.hosted === 'sediment' ? 0 : sediment;
		var crust = s.hSed[owner] + s.hFel[owner] + s.hMaf[owner];
		// A cluster is emplaced inside the crust it belongs to: the stack is shifted up rather
		// than allowed to hang below the Moho, and never above its own burial depth.
		var emplaced = buried + bandDepth(row, salted(s.seed, k, key, SALT_EMPLACE));
		var top = Math.max(buried, Math.min(emplaced, crust - stack));
		var cover = row.hosted === 'sediment' ? Math.min(top, sediment) : sediment;
		for (b = 0; b < count; b++) {
			bodies[b].top = top + offsets[b];
			bodies[b].bottom = bodies[b].top + bodies[b].thicknessM;
		}
		var bottom = bodies[count - 1].bottom;
		var contained = containedOf(row, grade, oreMt * 1e6, {});
		var principal = row.grades.length ? contained[row.grades[0][0]] : contained[row.bulk];
		var gradeOk = screenGrade(row, grade, bodies);
		var sizeOk = size >= row.minSize && (!row.minContained || principal >= row.minContained);
		var depthOk = top <= row.maxTop;
		var surfaceZ = s.z[cell], wet = surfaceZ < DepositParams.sea;

		return {
			id: hex32(hash32(s.seed, k, key)), kind: KINDS[k], kindIndex: k, variant: row.variant,
			commodity: row.commodity, cell: cell, owner: owner, plate: s.plate[owner],
			anchorKey: key, direction: direction, potential: value,
			host: DepositExtract.host(s, cell), ageMyr: Math.round(s.age[owner]),
			epochMyr: Math.round(s.t * 10) / 10,
			lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
			cover: cover, surfaceZ: Number.isFinite(surfaceZ) ? Math.round(surfaceZ / 10) * 10 : 0,
			water: wet ? Math.round((DepositParams.sea - surfaceZ) / 10) * 10 : 0,
			top: top, bottom: bottom, bodies: bodies,
			unit: row.unit, size: size, sizeMt: row.unit === 'Mt' ? size : sig3(oreMt),
			sizeClass: sizeClassOf(row, size), grade: grade, gradeUnit: gradeUnit, contained: contained,
			viable: gradeOk && sizeOk && depthOk,
			reason: !gradeOk ? 'grade' : !sizeOk ? 'size' : !depthOk ? 'depth' : CONFIDENCE_NONE
		};
	}
	// The local primitive: one cell, one kind, no world builder behind it.
	function recordAt(s, kind, cell) {
		var k = kindIndex(kind);
		if (k < 0) return null;
		var value = blurAt(s, k, cell);
		if (value < DepositParams.depositMin || !isPeak(s, k, cell, value)) return null;
		return buildRecord(s, k, cell, value);
	}

	// --- the explicit O(V) catalogue -------------------------------------------------------
	// One blur store per level, allocated on the first explicit build and reused afterwards
	// (the same policy the old extract scratch had): 7 x V x 8 B, 0.6 MB at L5 and 9.2 MB at L7.
	var scratch = null, cache = null;
	function fieldScratch(V) {
		if (!scratch || scratch.length !== KINDS.length * V) scratch = new Float64Array(KINDS.length * V);
		return scratch;
	}
	function blurKind(s, k, out, offset) {
		var g = s.grid, field = s[FIELDS[k]], scale = FIELD_SCALE[k];
		for (var c = 0; c < g.V; c++) {
			var owner = s.owner[c];
			if (owner < 0 || owner >= s.n || !s.alive[owner]) { out[offset + c] = 0; continue; }
			var sum = field[owner], count = 1;
			for (var n = 0; n < g.ringN[c]; n++) {
				var adjacent = s.owner[g.ring[c * 6 + n]];
				if (adjacent < 0 || adjacent >= s.n || !s.alive[adjacent]) continue;
				sum += field[adjacent]; count++;
			}
			out[offset + c] = potential(sum / count * scale);
		}
	}
	// Iron reads the parent fields the same pass already blurred, so the whole build stays one
	// blur per potential instead of four.
	function blurIron(s, out, V) {
		var offset = IRON * V;
		for (var c = 0; c < V; c++) {
			var owner = s.owner[c];
			if (owner < 0 || owner >= s.n || !s.alive[owner]) { out[offset + c] = 0; continue; }
			var best = 0;
			if (ironExposed(s, owner, c)) {
				var mafic = out[K_MAFIC * V + c], vms = out[K_VMS * V + c];
				best = mafic > vms ? mafic : vms;
			}
			var basin = ironBasin(s, owner) ? out[K_BASIN * V + c] : 0;
			out[offset + c] = basin > best ? basin : best;
		}
	}
	function rankCompare(a, b) {
		return a.weight !== b.weight ? b.weight - a.weight : a.index - b.index;
	}
	function principalOf(record) {
		for (var metal in record.contained) return record.contained[metal];
		return 0;
	}
	function buildCatalogue(s) {
		var g = s.grid, store = fieldScratch(g.V), records = [], seenIds = Object.create(null), k, c;
		for (k = 0; k < IRON; k++) blurKind(s, k, store, k * g.V);
		blurIron(s, store, g.V);
		for (k = 0; k < KINDS.length; k++) {
			var field = store.subarray(k * g.V, (k + 1) * g.V);
			var peaks = DepositExtract.peaks(s, field, DepositParams.depositMin, []);
			for (var at = 0; at < peaks.length; at++) {
				var record = buildRecord(s, k, peaks[at].cell, peaks[at].value);
				if (!record) continue;
				var salt = 0;
				while (seenIds[record.id]) {
					salt++;
					record.id = hex32(salted(s.seed, k, record.anchorKey, SALT_COLLISION + salt));
				}
				seenIds[record.id] = 1;
				records.push(record);
			}
		}
		records.sort(function (a, b) {
			return a.cell !== b.cell ? a.cell - b.cell : a.kindIndex - b.kindIndex;
		});
		var cellStart = new Int32Array(g.V + 1), i;
		for (i = 0; i < records.length; i++) cellStart[records[i].cell + 1]++;
		for (c = 0; c < g.V; c++) cellStart[c + 1] += cellStart[c];
		var byKind = [], viableCount = 0, containedTotals = {};
		for (k = 0; k < KINDS.length; k++) byKind.push([]);
		for (i = 0; i < records.length; i++) {
			var r = records[i];
			if (r.viable) viableCount++;
			byKind[r.kindIndex].push({ index: i, weight: principalOf(r) });
			for (var metal in r.contained) containedTotals[metal] = (containedTotals[metal] || 0) + r.contained[metal];
		}
		for (k = 0; k < KINDS.length; k++) {
			byKind[k].sort(rankCompare);
			byKind[k] = byKind[k].slice(0, 64).map(function (entry) { return entry.index; });
		}
		return {
			epochMyr: Math.round(s.t * 10) / 10, time: s.t, threshold: DepositParams.depositMin, classes: CLASSES,
			records: records, cellStart: cellStart, byKind: byKind,
			viableCount: viableCount, containedTotals: containedTotals, signature: s.frame, level: s.grid.level
		};
	}
	// The explicit path. Never called by a click: only a regional view, a campaign or an export
	// may pay O(V), and the result is cached until the frame moves.
	function build(s, opts) {
		var reconEpoch = s.reconEpoch || 0;
		if (cache && cache.state === s && cache.frame === s.frame && cache.t === s.t
			&& cache.V === s.grid.V && cache.sea === DepositParams.sea
			&& cache.reconEpoch === reconEpoch && cache.threshold === DepositParams.depositMin)
			return opts && opts.min === 'viable' ? filterViable(cache.catalogue) : cache.catalogue;
		var catalogue = buildCatalogue(s);
		cache = {
			state: s, frame: s.frame, t: s.t, V: s.grid.V, sea: DepositParams.sea,
			reconEpoch: reconEpoch, threshold: DepositParams.depositMin, catalogue: catalogue
		};
		if (opts && opts.min === 'viable') return filterViable(catalogue);
		return catalogue;
	}
	function filterViable(catalogue) {
		var out = [];
		for (var i = 0; i < catalogue.records.length; i++) if (catalogue.records[i].viable) out.push(catalogue.records[i]);
		return out;
	}
	function viable(s) {
		return filterViable(build(s));
	}
	function stale(s, catalogue) {
		var snapshotTime = catalogue.time === undefined ? catalogue.epochMyr : catalogue.time;
		return Math.abs(s.t - snapshotTime) > 5;
	}
	function atCell(s, cell) {
		var catalogue = build(s), out = [];
		for (var i = catalogue.cellStart[cell]; i < catalogue.cellStart[cell + 1]; i++) out.push(catalogue.records[i]);
		return out;
	}
	function allowed(record, opts) {
		if (!opts) return true;
		if (opts.kind && opts.kind !== 'all' && opts.kind !== record.kind) return false;
		return !opts.ledger || !!opts.ledger.byId[record.id];
	}
	function addTotals(target, source) {
		for (var metal in source) target[metal] = (target[metal] || 0) + source[metal];
	}
	function topInsert(top, record) {
		var weight = principalOf(record), at = 0;
		while (at < top.length) {
			var current = top[at], currentWeight = principalOf(current);
			if (weight > currentWeight || (weight === currentWeight && record.id < current.id)) break;
			at++;
		}
		top.splice(at, 0, record);
		if (top.length > 10) top.pop();
	}
	function summary(s, opts) {
		opts = opts || {};
		var catalogue = opts.catalogue || build(s), perKind = [], globalTop = [], all = {}, viable = {},
			recordCount = 0, viableCount = 0, k;
		// The monetary screen is counted alongside the geological one, not folded into it:
		// `viable` is the class table's grade/size/depth verdict, `money` is the price
		// scenario's, and the two disagree often enough that reporting only one would hide
		// the other. Measured in experiments/economics-calibration.js.
		var money = { positive: 0, net: 0, geoOnly: 0, moneyOnly: 0 };
		for (k = 0; k < KINDS.length; k++) perKind.push({ kind: KINDS[k], records: 0, viable: 0, top: [] });
		for (var i = 0; i < catalogue.records.length; i++) {
			var r = catalogue.records[i];
			if (!allowed(r, opts)) continue;
			recordCount++;
			perKind[r.kindIndex].records++;
			addTotals(all, r.contained);
			var screen = DepositMoney.screen(r);
			if (screen.positive) { money.positive++; money.net += screen.net; }
			if (r.viable && !screen.positive) money.geoOnly++;
			if (!r.viable && screen.positive) money.moneyOnly++;
			if (!r.viable) continue;
			viableCount++;
			perKind[r.kindIndex].viable++;
			addTotals(viable, r.contained);
			topInsert(perKind[r.kindIndex].top, r);
			topInsert(globalTop, r);
		}
		money.scenario = DepositMoney.describe();
		return {
			epochMyr: catalogue.epochMyr,
			records: recordCount,
			viable: viableCount,
			byKind: perKind,
			top: globalTop,
			contained: viable,
			containedAll: all,
			money: money,
			surveyedCells: opts.ledger ? opts.ledger.cellsN : 0,
			kind: opts.kind || 'all',
			stale: stale(s, catalogue)
		};
	}
	function publicRecord(r) {
		return {
			id: r.id, kind: r.kind, variant: r.variant, commodity: r.commodity, cell: r.cell,
			plate: r.plate, anchorKey: r.anchorKey, lat: r.lat, lon: r.lon,
			potential: Math.round(r.potential * 10000) / 10000,
			host: r.host, ageMyr: r.ageMyr, epochMyr: r.epochMyr, cover: r.cover, surfaceZ: r.surfaceZ,
			water: r.water, top: r.top, bottom: r.bottom, bodies: r.bodies, unit: r.unit, size: r.size,
			sizeClass: r.sizeClass, grade: r.grade, gradeUnit: r.gradeUnit, contained: r.contained,
			viable: r.viable, reason: r.reason
		};
	}
	function json(s, opts) {
		opts = opts || {};
		var catalogue = opts.catalogue || build(s), classes = [], i;
		for (i = 0; i < CLASSES.length; i++) {
			classes.push({ kind: CLASSES[i].kind, variant: CLASSES[i].variant, unit: CLASSES[i].unit,
				cutOff: CLASSES[i].screen.label, minSize: CLASSES[i].minSize, maxTop: CLASSES[i].maxTop,
				source: CLASSES[i].source });
		}
		var deposits = [], contained = {}, viableContained = {}, viableCount = 0;
		for (i = 0; i < catalogue.records.length; i++) {
			var record = catalogue.records[i];
			if (!allowed(record, opts) || (opts.viableOnly && !record.viable)) continue;
			deposits.push(publicRecord(record));
			addTotals(contained, record.contained);
			if (record.viable) {
				viableCount++;
				addTotals(viableContained, record.contained);
			}
		}
		return JSON.stringify({
			format: 'pgt-deposits', version: 2, level: s.grid.level, seed: s.seed,
			t: +s.t.toFixed(3), epoch: catalogue.epochMyr,
			thresholds: { traceMin: DepositParams.traceMin, depositMin: DepositParams.depositMin },
			classes: classes,
			totals: { records: deposits.length, viable: viableCount,
				contained: contained, viableContained: viableContained },
			deposits: deposits
		}, null, 1);
	}
	function release() {
		scratch = null; cache = null;
	}

	return {
		KINDS: KINDS,
		FIELDS: FIELDS,
		CLASSES: CLASSES,
		SIZE_CLASSES: SIZE_CLASSES,
		FIELD_SCALE: FIELD_SCALE,
		IRON: IRON,
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
		axisUnits: axisUnits,
		verticalHalfExtent: verticalHalfExtent,
		verticalIntersection: verticalIntersection,
		rowFor: function (s, kind, cell) {
			var k = kindIndex(kind), owner = s.owner[cell], key = anchorKey(s, cell);
			if (k < 0 || !key) return null;
			var direction = currentDirection(s, cell, owner);
			return pickRow(s, k, cell, owner, key, Math.asin(Math.max(-1, Math.min(1, direction[1]))));
		},
		at: recordAt,
		build: build,
		atCell: atCell,
		viable: viable,
		stale: stale,
		summary: summary,
		json: json,
		release: release
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Deposits;

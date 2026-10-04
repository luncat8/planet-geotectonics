// Calibration for the 0.5.6 continuous-height lookup (0.5.0-plan-3d-render.md §14.3 slice 1).
// Not loaded by the page. Reports what the plan asks the slice to report - lookup bytes, build
// time, maximum quantization error - plus the numbers the next slices need before a device
// shader and a live toggle are wired: fallbacks, clamps, shared-edge agreement, plateau share
// and the CPU reference's own sampling cost.
// usage: node experiments/heightfield-calibration.js [levels] [seed]
//   levels - comma list, default 5,6,7
//   seed   - default 7. The geodesic grid's geometry is seed-independent (its own noise
//            fields use the seed; the cell positions do not), so the seed varies the synthetic
//            relief this script samples, not the triangulation: the reported fallbacks, clamps
//            and plateau shares are then measured against a different field, not a different
//            mesh. Repeat runs with different seeds are a data sweep, not a geometry sweep.
var Grid = require('../js/geodesics.js');
var HeightField = require('../js/heightfield.js');

var levels = String(process.argv[2] || '5,6,7').split(',').map(Number);
var seed = +(process.argv[3] || 7);
var phase = (seed % 23) * 0.517;
var RESOLUTIONS = [[1024, 512], [2048, 1024]];

function relief(x, y, z) {
	return 4200 * Math.sin(2.3 * x + 0.7 + phase) * Math.cos(1.7 * y - 0.31 * phase)
		+ 2600 * z - 900 * Math.sin(5.1 * z + phase);
}
function field(grid) {
	var out = new Float64Array(grid.V);
	for (var c = 0; c < grid.V; c++) out[c] = relief(grid.pos[c * 3], grid.pos[c * 3 + 1], grid.pos[c * 3 + 2]);
	return out;
}
function rangeOf(values) {
	var lo = Infinity, hi = -Infinity;
	for (var i = 0; i < values.length; i++) { if (values[i] < lo) lo = values[i]; if (values[i] > hi) hi = values[i]; }
	return hi - lo || 1;
}
// Plateau share: adjacent texel pairs with exactly equal heights, for the nearest-cell gather.
// The gather parks whole patches on one value; a continuous field only does that where the
// field itself is flat, so this is the number the mode exists to move.
function nearestPlateauShare(grid, heights, width, height) {
	var dir = new Float64Array(3), equal = 0, total = 0, previous = NaN, x, y;
	for (y = 0; y < height; y++) {
		previous = NaN;
		for (x = 0; x < width; x++) {
			HeightField.direction(width, height, x, y, dir);
			var lon = Math.atan2(dir[2], dir[0]), lat = Math.asin(Math.max(-1, Math.min(1, dir[1])));
			var sx = Math.min(grid.lookupW - 1, Math.max(0, Math.floor((lon / (2 * Math.PI) + 0.5) * grid.lookupW)));
			var sy = Math.min(grid.lookupH - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * grid.lookupH)));
			var value = heights[grid.lookup[sy * grid.lookupW + sx]];
			if (x > 0 && value === previous) equal++;
			previous = value;
			total++;
		}
	}
	return equal / (total - height);
}
function edgeAgreement(grid, heights) {
	var dir = new Float64Array(3), wa = new Float64Array(3), wb = new Float64Array(3), worst = 0, edges = 0;
	for (var c = 0; c < grid.V; c++) {
		var m = grid.ringN[c];
		for (var k = 0; k < m; k++) {
			var b = grid.ring[c * 6 + k];
			if (b < c) continue;
			var left = grid.ring[c * 6 + (k + 1) % m], right = grid.ring[c * 6 + (k - 1 + m) % m];
			dir[0] = grid.pos[c * 3] + grid.pos[b * 3];
			dir[1] = grid.pos[c * 3 + 1] + grid.pos[b * 3 + 1];
			dir[2] = grid.pos[c * 3 + 2] + grid.pos[b * 3 + 2];
			var len = Math.hypot(dir[0], dir[1], dir[2]);
			dir[0] /= len; dir[1] /= len; dir[2] /= len;
			var sa = HeightField.faceCoords(grid.pos, c, b, left, dir, wa);
			var sb = HeightField.faceCoords(grid.pos, b, c, right, dir, wb);
			if (sa === 0 || sb === 0) continue;
			var za = (wa[0] * heights[c] + wa[1] * heights[b] + wa[2] * heights[left]) / sa;
			var zb = (wb[0] * heights[b] + wb[1] * heights[c] + wb[2] * heights[right]) / sb;
			worst = Math.max(worst, Math.abs(za - zb));
			edges++;
		}
	}
	return { worst: worst, edges: edges };
}

console.log('continuous-height lookup calibration · seed ' + seed + ' · node ' + process.version);
for (var li = 0; li < levels.length; li++) {
	var level = levels[li];
	var t0 = Date.now(), grid = new Grid(level, seed).build(), gridMs = Date.now() - t0;
	var heights = field(grid), span = rangeOf(heights);
	var edge = edgeAgreement(grid, heights);
	console.log('L' + level + ' · ' + grid.V + ' cells · grid build ' + gridMs + ' ms · field range '
		+ span.toFixed(0) + ' m · ' + edge.edges + ' edges agree to ' + edge.worst.toExponential(2) + ' m');
	for (var r = 0; r < RESOLUTIONS.length; r++) {
		var width = RESOLUTIONS[r][0], height = RESOLUTIONS[r][1];
		var lookup = HeightField.build(grid, { width: width, height: height, exact: true });
		var quant = 0, t;
		for (t = 0; t < lookup.texels; t++) {
			quant = Math.max(quant, Math.abs(HeightField.sample(lookup, heights, t)
				- HeightField.sampleExact(lookup, heights, t)));
		}
		var gather0 = Date.now(), out = HeightField.gather(lookup, heights, new Float64Array(lookup.texels));
		var gatherMs = Date.now() - gather0;
		var nearestPlateau = nearestPlateauShare(grid, heights, width, height);
		var contEqual = 0;
		for (t = 1; t < lookup.texels; t++) if (out[t] === out[t - 1]) contEqual++;
		console.log('  ' + width + 'x' + height + ' · ' + (lookup.bytes / 1048576).toFixed(1) + ' MiB · build '
			+ lookup.buildMs + ' ms (' + (lookup.buildMs * 1000 / lookup.texels).toFixed(2) + ' µs/texel)'
			+ ' · max weight error ' + lookup.maxWeightError.toExponential(2)
			+ ' · quantization ' + quant.toExponential(2) + ' m (' + (quant / span * HeightField.QUANT).toFixed(3)
			+ '/65535 of range) · fallbacks ' + lookup.fallbacks + ' · clamps ' + lookup.clamps
			+ ' · CPU gather ' + gatherMs + ' ms · plateau share ' + (nearestPlateau * 100).toFixed(1)
			+ '% nearest vs ' + (contEqual / (lookup.texels - 1) * 100).toFixed(2) + '% continuous');
	}
}
console.log('record: 3 x u32 cell indices + two u16 weights in the fourth word = 16 bytes/texel;'
	+ ' L7 cell indices exceed 16 bits, so the u32s are not padding');

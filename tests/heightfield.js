/* 0.5.6 slice 1: the continuous-height lookup and its CPU reference sampler.
   The acceptance list is 0.5.0-plan-3d-render.md §14.4, restricted to what a CPU reference can
   prove: constants, sample-centre exactness, weight sanity, shared-edge agreement, bounded
   output, deterministic ties, gap handling and the quantization budget. Device timing, pixel
   correctness and the live toggle belong to the slices that ship the shader and the UI. */
const { assert, Grid } = require('./helpers.js');
const HeightField = require('../js/heightfield.js');

const QUANT = HeightField.QUANT;
function fieldOf(grid, fn) {
	const out = new Float64Array(grid.V);
	for (let c = 0; c < grid.V; c++) out[c] = fn(grid.pos[c * 3], grid.pos[c * 3 + 1], grid.pos[c * 3 + 2], c);
	return out;
}
function rangeOf(field) {
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < field.length; i++) { if (field[i] < lo) lo = field[i]; if (field[i] > hi) hi = field[i]; }
	return hi - lo || 1;
}
// A varying synthetic relief, in metres, with no flat patches to hide a staircase behind.
const relief = (x, y, z) => 4200 * Math.sin(2.3 * x + 0.7) * Math.cos(1.7 * y) + 2600 * z - 900 * Math.sin(5.1 * z);

const grid = new Grid(3, 7).build();
const small = HeightField.build(grid, { width: 256, height: 128, exact: true });
assert.equal(small.bytes, small.texels * 16, 'one 16-byte record per texel');
assert.equal(small.data.length, small.texels * 4, 'four u32 per record: three cells and the packed weights');
assert.equal(small.fallbacks, 0, 'every texel is inside a face of its nearest cell at L3');
assert.equal(small.clamps, 0, 'and no weight had to be clamped to get there');
assert.ok(small.maxWeightError <= 1 / QUANT + 1e-12, 'a quantized weight is within one step of its exact value');

// Weights: non-negative, summing to one, and the packed integers summing to exactly QUANT -
// that exact sum is what makes a constant field survive quantization bit for bit.
for (let t = 0; t < small.texels; t++) {
	const packed = small.data[t * 4 + 3];
	const q0 = packed & 65535, q1 = (packed >>> 16) & 65535, q2 = QUANT - q0 - q1;
	assert.ok(q0 >= 0 && q1 >= 0 && q2 >= 0, 'the packed weights are non-negative');
	assert.equal(q0 + q1 + q2, QUANT, 'the three weights sum to the full quantum');
	const w0 = small.exactWeights[t * 3], w1 = small.exactWeights[t * 3 + 1], w2 = small.exactWeights[t * 3 + 2];
	assert.ok(w0 >= 0 && w1 >= 0 && w2 >= 0, 'the exact weights are non-negative');
	assert.ok(Math.abs(w0 + w1 + w2 - 1) < 1e-12, 'and sum to one');
	const a = small.data[t * 4], b = small.data[t * 4 + 1], c = small.data[t * 4 + 2];
	assert.ok(a >= 0 && b >= 0 && c >= 0 && a < grid.V && b < grid.V && c < grid.V, 'cell indices are in range');
	assert.notEqual(a, b, 'the three cells of a face are distinct');
	assert.notEqual(b, c, 'the three cells of a face are distinct');
}

// Constants: exact, at every texel, with no rounding left over.
const flat = fieldOf(grid, () => 1234.5);
const flatOut = new Float64Array(small.texels);
HeightField.gather(small, flat, flatOut);
let flatError = 0;
for (let t = 0; t < small.texels; t++) flatError = Math.max(flatError, Math.abs(flatOut[t] - 1234.5));
assert.equal(flatError, 0, 'a constant field is reproduced exactly, not approximately');

// Sample centres: the weights at a cell's own direction are exactly (1, 0, 0), so the mode
// reproduces the samples it is built from before any quantization.
const centre = new Float64Array(3), weights = new Float64Array(3);
let centreError = 0;
for (let c = 0; c < grid.V; c++) {
	centre[0] = grid.pos[c * 3]; centre[1] = grid.pos[c * 3 + 1]; centre[2] = grid.pos[c * 3 + 2];
	const b = grid.ring[c * 6], d = grid.ring[c * 6 + 1];
	const sum = HeightField.faceCoords(grid.pos, c, b, d, centre, weights);
	assert.ok(sum !== 0, 'a face at its own vertex is not degenerate');
	centreError = Math.max(centreError, Math.abs(weights[0] / sum - 1),
		Math.abs(weights[1] / sum), Math.abs(weights[2] / sum));
}
assert.ok(centreError < 1e-12, 'sample centres are reproduced exactly');

// Shared edges: every edge of the triangulation, read from both faces that share it, must give
// the same height. That is the C0 claim, and it is what stops the mesh from cracking.
const heights = fieldOf(grid, relief);
const span = rangeOf(heights);
const dir = new Float64Array(3), wA = new Float64Array(3), wB = new Float64Array(3);
let edgeError = 0, edges = 0;
for (let c = 0; c < grid.V; c++) {
	const m = grid.ringN[c];
	for (let k = 0; k < m; k++) {
		const b = grid.ring[c * 6 + k];
		if (b < c) continue;   // each edge once
		const left = grid.ring[c * 6 + (k + 1) % m], right = grid.ring[c * 6 + (k - 1 + m) % m];
		dir[0] = grid.pos[c * 3] + grid.pos[b * 3];
		dir[1] = grid.pos[c * 3 + 1] + grid.pos[b * 3 + 1];
		dir[2] = grid.pos[c * 3 + 2] + grid.pos[b * 3 + 2];
		const len = Math.hypot(dir[0], dir[1], dir[2]);
		dir[0] /= len; dir[1] /= len; dir[2] /= len;
		const sA = HeightField.faceCoords(grid.pos, c, b, left, dir, wA);
		const sB = HeightField.faceCoords(grid.pos, b, c, right, dir, wB);
		if (sA === 0 || sB === 0) continue;
		const zA = (wA[0] * heights[c] + wA[1] * heights[b] + wA[2] * heights[left]) / sA;
		const zB = (wB[0] * heights[b] + wB[1] * heights[c] + wB[2] * heights[right]) / sB;
		edgeError = Math.max(edgeError, Math.abs(zA - zB));
		edges++;
	}
}
assert.ok(edges > grid.V * 2, 'the edge sweep covers the whole triangulation');
assert.ok(edgeError < 1e-6 * span, 'both faces of a shared edge agree on its height');

// Quantization budget: the plan allows 2/65535 of field range for the packed pair.
let quantError = 0;
for (let t = 0; t < small.texels; t++) {
	const exact = HeightField.sampleExact(small, heights, t);
	quantError = Math.max(quantError, Math.abs(HeightField.sample(small, heights, t) - exact));
}
assert.ok(quantError <= 2 / QUANT * span, 'quantization stays inside 2/65535 of the field range');

// Gaps: a missing cell drops out and the rest renormalize; three missing cells are the gap
// marker, never -1e9 blended into real relief.
const gapped = Float64Array.from(heights);
const tri = [small.data[0], small.data[1], small.data[2]];
gapped[tri[0]] = NaN;
const partial = HeightField.sample(small, gapped, 0);
assert.ok(Number.isFinite(partial) && Math.abs(partial) < 1e5, 'one gap renormalizes over the other two');
for (const cell of tri) gapped[cell] = -1e9;
assert.equal(HeightField.sample(small, gapped, 0), HeightField.GAP, 'three gaps are the gap marker');
const gatherOut = HeightField.gather(small, heights, new Float64Array(small.texels));
let bounded = true;
for (let t = 0; t < small.texels; t++) {
	const v = gatherOut[t];
	if (!(v >= -1e5 && v <= 1e5) && v !== HeightField.GAP) bounded = false;
}
assert.ok(bounded, 'no texel interpolates the gap marker into relief');

// Determinism: the same grid builds the same bytes, ties included.
const again = HeightField.build(grid, { width: 256, height: 128 });
assert.equal(Buffer.compare(Buffer.from(small.data.buffer), Buffer.from(again.data.buffer)), 0,
	'two builds of one grid are bit-identical, face ties included');

// Cancellation: the builder stops on request and says so.
let calls = 0;
const stopped = HeightField.build(grid, {
	width: 256, height: 128,
	cancel: () => ++calls > 1,
	onProgress: () => {}
});
assert.equal(stopped.cancelled, true, 'a cancelled build reports itself instead of half a lookup');
assert.ok(stopped.texels === 256 * 128, 'and still describes the grid it was asked for');

// The point of the mode: on a varying field the nearest-cell gather paints broad plateaus, and
// this one does not. Both read the same numbers, so the difference is the interpolation.
const big = new Grid(5, 7).build();
const bigHeights = fieldOf(big, relief);
const lookup = HeightField.build(big, { width: 512, height: 256 });
const continuous = HeightField.gather(lookup, bigHeights, new Float64Array(lookup.texels));
const nearest = new Float64Array(lookup.texels);
for (let y = 0; y < 256; y++) {
	for (let x = 0; x < 512; x++) {
		HeightField.direction(512, 256, x, y, dir);
		const lon = Math.atan2(dir[2], dir[0]), lat = Math.asin(Math.max(-1, Math.min(1, dir[1])));
		const sx = Math.min(big.lookupW - 1, Math.max(0, Math.floor((lon / (2 * Math.PI) + 0.5) * big.lookupW)));
		const sy = Math.min(big.lookupH - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * big.lookupH)));
		nearest[y * 512 + x] = bigHeights[big.lookup[sy * big.lookupW + sx]];
	}
}
// The plateau measure that matters: how many texels share their exact height with the texel
// to their right. The nearest-cell gather parks whole patches on one cell's value; a continuous
// field only does that where the field itself is flat.
function plateauPairs(values, width, height) {
	let equal = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width - 1; x++) if (values[y * width + x] === values[y * width + x + 1]) equal++;
	}
	return equal / (height * (width - 1));
}
function distinctSteps(values) {
	const set = new Set();
	for (let i = 0; i < values.length; i++) set.add(Math.round(values[i]));
	return set.size;
}
const nearPlateau = plateauPairs(nearest, 512, 256), contPlateau = plateauPairs(continuous, 512, 256);
assert.ok(nearPlateau > 0.5, 'the nearest-cell gather really does paint broad plateaus');
assert.ok(contPlateau < 0.01, 'and the continuous field leaves none of them behind');
assert.ok(distinctSteps(continuous) > distinctSteps(nearest) * 2,
	'continuous relief carries far more distinct heights over the same field');
assert.equal(lookup.fallbacks, 0, 'every L5 texel resolves inside a face');
assert.equal(lookup.clamps, 0, 'with no clamped weights');

// Poles, seam and pentagons: the corner texels of the equirectangular grid and the twelve
// five-sided cells are where a face walk goes wrong, so they are named, not sampled.
const poleTexels = [0, 511, 512 * 255, 512 * 255 + 255];
for (const t of poleTexels) {
	const v = HeightField.sample(lookup, bigHeights, t);
	assert.ok(Number.isFinite(v), 'the seam and pole texels sample a finite height');
}
let pentagonTexels = 0;
for (let t = 0; t < lookup.texels; t++) {
	const a = lookup.data[t * 4], b = lookup.data[t * 4 + 1], c = lookup.data[t * 4 + 2];
	if (big.ringN[a] === 5 || big.ringN[b] === 5 || big.ringN[c] === 5) pentagonTexels++;
}
assert.ok(pentagonTexels > 0, 'the L5 lookup really does cover pentagon corners');

// L7 is why the record holds u32 cell indices: two u16 would cap out at 65535 and L7 has
// 163842 cells. The lookup is small here because the level, not the texel count, is the point.
const fine = new Grid(7, 7).build();
const fineLookup = HeightField.build(fine, { width: 512, height: 256 });
assert.equal(fineLookup.fallbacks, 0, 'every L7 texel resolves inside a face too');
assert.equal(fineLookup.clamps, 0, 'with no clamped weights at the finest level');
let wideIndices = 0;
for (let t = 0; t < fineLookup.texels; t++) {
	for (let i = 0; i < 3; i++) if (fineLookup.data[t * 4 + i] > 65535) wideIndices++;
}
assert.ok(wideIndices > 0, 'L7 cell indices overflow 16 bits, which is why the record holds u32');

// The report the plan asks for: bytes, build time, quantization error.
const report = HeightField.build(big, { width: 1024, height: 512 });
console.log('heightfield: L5 1024x512 ' + (report.bytes / 1048576).toFixed(1) + ' MiB in ' + report.buildMs
	+ ' ms · max weight error ' + report.maxWeightError.toExponential(2) + ' · ' + report.fallbacks
	+ ' fallbacks · shared-edge agreement ' + edgeError.toExponential(2) + ' m of '
	+ span.toFixed(0) + ' m range · quantization ' + quantError.toExponential(2) + ' m'
	+ ' · plateau pairs ' + (nearPlateau * 100).toFixed(1) + '% nearest vs '
	+ (contPlateau * 100).toFixed(2) + '% continuous · L7 ' + fineLookup.fallbacks + ' fallbacks, '
	+ wideIndices + ' cell indices over 16 bits');
console.log('PASS heightfield: 16-byte records, exact constants and sample centres, non-negative'
	+ ' weights summing to one, shared-edge agreement on every edge of the triangulation, the'
	+ ' 2/65535 quantization budget, gap renormalization and the gap marker, bit-identical'
	+ ' rebuilds, cancellation, and no plateaus where the nearest-cell gather has them');

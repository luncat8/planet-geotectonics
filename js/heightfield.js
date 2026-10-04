/* heightfield.js - continuous display relief from cell-centre samples (0.5.6).

   The 3D gather displaces every height texel by the height of its nearest raster cell, so one
   cell's value covers a whole patch of texels and the planet reads as a quilt of flat plates.
   Crust really does live on discrete Lagrangian columns, but the grid is a sampling frame, not
   a physical boundary, so a display mode may reconstruct continuous relief between the samples
   without inventing sub-grid facts: it is another view of the same numbers, and it touches
   neither crust, erosion, ownership and picking, nor the mass ledger.

   Candidate A of 0.5.0-plan-3d-render.md §14.2: the cell centres are the vertices of a
   triangulation (every icosphere face is three mutually adjacent cells), so a direction is
   located in one face and interpolated with barycentric weights there. That agrees on shared
   edges, reproduces constants and sample centres exactly, and is C0 before the texture
   discretizes it. It is not C1 - two faces meeting at an edge may slope differently.

   Pure setup-time math plus a CPU reference sampler: no device, no page. `build` is the only
   allocating call and runs once per grid level; `sample` and `gather` allocate nothing, so a
   device readback can be diffed against them texel by texel. The record layout is the one the
   gather shader will read: three u32 cell indices and two u16 weights packed into the fourth
   word (16 bytes per texel, 32 MiB at 2048 x 1024), because WGSL's unpack2x16unorm turns that
   word straight into the two weights and the third is their remainder. */
var HeightField = (function () {
	var TAU = Math.PI * 2, PI = Math.PI;
	var QUANT = 65535;
	// The gather writes GAP for a NaN cell (Render3D.packZ), so a height at or below half of it
	// is a gap in both engine paths. Real relief stays within tens of kilometres of zero.
	var GAP = -1e9, INVALID = GAP * 0.5;
	var RECORD_FLOATS = 4;
	// Scratch, allocated once: the builder walks millions of texels, the sampler allocates
	// nothing at all.
	var dir3 = new Float64Array(3), w3 = new Float64Array(3), s3 = new Float64Array(3);
	// Four distinct triples: the candidate under test, the best miss so far, the winner, and the
	// caller's output - the last is the one that ends up in the record.
	var candTri = new Int32Array(3), bestTri = new Int32Array(3), buildTri = new Int32Array(3);
	// The winning and best-miss coordinate sets carry their sum in the fourth slot.
	var winTri = new Int32Array(3), winS = new Float64Array(4), bestS = new Float64Array(4);

	// The gather's own texel convention: row 0 is south, no flip anywhere.
	function direction(width, height, x, y, out) {
		var lon = (x + 0.5) / width * TAU - PI, lat = (y + 0.5) / height * PI - PI / 2;
		var cl = Math.cos(lat);
		out[0] = cl * Math.cos(lon); out[1] = Math.sin(lat); out[2] = cl * Math.sin(lon);
		return out;
	}
	// The nearest-cell raster is the seed, read as the best of the four lookup texels around
	// this direction: at the pole corner the raster's own chained search can land a whole
	// cap away, and one extra texel read is cheaper than a long climb from a bad seed.
	function lookupSeed(grid, dir) {
		var lon = Math.atan2(dir[2], dir[0]), lat = Math.asin(Math.max(-1, Math.min(1, dir[1])));
		var lw = grid.lookupW, lh = grid.lookupH, pos = grid.pos;
		var sx = Math.floor((lon / TAU + 0.5) * lw), sy = Math.floor((lat / PI + 0.5) * lh);
		sx = sx < 0 ? 0 : sx >= lw - 1 ? lw - 2 : sx;
		sy = sy < 0 ? 0 : sy >= lh - 1 ? lh - 2 : sy;
		var best = -2, cell = 0;
		for (var y = 0; y < 2; y++) {
			for (var x = 0; x < 2; x++) {
				var cand = grid.lookup[(sy + y) * lw + sx + x];
				var dot = pos[cand * 3] * dir[0] + pos[cand * 3 + 1] * dir[1] + pos[cand * 3 + 2] * dir[2];
				if (dot > best) { best = dot; cell = cand; }
			}
		}
		return cell;
	}
	// The lookup is already a nearest-cell raster, but its texel direction is not quite this
	// texel's, so climb to the true nearest cell: the face search below assumes the seed owns
	// the direction or is one ring away from the cell that does.
	function nearestCell(grid, dir, seed) {
		var pos = grid.pos, ring = grid.ring, ringN = grid.ringN;
		var cell = seed, best = pos[cell * 3] * dir[0] + pos[cell * 3 + 1] * dir[1] + pos[cell * 3 + 2] * dir[2];
		// Bounded because it is a setup walk, generous because a pole-row seed can start a cap
		// away; it stops on the first pass that improves nothing, so the cap is never the cost.
		for (var it = 0; it < 64; it++) {
			var moved = false, m = ringN[cell];
			for (var k = 0; k < m; k++) {
				var cand = ring[cell * 6 + k];
				if (cand < 0) continue;
				var dot = pos[cand * 3] * dir[0] + pos[cand * 3 + 1] * dir[1] + pos[cand * 3 + 2] * dir[2];
				if (dot > best) { best = dot; cell = cand; moved = true; }
			}
			if (!moved) break;
		}
		return cell;
	}
	function sortTriple(a, b, c, out) {
		var lo = a < b ? (a < c ? a : c) : (b < c ? b : c);
		var hi = a > b ? (a > c ? a : c) : (b > c ? b : c);
		out[0] = lo; out[1] = a + b + c - lo - hi; out[2] = hi;
		return out;
	}
	function lessTriple(a, b, c, x, y, z) {
		return a !== x ? a < x : b !== y ? b < y : c < z;
	}
	/* Three numbers do both jobs at once. For a face (a, b, c) the three edge normals
	   cross(b,c), cross(c,a), cross(a,b) all point the same way round, so a direction shares the
	   half-spaces of the spherical triangle *or the triangle at its antipode* exactly when its
	   three dot products share a sign - the test cannot tell d from -d, and faceFront is what
	   separates them; divided by their sum they are the barycentric weights of the ray's
	   intersection with the face plane. That is the same ratio the planar solve gives - the intersection point is a
	   positive combination of the three vertices, and each triple product isolates one
	   coefficient - without the 2x2 Gram determinant, which at L7 face sizes is ~1e-19 and
	   loses every digit. Returns the sum, or 0 for a degenerate face. */
	function faceCoords(pos, a, b, c, dir, out) {
		var bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
		var cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
		var ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
		var dx = dir[0], dy = dir[1], dz = dir[2];
		out[0] = dx * (by * cz - bz * cy) + dy * (bz * cx - bx * cz) + dz * (bx * cy - by * cx);
		out[1] = dx * (cy * az - cz * ay) + dy * (cz * ax - cx * az) + dz * (cx * ay - cy * ax);
		out[2] = dx * (ay * bz - az * by) + dy * (az * bx - ax * bz) + dz * (ax * by - ay * bx);
		return out[0] + out[1] + out[2];
	}
	// How far outside a face a direction fell, normalized: 0 on the boundary, negative outside.
	// Only used to rank misses, so its scale needs to be comparable between faces, not exact.
	function outsideBy(s, sum) {
		var sign = sum > 0 ? 1 : -1, worst = 0;
		for (var i = 0; i < 3; i++) {
			var scaled = sign * s[i];
			if (scaled < worst) worst = scaled;
		}
		return worst / (sign * sum);
	}
	function contains(s) {
		return (s[0] >= 0 && s[1] >= 0 && s[2] >= 0) || (s[0] <= 0 && s[1] <= 0 && s[2] <= 0);
	}
	// det(a, b, c): the face plane's offset from the centre, and the normal both side tests
	// below are measured against. Same triple product faceCoords computes for the ray, with the
	// face's own first vertex as the direction.
	function faceDet(pos, a, b, c) {
		var bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
		var cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
		var ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
		return ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
	}
	// Whether the ray meets the face plane from the front. The shared-sign half-space test also
	// accepts the face at the antipode - a direction is "inside" a triangle and inside its
	// antipodal twin at the same time - because it cannot tell d from -d. Both numbers are
	// scaled by the ray parameter t (the intersection is t * dir, t = det / sum), so the two
	// signs agree exactly when that parameter is positive.
	function faceFront(pos, a, b, c, sum) {
		return (sum > 0) === (faceDet(pos, a, b, c) > 0);
	}
	// The triangles incident to a cell are (c, ring[k], ring[k+1]): the ring is built from the
	// face table's next-vertex map, so consecutive neighbours are exactly the faces at c. No
	// face table, no opposite-face adjacency and no walk state - the candidates are enumerated
	// and the containing one wins. An exact tie, a direction on a shared edge or at a vertex,
	// resolves to the lexicographically smallest vertex triple, which belongs to the triangle
	// and not to the order it happened to be visited in. Returns 1 when a face contained the
	// direction, 0 when the least-outside face had to be used with clamped weights.
	function chooseFace(grid, seed, dir, outCells, outW) {
		var pos = grid.pos, ring = grid.ring, ringN = grid.ringN;
		var haveWin = false, haveBest = false, bestMargin = -Infinity;
		for (var pass = 0; pass < 2; pass++) {
			var cells = pass === 0 ? 1 : ringN[seed], haveIn = false;
			for (var n = 0; n < cells; n++) {
				var c = pass === 0 ? seed : ring[seed * 6 + n];
				if (c < 0) continue;
				var m = ringN[c];
				for (var k = 0; k < m; k++) {
					var b = ring[c * 6 + k], d = ring[c * 6 + ((k + 1) % m)];
					if (b < 0 || d < 0) continue;
					sortTriple(c, b, d, candTri);
					var sum = faceCoords(pos, candTri[0], candTri[1], candTri[2], dir, s3);
					if (sum === 0) continue;
					if (!contains(s3)) {
						var margin = outsideBy(s3, sum);
						if (margin > bestMargin) {
							bestMargin = margin; haveBest = true;
							bestTri.set(candTri); bestS.set(s3);
							bestS[3] = sum;
						}
						continue;
					}
					// Inside the half-spaces, but a ray can meet a face's plane through the back:
					// the antipodal triangle passes the same test. Skipped rather than ranked as
					// a near miss, because its weights reconstruct the direction of the ray that
					// came from the other side.
					if (!faceFront(pos, candTri[0], candTri[1], candTri[2], sum)) continue;
					if (haveIn && !lessTriple(candTri[0], candTri[1], candTri[2], winTri[0], winTri[1], winTri[2])) continue;
					winTri.set(candTri); winS.set(s3); winS[3] = sum;
					haveIn = true;
				}
			}
			if (haveIn) return accept(winTri, winS, outCells, outW, 1);
		}
		return haveBest ? accept(bestTri, bestS, outCells, outW, 0) : 0;
	}
	// One face, the whole predicate: does the face cover this direction? The barycentric
	// numerators land in `out` either way (their sum is the denominator the caller divides by),
	// and the answer is true only when the direction is inside the face and the ray meets its
	// plane from the front. This is what "the record's face contains the texel's direction"
	// means, and what a full scan over every face can be checked against.
	function faceInside(pos, a, b, c, dir, out) {
		var sum = faceCoords(pos, a, b, c, dir, out);
		if (sum === 0 || !contains(out)) return false;
		return faceFront(pos, a, b, c, sum);
	}
	function accept(tri, s, outCells, outW, contained) {
		outCells[0] = tri[0]; outCells[1] = tri[1]; outCells[2] = tri[2];
		var sum = s[3];
		outW[0] = s[0] / sum; outW[1] = s[1] / sum; outW[2] = s[2] / sum;
		return contained;
	}
	function clampWeights(out, stats) {
		var sum = out[0] + out[1] + out[2], scale = sum > 0 ? 1 / sum : 0;
		for (var i = 0; i < 3; i++) {
			var w = out[i] * scale;
			if (w < 0) { if (-w > stats.maxClamp) stats.maxClamp = -w; stats.clamps++; w = 0; }
			out[i] = w;
		}
	}
	// One 16-byte record per texel: three u32 cell indices, then w0 in the low half and w1 in
	// the high half of the fourth word. The weights are quantized jointly so their integer sum
	// is exactly QUANT and the third weight is the remainder, which is what keeps a constant
	// field constant to the last bit.
	function packRecord(data, at, tri, w, stats) {
		var q0 = Math.round(w[0] * QUANT), q1 = Math.round(w[1] * QUANT), q2 = QUANT - q0 - q1;
		if (q2 < 0) {
			if (q0 >= q1) q0 += q2; else q1 += q2;
			q2 = 0;
		}
		data[at] = tri[0]; data[at + 1] = tri[1]; data[at + 2] = tri[2];
		data[at + 3] = q1 * 65536 + q0;
		var e0 = Math.abs(q0 / QUANT - w[0]), e1 = Math.abs(q1 / QUANT - w[1]);
		var e2 = Math.abs(q2 / QUANT - w[2]);
		var max = e0 > e1 ? e0 : e1;
		if (e2 > max) max = e2;
		if (max > stats.maxWeightError) stats.maxWeightError = max;
	}
	/* Build the lookup for one grid at the height-texture resolution - not at a coarser nearest
	   lookup, which would put another staircase under the interpolation. opts:
	     width, height  texel grid, default the gather's 2048 x 1024
	     exact          also keep the unquantized weights for the error budget (tests only)
	     onProgress(f)  called with 0..1 as the build advances
	     cancel()       return true to stop; the result then carries cancelled: true
	   Setup may allocate; nothing downstream of it may. A build is resumable in row bands so a
	   page can spread the one-off cost across frames: opts.rows stops after that many rows and
	   opts.resume continues that job *in place* (the same object comes back, so a frame loop
	   allocates nothing), and a chunked sequence lands the same bytes as one call. */
	function build(grid, opts) {
		opts = opts || {};
		var job = opts.resume, fresh = !job;
		var width = fresh ? (opts.width || 2048) : job.width;
		var height = fresh ? (opts.height || 1024) : job.height, texels = width * height;
		var data = fresh ? new Uint32Array(texels * RECORD_FLOATS) : job.data;
		var exactCells = fresh ? (opts.exact ? new Int32Array(texels * 3) : null) : job.exactCells;
		var exactWeights = fresh ? (opts.exact ? new Float64Array(texels * 3) : null) : job.exactWeights;
		var stats = fresh ? { fallbacks: 0, clamps: 0, maxClamp: 0, maxWeightError: 0 } : job.stats;
		var started = fresh ? Date.now() : job.started;
		var y0 = fresh ? 0 : job.y, y1 = opts.rows ? Math.min(height, y0 + opts.rows) : height;
		var cancelled = false, y, x, texel = y0 * width;
		for (y = y0; y < y1 && !cancelled; y++) {
			for (x = 0; x < width; x++, texel++) {
				direction(width, height, x, y, dir3);
				var seed = nearestCell(grid, dir3, lookupSeed(grid, dir3));
				if (!chooseFace(grid, seed, dir3, buildTri, w3)) stats.fallbacks++;
				clampWeights(w3, stats);
				var at = texel * RECORD_FLOATS;
				packRecord(data, at, buildTri, w3, stats);
				if (exactCells) {
					exactCells[texel * 3] = buildTri[0]; exactCells[texel * 3 + 1] = buildTri[1];
					exactCells[texel * 3 + 2] = buildTri[2];
					exactWeights[texel * 3] = w3[0]; exactWeights[texel * 3 + 1] = w3[1];
					exactWeights[texel * 3 + 2] = w3[2];
				}
				if (opts.cancel && (texel & 8191) === 8191 && opts.cancel()) { cancelled = true; break; }
			}
			if (opts.onProgress) opts.onProgress((y + 1) / height);
		}
		var out = job || {};
		out.level = grid.level; out.width = width; out.height = height; out.texels = texels;
		out.bytes = texels * RECORD_FLOATS * 4; out.data = data;
		out.exactCells = exactCells; out.exactWeights = exactWeights; out.stats = stats;
		out.started = started; out.y = y; out.done = !cancelled && y >= height; out.cancelled = cancelled;
		out.fallbacks = stats.fallbacks; out.clamps = stats.clamps; out.maxClamp = stats.maxClamp;
		out.maxWeightError = stats.maxWeightError; out.buildMs = Date.now() - started;
		return out;
	}

	// The CPU reference for one texel, in the arithmetic the gather shader will use: the packed
	// word becomes w0 and w1, the third weight is the remainder, a gap drops out of the sum and
	// the rest renormalize. Three gaps mean the gap marker - never -1e9 blended into relief.
	function sample(lookup, heights, texel) {
		var data = lookup.data, at = texel * RECORD_FLOATS, packed = data[at + 3];
		var q0 = packed & 65535, q1 = (packed >>> 16) & 65535, q2 = QUANT - q0 - q1;
		var h0 = heights[data[at]], h1 = heights[data[at + 1]], h2 = heights[data[at + 2]];
		var sum = 0, weight = 0;
		if (h0 > INVALID) { sum += q0 * h0; weight += q0; }
		if (h1 > INVALID) { sum += q1 * h1; weight += q1; }
		if (h2 > INVALID) { sum += q2 * h2; weight += q2; }
		return weight > 0 ? sum / weight : GAP;
	}
	// The same value before quantization, for the error budget. Needs a lookup built with
	// `exact`, so it never runs in the page.
	function sampleExact(lookup, heights, texel) {
		var cells = lookup.exactCells, weights = lookup.exactWeights, at = texel * 3;
		var sum = 0, weight = 0;
		for (var i = 0; i < 3; i++) {
			var h = heights[cells[at + i]], w = weights[at + i];
			if (!(h > INVALID) || !(w > 0)) continue;
			sum += w * h; weight += w;
		}
		return weight > 0 ? sum / weight : GAP;
	}
	// The whole height texture, the way the gather pass fills it.
	function gather(lookup, heights, out) {
		for (var t = 0; t < lookup.texels; t++) out[t] = sample(lookup, heights, t);
		return out;
	}
	return {
		GAP: GAP, QUANT: QUANT, RECORD_FLOATS: RECORD_FLOATS,
		build: build, sample: sample, sampleExact: sampleExact, gather: gather,
		direction: direction, faceCoords: faceCoords, faceInside: faceInside, nearestCell: nearestCell
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = HeightField;

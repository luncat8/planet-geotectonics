/* slice.js — globe-owned great-circle section cutter (0.8.1).
 * Pure path geometry, cell-run walker and pgt-slice-pack v2 writer over one captured
 * world snapshot. No DOM, no kernels, no Diag.check, no Columns.climb: js/ui.js owns the
 * browser lifetime, the GPU draining and the transport, and calls SlicePack.validate
 * before anything leaves the page. The shared codec lives in port/slice-format.js.
 */
var SliceSP = typeof module !== 'undefined' && module.exports ? require('../port/slice-format.js') : SlicePack;
var SliceParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var SliceDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var SliceResolution = typeof module !== 'undefined' && module.exports ? require('./resolution.js') : Resolution;

var Slice = (function () {
	// Release provenance (0.8.1 plan §5.1): update both in the release change that ships them.
	var REPO = 'luncat8/planet-geotectonics';
	var COMMIT = '0000000000000000000000000000000000000000';
	// Walk tolerances. The smallest ring-edge distance measures 220.4 / 110.2 / 55.1 km at
	// L5 / L6 / L7, so one third of it keeps every probe step well inside a single cell and a
	// transition bracket never spans more than the two cells it separates. A path that only
	// grazes a cell corner for less than that step can be coalesced away - documented, not
	// hidden; the reader's interpolation is what a one-cell blur already assumes.
	var STEP_DIVISOR = 3;
	var TOL_KM = 1e-3;        // metre-scale boundary bracket
	// The codec quantises sKm to six significant digits, so near a 40,030 km arc two runs
	// closer than ~0.1 km are the same number and the pack would not validate. A grazing
	// corner clip that short is absorbed into the run that follows it: the cells meeting at a
	// Voronoi vertex are pairwise ring neighbours, so the surrounding transition stays legal.
	function minSpanFor(arcKm) {
		return 1.5 * Math.pow(10, Math.floor(Math.log(arcKm) / Math.LN10) - 5);
	}
	var POTENTIALS = SliceSP.POTENTIALS;

	function radiusKm() {
		return SliceParams.radius / 1000;
	}
	// The documented per-level cell budget (the map-top line's 223 / 112 / 56 km): the v2 span
	// check allows 1.5x it, and the widest chord through the largest cell (~1.21x mean area)
	// stays inside that margin at every offered level.
	function cellKmFor(grid) {
		return Math.sqrt(4 * Math.PI * SliceParams.radius * SliceParams.radius / grid.V) / 1000;
	}
	// The editing representation stays full precision; only SlicePack.seal quantises its own
	// copy, so repeated exports of an unchanged path keep one canonical path checksum.
	function circleThrough(aWorld, bWorld, rKm, cellKm) {
		return SliceSP.circleThrough(aWorld, bWorld, rKm === undefined ? radiusKm() : rKm, cellKm);
	}
	function copyPath(path) {
		return path.kind === 'circle'
			? { kind: 'circle', closes: true, arcKm: path.arcKm, cellKm: path.cellKm,
				lat0: path.lat0, lon0: path.lon0, az0: path.az0 }
			: { kind: 'polyline', closes: path.closes, arcKm: path.arcKm, cellKm: path.cellKm,
				verts: path.verts.slice() };
	}

	// --- the cell-run walker (0.8.1 plan §4) ------------------------------------------------
	// Samples the analytic circle, bisects each first boundary down to a metre-scale bracket
	// and appends the preceding cell's run at the bracket midpoint. `nearest` is
	// Resolution.nearestCell - the one shared climb, so a vertex-exact tie resolves the same
	// way here and in the live-resolution transfer.
	function walk(grid, path, nearest) {
		if (!path || path.kind !== 'circle' || !path.closes)
			throw new TypeError('the cutter walks closed circles only; polyline paths are reserved');
		if (typeof nearest !== 'function')
			throw new TypeError('walk needs the nearestCell lookup (Resolution.nearestCell)');
		var arc = path.arcKm;
		if (!(arc > 0) || !Number.isFinite(arc)) throw new RangeError('path.arcKm must be positive and finite');
		var maxDot = -Infinity;
		for (var c = 0; c < grid.V; c++) {
			for (var k = 0; k < grid.ringN[c]; k++) {
				var j = grid.ring[c * 6 + k];
				if (j < 0) continue;
				var dot = grid.pos[c * 3] * grid.pos[j * 3] + grid.pos[c * 3 + 1] * grid.pos[j * 3 + 1]
					+ grid.pos[c * 3 + 2] * grid.pos[j * 3 + 2];
				if (dot > maxDot) maxDot = dot;
			}
		}
		var step = Math.acos(Math.min(1, maxDot)) * radiusKm() / STEP_DIVISOR;
		var minSpan = minSpanFor(arc);
		var dir = new Float64Array(3), probes = 0;
		function probe(s) {
			probes++;
			SliceSP.directionAt(path, s, dir);
			return nearest(grid, dir[0], dir[1], dir[2]);
		}
		function isNeighbour(a, b) {
			var base = a * 6, n = grid.ringN[a];
			for (var k = 0; k < n; k++) if (grid.ring[base + k] === b) return true;
			return false;
		}
		var cells = [], starts = [];
		var runCell = probe(0), runStart = 0;
		// Closes the open run at `at` and opens `nextCell` there. A run the codec could not
		// keep distinct after quantisation is dropped instead: its arc joins the run that
		// follows (runStart stays), which also keeps sKm[0] = 0 when the very first run is
		// the graze.
		function endRun(at, nextCell) {
			if (at - runStart >= minSpan) {
				cells.push(runCell);
				starts.push(runStart);
				runStart = at;
			}
			runCell = nextCell;
		}
		// Resolves every transition in (from, to] whose far endpoint differs from the open run.
		// Each pass bisects the FIRST boundary, appends that run and continues from the new
		// cell inside the same step, so several boundaries inside one step all land.
		function resolve(from, to) {
			var at = from;
			for (var guard = 0; guard < 1 << 20; guard++) {
				if (probe(to) === runCell) return;
				if (to - at <= TOL_KM)
					throw new RangeError('cutter transition at s=' + to.toFixed(3) + ' km is closer than the '
						+ 'metre bracket to its probe; cells ' + runCell + ' -> ' + probe(to));
				var lo = at, hi = to, mid;
				while (hi - lo > TOL_KM) {
					mid = (lo + hi) / 2;
					if (probe(mid) === runCell) lo = mid; else hi = mid;
				}
				var nextCell = probe(hi);
				if (!isNeighbour(runCell, nextCell))
					throw new RangeError('cutter transition at s=' + ((lo + hi) / 2).toFixed(3) + ' km joins '
						+ 'non-neighbour cells ' + runCell + ' -> ' + nextCell + '; no edge was invented');
				endRun((lo + hi) / 2, nextCell);
				at = hi;
			}
			throw new RangeError('cutter walk did not converge near s=' + to.toFixed(3) + ' km');
		}
		var s = 0;
		while (s < arc) {
			var next = Math.min(s + step, arc);
			resolve(s, next);
			s = next;
		}
		// The wrap: probe(arc) is probe(0) bit-for-bit, so the loop always ends on the first
		// run's cell. Its open tail is pushed as its own run (the first cell legitimately
		// appears as both the first and the last run), or dropped as a sub-quantisation graze
		// into the wrap, where the last pushed run then ends at the full arc.
		endRun(arc, runCell);
		if (cells.length < 2)
			throw new RangeError('the circle crosses only ' + cells.length + ' cell(s); a section needs at least two runs');
		for (var i = 1; i < cells.length; i++)
			if (!(starts[i] > starts[i - 1])) throw new RangeError('walk produced a non-increasing start at run ' + i);
		return { cells: cells, starts: starts, n: cells.length, arcKm: arc, stepKm: step, probes: probes };
	}

	// --- the v2 writer over one snapshot (0.8.1 plan §4.2-4.3) -----------------------------
	// Reads the authoritative split exactly once per run: cell-frame z/vel/edge/wet, the
	// owner column's crust/age/plate/potentials, and the plate table's omega. A gap row is
	// canonicalised through the shared setGap, never filled from a neighbouring owner.
	function pack(state, path, sea, provenance, license) {
		var grid = state.grid;
		var runs = walk(grid, path, SliceResolution.nearestCell);
		var p = SliceSP.make(runs.n, copyPath(path));
		p.planet.rKm = radiusKm();
		p.sea = { mode: sea.mode, levelM: sea.levelM, volScale: sea.volScale };
		p.license = license;
		p.source = {
			repo: REPO, commit: provenance.commit || COMMIT,
			pack: provenance.pack, epochMa: provenance.epochMa,
			rotModel: provenance.rotModel, built: provenance.built,
			tMyr: state.t, level: grid.level, gridSeed: grid.seed, simSeed: state.seed
		};
		var gapRows = 0;
		var plateCount = new Uint32Array(state.plateCap);
		var plateSeen = new Uint8Array(state.plateCap);
		var ids = [];
		var tangent = new Float64Array(3);
		for (var i = 0; i < runs.n; i++) {
			var cell = runs.cells[i];
			p.sKm[i] = runs.starts[i];
			var owner = state.owner[cell];
			if (owner < 0) {
				gapRows++;
				SliceSP.setGap(p, i);
				continue;
			}
			var hFel = Math.round(state.hFel[owner]), hMaf = Math.round(state.hMaf[owner]), hSed = Math.round(state.hSed[owner]);
			p.zM[i] = Math.round(state.z[cell]);
			p.hFelM[i] = hFel;
			p.hMafM[i] = hMaf;
			p.hSedM[i] = hSed;
			p.ageMyr[i] = state.age[owner];
			p.fert[i] = state.fert[owner];
			p.damage[i] = state.damage[owner];
			p.host[i] = SliceSP.hostCode(hFel, hMaf, hSed);
			var plate = state.plate[owner];
			p.plate[i] = plate;
			p.alive[i] = 1;
			p.wet[i] = state.z[cell] < sea.levelM ? 1 : 0;
			if (!plateSeen[plate]) { plateSeen[plate] = 1; ids.push(plate); }
			plateCount[plate]++;
			// Directed boundary toward the next run: the ring slot in this cell, then the
			// shared conversion. The closing run points at the first run's cell.
			var nextCell = runs.cells[(i + 1) % runs.n];
			if (nextCell === cell) {
				p.bnd[i] = 0;
				p.pol[i] = 0;
			} else {
				var slot = -1, base = cell * 6;
				for (var k = 0; k < grid.ringN[cell]; k++) if (grid.ring[base + k] === nextCell) { slot = k; break; }
				if (slot < 0) throw new RangeError('run ' + i + ' ends in non-neighbour cell ' + nextCell);
				var e = cell * 6 + slot;
				p.bnd[i] = SliceSP.edgeCode(state.edgeType[e], state.polarity[e]);
				p.pol[i] = SliceSP.edgePolarity(state.edgeType[e], state.polarity[e]);
			}
			// vt/vp at the run midpoint against the analytic tangent: signed along-cut
			// component and the non-negative out-of-plane magnitude. Display-side only.
			var end = i + 1 < runs.n ? runs.starts[i + 1] : runs.arcKm;
			SliceSP.tangentAt(path, (runs.starts[i] + end) / 2, tangent);
			var vb = cell * 3;
			var vx = state.vel[vb], vy = state.vel[vb + 1], vz = state.vel[vb + 2];
			var vt = vx * tangent[0] + vy * tangent[1] + vz * tangent[2];
			p.vt[i] = vt;
			p.vp[i] = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - vt * vt));
			for (var f = 0; f < POTENTIALS.length; f++) p.pot[i * POTENTIALS.length + f] = state[SliceDiag.ORE_FIELDS[f]][owner];
		}
		// Ordered plate table: every live sample's id, plus id 0 when a gap row references it
		// and no live sample supplied it (gap rows carry plate 0 by the canonical rule).
		ids.sort(function (a, b) { return a - b; });
		if (gapRows && (ids.length === 0 || ids[0] !== 0) && !plateSeen[0]) ids.unshift(0);
		for (var t = 0; t < ids.length; t++) {
			var id = ids[t], w = id * 3;
			p.plates.push({ id: id, n: plateCount[id], wx: state.omega[w], wy: state.omega[w + 1], wz: state.omega[w + 2] });
		}
		SliceSP.seal(p);
		return { pack: p, runs: runs, checksum: p.checksum, pathChecksum: SliceSP.pathChecksum(p.path) };
	}

	// One honest status line for the control (0.8.1 plan §6); the UI decorates it with the
	// capture provenance it owns (engine, transport result).
	function report(result) {
		var p = result.pack;
		return result.runs.n + ' runs · ' + Math.round(p.path.arcKm).toLocaleString('en-US') + ' km · t '
			+ SliceSP.round(p.source.tMyr).toFixed(1) + ' Myr · path ' + result.pathChecksum.slice(0, 8)
			+ ' · pack ' + p.checksum.slice(0, 8);
	}

	return {
		REPO: REPO,
		COMMIT: COMMIT,
		STEP_DIVISOR: STEP_DIVISOR,
		TOL_KM: TOL_KM,
		radiusKm: radiusKm,
		cellKmFor: cellKmFor,
		circleThrough: circleThrough,
		walk: walk,
		pack: pack,
		report: report
	};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Slice;

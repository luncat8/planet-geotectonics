/* advection-bench.js - which crust-transport scheme survives 10k-100k yr frames?
   A rigid 30-degree cap ("continent") rotates about z at a fixed plate speed inside a
   stationary background plate. After a long run the cap is compared with the exactly
   rotated cap (IoU of occupied cells). Three schemes, same grid, same motion:

   sl       lagged nearest-cell semi-Lagrangian raster (GPT design): copy state from the
            backtraced cell whenever the accumulated rotation reaches `thr` cells.
   upwind   Eulerian first-order upwind flux transport of a thickness field
            (GLM design P7 / Gemini per-frame advection), run every frame.
   columns  Lagrangian material columns, body-frame position + per-plate rotation
            matrix, re-rasterized EVERY frame by "nearest column within the 1-ring".
            Overlap ownership: cap overrides background (a physics priority rule).

   usage: node experiments/advection-bench.js [level=5] [dtMyr=0.1] [Myr=1000] [cmPerYr=5] */
var fs = typeof require === 'function' ? require('fs') : null;
if (fs && typeof Grid === 'undefined') eval(fs.readFileSync(__dirname + '/../js/geodesics.js', 'utf8'));

var LEVEL = +(process.argv[2] || 5);
var DT = +(process.argv[3] || 0.1);
var TOTAL_MYR = +(process.argv[4] || 1000);
var CM_PER_YR = +(process.argv[5] || 5);
var CAP_DEG = 30;

var R = PLANET_R;
var grid = new Grid(LEVEL, 7).build();
var V = grid.V, WH = grid.W * grid.H;
var spacing = Math.sqrt(4 * Math.PI * R * R / V);
var omega = CM_PER_YR * 1e-2 * 1e6 / R; /* rad per Myr */
var cosCap = Math.cos(CAP_DEG * Math.PI / 180);

/* flat neighbour tables: ring[i*6+k], -1 when absent (pentagons) */
var pos = new Float64Array(V * 3), area = new Float64Array(V), ring = new Int32Array(V * 6).fill(-1);
var ringN = new Uint8Array(V), nbrDist = new Float64Array(V), edgeLen = new Float64Array(V * 6);
var faceNx = new Float64Array(V * 6), faceNy = new Float64Array(V * 6), faceNz = new Float64Array(V * 6);
var i, k, j, b;
for (i = 0; i < V; i++) {
	pos[i * 3] = grid.cellA[i * 4]; pos[i * 3 + 1] = grid.cellA[i * 4 + 1]; pos[i * 3 + 2] = grid.cellA[i * 4 + 2];
	area[i] = grid.cellA[i * 4 + 3];
}
for (i = 0; i < V; i++) {
	var n = 0, dsum = 0;
	for (k = 0; k < 6; k++) {
		b = (i + k * WH) * 4;
		if (grid.nbrA[b + 3] === 0) continue;
		j = grid.nbrA[b];
		ring[i * 6 + n] = j; edgeLen[i * 6 + n] = grid.nbrA[b + 1]; dsum += grid.nbrA[b + 2];
		var dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
		var d = dx * pos[i * 3] + dy * pos[i * 3 + 1] + dz * pos[i * 3 + 2];
		dx -= d * pos[i * 3]; dy -= d * pos[i * 3 + 1]; dz -= d * pos[i * 3 + 2];
		var l = Math.hypot(dx, dy, dz);
		faceNx[i * 6 + n] = dx / l; faceNy[i * 6 + n] = dy / l; faceNz[i * 6 + n] = dz / l;
		n++;
	}
	ringN[i] = n; nbrDist[i] = dsum / n;
}

/* nearest cell to a unit vector by hill climbing from a guess (exact for a Voronoi grid) */
function climb(c, x, y, z) {
	var best = pos[c * 3] * x + pos[c * 3 + 1] * y + pos[c * 3 + 2] * z;
	for (var it = 0; it < 8; it++) {
		var moved = false;
		for (var q = 0; q < ringN[c]; q++) {
			var cj = ring[c * 6 + q], dd = pos[cj * 3] * x + pos[cj * 3 + 1] * y + pos[cj * 3 + 2] * z;
			if (dd <= best) continue;
			best = dd; c = cj; moved = true;
		}
		if (!moved) return c;
	}
	return c;
}
function lookupCell(x, y, z) {
	var lat = Math.asin(Math.max(-1, Math.min(1, y))), lon = Math.atan2(z, x);
	var px = Math.max(0, Math.min(grid.lookupW - 1, Math.floor((lon / (2 * Math.PI) + 0.5) * grid.lookupW)));
	var py = Math.max(0, Math.min(grid.lookupH - 1, Math.floor((lat / Math.PI + 0.5) * grid.lookupH)));
	return climb(grid.lookup[py * grid.lookupW + px], x, y, z);
}
function inCap(i) { return pos[i * 3] >= cosCap; }
function iouVsExact(occupied, theta) {
	var vx = Math.cos(theta), vy = Math.sin(theta), inter = 0, uni = 0;
	for (var c = 0; c < V; c++) {
		var exact = pos[c * 3] * vx + pos[c * 3 + 1] * vy >= cosCap, got = occupied[c] > 0;
		if (got && exact) inter++;
		if (got || exact) uni++;
	}
	return inter / uni;
}
function report(name, detail, occupied, theta, ms) {
	var cells = 0;
	for (var c = 0; c < V; c++) if (occupied[c] > 0) cells++;
	console.log(name.padEnd(8) + detail.padEnd(34) + ' cells ' + String(cells).padStart(6) + '  IoU ' + iouVsExact(occupied, theta).toFixed(3) + '  ms/frame ' + ms.toFixed(2));
}

/* ---- scheme 1: lagged nearest-cell semi-Lagrangian ---- */
function runSemiLagrangian(thrCells) {
	var plate = new Uint8Array(V), next = new Uint8Array(V), acc = 0, theta = 0, frames = 0, rasters = 0;
	for (i = 0; i < V; i++) plate[i] = inCap(i) ? 1 : 0;
	var t0 = Date.now();
	for (var t = 0; t < TOTAL_MYR; t += DT) {
		frames++; acc += omega * DT;
		if (acc < thrCells * spacing / R) continue;
		rasters++; theta += acc;
		var c = Math.cos(-acc), s = Math.sin(-acc);
		for (i = 0; i < V; i++) {
			var x = pos[i * 3], y = pos[i * 3 + 1];
			next[i] = plate[lookupCell(c * x - s * y, s * x + c * y, pos[i * 3 + 2])];
		}
		var sw = plate; plate = next; next = sw; acc = 0;
	}
	report('sl', 'thr=' + thrCells + ' cell, rasters=' + rasters, plate, theta, (Date.now() - t0) / frames);
}

/* ---- scheme 2: Eulerian upwind of a thickness field, every frame ---- */
function runUpwind() {
	var h = new Float64Array(V), h2 = new Float64Array(V), frames = 0, theta = 0, mass0 = 0;
	for (i = 0; i < V; i++) { h[i] = inCap(i) ? 1 : 0; mass0 += h[i] * area[i]; }
	var t0 = Date.now();
	for (var t = 0; t < TOTAL_MYR; t += DT) {
		frames++; theta += omega * DT;
		for (i = 0; i < V; i++) {
			var flux = 0, vx = -omega * R * pos[i * 3 + 1], vy = omega * R * pos[i * 3];
			for (k = 0; k < ringN[i]; k++) {
				j = ring[i * 6 + k];
				var un = 0.5 * ((vx - omega * R * pos[j * 3 + 1]) * faceNx[i * 6 + k] + (vy + omega * R * pos[j * 3]) * faceNy[i * 6 + k]);
				flux += un > 0 ? un * h[i] * edgeLen[i * 6 + k] : un * h[j] * edgeLen[i * 6 + k];
			}
			h2[i] = h[i] - DT * flux / area[i];
		}
		var sw = h; h = h2; h2 = sw;
	}
	var mass = 0, a10 = 0, a90 = 0, occ = new Uint8Array(V);
	for (i = 0; i < V; i++) { mass += h[i] * area[i]; if (h[i] > 0.1) a10 += area[i]; if (h[i] > 0.9) a90 += area[i]; occ[i] = h[i] > 0.5 ? 1 : 0; }
	var edgeKm = (Math.sqrt(a10 / Math.PI) - Math.sqrt(a90 / Math.PI)) / 1e3;
	report('upwind', 'C=' + (omega * R * DT / spacing).toFixed(3) + ' mass drift ' + ((mass / mass0 - 1) * 100).toFixed(2) + '%', occ, theta, (Date.now() - t0) / frames);
	console.log('         10%-90% edge width after run: ' + edgeKm.toFixed(0) + ' km = ' + (edgeKm * 1e3 / spacing).toFixed(1) + ' cells (was 0)');
}

/* ---- scheme 3: Lagrangian columns, per-frame nearest-column raster over the 1-ring ---- */
function runColumns(gapRatio) {
	var N = V; /* one column per cell at start: background (plate 0) everywhere, cap = plate 1 */
	var bx = new Float64Array(N), by = new Float64Array(N), bz = new Float64Array(N);
	var wx = new Float64Array(N), wy = new Float64Array(N), wz = new Float64Array(N);
	var plateOf = new Uint8Array(N), cell = new Int32Array(N);
	var winner = new Int32Array(V), winScore = new Float64Array(V), owner = new Int8Array(V), occ = new Uint8Array(V);
	for (var q = 0; q < N; q++) { bx[q] = pos[q * 3]; by[q] = pos[q * 3 + 1]; bz[q] = pos[q * 3 + 2]; plateOf[q] = inCap(q) ? 1 : 0; cell[q] = q; }
	var theta = 0, frames = 0, interiorGaps = 0, t0 = Date.now();
	for (var t = 0; t < TOTAL_MYR; t += DT) {
		frames++; theta += omega * DT;
		var c = Math.cos(theta), s = Math.sin(theta);
		/* particle pass: world = R_plate * body (exact, no accumulation), locate cell */
		for (q = 0; q < N; q++) {
			var x = bx[q], y = by[q];
			if (plateOf[q] === 1) { var nx = c * x - s * y; y = s * x + c * y; x = nx; }
			wx[q] = x; wy[q] = y; wz[q] = bz[q];
			cell[q] = climb(cell[q], x, y, bz[q]);
		}
		/* raster: each column competes for its cell and the ring; priority (cap overrides) then distance */
		winScore.fill(-2); winner.fill(-1);
		for (q = 0; q < N; q++) {
			var ci = cell[q], prio = plateOf[q] === 1 ? 10 : 0;
			for (k = -1; k < ringN[ci]; k++) {
				var cj = k < 0 ? ci : ring[ci * 6 + k];
				var score = prio + pos[cj * 3] * wx[q] + pos[cj * 3 + 1] * wy[q] + pos[cj * 3 + 2] * wz[q];
				if (score <= winScore[cj]) continue;
				winScore[cj] = score; winner[cj] = q;
			}
		}
		for (i = 0; i < V; i++) {
			var sc = winScore[i] >= 5 ? winScore[i] - 10 : winScore[i];
			var far = winner[i] < 0 || Math.acos(Math.min(1, sc)) * R > gapRatio * nbrDist[i];
			owner[i] = far ? -1 : plateOf[winner[i]];
			occ[i] = owner[i] === 1 ? 1 : 0;
		}
		/* a gap whose whole ring belongs to one plate would be a raster hole (must never happen) */
		for (i = 0; i < V; i++) {
			if (owner[i] >= 0) continue;
			var p0 = owner[ring[i * 6]], same = p0 >= 0;
			for (k = 1; k < ringN[i]; k++) if (owner[ring[i * 6 + k]] !== p0) same = false;
			if (same) interiorGaps++;
		}
	}
	report('columns', 'gap>' + gapRatio + ' nbrDist, interior holes=' + interiorGaps, occ, theta, (Date.now() - t0) / frames);
}

console.log('L' + LEVEL + ' V=' + V + ' spacing ' + (spacing / 1e3).toFixed(0) + ' km | dt ' + DT + ' Myr (' + (DT * 1e3) + ' kyr/frame) | ' + CM_PER_YR + ' cm/yr -> ' + (omega * R * DT / spacing).toFixed(4) + ' cells/frame | ' + TOTAL_MYR + ' Myr = ' + (omega * TOTAL_MYR * R / 1e3).toFixed(0) + ' km travelled');
runSemiLagrangian(0.5);
runSemiLagrangian(0.7);
runSemiLagrangian(1.0);
runUpwind();
runColumns(0.75);

if (typeof module !== 'undefined') module.exports = { climb: climb, lookupCell: lookupCell };

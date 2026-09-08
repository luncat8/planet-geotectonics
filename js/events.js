var EventsParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var EventsQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var EventsEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var EventsPlates = typeof module !== 'undefined' && module.exports ? require('./plates.js') : Plates;
// K0 plate-level events, cadence ~1 Myr (Params.eventCadence). Runs at the top of the frame,
// before MOVE/BIN, so every index consumer downstream sees the compacted numbering.
// Order inside a cycle: compact columns, suture neighbouring plates, drop empty plates,
// compact the plate table, then split. Splitting last gives the new plates free slots.
var Events = {
	MAX_PARTS: 8,
	// minPlateCells is quoted at L5 (design §11); other levels scale with the cell count.
	minCells: function (s) {
		return Math.max(3, Math.round(EventsParams.minPlateCells * s.grid.V / 10242));
	},
	cycle: function (s) {
		var span = s.t - s.lastEvent;
		Events.compact(s);
		Events.census(s);
		Events.suture(s, span);
		Events.absorb(s);
		Events.retire(s);
		Events.compactPlates(s);
		Events.split(s);
	},
	copy: function (s, from, to) {
		var a = from * 3, b = to * 3;
		s.body[b] = s.body[a]; s.body[b + 1] = s.body[a + 1]; s.body[b + 2] = s.body[a + 2];
		s.world[b] = s.world[a]; s.world[b + 1] = s.world[a + 1]; s.world[b + 2] = s.world[a + 2];
		s.area[to] = s.area[from];
		s.hFel[to] = s.hFel[from]; s.hMaf[to] = s.hMaf[from]; s.hSed[to] = s.hSed[from];
		s.age[to] = s.age[from]; s.damage[to] = s.damage[from]; s.zDyn[to] = s.zDyn[from];
		s.fert[to] = s.fert[from];
		s.oVms[to] = s.oVms[from]; s.oMaf[to] = s.oMaf[from]; s.oArc[to] = s.oArc[from];
		s.oOro[to] = s.oOro[from]; s.oBas[to] = s.oBas[from]; s.oPla[to] = s.oPla[from];
		s.plate[to] = s.plate[from]; s.cell[to] = s.cell[from];
		s.alive[to] = 1;
	},
	compact: function (s) {
		var dst = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			if (dst !== i) Events.copy(s, i, dst);
			dst++;
		}
		for (var j = dst; j < s.n; j++) {
			s.alive[j] = 0;
			s.cell[j] = -1;
			s.consumedBy[j] = -1;
		}
		s.n = dst;
	},
	// Per plate pair: shared boundary length, length-weighted relative speed, and whether every
	// shared edge is sutureable. The same pass recounts the cells per plate, because the event
	// cycle must not depend on K5 having run — a fixedOmega rig never classifies a boundary, and
	// a stale zero there would retire every plate on the planet. One pass over the boundary
	// edges feeds merge, absorb and the split guard, so the cadence stays linear in the cells.
	census: function (s) {
		var g = s.grid, cap = s.plateCap, nP = s.plateCount;
		var len = s.pairLen, vel = s.pairVel, ok = s.pairOk;
		len.fill(0); vel.fill(0); ok.fill(1);
		s.plateCells.fill(0);
		for (var c = 0; c < g.V; c++) {
			var pi = s.cellPlate[c];
			if (pi >= nP) continue;
			s.plateCells[pi]++;
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, pj = s.cellPlate[g.ring[e]];
				if (pj >= nP || pj === pi) continue;
				var slot = (pi < pj ? pi : pj) * cap + (pi < pj ? pj : pi);
				var L = g.edgeLen[e], v = Math.hypot(s.relN[e], s.relT[e]);
				len[slot] += L;
				vel[slot] += v * L;
				if (!Events.suturing(s, e, v)) ok[slot] = 0;
			}
		}
	},
	// A boundary sutures while it neither opens nor creeps: continental collision, or a
	// transform slower than vSuture. relN and relT span the tangent plane, so their magnitude
	// is the full relative speed of the two plates at that edge.
	suturing: function (s, e, speed) {
		var type = s.edgeType[e];
		if (type === EventsEdges.CONVERGENT) return s.polarity[e] === 2;
		if (type === EventsEdges.TRANSFORM) return speed < EventsParams.vSuture;
		return false;
	},
	suture: function (s, span) {
		var cap = s.plateCap, nP = s.plateCount, p = EventsParams, time = s.sutureTime;
		for (var a = 0; a < nP; a++) {
			for (var b = a + 1; b < nP; b++) {
				var slot = a * cap + b, len = s.pairLen[slot];
				var slow = len > 0 && s.pairOk[slot] && s.pairVel[slot] < p.vSuture * len;
				time[slot] = slow ? time[slot] + span : 0;
				if (time[slot] < p.mergeTime) continue;
				time[slot] = 0;
				var winner = s.plateCells[a] >= s.plateCells[b] ? a : b;
				Events.merge(s, winner === a ? b : a, winner);
			}
		}
	},
	// A plate too small to be a plate is absorbed by the neighbour it shares most boundary with.
	absorb: function (s) {
		var cap = s.plateCap, nP = s.plateCount, floor = Events.minCells(s) * 0.5;
		for (var a = 0; a < nP; a++) {
			if (s.plateDead[a] || s.plateCells[a] >= floor) continue;
			var best = -1, bestLen = 0;
			for (var b = 0; b < nP; b++) {
				if (b === a || s.plateDead[b]) continue;
				var slot = (a < b ? a : b) * cap + (a < b ? b : a);
				if (s.pairLen[slot] <= bestLen) continue;
				bestLen = s.pairLen[slot]; best = b;
			}
			if (best >= 0) Events.merge(s, a, best);
		}
	},
	// A plate that lost its last column to subduction is gone. With nothing rasterised there is
	// no verdict to give, so an unrasterised state retires no plate at all.
	retire: function (s) {
		var covered = 0, p;
		for (p = 0; p < s.plateCount; p++) covered += s.plateCells[p];
		if (!covered) return;
		for (p = 0; p < s.plateCount; p++) {
			if (!s.plateDead[p] && s.plateCells[p] === 0) s.plateDead[p] = 1;
		}
	},
	// b' = q_winner^-1 (q_loser b): the crust keeps its world position, so a merge is invisible
	// to the map except for the boundary that disappears.
	rebase: function (s, loser, winner) {
		var lp = loser * 4, wp = winner * 4, scratch = s.scratch;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i] || s.plate[i] !== loser) continue;
			var b = i * 3;
			EventsQuat.rotate(scratch, 0, s.q, lp, s.body, b);
			EventsQuat.rotateInv(s.body, b, s.q, wp, scratch, 0);
			s.world[b] = scratch[0]; s.world[b + 1] = scratch[1]; s.world[b + 2] = scratch[2];
			s.plate[i] = winner;
		}
	},
	merge: function (s, loser, winner) {
		if (loser === winner || s.plateDead[loser] || s.plateDead[winner]) return 0;
		var a = loser * 3, b = winner * 3;
		var cells = s.plateCells[loser] + s.plateCells[winner];
		var f = cells > 0 ? s.plateCells[loser] / cells : 0.5;
		Events.rebase(s, loser, winner);
		// Angular momentum of the two rigid halves, weighted by area, is the least jolting
		// choice; K10 redoes the fit within a few τ_ω anyway.
		s.omega[b] += (s.omega[a] - s.omega[b]) * f;
		s.omega[b + 1] += (s.omega[a + 1] - s.omega[b + 1]) * f;
		s.omega[b + 2] += (s.omega[a + 2] - s.omega[b + 2]) * f;
		s.plateCells[winner] = cells;
		s.plateSpawned[winner] += s.plateSpawned[loser];
		s.plateLost[winner] += s.plateLost[loser];
		s.plateDead[loser] = 1;
		s.merges++;
		return 1;
	},
	copyPlate: function (s, from, to) {
		var a = from * 4, b = to * 4, a3 = from * 3, b3 = to * 3;
		s.q[b] = s.q[a]; s.q[b + 1] = s.q[a + 1]; s.q[b + 2] = s.q[a + 2]; s.q[b + 3] = s.q[a + 3];
		s.omega[b3] = s.omega[a3]; s.omega[b3 + 1] = s.omega[a3 + 1]; s.omega[b3 + 2] = s.omega[a3 + 2];
		s.seeds[b3] = s.seeds[a3]; s.seeds[b3 + 1] = s.seeds[a3 + 1]; s.seeds[b3 + 2] = s.seeds[a3 + 2];
		s.plateCells[to] = s.plateCells[from]; s.plateSpawned[to] = s.plateSpawned[from];
		s.plateLost[to] = s.plateLost[from]; s.subRate[to] = s.subRate[from]; s.subCount[to] = s.subCount[from];
		s.plateBirth[to] = s.plateBirth[from]; s.plateParent[to] = s.plateParent[from];
	},
	clearPlate: function (s, p) {
		var a = p * 4, b = p * 3;
		s.q[a] = 0; s.q[a + 1] = 0; s.q[a + 2] = 0; s.q[a + 3] = 1;
		s.omega[b] = 0; s.omega[b + 1] = 0; s.omega[b + 2] = 0;
		s.seeds[b] = 0; s.seeds[b + 1] = 0; s.seeds[b + 2] = 0;
		s.plateCells[p] = 0; s.plateSpawned[p] = 0; s.plateLost[p] = 0;
		s.subRate[p] = 0; s.subCount[p] = 0; s.plateBirth[p] = 0; s.plateParent[p] = -1;
	},
	// Plates stay dense in 0..plateCount-1: every per-plate array is indexed by a loop bound,
	// and the renderer palette, K5 and K10 all assume it.
	compactPlates: function (s) {
		var remap = s.plateRemap, nP = s.plateCount, dst = 0;
		for (var p = 0; p < nP; p++) {
			if (s.plateDead[p]) { remap[p] = -1; continue; }
			remap[p] = dst;
			if (dst !== p) Events.copyPlate(s, p, dst);
			dst++;
		}
		s.plateDead.fill(0);
		if (dst === nP) return;
		for (p = dst; p < nP; p++) Events.clearPlate(s, p);
		s.plateCount = dst;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			s.plate[i] = remap[s.plate[i]];
		}
		Events.permutePairs(s, remap, nP);
	},
	// Suture timers are keyed by plate pair, so they must follow the renumbering or a pair that
	// was 19 Myr into a suture silently restarts.
	permutePairs: function (s, remap, nP) {
		var cap = s.plateCap, src = s.sutureTime, out = s.pairScratch;
		out.fill(0);
		for (var a = 0; a < nP; a++) {
			var ra = remap[a];
			if (ra < 0) continue;
			for (var b = a + 1; b < nP; b++) {
				var rb = remap[b];
				if (rb < 0) continue;
				out[(ra < rb ? ra : rb) * cap + (ra < rb ? rb : ra)] = src[a * cap + b];
			}
		}
		src.set(out);
	},
	newPlate: function (s, parent) {
		if (s.plateCount >= s.plateCap) return -1;
		var p = s.plateCount++, a = parent * 4, b = p * 4, a3 = parent * 3, b3 = p * 3;
		s.q[b] = s.q[a]; s.q[b + 1] = s.q[a + 1]; s.q[b + 2] = s.q[a + 2]; s.q[b + 3] = s.q[a + 3];
		s.omega[b3] = s.omega[a3]; s.omega[b3 + 1] = s.omega[a3 + 1]; s.omega[b3 + 2] = s.omega[a3 + 2];
		s.plateCells[p] = 0; s.plateSpawned[p] = 0; s.plateLost[p] = 0;
		s.subRate[p] = 0; s.subCount[p] = 0;
		s.plateBirth[p] = s.t; s.plateParent[p] = parent;
		return p;
	},
	// Connected components of one plate after its damaged cells are removed, labelled in
	// s.compLabel. Returns the component count; s.compSize holds the core sizes and
	// compLabel is cleared for the whole grid, so a label always names a cell of the plate
	// currently being cut. The threshold is an argument so a test can prescribe a corridor
	// without touching the damage field.
	components: function (s, plate, threshold) {
		var g = s.grid, label = s.compLabel, queue = s.queue, corridor = s.corridor;
		var thr = threshold === undefined ? EventsParams.splitDamage : threshold;
		var nComp = 0, head, tail, c, k;
		label.fill(-1);
		for (c = 0; c < g.V; c++) {
			if (s.cellPlate[c] !== plate) { corridor[c] = 0; continue; }
			var o = s.owner[c];
			corridor[c] = o >= 0 && s.damage[o] > thr ? 1 : 0;
		}
		for (c = 0; c < g.V; c++) {
			if (s.cellPlate[c] !== plate || corridor[c] || label[c] >= 0) continue;
			var size = 0;
			queue[0] = c; head = 0; tail = 1; label[c] = nComp;
			while (head < tail) {
				var cur = queue[head++];
				size++;
				for (k = 0; k < g.ringN[cur]; k++) {
					var j = g.ring[cur * 6 + k];
					if (s.cellPlate[j] !== plate || corridor[j] || label[j] >= 0) continue;
					label[j] = nComp; queue[tail++] = j;
				}
			}
			s.compSize[nComp] = size;
			if (++nComp === s.compSize.length) break;
		}
		return nComp;
	},
	// Every unlabelled cell of the plate (corridor, plus components too small to stand alone)
	// joins the nearest surviving component, so a split never orphans cells.
	assignRest: function (s, plate) {
		var g = s.grid, label = s.compLabel, queue = s.queue;
		var head = 0, tail = 0;
		for (var c = 0; c < g.V; c++) {
			if (s.cellPlate[c] === plate && label[c] >= 0) queue[tail++] = c;
		}
		while (head < tail) {
			var cur = queue[head++];
			for (var k = 0; k < g.ringN[cur]; k++) {
				var j = g.ring[cur * 6 + k];
				if (s.cellPlate[j] !== plate || label[j] >= 0) continue;
				label[j] = label[cur]; queue[tail++] = j;
			}
		}
	},
	// Opening rate the mantle flow would put across each internal boundary of a plate that has
	// just been labelled by component. Every component is fitted with the rotation the flow
	// beneath it would give it on its own, and the relative velocity is projected on the local
	// boundary normal. Only the opening half is averaged: two rigid pieces on a sphere always
	// open on one side of a cut and close on the other, so a signed mean is identically zero
	// around any closed corridor. The positive part is what opens an ocean; the closing half
	// becomes a trench. A damaged line the flow is not pulling apart anywhere is a fossil weak
	// zone, and cutting it shreds the plate instead of rifting it.
	opening: function (s, keep) {
		var g = s.grid, R = EventsParams.radius, label = s.compLabel;
		var sum = s.openSum, count = s.openLen, fitted = s.openFitted, omega = s.fitOmega;
		var keepW = keep * 3;
		sum.fill(0); count.fill(0); fitted.fill(0);
		EventsPlates.dragFit(s, label, keep, omega, keepW);
		fitted[keep] = 1;
		for (var c = 0; c < g.V; c++) {
			if (label[c] !== keep) continue;
			var b = c * 3, x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2];
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, j = g.ring[e], lab = label[j];
				if (lab < 0 || lab === keep) continue;
				if (!fitted[lab]) { EventsPlates.dragFit(s, label, lab, omega, lab * 3); fitted[lab] = 1; }
				var jb = j * 3;
				var dx = g.pos[jb] - x, dy = g.pos[jb + 1] - y, dz = g.pos[jb + 2] - z;
				var radial = dx * x + dy * y + dz * z;
				dx -= x * radial; dy -= y * radial; dz -= z * radial;
				var len = Math.hypot(dx, dy, dz);
				if (len < 1e-9) continue;
				var l3 = lab * 3;
				var wx = omega[l3] - omega[keepW], wy = omega[l3 + 1] - omega[keepW + 1], wz = omega[l3 + 2] - omega[keepW + 2];
				var vx = wy * z - wz * y, vy = wz * x - wx * z, vz = wx * y - wy * x;
				var open = R * (vx * dx + vy * dy + vz * dz) / len, L = g.edgeLen[e];
				if (open > 0) sum[lab] += open * L;
				count[lab] += L;
			}
		}
	},
	// Design §5: a damaged corridor that cuts a plate in two makes the smaller pieces new
	// plates. They inherit q and ω, so the crust does not move at the instant of the split;
	// K10 then gives each half the rotation of the flow beneath it, which is what opens the rift.
	split: function (s) {
		var g = s.grid, nP = s.plateCount, min = Events.minCells(s), corridor = s.corridor, label = s.compLabel;
		var c, i;
		for (var plate = 0; plate < nP; plate++) {
			if (s.plateCells[plate] < 2 * min) continue;
			// A plate that has just rifted has a warm, healing margin: the next weak zone takes
			// tens of Myr to accumulate, which is what keeps splits from cascading.
			if (s.t - s.plateBirth[plate] < EventsParams.splitAge) continue;
			var nComp = Events.components(s, plate);
			if (nComp < 2) continue;
			// A corridor that covers most of the plate is diffuse weakening, not a rift: cutting
			// along it would shred the plate instead of opening one ocean.
			var cells = 0, corridorCells = 0;
			for (c = 0; c < g.V; c++) {
				if (s.cellPlate[c] !== plate) continue;
				cells++;
				corridorCells += corridor[c];
			}
			if (corridorCells * 2 > cells) continue;
			var big = 0, biggest = -1, biggestSize = 0;
			for (i = 0; i < nComp; i++) {
				if (s.compSize[i] < min) continue;
				big++;
				if (s.compSize[i] > biggestSize) { biggestSize = s.compSize[i]; biggest = i; }
			}
			if (big < 2 || biggest < 0) continue;
			// Pieces too small to be a plate are unlabelled, so the next pass folds their cells
			// (and the corridor) into whichever surviving piece is nearest.
			for (c = 0; c < g.V; c++) {
				if (label[c] < 0 || s.compSize[label[c]] >= min) continue;
				label[c] = -1;
			}
			Events.assignRest(s, plate);
			Events.opening(s, biggest);
			var map = s.compPlate, made = 0;
			for (i = 0; i < nComp; i++) map[i] = -1;
			map[biggest] = plate;
			for (i = 0; i < nComp && made < Events.MAX_PARTS - 1; i++) {
				if (i === biggest || s.compSize[i] < min) continue;
				if (!(s.openLen[i] > 0) || s.openSum[i] / s.openLen[i] < EventsParams.vRift) continue;
				var np = Events.newPlate(s, plate);
				if (np < 0) break;
				map[i] = np; made++;
			}
			if (!made) continue;
			for (i = 0; i < s.n; i++) {
				if (!s.alive[i] || s.plate[i] !== plate) continue;
				var cell = s.cell[i];
				if (cell < 0 || label[cell] < 0 || map[label[cell]] < 0) continue;
				s.plate[i] = map[label[cell]];
				if (corridor[cell]) s.damage[i] = EventsParams.splitDamage * 0.5;
			}
			s.splits += made;
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Events;

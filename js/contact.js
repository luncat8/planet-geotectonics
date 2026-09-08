var ContactParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var ContactQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var ContactMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var ContactEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var ContactGrid = typeof module !== 'undefined' && module.exports ? require('./geodesics.js') : Grid;
// K6 CONTACT (scan: mark own records) and K7 APPLY (gather from marked records).
// Every cross-column transfer is a mark here plus a pull there, so the GPU port needs no
// atomics in the state path and the CPU result does not depend on traversal order.
var Contact = {
	hash: function (cell, frame) {
		var h = Math.imul(cell ^ 0x9E3779B1, 0x85EBCA6B) ^ Math.imul(frame + 1, 0xC2B2AE35);
		return (h ^ (h >>> 15)) >>> 0;
	},
	// Total order on columns, so "loses to" is transitive and consumedBy chains cannot cycle:
	// continental beats oceanic, younger oceanic beats older, thicker continental beats thinner.
	loser: function (s, i, j) {
		var ocean = ContactParams.hOceanic;
		var oi = s.hFel[i] < ocean, oj = s.hFel[j] < ocean;
		if (oi !== oj) return oi ? i : j;
		if (oi) return s.age[i] !== s.age[j] ? (s.age[i] > s.age[j] ? i : j) : (i < j ? i : j);
		if (s.hFel[i] !== s.hFel[j]) return s.hFel[i] < s.hFel[j] ? i : j;
		var ci = s.plateCells[s.plate[i]], cj = s.plateCells[s.plate[j]];
		if (ci !== cj) return ci < cj ? i : j;
		return i < j ? i : j;
	},
	// Overlaps: the nearest foreign column inside rContact·d that is closing in. The pair's own
	// relative velocity is the test, not the cell-edge type, so it does not care how the two
	// columns happen to fall into cells.
	overlaps: function (s) {
		var g = s.grid, R = ContactParams.radius, hi = ContactParams.epsHi;
		s.consumedBy.fill(-1);
		s.overlaps = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var c = s.cell[i];
			if (c < 0) continue;
			var wi = i * 3, wx = s.world[wi], wy = s.world[wi + 1], wz = s.world[wi + 2];
			var limit = ContactGrid.chord(ContactParams.rContact * g.nbrDist[c]);
			var best = limit * limit, other = -1;
			var dx = 0, dy = 0, dz = 0, own = s.plate[i];
			for (var k = -1; k < g.ringN[c]; k++) {
				var bin = k < 0 ? c : g.ring[c * 6 + k];
				for (var at = s.offset[bin]; at < s.offset[bin + 1]; at++) {
					var j = s.entries[at];
					if (j === i || s.plate[j] === own) continue;
					var wj = j * 3;
					var ex = s.world[wj] - wx, ey = s.world[wj + 1] - wy, ez = s.world[wj + 2] - wz;
					var d = ex * ex + ey * ey + ez * ez;
					if (d >= best) continue;
					best = d; other = j; dx = ex; dy = ey; dz = ez;
				}
			}
			if (other < 0) continue;
			var inv = 1 / Math.sqrt(best), wj2 = other * 3;
			var nx = dx * inv, ny = dy * inv, nz = dz * inv;
			var xj = s.world[wj2], yj = s.world[wj2 + 1], zj = s.world[wj2 + 2];
			var a = s.plate[i] * 3, b = s.plate[other] * 3;
			var closing = (s.omega[b + 1] * zj - s.omega[b + 2] * yj - s.omega[a + 1] * wz + s.omega[a + 2] * wy) * nx
				+ (s.omega[b + 2] * xj - s.omega[b] * zj - s.omega[a + 2] * wx + s.omega[a] * wz) * ny
				+ (s.omega[b] * yj - s.omega[b + 1] * xj - s.omega[a] * wy + s.omega[a + 1] * wx) * nz;
			if (R * closing > -hi) continue;
			if (Contact.loser(s, i, other) !== i) continue;
			s.consumedBy[i] = other;
			s.overlaps++;
		}
	},
	// Cells within two hops, flat and with repeats: a repeated column only loses its own
	// distance comparison, and a donor one cell outside the ring is what a fresh gap needs.
	ringCells: function (s, c, out) {
		var g = s.grid, n = 0;
		out[n++] = c;
		for (var k = 0; k < g.ringN[c]; k++) {
			var j = g.ring[c * 6 + k];
			out[n++] = j;
			for (var k2 = 0; k2 < g.ringN[j]; k2++) out[n++] = g.ring[j * 6 + k2];
		}
		return n;
	},
	// Gaps: a cell that stayed uncovered long enough spawns one column at its centre.
	gaps: function (s, dt) {
		var g = s.grid, p = ContactParams;
		s.spawns = 0;
		s.spawnSlot.fill(-1);
		for (var c = 0; c < g.V; c++) {
			if (s.owner[c] >= 0) { s.gapFrames[c] = 0; s.gapTime[c] = 0; continue; }
			if (s.gapFrames[c] < 65535) s.gapFrames[c]++;
			s.gapTime[c] += dt;
			if (s.gapFrames[c] < p.gapPersist) continue;
			// A cell only spawns once it is empty by rSpawn. At the 0.75 raster threshold the two
			// cells of an opening pair gap in the same frame and each spawns, which creates 33 %
			// more crust than the divergence flux can pay for. A cell that stays empty far longer
			// than a rift takes to open is a packing hole in fresh crust instead: fill it.
			if (s.distance[c] <= p.rSpawn * g.nbrDist[c] && s.gapTime[c] < p.fillDelay) continue;
			var b = c * 3, px = g.pos[b], py = g.pos[b + 1], pz = g.pos[b + 2];
			var h = Contact.hash(c, s.frame), best = Infinity, near = -1, q, at, j, w, dx, dy, dz, d;
			var scan = s.gapScan, bins = Contact.ringCells(s, c, scan);
			for (q = 0; q < bins; q++) {
				var bin = scan[q];
				for (at = s.offset[bin]; at < s.offset[bin + 1]; at++) {
					j = s.entries[at]; w = j * 3;
					dx = s.world[w] - px; dy = s.world[w + 1] - py; dz = s.world[w + 2] - pz;
					d = dx * dx + dy * dy + dz * dz;
					if (d > best || (d === best && ((j ^ h) >>> 0) > ((near ^ h) >>> 0))) continue;
					best = d; near = j;
				}
			}
			if (near < 0) continue;
			var plate = s.plate[near];
			var d0 = Infinity, i0 = -1, d1 = Infinity, i1 = -1, d2 = Infinity, i2 = -1, foreign = Infinity;
			for (q = 0; q < bins; q++) {
				var bin2 = scan[q];
				for (at = s.offset[bin2]; at < s.offset[bin2 + 1]; at++) {
					j = s.entries[at]; w = j * 3;
					dx = s.world[w] - px; dy = s.world[w + 1] - py; dz = s.world[w + 2] - pz;
					d = dx * dx + dy * dy + dz * dz;
					if (s.plate[j] !== plate) { if (d < foreign) foreign = d; continue; }
					if (d < d0) { d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = j; }
					else if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = j; }
					else if (d < d2) { d2 = d; i2 = j; }
				}
			}
			// An opposing plate already in contact would turn the newborn into an overlap next
			// frame: spawn/consume oscillation at slow boundaries. Leave the cell empty instead.
			var reach = ContactGrid.chord(p.rContact * g.nbrDist[c]);
			if (i0 < 0 || foreign <= reach * reach) continue;
			if (s.n + s.spawns >= s.colCap) break;
			var slot = s.n + s.spawns++;
			s.spawnSlot[c] = slot;
			s.gapPlate[c] = plate;
			s.gapDonor[c * 3] = i0; s.gapDonor[c * 3 + 1] = i1; s.gapDonor[c * 3 + 2] = i2;
			s.gapDonorN[c] = (i0 >= 0) + (i1 >= 0) + (i2 >= 0);
		}
	},
	scan: function (s, dt) {
		Contact.overlaps(s);
		Contact.gaps(s, dt);
	},
	// A winner may itself be a loser. Redirect to the root winner; the order above makes the
	// chain finite, and the mass simply follows it.
	resolve: function (s) {
		for (var i = 0; i < s.n; i++) {
			var w = s.consumedBy[i];
			if (w < 0) continue;
			while (s.consumedBy[w] >= 0) w = s.consumedBy[w];
			s.consumedBy[i] = w;
		}
	},
	// Winners gather from their losers. Losers are bucketed by winner with a counting sort, so
	// each merged column is visited exactly once and in winner order.
	gather: function (s) {
		var g = s.grid, p = ContactParams, A0 = s.A0ref, ocean = p.hOceanic;
		var start = s.loserStart, cursor = s.loserCursor, list = s.loserList;
		var i, w;
		start.fill(0);
		for (i = 0; i < s.n; i++) {
			w = s.consumedBy[i];
			if (w >= 0) start[w + 1]++;
		}
		for (w = 0; w < s.n; w++) start[w + 1] += start[w];
		for (w = 0; w <= s.n; w++) cursor[w] = start[w];
		for (i = 0; i < s.n; i++) {
			w = s.consumedBy[i];
			if (w >= 0) list[cursor[w]++] = i;
		}
		for (w = 0; w < s.n; w++) {
			for (var at = start[w]; at < start[w + 1]; at++) {
				var l = list[at];
				if (s.hFel[w] >= ocean && s.hFel[l] >= ocean) {
					// Continental collision: crust is preserved, the older lithosphere survives,
					// and the loser's mafic root delaminates into the mantle.
					s.hFel[w] += s.hFel[l];
					s.hSed[w] += s.hSed[l];
					s.subductedMaf += s.hMaf[l] * A0;
					if (s.age[l] > s.age[w]) s.age[w] = s.age[l];
				} else {
					// Felsic crust is too buoyant to subduct: it accretes onto the overriding
					// plate, which keeps Σ hFel sourced only by arc production.
					s.hFel[w] += s.hFel[l];
					s.hSed[w] += p.sedScrape * s.hSed[l];
					s.subductedSed += (1 - p.sedScrape) * s.hSed[l] * A0;
					s.subductedMaf += s.hMaf[l] * A0;
					s.subductedArea += A0;
				}
				s.alive[l] = 0;
				s.cell[l] = -1;
				s.deaths++;
				s.plateLost[s.plate[l]]++;
			}
		}
		// Cells of a deleted column are gaps for the rest of this frame; the next raster gives
		// them to the winner. A one-frame gap never reaches the spawn threshold.
		for (var c = 0; c < g.V; c++) {
			var o = s.owner[c];
			if (o >= 0 && !s.alive[o]) { s.owner[c] = -1; s.gaps++; }
		}
	},
	// Subduction feeds the overriding plate: trench load on the boundary cells, arc crust on the
	// cells one and two rings behind it, at a rate set by that plate's mean closing speed.
	arcs: function (s, dt) {
		var g = s.grid, p = ContactParams, A0 = s.A0ref, nP = s.plateCount;
		var relax = Math.min(1, dt / p.tauDyn);
		s.subRate.fill(0); s.subCount.fill(0);
		for (var c = 0; c < g.V; c++) {
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k;
				if (s.edgeType[e] !== ContactEdges.CONVERGENT || s.polarity[e] !== 1) continue;
				var over = s.cellPlate[c];
				if (over >= nP) continue;
				s.subRate[over] -= s.relN[e];
				s.subCount[over]++;
			}
		}
		for (var q = 0; q < nP; q++) if (s.subCount[q]) s.subRate[q] /= s.subCount[q];
		for (var c2 = 0; c2 < g.V; c2++) {
			var o = s.owner[c2];
			if (o < 0) continue;
			var rate = s.plate[o] < nP ? s.subRate[s.plate[o]] / p.vRef : 0;
			if (rate <= 0) continue;
			var dist = s.trenchDist[c2];
			if (dist === 0) { s.zDyn[o] -= p.zTrench * relax; continue; }
			if (dist > 2) continue;
			var dh = p.kArc * s.Tm * rate * dt;
			s.hFel[o] += dh;
			s.hMaf[o] += p.arcMafShare * dh;
			s.producedFel += dh * A0;
			s.producedMaf += p.arcMafShare * dh * A0;
		}
	},
	spawn: function (s) {
		var g = s.grid, p = ContactParams, A0 = s.A0ref, k, d;
		for (var c = 0; c < g.V; c++) {
			var slot = s.spawnSlot[c];
			if (slot < 0) continue;
			var b = c * 3, w = slot * 3, plate = s.gapPlate[c], K = s.gapDonorN[c];
			var meanFel = 0;
			for (k = 0; k < K; k++) meanFel += s.hFel[s.gapDonor[c * 3 + k]];
			ContactQuat.rotateInv(s.body, w, s.q, plate * 4, g.pos, b);
			s.world[w] = g.pos[b]; s.world[w + 1] = g.pos[b + 1]; s.world[w + 2] = g.pos[b + 2];
			s.plate[slot] = plate; s.cell[slot] = c; s.area[slot] = g.A0[c];
			s.plateSpawned[plate]++;
			s.age[slot] = 0; s.zDyn[slot] = 0; s.alive[slot] = 1; s.consumedBy[slot] = -1;
			if (meanFel / K < p.hRiftBreakup) {
				// Oceanic crust from the mantle; the donors keep their crust untouched.
				s.hFel[slot] = 0; s.hSed[slot] = 0;
				s.hMaf[slot] = ContactMantle.hMafNew(s.Tm);
				s.damage[slot] = 0;
				s.producedMaf += s.hMaf[slot] * A0;
				continue;
			}
			// Rifting stretches existing crust: the newborn takes 1/(K+1) of each donor, and the
			// donors lose exactly the amount it gains.
			var share = 1 / (K + 1), newFel = 0, newSed = 0;
			for (k = 0; k < K; k++) {
				d = s.gapDonor[c * 3 + k];
				var giveFel = share * s.hFel[d], giveSed = share * s.hSed[d];
				newFel += giveFel; newSed += giveSed;
				s.hFel[d] -= giveFel; s.hSed[d] -= giveSed;
			}
			s.hFel[slot] = newFel; s.hSed[slot] = newSed; s.hMaf[slot] = 0;
			s.damage[slot] = p.riftDamage;
		}
		s.n += s.spawns;
	},
	apply: function (s, dt) {
		Contact.resolve(s);
		Contact.gather(s);
		Contact.arcs(s, dt);
		Contact.spawn(s);
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Contact;

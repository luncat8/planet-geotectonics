var ContactParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var ContactQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var ContactMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var ContactEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
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
	// Two columns of equal nominal area merge into one: potentials average, they do not sum.
	meanOre: function (s, w, l) {
		s.oVms[w] = 0.5 * (s.oVms[w] + s.oVms[l]); s.oMaf[w] = 0.5 * (s.oMaf[w] + s.oMaf[l]);
		s.oArc[w] = 0.5 * (s.oArc[w] + s.oArc[l]); s.oOro[w] = 0.5 * (s.oOro[w] + s.oOro[l]);
		s.oBas[w] = 0.5 * (s.oBas[w] + s.oBas[l]); s.oPla[w] = 0.5 * (s.oPla[w] + s.oPla[l]);
	},
	// Overlaps: the nearest foreign column inside rContact·d that is closing in. The pair's own
	// relative velocity is the test, not the cell-edge type, so it does not care how the two
	// columns happen to fall into cells.
	overlaps: function (s) {
		var g = s.grid, R = ContactParams.radius;
		s.consumedBy.fill(-1);
		s.overlaps = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var c = s.cell[i];
			if (c < 0) continue;
			var wi = i * 3, wx = s.world[wi], wy = s.world[wi + 1], wz = s.world[wi + 2];
			var best = s.contactLimit2[c], other = -1;
			var dx = 0, dy = 0, dz = 0, own = s.plate[i];
			for (var k = -1; k < g.ringN[c]; k++) {
				var bin = k < 0 ? c : g.ring[c * 6 + k];
				for (var at = s.offset[bin]; at < s.offset[bin + 1]; at++) {
					var j = s.entries[at];
					if (j === i || s.plate[j] === own) continue;
					var wj = j * 3;
					var ex = s.world[wj] - wx, ey = s.world[wj + 1] - wy, ez = s.world[wj + 2] - wz;
					var d = ex * ex + ey * ey + ez * ez;
					if (d >= best || d <= 0) continue;
					var invD = 1 / Math.sqrt(d), nxD = ex * invD, nyD = ey * invD, nzD = ez * invD;
					var aD = s.plate[i] * 3, bD = s.plate[j] * 3;
					var closingD = (s.omega[bD + 1] * s.world[wj + 2] - s.omega[bD + 2] * s.world[wj + 1]
						- s.omega[aD + 1] * wz + s.omega[aD + 2] * wy) * nxD
						+ (s.omega[bD + 2] * s.world[wj] - s.omega[bD] * s.world[wj + 2]
						- s.omega[aD + 2] * wx + s.omega[aD] * wz) * nyD
						+ (s.omega[bD] * s.world[wj + 1] - s.omega[bD + 1] * s.world[wj]
						- s.omega[aD] * wy + s.omega[aD + 1] * wx) * nzD;
					// Any convergence consumes (design §4.1: every overlap removes one column;
					// the removal rate is the full relative speed). Gating on epsHi starved
					// sub-threshold convergence instead, and a boundary closing at just under
					// epsHi interpenetrated ~2 km/Myr: ghost columns passed through each other
					// and shredded both plates into interleaved strips.
					if (R * closingD > 0) continue;
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
			if (R * closing > 0) continue;
			if (Contact.loser(s, i, other) !== i) continue;
			s.consumedBy[i] = other;
			s.overlaps++;
		}
	},
	// Cells within two hops, unique, in first-occurrence order: a repeated column only loses
	// its own distance comparison, and a donor one cell outside the ring is what a fresh gap
	// needs. Uniqueness matters twice over: a donor appearing in two slots of the top-3 would
	// be charged two shares, and the donor-side thinning gather must see each request once.
	ringCells: function (s, c, out) {
		var g = s.grid, n = 0, q, k, k2, j;
		out[n++] = c;
		for (k = 0; k < g.ringN[c]; k++) {
			j = g.ring[c * 6 + k];
			out[n++] = j;
			for (k2 = 0; k2 < g.ringN[j]; k2++) out[n++] = g.ring[j * 6 + k2];
		}
		var u = 0;
		for (q = 0; q < n; q++) {
			var v = out[q], seen = false;
			for (k = 0; k < u; k++) if (out[k] === v) { seen = true; break; }
			if (!seen) out[u++] = v;
		}
		return u;
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
				// Donor order is a total order (distance, index): equal distances keep the
				// smaller column, so the pick does not depend on the bin walk order.
				if (d < d0 || (d === d0 && j < i0)) { d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = j; }
				else if (d < d1 || (d === d1 && j < i1)) { d2 = d1; i2 = i1; d1 = d; i1 = j; }
				else if (d < d2 || (d === d2 && j < i2)) { d2 = d; i2 = j; }
				}
			}
			// An opposing plate already in contact would turn the newborn into an overlap next
			// frame: spawn/consume oscillation at slow boundaries. Leave the cell empty instead.
			if (i0 < 0 || foreign <= s.contactLimit2[c]) continue;
			if (s.n + s.spawns >= s.colCap) break;
			var slot = s.n + s.spawns++;
			s.spawnSlot[c] = slot;
			s.gapPlate[c] = plate;
			s.gapDonor[c * 3] = i0; s.gapDonor[c * 3 + 1] = i1; s.gapDonor[c * 3 + 2] = i2;
			s.gapDonorN[c] = (i0 >= 0) + (i1 >= 0) + (i2 >= 0);
		}
	},
	// The fastest opening rate around a gap cell, read from the ridge flanks that bound it:
	// the gap cell itself has no owner yet, so its own edges were never classified.
	spread: function (s, c) {
		var g = s.grid, best = 0;
		for (var k = -1; k < g.ringN[c]; k++) {
			var bin = k < 0 ? c : g.ring[c * 6 + k];
			for (var j = 0; j < g.ringN[bin]; j++) {
				var e = bin * 6 + j;
				if (s.edgeType[e] === ContactEdges.DIVERGENT && s.relN[e] > best) best = s.relN[e];
			}
		}
		return best;
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
		s.arcFeed.fill(0); s.arcFeedN.fill(0);
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
					Contact.meanOre(s, w, l);
				} else {
					// Felsic crust is too buoyant to subduct: it accretes onto the overriding
					// plate, which keeps Σ hFel sourced only by arc production.
					s.hFel[w] += s.hFel[l];
					s.hSed[w] += p.sedScrape * s.hSed[l];
					s.subductedSed += (1 - p.sedScrape) * s.hSed[l] * A0;
					s.subductedMaf += s.hMaf[l] * A0;
					s.subductedArea += A0;
					// What goes down the trench is the arc's raw material (design §8 recycling
					// enrichment), booked per overriding plate for Contact.arcs.
					var q = s.plate[w];
					s.arcFeed[q] += s.oVms[l] + s.oBas[l] + s.hSed[l] / 1000;
					s.arcFeedN[q]++;
				}
			s.alive[l] = 0;
			s.cell[l] = -1;
			// A dead slot must read as empty: spawn below takes a share of its donors, and a
			// stale thickness on a consumed column would be handed out a second time.
			s.hFel[l] = 0; s.hMaf[l] = 0; s.hSed[l] = 0; s.damage[l] = 0;
			s.fert[l] = 0; s.oVms[l] = 0; s.oMaf[l] = 0; s.oArc[l] = 0;
			s.oOro[l] = 0; s.oBas[l] = 0; s.oPla[l] = 0;
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
	// The apply pass is a per-column gather over the cells raster can own (own cell plus its
	// ring): 15 % of columns own several cells, and each owned arc cell grows its owner.
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
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var q2 = s.plate[i];
			if (q2 >= nP) continue;
			var rate = s.subRate[q2] / p.vRef;
			if (rate <= 0) continue;
			var cell = s.cell[i];
			if (cell < 0) continue;
			var fed = s.arcFeedN[q2];
			var feed = fed ? p.kRec * s.arcFeed[q2] / fed : 0;
			for (var k2 = -1; k2 < g.ringN[cell]; k2++) {
				var c2 = k2 < 0 ? cell : g.ring[cell * 6 + k2];
				if (s.owner[c2] !== i) continue;
				var dist = s.trenchDist[c2];
				if (dist === 0) { s.zDyn[i] -= p.zTrench * relax; continue; }
				if (dist > 2) continue;
				var dh = p.kArc * s.Tm * rate * dt;
				s.hFel[i] += dh;
				s.hMaf[i] += p.arcMafShare * dh;
				s.producedFel += dh * A0;
				s.producedMaf += p.arcMafShare * dh * A0;
				// Porphyry/epithermal potential, enriched by what this plate is subducting.
				// The recycling feed carries hSed in kilometres, so the per-frame gain is not
				// bounded by construction; cap the dose at 1 to keep the potential at most 1.
				s.oArc[i] += (1 - s.oArc[i])
					* Math.min(1, p.kA * s.Tm * rate * (1 + feed) * s.fert[i] * dt);
			}
		}
	},
	spawn: function (s) {
		var g = s.grid, p = ContactParams, A0 = s.A0ref, k, d;
		s.riftZone.fill(0);
		for (var c = 0; c < g.V; c++) {
			var slot = s.spawnSlot[c];
			if (slot < 0) continue;
			var b = c * 3, w = slot * 3, plate = s.gapPlate[c];
			// A donor can be consumed by this frame's APPLY between scan and spawn. It has
			// nothing left to give, so it is dropped from the share as well as from the mean.
			// gapDonorN records the surviving count, or 255 when the newborn is oceanic.
			var K = 0, meanFel = 0;
			for (k = 0; k < 3; k++) {
				d = s.gapDonor[c * 3 + k];
				if (d < 0 || !s.alive[d]) continue;
				K++;
				meanFel += s.hFel[d];
			}
			ContactQuat.rotateInv(s.body, w, s.q, plate * 4, g.pos, b);
			s.world[w] = g.pos[b]; s.world[w + 1] = g.pos[b + 1]; s.world[w + 2] = g.pos[b + 2];
			s.plate[slot] = plate; s.cell[slot] = c; s.area[slot] = g.A0[c];
			s.plateSpawned[plate]++;
			s.age[slot] = 0; s.zDyn[slot] = 0; s.alive[slot] = 1; s.consumedBy[slot] = -1;
			s.fert[slot] = p.fertLo + (1 - p.fertLo) * (Contact.hash(c, s.frame) >>> 8) / 0xffffff;
			s.oVms[slot] = 0; s.oMaf[slot] = 0; s.oArc[slot] = 0;
			s.oOro[slot] = 0; s.oBas[slot] = 0; s.oPla[slot] = 0;
			if (!K || meanFel / K < p.hRiftBreakup) {
				// Oceanic crust from the mantle; the donors keep their crust untouched. VMS is a
				// one-shot at birth scaled by the spreading rate the ridge flanks are opening at.
				s.gapDonorN[c] = 255;
				s.hFel[slot] = 0; s.hSed[slot] = 0;
				s.hMaf[slot] = ContactMantle.hMafNew(s.Tm);
				s.damage[slot] = 0;
				s.producedMaf += s.hMaf[slot] * A0;
				s.oVms[slot] = p.kV * s.Tm * Math.min(1, Contact.spread(s, c) / p.vRef) * s.fert[slot];
				continue;
			}
			// Rifting stretches existing crust: each donor gives 1/(K+1) of what it holds
			// before any thinning, so every share is computed from the same pre-rift stock.
			// The newborn's gain and the donors' losses are the same terms, which keeps the
			// ledger exact however many rift cells share one donor — both sides are then
			// independent gathers with no ordering between them, which the GPU port needs.
			s.gapDonorN[c] = K;
			var share = 1 / (K + 1), newFel = 0, newSed = 0;
			for (k = 0; k < 3; k++) {
				d = s.gapDonor[c * 3 + k];
				if (d < 0 || !s.alive[d]) continue;
				newFel += share * s.hFel[d];
				newSed += share * s.hSed[d];
			}
			s.hFel[slot] = newFel; s.hSed[slot] = newSed; s.hMaf[slot] = 0;
			s.damage[slot] = p.riftDamage;
			// Rifted continental crust carries its Ni-Cu-PGE endowment with it.
			s.oMaf[slot] = p.kM2 * s.fert[slot];
			// Mark the cells a donor of this newborn can live in (the gap scan's two-hop
			// reach), so the thinning pass below only walks columns near an open rift.
			var scan = s.gapScan, bins = Contact.ringCells(s, c, scan);
			for (var q = 0; q < bins; q++) s.riftZone[scan[q]] = 1;
		}
	},
	// The donor side of rifting: a donor gives a share to every newborn gap cell that picked
	// it. All of a donor's requests lie within two hops of its own cell, so the loss is a
	// gather over that fixed candidate set — no per-newborn writer ever touches a donor.
	thinning: function (s) {
		var g = s.grid, scan = s.gapScan;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var cell = s.cell[i];
			if (cell < 0 || !s.riftZone[cell]) continue;
			var bins = Contact.ringCells(s, cell, scan), lossFel = 0, lossSed = 0;
			for (var q = 0; q < bins; q++) {
				var c = scan[q];
				if (s.spawnSlot[c] < 0 || s.gapDonorN[c] === 255) continue;
				var share = 1 / (s.gapDonorN[c] + 1), gives = false;
				for (var k = 0; k < 3; k++) if (s.gapDonor[c * 3 + k] === i) gives = true;
				if (!gives) continue;
				lossFel += s.hFel[i] * share;
				lossSed += s.hSed[i] * share;
			}
			if (!(lossFel > 0)) continue;
			s.hFel[i] -= lossFel;
			s.hSed[i] -= lossSed;
		}
	},
	apply: function (s, dt) {
		Contact.resolve(s);
		Contact.gather(s);
		Contact.arcs(s, dt);
		Contact.spawn(s);
		Contact.thinning(s);
		s.n += s.spawns;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Contact;

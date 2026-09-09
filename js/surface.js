var SurfaceParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// K9 SURFACE: elevation, flexure, one-hop sediment routing. Cell buffers are gathered in
// ascending cell order; column fields are only changed by the owning cell, so the result is
// independent of traversal order and has no per-frame allocation.
var Surface = {
	smoothstep: function (x, lo, hi) {
		var t = (x - lo) / (hi - lo);
		t = Math.max(0, Math.min(1, t));
		return t * t * (3 - 2 * t);
	},
	updateDynamics: function (s, dt) {
		if (!(dt > 0)) return;
		var p = SurfaceParams, g = s.grid, invTau = 1 / p.tauDyn, plumeRelax = Math.min(1, dt / p.tauPlume);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var cell = s.cell[i], lap = 0;
			if (cell >= 0) {
				for (var k = 0; k < g.ringN[cell]; k++) {
					var j = g.ring[cell * 6 + k], oj = s.owner[j];
					if (oj >= 0 && oj !== i) lap += s.zDyn[oj] - s.zDyn[i];
				}
			}
			var next = s.zDyn[i] * Math.exp(-dt * invTau) + p.kFlex * dt * lap;
			var heat = cell >= 0 ? s.plumeT[cell] : 0;
			var target = p.zPlume * Math.max(0, Math.min(1, heat));
			next += (target - next) * plumeRelax;
			s.zDynNext[i] = next;
		}
		for (var i2 = 0; i2 < s.n; i2++) if (s.alive[i2]) s.zDyn[i2] = s.zDynNext[i2];
	},
	elevation: function (s, gradient) {
		var g = s.grid, p = SurfaceParams, R = p.radius, inv = g.gradInv;
		for (var c = 0; c < g.V; c++) {
			var o = s.owner[c];
			if (o < 0) {
				s.z[c] = NaN; s.wet[c] = 0; s.gradZ[c * 3] = 0; s.gradZ[c * 3 + 1] = 0; s.gradZ[c * 3 + 2] = 0;
				s.slope[c] = 0; s.low[c] = -1;
				continue;
			}
			var felsic = s.hFel[o], ci = Surface.smoothstep(felsic, 5000, 20000);
			var thermal = (1 - ci) * 350 * Math.sqrt(Math.min(s.age[o], 80)) + ci * 2091;
			s.z[c] = -3342 + felsic / 6 + (s.hMaf[o] * 350 + s.hSed[o] * 900) / 3300 - thermal + s.zDyn[o];
			s.wet[c] = s.z[c] < 0 ? 1 : 0;
		}
		if (gradient === false) return;
		for (var c2 = 0; c2 < g.V; c2++) {
			var b = c2 * 3, zi = s.z[c2];
			if (zi !== zi) continue;
			var x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2], bx = 0, by = 0, bz = 0, low = -1, lowZ = Infinity;
			for (var k2 = 0; k2 < g.ringN[c2]; k2++) {
				var j2 = g.ring[c2 * 6 + k2], zj = s.z[j2], jb = j2 * 3;
				if (zj !== zj) continue;
				var dz = zj - zi;
				bx += dz * g.pos[jb]; by += dz * g.pos[jb + 1]; bz += dz * g.pos[jb + 2];
				if (zj < lowZ || (zj === lowZ && j2 < low)) { low = j2; lowZ = zj; }
			}
			var i9 = c2 * 9;
			var gx = inv[i9] * bx + inv[i9 + 1] * by + inv[i9 + 2] * bz;
			var gy = inv[i9 + 3] * bx + inv[i9 + 4] * by + inv[i9 + 5] * bz;
			var gz = inv[i9 + 6] * bx + inv[i9 + 7] * by + inv[i9 + 8] * bz;
			var radial = gx * x + gy * y + gz * z;
			gx = (gx - x * radial) / R; gy = (gy - y * radial) / R; gz = (gz - z * radial) / R;
			s.gradZ[b] = gx; s.gradZ[b + 1] = gy; s.gradZ[b + 2] = gz;
			s.slope[c2] = Math.sqrt(gx * gx + gy * gy + gz * gz); s.low[c2] = low;
		}
	},
	// Erosion is taken in the order sediment, felsic crust, mafic crust. The signed production
	// ledgers include crust that has become mobile sediment, preserving the Phase C checks while
	// the total hFel+hMaf+hSed+mobile ledger remains exact through deposition.
	// Gather form (design §2): 15 % of columns own more than one cell, so a per-cell writer
	// would race on the column (and depend on traversal order). Each column instead walks the
	// cells raster can give it — its own cell and that cell's ring — and takes from its own
	// stock in that fixed order; what it took is left on the cell for the routing passes.
	route: function (s, dt) {
		var g = s.grid, p = SurfaceParams;
		s.eroSed.fill(0); s.eroFel.fill(0); s.eroPla.fill(0);
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			var cell = s.cell[i];
			if (cell < 0) continue;
			for (var k = -1; k < g.ringN[cell]; k++) {
				var c = k < 0 ? cell : g.ring[cell * 6 + k];
				if (s.owner[c] !== i || s.z[c] <= 0) continue;
				var want = p.kEro * s.z[c] * (1 + 2 * s.slope[c] / p.slopeRef) * dt;
				var takeSed = Math.min(want, s.hSed[i]);
				s.hSed[i] -= takeSed; want -= takeSed;
				var takeFel = Math.min(want, s.hFel[i]);
				s.hFel[i] -= takeFel; want -= takeFel;
				var takeMaf = Math.min(want, s.hMaf[i]);
				s.hMaf[i] -= takeMaf;
				var eroded = takeSed + takeFel + takeMaf;
				s.eroSed[c] = eroded;
				s.eroFel[c] = takeSed + takeFel;
				// Placer load is liberated in proportion to what the source column holds, so
				// oPla can only end up downslope of an oOro/oArc maximum (acceptance 5).
				s.eroPla[c] = p.kPlacer * eroded * 0.5 * (s.oOro[i] + s.oArc[i]);
				s.erodedFel += takeFel * s.A0ref; s.erodedMaf += takeMaf * s.A0ref;
				s.producedFel -= takeFel * s.A0ref; s.producedMaf -= takeMaf * s.A0ref;
			}
		}
		for (var c2 = 0; c2 < g.V; c2++) {
			var local = s.mobile[c2] + s.eroSed[c2], localFel = s.mobileFel[c2] + s.eroFel[c2], localPla = s.mobilePla[c2] + s.eroPla[c2];
			var low = s.low[c2], fraction = 0;
			if (low >= 0 && s.z[low] < s.z[c2] - p.deltaZ) fraction = s.wet[c2] ? 0.5 : 1;
			s.outflow[c2] = local * fraction; s.outflowFel[c2] = localFel * fraction; s.outflowPla[c2] = localPla * fraction;
			s.mobile[c2] = local - s.outflow[c2]; s.mobileFel[c2] = localFel - s.outflowFel[c2]; s.mobilePla[c2] = localPla - s.outflowPla[c2];
		}
		// Inflow in gather form: routing is one hop, so a cell can only receive from its ring.
		// Uncovered cells keep their load in mobile; an owned cell's load is claimed below.
		for (var c3 = 0; c3 < g.V; c3++) {
			var stay = s.mobile[c3], stayFel = s.mobileFel[c3], stayPla = s.mobilePla[c3];
			for (var k2 = 0; k2 < g.ringN[c3]; k2++) {
				var src = g.ring[c3 * 6 + k2];
				if (s.low[src] !== c3) continue;
				stay += s.outflow[src]; stayFel += s.outflowFel[src]; stayPla += s.outflowPla[src];
			}
			s.stay[c3] = stay; s.stayFel[c3] = stayFel; s.stayPla[c3] = stayPla;
			if (s.owner[c3] < 0) { s.mobile[c3] = stay; s.mobileFel[c3] = stayFel; s.mobilePla[c3] = stayPla; }
		}
		// Deposit pulls the stayed load of each owned cell into its column, in the same fixed
		// candidate order erosion used, so both sides of the transfer see one sequence.
		for (var i2 = 0; i2 < s.n; i2++) {
			if (!s.alive[i2]) continue;
			var cell2 = s.cell[i2];
			if (cell2 < 0) continue;
			for (var k3 = -1; k3 < g.ringN[cell2]; k3++) {
				var c4 = k3 < 0 ? cell2 : g.ring[cell2 * 6 + k3];
				if (s.owner[c4] !== i2) continue;
				var stay2 = s.stay[c4], stayFel2 = s.stayFel[c4], stayPla2 = s.stayPla[c4];
				s.hSed[i2] += stay2;
				// Basin and placer potentials from what actually lands here, only in a
				// submerged or low cell; mFel is the non-mafic share of the deposit.
				if (stay2 > 0 && s.z[c4] < p.zBasin) {
					// A deposit is a dose, not a rate: one frame can dump kilometres of
					// sediment that sat mobile in a gap, so the dose is capped at 1 before
					// the (1 − o) factor or a single event overshoots saturation.
					s.oBas[i2] += (1 - s.oBas[i2])
						* Math.min(1, p.kB * stayFel2 * s.fert[i2]);
					if (stayPla2 > 0) {
						s.oPla[i2] += (1 - s.oPla[i2]) * Math.min(1, p.kB * stayPla2 * s.fert[i2]);
					}
				}
				s.mobile[c4] = 0; s.mobileFel[c4] = 0; s.mobilePla[c4] = 0;
			}
		}
	},
	// Basin potential for sediment that is thick and under water. This is a K9 job, not a K8
	// one: it reads the elevation and shore line this kernel has just computed, and K8 runs
	// before it, where a freshly loaded world would still read a stale, empty `wet`.
	basins: function (s, dt) {
		var p = SurfaceParams, gain = p.kB2 * dt;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i] || s.hSed[i] <= p.hBas) continue;
			var cell = s.cell[i];
			if (cell < 0 || !s.wet[cell]) continue;
			s.oBas[i] += (1 - s.oBas[i]) * gain * s.fert[i];
		}
	},
	step: function (s, dt) {
		Surface.updateDynamics(s, dt);
		Surface.elevation(s);
		if (dt > 0) Surface.basins(s, dt);
		if (dt > 0) {
			Surface.route(s, dt);
			// Deposits change z immediately for rendering. The slope is refreshed at the start of
			// the next frame; erosion per frame is small and this avoids a second graph gradient.
			Surface.elevation(s, false);
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Surface;

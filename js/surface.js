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
	route: function (s, dt) {
		var g = s.grid, p = SurfaceParams;
		s.inflow.fill(0); s.inflowFel.fill(0); s.inflowPla.fill(0);
		for (var c = 0; c < g.V; c++) {
			var o = s.owner[c], local = s.mobile[c], localFel = s.mobileFel[c], localPla = s.mobilePla[c];
			if (o >= 0 && s.z[c] > 0) {
				var want = p.kEro * s.z[c] * (1 + 2 * s.slope[c] / p.slopeRef) * dt;
				var takeSed = Math.min(want, s.hSed[o]);
				s.hSed[o] -= takeSed; want -= takeSed;
				var takeFel = Math.min(want, s.hFel[o]);
				s.hFel[o] -= takeFel; want -= takeFel;
				var takeMaf = Math.min(want, s.hMaf[o]);
				s.hMaf[o] -= takeMaf;
				var eroded = takeSed + takeFel + takeMaf;
				local += eroded; localFel += takeSed + takeFel;
				// Placer load is liberated in proportion to what the source column holds, so
				// oPla can only end up downslope of an oOro/oArc maximum (acceptance 5).
				localPla += p.kPlacer * eroded * 0.5 * (s.oOro[o] + s.oArc[o]);
				s.erodedFel += takeFel * s.A0ref; s.erodedMaf += takeMaf * s.A0ref;
				s.producedFel -= takeFel * s.A0ref; s.producedMaf -= takeMaf * s.A0ref;
			}
			var low = s.low[c], fraction = 0;
			if (low >= 0 && s.z[low] < s.z[c] - p.deltaZ) fraction = s.wet[c] ? 0.5 : 1;
			s.outflow[c] = local * fraction; s.outflowFel[c] = localFel * fraction; s.outflowPla[c] = localPla * fraction;
			s.mobile[c] = local - s.outflow[c]; s.mobileFel[c] = localFel - s.outflowFel[c]; s.mobilePla[c] = localPla - s.outflowPla[c];
		}
		for (var c2 = 0; c2 < g.V; c2++) {
			var target = s.low[c2];
			if (target < 0 || s.outflow[c2] === 0) continue;
			s.inflow[target] += s.outflow[c2]; s.inflowFel[target] += s.outflowFel[c2]; s.inflowPla[target] += s.outflowPla[c2];
		}
		for (var c3 = 0; c3 < g.V; c3++) {
			var stay = s.mobile[c3] + s.inflow[c3], stayFel = s.mobileFel[c3] + s.inflowFel[c3], stayPla = s.mobilePla[c3] + s.inflowPla[c3];
			var o3 = s.owner[c3];
			if (o3 >= 0) {
				s.hSed[o3] += stay;
				// Basin and placer potentials from what actually lands here, only in a
				// submerged or low cell; mFel is the non-mafic share of the deposit.
				if (stay > 0 && s.z[c3] < p.zBasin) {
					// A deposit is a dose, not a rate: one frame can dump kilometres of
					// sediment that sat mobile in a gap, so the dose is capped at 1 before
					// the (1 − o) factor or a single event overshoots saturation.
					s.oBas[o3] += (1 - s.oBas[o3])
						* Math.min(1, p.kB * stayFel * s.fert[o3]);
					if (stayPla > 0) {
						s.oPla[o3] += (1 - s.oPla[o3]) * Math.min(1, p.kB * stayPla * s.fert[o3]);
					}
				}
				s.mobile[c3] = 0; s.mobileFel[c3] = 0; s.mobilePla[c3] = 0;
			} else {
				s.mobile[c3] = stay; s.mobileFel[c3] = stayFel; s.mobilePla[c3] = stayPla;
			}
			s.inflow[c3] = 0; s.inflowFel[c3] = 0; s.inflowPla[c3] = 0;
			s.outflow[c3] = 0; s.outflowFel[c3] = 0; s.outflowPla[c3] = 0;
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

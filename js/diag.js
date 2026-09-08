var DiagQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var Diag = {
	ORE_FIELDS: ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'],
	ORE_NAMES: ['vms', 'mafic', 'arc', 'orogenic', 'basin', 'placer'],
	// Source/sink ledgers. Mass is counted with the nominal column footprint A0ref, so a
	// transfer between columns or into mobile sediment is exact. producedFel/producedMaf are
	// signed net sources after surface erosion; only recorded sources and sinks move total crust.
	// Σ of each potential over the alive columns (design §10 invariant). A potential is not
	// conserved — it saturates and decays — so this is a diagnostic, not a ledger.
	ores: function (s) {
		var a = s.oVms, b = s.oMaf, c = s.oArc, d = s.oOro, e = s.oBas, f = s.oPla, sum = s.oreSum;
		var t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			t0 += a[i]; t1 += b[i]; t2 += c[i]; t3 += d[i]; t4 += e[i]; t5 += f[i];
		}
		sum[0] = t0; sum[1] = t1; sum[2] = t2; sum[3] = t3; sum[4] = t4; sum[5] = t5;
	},
	mass: function (s) {
		var fel = 0, maf = 0, sed = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			fel += s.hFel[i]; maf += s.hMaf[i]; sed += s.hSed[i];
		}
		for (var c = 0; c < s.grid.V; c++) sed += s.mobile[c];
		s.massFel = fel * s.A0ref; s.massMaf = maf * s.A0ref; s.massSed = sed * s.A0ref;
	},
	check: function (s) {
		var g = s.grid, qErr = 0, rigid = 0, finite = 1;
		for (var p = 0; p < s.plateCount; p++) {
			var nq = Math.hypot(s.q[p * 4], s.q[p * 4 + 1], s.q[p * 4 + 2], s.q[p * 4 + 3]);
			var dq = Math.abs(nq - 1);
			if (dq > qErr) qErr = dq;
			if (!Number.isFinite(nq + s.omega[p * 3] + s.omega[p * 3 + 1] + s.omega[p * 3 + 2])) finite = 0;
		}
		Diag.mass(s);
		Diag.ores(s);
		for (var i = 0; i < s.n; i++) {
			var b = i * 3;
			if (!s.alive[i]) continue;
		DiagQuat.rotate(s.scratch, 0, s.q, s.plate[i] * 4, s.body, b);
		var err = Math.hypot(s.scratch[0] - s.world[b], s.scratch[1] - s.world[b + 1], s.scratch[2] - s.world[b + 2]);
		if (err > rigid) rigid = err;
		// A plate id outside the dense table means an event kernel dropped a renumbering.
		if (s.plate[i] >= s.plateCount) finite = 0;
		if (!Number.isFinite(s.world[b] + s.world[b + 1] + s.world[b + 2] + s.body[b]
			+ s.hFel[i] + s.hMaf[i] + s.hSed[i] + s.age[i] + s.zDyn[i] + s.damage[i]
			+ s.fert[i] + s.oVms[i] + s.oMaf[i] + s.oArc[i] + s.oOro[i] + s.oBas[i] + s.oPla[i])) finite = 0;
		// Every potential saturates at 1 by construction; exceeding it means a rate lost its
		// (1 − o) factor.
		if (s.oVms[i] > 1 || s.oMaf[i] > 1 || s.oArc[i] > 1
			|| s.oOro[i] > 1 || s.oBas[i] > 1 || s.oPla[i] > 1) finite = 0;
		}
		for (var c = 0; c < g.V; c++) {
			if (!Number.isFinite(s.mobile[c] + s.mobileFel[c] + s.mobilePla[c])) finite = 0;
			if (s.owner[c] < 0) continue;
			var cb = c * 3;
			if (!Number.isFinite(s.vel[cb] + s.uMantle[cb] + s.z[c] + s.ext[c]
				+ s.gradZ[cb] + s.slope[c])) finite = 0;
		}
		s.quatError = qErr; s.rigidError = rigid; s.finite = finite;
		var h = s.histI % s.histT.length;
		s.histT[h] = s.t; s.histMeanV[h] = s.meanSpeed; s.histMaxV[h] = s.maxSpeed;
		s.histGaps[h] = s.gaps; s.histPlates[h] = s.plateCount; s.histChanges[h] = s.typeChanges;
		s.histCols[h] = s.n;
		s.histI++;
		if (s.histN < s.histT.length) s.histN++;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Diag;

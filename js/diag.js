var DiagQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var Diag = {
	// Source/sink ledgers. Mass is counted with the nominal column footprint A0ref, so a
	// transfer between columns is exact and only the recorded sources and sinks move the total.
	mass: function (s) {
		var fel = 0, maf = 0, sed = 0;
		for (var i = 0; i < s.n; i++) {
			if (!s.alive[i]) continue;
			fel += s.hFel[i]; maf += s.hMaf[i]; sed += s.hSed[i];
		}
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
		for (var i = 0; i < s.n; i++) {
			var b = i * 3;
			if (!s.alive[i]) continue;
			DiagQuat.rotate(s.scratch, 0, s.q, s.plate[i] * 4, s.body, b);
			var err = Math.hypot(s.scratch[0] - s.world[b], s.scratch[1] - s.world[b + 1], s.scratch[2] - s.world[b + 2]);
			if (err > rigid) rigid = err;
			if (!Number.isFinite(s.world[b] + s.world[b + 1] + s.world[b + 2] + s.body[b]
				+ s.hFel[i] + s.hMaf[i] + s.hSed[i] + s.age[i] + s.zDyn[i])) finite = 0;
		}
		for (var c = 0; c < g.V; c++) {
			if (s.owner[c] < 0) continue;
			var cb = c * 3;
			if (!Number.isFinite(s.vel[cb] + s.uMantle[cb] + s.z[c] + s.ext[c])) finite = 0;
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

/* d1diff.js - defect D1 cross-engine diff: localizes a CPU/GPU plate-speed
   divergence to one layer of the K10 pipeline by comparing intermediates the
   mirror already ships. No device code and no extra transfers:

     inputs        per cell  uMantle, wEq (the mantle/forces field kernels)
     accumulation  per plate M, rhs    (the chunked Kahan normal-equation sums)
     solve         per plate omegaTarget (the cofactor least-squares fit)
     trajectory    per plate omega     (the relaxed rotation history)

   The device's reduceB stores M and rhs DIVIDED BY A0[0] so the f32 cofactor
   products stay in range; every comparison rescales them back before use.

   The threshold is 1e-3 relative: ~100x the healthy f32-vs-f64 tracking and
   ~100x below the observed 20% aggregate drift. It is a layer gate, not a
   parity tolerance, and must not be tuned until the 20% gate passes.

   Used by webgpu-smoke.html (classic script) and tests/gpu-d1diff.js (node). */
var D1Params = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;
var D1Diff = {
	THRESH: 1e-3,
	// Near-zero floors as a fraction of each family's global scale, so a
	// cancelled component cannot fake an infinite relative error. The cell
	// floor is 1e-2 vRef: the known f32 velocity noise is (1e-6 + 1e-5|x|)vRef,
	// which stays a decade under the 1e-3 gate even at a zero-velocity cell.
	FLOOR: 1e-6,
	CELL_FLOOR: 1e-2,

	// gpu.M / gpu.rhs hold the device's NORMALIZED equations (raw / A0[0]);
	// everything else is compared in its stored units.
	compare: function (cpu, gpu) {
		var P = D1Params, vRef = P.vRef, A0 = Math.fround(cpu.grid.A0[0]);
		var V = Math.min(cpu.grid.V, gpu.grid.V);
		var nP = Math.min(cpu.plateCount, gpu.plateCount);
		var plates = new Array(nP);
		var mScale = 0, rScale = 0, fScale = 0, wScale = 0;
		var finite = true;
		var p, k, b, n, dx, dy, dz;

		function addFinite(x) { if (!(x === x && isFinite(x))) finite = false; }
		function vnorm(a, o) { return Math.sqrt(a[o] * a[o] + a[o + 1] * a[o + 1] + a[o + 2] * a[o + 2]); }
		function vdist(a, ao, b, bo) {
			dx = a[ao] - b[bo]; dy = a[ao + 1] - b[bo + 1]; dz = a[ao + 2] - b[bo + 2];
			return Math.sqrt(dx * dx + dy * dy + dz * dz);
		}

		// Reference scales come from the CPU family, so the floors never depend
		// on the values under test.
		for (p = 0; p < nP; p++) {
			var mn = 0, rn = 0;
			for (k = 0; k < 9; k++) mn += Math.pow(cpu.M[p * 9 + k] / A0, 2);
			for (k = 0; k < 3; k++) rn += Math.pow(cpu.rhs[p * 3 + k] / A0, 2);
			mn = Math.sqrt(mn); rn = Math.sqrt(rn);
			if (mn > mScale) mScale = mn;
			if (rn > rScale) rScale = rn;
			var fn = vnorm(cpu.omegaTarget, p * 3), wn = vnorm(cpu.omega, p * 3);
			if (fn > fScale) fScale = fn;
			if (wn > wScale) wScale = wn;
		}
		var mFloor = D1Diff.FLOOR * mScale, rFloor = D1Diff.FLOOR * rScale;
		var fFloor = D1Diff.FLOOR * fScale, wFloor = D1Diff.FLOOR * wScale;

		var worst = { M: 0, rhs: 0, fit: 0, omega: 0 };
		var at = { M: -1, rhs: -1, fit: -1, omega: -1 };
		for (p = 0; p < nP; p++) {
			var md = 0, mc = 0, rd = 0, rc = 0;
			for (k = 0; k < 9; k++) {
				var cm = cpu.M[p * 9 + k] / A0, gm = gpu.M[p * 9 + k];
				md += (gm - cm) * (gm - cm); mc += cm * cm;
				addFinite(cm); addFinite(gm);
			}
			for (k = 0; k < 3; k++) {
				var cr = cpu.rhs[p * 3 + k] / A0, gr = gpu.rhs[p * 3 + k];
				rd += (gr - cr) * (gr - cr); rc += cr * cr;
				addFinite(cr); addFinite(gr);
				addFinite(cpu.omegaTarget[p * 3 + k]); addFinite(gpu.omegaTarget[p * 3 + k]);
				addFinite(cpu.omega[p * 3 + k]); addFinite(gpu.omega[p * 3 + k]);
			}
			var mRel = Math.sqrt(md) / Math.max(Math.sqrt(mc), mFloor);
			var rRel = Math.sqrt(rd) / Math.max(Math.sqrt(rc), rFloor);
			var fitN = vnorm(cpu.omegaTarget, p * 3);
			var wN = vnorm(cpu.omega, p * 3);
			var fitRel = vdist(gpu.omegaTarget, p * 3, cpu.omegaTarget, p * 3) / Math.max(fitN, fFloor);
			var wRel = vdist(gpu.omega, p * 3, cpu.omega, p * 3) / Math.max(wN, wFloor);
			plates[p] = { M: mRel, rhs: rRel, fit: fitRel, omega: wRel };
			if (mRel > worst.M) { worst.M = mRel; at.M = p; }
			if (rRel > worst.rhs) { worst.rhs = rRel; at.rhs = p; }
			if (fitRel > worst.fit) { worst.fit = fitRel; at.fit = p; }
			if (wRel > worst.omega) { worst.omega = wRel; at.omega = p; }
		}

		// Per-cell field inputs. Denominator is |cpu| plus a floor, so a gross
		// delta on a near-stationary cell still reads as a gross delta.
		var cellFloor = D1Diff.CELL_FLOOR * vRef;
		var cells = {
			uMantle: { rel: 0, abs: 0, atRel: -1, atAbs: -1 },
			wEq: { rel: 0, abs: 0, atRel: -1, atAbs: -1 }
		};
		function cellPair(name, gArr, cArr, c) {
			b = c * 3;
			dx = gArr[b] - cArr[b]; dy = gArr[b + 1] - cArr[b + 1]; dz = gArr[b + 2] - cArr[b + 2];
			var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
			var cn = vnorm(cArr, b);
			var rel = d / (cn + cellFloor);
			addFinite(gArr[b]); addFinite(gArr[b + 1]); addFinite(gArr[b + 2]); addFinite(cn);
			var r = cells[name];
			if (rel > r.rel) { r.rel = rel; r.atRel = c; r.relAbs = d; }
			if (d > r.abs) { r.abs = d; r.atAbs = c; r.absRel = rel; }
		}
		for (var c = 0; c < V; c++) {
			cellPair('uMantle', gpu.uMantle, cpu.uMantle, c);
			cellPair('wEq', gpu.wEq, cpu.wEq, c);
		}

		var flags = {
			inputs: cells.uMantle.rel >= D1Diff.THRESH || cells.wEq.rel >= D1Diff.THRESH,
			accumulation: worst.M >= D1Diff.THRESH || worst.rhs >= D1Diff.THRESH,
			solve: worst.fit >= D1Diff.THRESH,
			trajectory: worst.omega >= D1Diff.THRESH
		};
		// First trip in pipeline order is the named layer: a later array is
		// recomputed from the earlier one, so once the upstream layer is wrong
		// the downstream deltas are consequences, not causes.
		var layer = null;
		if (!finite) layer = 'inputs';
		else if (flags.inputs) layer = 'inputs';
		else if (flags.accumulation) layer = 'accumulation';
		else if (flags.solve) layer = 'solve';
		else if (flags.trajectory) layer = 'trajectory';
		return { V: V, nP: nP, A0: A0, plates: plates, worst: worst, at: at,
			cells: cells, flags: flags, layer: layer, finite: finite };
	},

	fmt: function (x) { return x.toExponential(1); },

	// The capture table: four per-plate lines covering every plate (the 0.3-6
	// ratio table stopped at four and the worst plate was 14), then one line
	// per cell family. `label` is 'boot' or 'frame 5'.
	lines: function (res, label) {
		function plateLine(family, title) {
			var line = '[parity] D1 ' + label + ' ' + title + ' rel';
			for (var p = 0; p < res.plates.length; p++) {
				line += ' p' + (p + 1) + ' ' + D1Diff.fmt(res.plates[p][family]);
			}
			line += ' · worst p' + (res.at[family] + 1) + ' ' + D1Diff.fmt(res.worst[family]);
			return line;
		}
		function cellLine(name, title) {
			var r = res.cells[name];
			return '[parity] D1 ' + label + ' ' + title + ': worst rel ' + D1Diff.fmt(r.rel)
				+ ' (|d| ' + r.relAbs.toExponential(2) + ' m/Myr @c' + r.atRel + ')'
				+ ' · worst |d| ' + r.abs.toExponential(2) + ' m/Myr @c' + r.atAbs
				+ ' (rel ' + D1Diff.fmt(r.absRel) + ')';
		}
		return [
			plateLine('M', 'M/A0[0]'),
			plateLine('rhs', 'rhs/A0[0]'),
			plateLine('fit', 'fit (omegaTarget)'),
			plateLine('omega', 'omega'),
			cellLine('uMantle', 'uMantle'),
			cellLine('wEq', 'wEq')
		];
	},

	// The named failure, in pipeline order, with the number that tripped it.
	// Empty on a clean diff, so the caller pushes every entry straight to fail().
	failures: function (res, label) {
		var out = [], w = res.worst, at = res.at, c = res.cells, T = D1Diff.THRESH;
		if (!res.finite) {
			out.push('D1 (' + label + '): non-finite values in the cross-engine diff');
			return out;
		}
		if (c.uMantle.rel >= T || c.wEq.rel >= T) {
			out.push('D1 (' + label + ') layer = INPUTS: uMantle/wEq diverge before the plate solve '
				+ '(worst rel uMantle ' + D1Diff.fmt(c.uMantle.rel) + ', wEq ' + D1Diff.fmt(c.wEq.rel)
				+ ' > ' + T + ') - the mantle/forces field kernels disagree');
			return out;
		}
		if (w.M >= T || w.rhs >= T) {
			out.push('D1 (' + label + ') layer = ACCUMULATION: M/rhs diverge while uMantle/wEq agree '
				+ '(worst rel M ' + D1Diff.fmt(w.M) + ' at p' + (at.M + 1)
				+ ', rhs ' + D1Diff.fmt(w.rhs) + ' at p' + (at.rhs + 1) + ' > ' + T
				+ ') - the chunked Kahan normal-equation sums disagree');
			return out;
		}
		if (w.fit >= T) {
			out.push('D1 (' + label + ') layer = SOLVE: the fit (omegaTarget) diverges while M/rhs agree '
				+ '(worst rel ' + D1Diff.fmt(w.fit) + ' at p' + (at.fit + 1) + ' > ' + T
				+ ') - the f32 cofactor solve; reduceB also runs one FMA-refinement step the CPU solve does not');
			return out;
		}
		if (w.omega >= T) {
			out.push('D1 (' + label + ') layer = TRAJECTORY: M/rhs/fit agree but omega diverges '
				+ '(worst rel ' + D1Diff.fmt(w.omega) + ' at p' + (at.omega + 1) + ' > ' + T
				+ ') - the relaxation history; the boot table shows whether it was present at boot');
			return out;
		}
		return out;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = D1Diff;

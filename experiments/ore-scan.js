// Calibration for the Phase F ore geography (design §10 acceptance 5). Not loaded by the page.
// usage: node experiments/ore-scan.js [level] [myr] [seed]
//
// Reports two things: where each potential is *produced* (call the owning kernel once and diff
// — exact, and immune to the column renumbering Events.compact does) and where the potential
// *ends up* after the plates have carried the deposits away.
var Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
var Contact = require('../js/contact.js'), CU = require('../js/column-update.js');
var Params = require('../js/params.js'), Diag = require('../js/diag.js');
var level = +(process.argv[2] || 4), myr = +(process.argv[3] || 800), seed = +(process.argv[4] || 7);
var g = new Grid(level, seed).build(), s = new State(g, seed, true), c, k, e, i;
s.ckptCap = 0;
Sim.raster(s);
Sim.advance(s, 0.1, myr / 0.1);

var sub = new Uint8Array(s.plateCap);
for (c = 0; c < g.V; c++) for (k = 0; k < g.ringN[c]; k++) {
	e = c * 6 + k;
	if (s.edgeType[e] === 1 && s.polarity[e] === 1 && s.cellPlate[c] < s.plateCount) sub[s.cellPlate[c]] = 1;
}
// A column can own several cells, so "near the trench" is the best of the cells it owns.
var near = new Int32Array(s.colCap).fill(9);
for (c = 0; c < g.V; c++) {
	var o = s.owner[c];
	if (o >= 0 && s.trenchDist[c] < near[o]) near[o] = s.trenchDist[c];
}
function site(field, before, test) {
	var hit = 0, all = 0;
	for (i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		var d = s[field][i] - before[i];
		if (!(d > 1e-12)) continue;
		all += d;
		if (test(i)) hit += d;
	}
	return all > 0 ? +(hit / all).toFixed(4) : NaN;
}
var a0 = Float64Array.from(s.oArc);
Contact.arcs(s, 0.1);
var arcTrench = site('oArc', a0, function (i) { return near[i] <= 2; });
var arcOver = site('oArc', a0, function (i) { return sub[s.plate[i]] === 1; });
var v0 = Float64Array.from(s.oVms), o0 = Float64Array.from(s.oOro), b0 = Float64Array.from(s.oBas);
CU.step(s, 0.1);
var produced = {
	arcTrench2: arcTrench, arcOverrider: arcOver,
	vmsOceanic: site('oVms', v0, function (i) { return s.hFel[i] < Params.hOceanic; }),
	oroContinental: site('oOro', o0, function (i) { return s.hFel[i] >= Params.hOceanic; }),
	basThickSed: site('oBas', b0, function (i) { return s.hSed[i] > 1000; })
};
function share(field, test) {
	var ki = Diag.ORE_FIELDS.indexOf(field), hit = 0;
	if (!(s.oreSum[ki] > 0)) return NaN;
	for (i = 0; i < s.n; i++) if (s.alive[i] && s[field][i] > 0 && test(i)) hit += s[field][i];
	return +(hit / s.oreSum[ki]).toFixed(3);
}
// Placer contrast: the strongest orogenic/arc columns against an arbitrary control, measuring
// the best placer found within `hops` downhill of each.
function placerContrast(hops) {
	var src = [], pick = [], at, h, cc, oo, best, acc = 0, ctrl = 0, mean = s.oreSum[5] / s.n;
	for (i = 0; i < s.n; i++) if (s.alive[i] && s.oOro[i] + s.oArc[i] > 0.6) src.push(i);
	src.sort(function (x, y) { return (s.oOro[y] + s.oArc[y]) - (s.oOro[x] + s.oArc[x]); });
	src = src.slice(0, 100);
	for (i = 0; i < s.n && pick.length < 100; i += 97) if (s.alive[i]) pick.push(i);
	function bestDown(list) {
		var total = 0;
		for (at = 0; at < list.length; at++) {
			cc = s.cell[list[at]]; best = 0;
			for (h = 0; h < hops && cc >= 0; h++) {
				cc = s.low[cc];
				if (cc < 0) break;
				oo = s.owner[cc];
				if (oo >= 0 && s.oPla[oo] > best) best = s.oPla[oo];
			}
			total += best;
		}
		return total / list.length;
	}
	acc = bestDown(src); ctrl = bestDown(pick);
	return { hops: hops, sources: +(acc).toFixed(4), control: +(ctrl).toFixed(4),
		ratio: +(acc / ctrl).toFixed(2), planetMean: +mean.toFixed(4) };
}
console.log(JSON.stringify({
	level: level, myr: myr, seed: seed, plates: s.plateCount,
	totals: Array.prototype.slice.call(s.oreSum).map(function (v) { return +v.toFixed(0); }),
	produced: produced,
	endState: {
		arcTrench2: share('oArc', function (i) { return near[i] <= 2; }),
		arcOverrider: share('oArc', function (i) { return sub[s.plate[i]] === 1; }),
		vmsOceanic: share('oVms', function (i) { return s.hFel[i] < Params.hOceanic; }),
		oroContinental: share('oOro', function (i) { return s.hFel[i] >= Params.hOceanic; }),
		basThickSed: share('oBas', function (i) { return s.hSed[i] > 1000; })
	},
	placer: [placerContrast(2), placerContrast(4), placerContrast(8)]
}, null, 1));

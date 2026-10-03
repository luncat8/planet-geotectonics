// Calibration for the 0.6.1 deposit catalogue (plan §10). Not loaded by the page.
// usage: node experiments/deposit-calibration.js [level] [myr] [seed]
//
// Runs one hot start, builds the full catalogue and prints the table the plan's §10 wants:
// build time, record and viable counts, per-class medians against the published bands, and
// the cluster-tonnage / body-count check that keeps a record comparable to a real deposit.
var Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
var Deposits = require('../js/deposits.js');
var level = +(process.argv[2] || 5), myr = +(process.argv[3] || 1500), seed = +(process.argv[4] || 7);
var g = new Grid(level, seed).build(), s = new State(g, seed, true);
s.ckptCap = 0;
Sim.raster(s);
Sim.advance(s, 0.1, Math.round(myr / 0.1));

var t0 = Date.now();
var catalogue = Deposits.build(s);
var buildMs = Date.now() - t0;
s.frame++;
var t1 = Date.now();
Deposits.build(s);
var rebuildMs = Date.now() - t1;

function median(values) {
	if (!values.length) return NaN;
	var sorted = values.slice(0).sort(function (a, b) { return a - b; });
	var mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(values, fraction) {
	if (!values.length) return NaN;
	var sorted = values.slice(0).sort(function (a, b) { return a - b; });
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}
function mean(values) {
	if (!values.length) return NaN;
	var total = 0;
	for (var i = 0; i < values.length; i++) total += values[i];
	return total / values.length;
}
function round(value, digits) {
	var scale = Math.pow(10, digits);
	return Math.round(value * scale) / scale;
}

var perRow = Object.create(null);
for (var i = 0; i < catalogue.records.length; i++) {
	var r = catalogue.records[i], tag = r.kind + '/' + r.variant;
	if (!perRow[tag]) perRow[tag] = { all: [], viable: [], bodies: [], grade: [], viableGrade: [], top: [] };
	var row = perRow[tag];
	row.all.push(r.size);
	row.bodies.push(r.bodies.length);
	row.top.push(r.top);
	var principal = Object.keys(r.grade)[0];
	if (principal) row.grade.push(r.grade[principal]);
	if (r.viable) {
		row.viable.push(r.size);
		if (principal) row.viableGrade.push(r.grade[principal]);
	}
}

console.log('level ' + level + ' seed ' + seed + ' t ' + s.t.toFixed(1) + ' Myr · cells ' + g.V
	+ ' · columns ' + s.n);
console.log('build ' + buildMs + ' ms (cached rebuild ' + rebuildMs + ' ms) · records '
	+ catalogue.records.length + ' · viable ' + catalogue.viableCount);
console.log('');
console.log('class'.padEnd(20) + 'n'.padStart(6) + 'viable'.padStart(8) + 'medSize'.padStart(10)
	+ 'bodies'.padStart(8) + 'med/body'.padStart(10) + 'p90/body'.padStart(10)
	+ 'anchorMed'.padStart(11) + 'ladderT50'.padStart(11)
	+ 'medGrade'.padStart(10) + 'band'.padStart(14) + 'medTop'.padStart(8));
for (var c = 0; c < Deposits.CLASSES.length; c++) {
	var cls = Deposits.CLASSES[c], key = cls.kind + '/' + cls.variant, data = perRow[key];
	if (!data) { console.log(key.padEnd(20) + '0'.padStart(6) + ' — not emitted'); continue; }
	var medSize = median(data.all), bodyMean = mean(data.bodies);
	var band = cls.grades.length ? cls.grades[0][2] + '-' + cls.grades[0][3] : 'bulk';
	console.log(key.padEnd(20)
		+ String(data.all.length).padStart(6)
		+ String(data.viable.length).padStart(8)
		+ String(round(medSize, 3)).padStart(10)
		+ String(round(bodyMean, 2)).padStart(8)
		+ String(round(medSize / bodyMean, 3)).padStart(10)
		+ String(round(percentile(data.all, 0.9) / bodyMean, 3)).padStart(10)
		+ String(cls.anchorMedian === null ? '—' : cls.anchorMedian).padStart(11)
		+ String(cls.ladder[2]).padStart(11)
		+ (data.grade.length ? String(round(median(data.grade), 3)) : '—').padStart(10)
		+ band.padStart(14)
		+ String(round(median(data.top), 0)).padStart(8));
}
console.log('');
console.log('field maxima (after FIELD_SCALE): ' + Deposits.KINDS.map(function (name, k) {
	var max = 0;
	for (var c = 0; c < g.V; c++) { var v = Deposits.blurAt(s, k, c); if (v > max) max = v; }
	return name + ' ' + round(max, 3);
}).join(' · '));
console.log('contained totals: ' + JSON.stringify(catalogue.containedTotals));
var arc = perRow['arc/porphyry'], oro = perRow['orogenic/vein'], pla = perRow['placer/gold'];
console.log('arc viable median Cu       ' + (arc ? round(median(arc.viableGrade), 3) : '—') + ' % (target 0.25-0.6)');
console.log('orogenic viable median Au  ' + (oro ? round(median(oro.viableGrade), 3) : '—') + ' g/t (target 1-6)');
console.log('placer viable median Au    ' + (pla ? round(median(pla.viableGrade), 3) : '—') + ' g/t (target 0.05-0.2)');

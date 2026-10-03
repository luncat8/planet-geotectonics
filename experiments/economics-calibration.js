// Calibration for the 0.6.3 monetary scenario (js/data/deposit-economics.js). Not loaded
// by the page. Usage: node experiments/economics-calibration.js [level] [myr] [seed]
//
// The catalogue's own `viable` flag is a geological screen that never mentions a price;
// this measures the second screen against it on an evolved world, so the split between
// them is a measurement rather than a guess. It prints, per class, how many records each
// screen passes, how many both pass, and why the monetary one refuses the rest.
//
// Read it as a distribution check, not as an acceptance gate with a tolerance chosen to
// make it pass: the point of keeping the two screens apart is that they disagree, and a
// number that moved because a price moved is the filter working, not a regression.
var Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
var Deposits = require('../js/deposits.js');
var Economics = require('../js/data/deposit-economics.js');

var level = +(process.argv[2] || 5), myr = +(process.argv[3] || 1500), seed = +(process.argv[4] || 7);
var g = new Grid(level, seed).build(), s = new State(g, seed, true);
s.ckptCap = 0;
Sim.raster(s);
Sim.advance(s, 0.1, Math.round(myr / 0.1));

var t0 = Date.now();
var catalogue = Deposits.build(s);
var buildMs = Date.now() - t0;

var byClass = Object.create(null);
var totals = { n: 0, geo: 0, money: 0, both: 0, geoOnly: 0, moneyOnly: 0, neither: 0 };
var reasons = Object.create(null);
var nets = [];

for (var i = 0; i < catalogue.records.length; i++) {
	var r = catalogue.records[i], screen = Economics.screen(r);
	var key = r.kind + '/' + r.variant;
	var row = byClass[key] || (byClass[key] = {
		n: 0, geo: 0, money: 0, both: 0, reasons: Object.create(null), nets: []
	});
	row.n++; totals.n++;
	if (r.viable) { row.geo++; totals.geo++; }
	if (screen.positive) { row.money++; totals.money++; }
	if (r.viable && screen.positive) { row.both++; totals.both++; }
	else if (r.viable) totals.geoOnly++;
	else if (screen.positive) totals.moneyOnly++;
	else totals.neither++;
	if (!screen.positive) {
		row.reasons[screen.reason] = (row.reasons[screen.reason] || 0) + 1;
		reasons[screen.reason] = (reasons[screen.reason] || 0) + 1;
	}
	if (Number.isFinite(screen.net)) { row.nets.push(screen.net); nets.push(screen.net); }
}

function median(values) {
	if (!values.length) return NaN;
	var sorted = values.slice(0).sort(function (a, b) { return a - b; });
	var mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function pad(value, width) {
	var text = String(value);
	while (text.length < width) text = ' ' + text;
	return text;
}
function billions(n) {
	return Number.isFinite(n) ? (n / 1e9).toFixed(2) + ' G$' : '-';
}
function counts(object) {
	var keys = Object.keys(object);
	if (!keys.length) return '-';
	keys.sort();
	return keys.map(function (k) { return k + ' ' + object[k]; }).join(', ');
}

console.log('monetary scenario v' + Economics.version + ' · ' + Economics.describe());
console.log('world L' + level + ' · ' + myr + ' Myr · seed ' + seed
	+ ' · catalogue build ' + buildMs + ' ms · ' + catalogue.records.length + ' records');
console.log('');
console.log('geologically viable (grade/size/depth, no price): ' + totals.geo + ' / ' + totals.n
	+ ' (' + (100 * totals.geo / totals.n).toFixed(1) + ' %)');
console.log('monetary positive (priced, method-based cost)  : ' + totals.money + ' / ' + totals.n
	+ ' (' + (100 * totals.money / totals.n).toFixed(1) + ' %)');
console.log('both screens pass                              : ' + totals.both);
console.log('geological only (real rock, does not pay)      : ' + totals.geoOnly);
console.log('monetary only (pays, fails the class screen)   : ' + totals.moneyOnly);
console.log('neither                                        : ' + totals.neither);
console.log('median net over finite records                 : ' + billions(median(nets)));
console.log('monetary refusals                              : ' + counts(reasons));
console.log('');
console.log('class                 n  geo  money  both   median net   monetary refusals');
Object.keys(byClass).sort().forEach(function (key) {
	var row = byClass[key];
	console.log(pad(key, 20) + pad(row.n, 4) + pad(row.geo, 5) + pad(row.money, 7)
		+ pad(row.both, 6) + pad(billions(median(row.nets)), 14) + '   ' + counts(row.reasons));
});
console.log('');
console.log('The disagreement is the result, not noise: a body can be exactly the right grade,');
console.log('size and depth for its class and still not carry its capital, and a body the class');
console.log('screen rejects as too deep can still pay at a bulk tonnage. Both lines are printed');
console.log('on the found report so neither can hide behind the other.');

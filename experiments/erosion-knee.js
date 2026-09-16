// Erosion-knee calibration (0.3.3 §3): the q² intake law was retuned against the linear one,
// so the release statistics move with it. This runs the L5 seed-7 hot-start history the longrun
// gate reads (acceptance 3: continental area 15-40 %, cratons, 1-10 cm/yr in the middle epoch)
// at each candidate, plus the relief the knee exists to cap, and prints one row per candidate.
// Every candidate is a fresh world, so the rows are comparable histories, not perturbations of
// one another.
//   node experiments/erosion-knee.js "kEro=0.05,zKnee=6500" "kEro=0.05,zKnee=13000"
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Params = require('../js/params.js');

const SEED = 7, EPOCH = 100;
const flag = (name, value) => {
	const arg = process.argv.find(a => a.startsWith('--' + name + '='));
	return arg === undefined ? value : +arg.slice(name.length + 3);
};
const LEVEL = flag('level', 5), MYR = flag('myr', 1500), DT = flag('dt', 0.1);

function parse(spec) {
	const cfg = {};
	for (const part of spec.split(',')) {
		const at = part.indexOf('=');
		const key = part.slice(0, at).trim(), value = +part.slice(at + 1);
		if (!(key in Params) || !(value >= 0)) throw new RangeError('not a tunable parameter: ' + part);
		cfg[key] = value;
	}
	return cfg;
}

// Column-side statistics, in the same definitions tests/longrun.js and acceptance 3 use.
function stats(s) {
	let columns = 0, continental = 0, craton = 0;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		columns++;
		if (s.hFel[i] > 20000) continental++;
		if (s.hFel[i] > 30000 && s.age[i] > 300) craton++;
	}
	return { continental: continental / columns, craton: craton / columns, columns: columns };
}

// Land relief: the elevation the world keeps (mean and the share above 2 km, which the old
// law ate) against the peaks it must not keep. The tallest cell is reported too but is a
// single column's accident, so the p99.9 is the number the cap is read from.
function relief(s) {
	const high = [];
	let sum = 0, n = 0, max = 0, above2 = 0, above10 = 0, above20 = 0;
	for (let c = 0; c < s.grid.V; c++) {
		const z = s.z[c];
		if (!(z > 0)) continue;
		n++; sum += z; high.push(z);
		if (z > 2000) above2++;
		if (z > 10000) above10++;
		if (z > 20000) above20++;
		if (z > max) max = z;
	}
	high.sort((a, b) => a - b);
	return { meanKm: n ? sum / n / 1000 : 0, maxKm: max / 1000, share2: n ? above2 / n : 0,
		share10: n ? above10 / n : 0, share20: n ? above20 / n : 0,
		p999Km: n ? high[Math.min(high.length - 1, Math.floor(0.999 * high.length))] / 1000 : 0 };
}

function run(cfg) {
	for (const key in cfg) Params[key] = cfg[key];
	const s = new State(new Grid(LEVEL, SEED).build(), SEED, 1);      // hot start
	s.ckptCap = 0;
	Sim.raster(s);
	const start = performance.now();
	let peakKm = 0, capKm = 0, middleSum = 0, middleN = 0, contSum = 0, contN = 0;
	let relSum = 0, relN = 0, sedSum = 0, sedN = 0, hiSum = 0, hiN = 0;
	for (let e = 0; e < Math.max(1, Math.round(MYR / EPOCH)); e++) {
		Sim.advance(s, DT, EPOCH / DT);
		const at = stats(s), r = relief(s);
		if (s.t >= 300) { contSum += at.continental; contN++; }
		if (s.t >= 500 && s.t <= 1000) { middleSum += s.meanSpeed / 10000; middleN++; }
		if (r.maxKm > peakKm) peakKm = r.maxKm;
		if (r.p999Km > capKm) capKm = r.p999Km;
		relSum += r.meanKm; relN++;
		hiSum += r.share10; hiN++;
		let sed = 0;
		for (let i = 0; i < s.n; i++) if (s.alive[i]) sed += s.hSed[i];
		sedSum += sed / at.columns; sedN++;
	}
	const at = stats(s), r = relief(s);
	const row = {
		cfg: Object.keys(cfg).map(k => k + ' ' + cfg[k]).join(', ') || 'default',
		cont: at.continental, contMean: contN ? contSum / contN : 0, craton: at.craton,
		meanCm: middleN ? middleSum / middleN : s.meanSpeed / 10000,
		plates: s.plateCount, peakKm: peakKm, capKm: capKm,
		landKm: relSum / relN, share2: r.share2, share10: hiSum / hiN, share20: r.share20,
		sedKm: sedSum / sedN, splits: s.splits, merges: s.merges,
		fel: (s.massFel0 + s.producedFel - s.massFel) / s.massFel,
		maf: (s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf) / s.massMaf,
		seconds: (performance.now() - start) / 1000
	};
	console.log(row.cfg.padEnd(26) + 'cont ' + (row.cont * 100).toFixed(1).padStart(5) + '%'
		+ ' mean ' + (row.contMean * 100).toFixed(1).padStart(5) + '%'
		+ ' craton ' + (row.craton * 100).toFixed(2).padStart(5) + '%'
		+ ' spd ' + row.meanCm.toFixed(2).padStart(5)
		+ ' land ' + row.landKm.toFixed(2).padStart(4) + ' km'
		+ ' >2km ' + (row.share2 * 100).toFixed(0).padStart(3) + '%'
		+ ' >10km ' + (row.share10 * 100).toFixed(1).padStart(4) + '%'
		+ ' >20km ' + (row.share20 * 100).toFixed(2).padStart(5) + '%'
		+ ' p99.9 ' + row.capKm.toFixed(1).padStart(6) + ' km'
		+ ' sed ' + row.sedKm.toFixed(2).padStart(5) + ' km'
		+ ' plates ' + String(row.plates).padStart(2)
		+ ' cycle ' + row.splits + '/' + row.merges
		+ ' fel ' + row.fel.toExponential(1) + ' maf ' + row.maf.toExponential(1)
		+ '  ' + row.seconds.toFixed(0) + ' s');
	return row;
}

const specs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const rows = specs.map(spec => run(parse(spec)));
console.log(JSON.stringify(rows.map(r => ({
	cfg: r.cfg, cont: +r.cont.toFixed(4), contMean: +r.contMean.toFixed(4),
	craton: +r.craton.toFixed(4), meanCm: +r.meanCm.toFixed(3), landKm: +r.landKm.toFixed(3),
	share2: +r.share2.toFixed(3), share10: +r.share10.toFixed(4), share20: +r.share20.toFixed(4),
	capKm: +r.capKm.toFixed(2), peakKm: +r.peakKm.toFixed(1), plates: r.plates
}))));

#!/usr/bin/env node
/* One-factor release calibration for the four coupled controls that most strongly set
   plate speed, continent production and relief. This is intentionally outside the browser
   runtime: a release sweep is long, may allocate reports, and mutates the sealed Params
   values between fresh worlds.

   Full L5 acceptance sweep (18 histories):
     node experiments/sweep.js --level=5 --myr=1500 --out=sweep.json

   Fast plumbing check:
     node experiments/sweep.js --quick --only=baseline
*/
const fs = require('node:fs');
const Grid = require('../js/geodesics.js');
const Params = require('../js/params.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');

function options(argv) {
	const out = { level: 4, myr: 600, seed: 7, sample: 25, dt: [0.02, 0.1], only: '', out: '' };
	for (let i = 2; i < argv.length; i++) {
		let arg = argv[i], split = arg.indexOf('='), key = split < 0 ? arg : arg.slice(0, split);
		let value = split < 0 ? argv[i + 1] : arg.slice(split + 1);
		if (key === '--quick') {
			out.level = 2; out.myr = 20; out.sample = 5;
			continue;
		}
		if (key === '--help' || key === '-h') out.help = true;
		else if (key === '--level') out.level = +value;
		else if (key === '--myr') out.myr = +value;
		else if (key === '--seed') out.seed = +value;
		else if (key === '--sample') out.sample = +value;
		else if (key === '--dt') out.dt = value.split(',').map(Number);
		else if (key === '--only') out.only = value;
		else if (key === '--out') out.out = value;
		else throw new RangeError('unknown option ' + key);
		if (split < 0) i++;
	}
	if (out.help) return out;
	if (!Number.isInteger(out.level) || out.level < 0 || out.level > 5) throw new RangeError('level must be 0–5');
	if (!(out.myr > 0) || !(out.sample > 0)) throw new RangeError('myr and sample must be positive');
	if (!Number.isInteger(out.seed) || out.seed < 0 || out.seed > 0xffffffff) throw new RangeError('seed must be uint32');
	for (const dt of out.dt) if (!Number.isFinite(dt) || dt < 0.01 || dt > 0.1) throw new RangeError('dt must be 0.01–0.1');
	return out;
}

function usage() {
	console.log('Usage: node experiments/sweep.js [--level=4] [--myr=600] [--dt=0.02,0.1]');
	console.log('       [--seed=7] [--sample=25] [--only=baseline,U0-low] [--out=report.json] [--quick]');
}

const TUNING = [
	{ key: 'U0', low: 40000, high: 60000 },
	{ key: 'vSlab', low: 750000, high: 1250000 },
	{ key: 'kArc', low: 50, high: 80 },
	{ key: 'kCollapse', low: 0.015, high: 0.03 }
];
const ORES = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];

function scenarios(only) {
	const rows = [{ id: 'baseline', key: '', value: 0 }];
	for (const tuning of TUNING) {
		rows.push({ id: tuning.key + '-low', key: tuning.key, value: tuning.low });
		rows.push({ id: tuning.key + '-high', key: tuning.key, value: tuning.high });
	}
	if (!only) return rows;
	const wanted = new Set(only.split(','));
	return rows.filter(row => wanted.has(row.id));
}

function boundaryCount(s) {
	let count = 0;
	for (let e = 0; e < s.edgeType.length; e++) if (s.edgeType[e]) count++;
	return count;
}

function finalStats(s) {
	let columns = 0, continental = 0, craton = 0, maxOre = 0;
	const orePopulated = new Array(ORES.length).fill(0);
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		columns++;
		if (s.hFel[i] > 20000) continental++;
		if (s.hFel[i] > 30000 && s.age[i] > 300) craton++;
		for (let k = 0; k < ORES.length; k++) {
			const value = s[ORES[k]][i];
			if (value > 1e-6) orePopulated[k]++;
			if (value > maxOre) maxOre = value;
		}
	}
	const felDen = Math.max(1, Math.abs(s.massFel));
	const mafDen = Math.max(1, Math.abs(s.massMaf));
	return {
		columns,
		plates: s.plateCount,
		continental: columns ? continental / columns : 0,
		craton: columns ? craton / columns : 0,
		splits: s.splits,
		merges: s.merges,
		Tm: s.Tm,
		felResidual: (s.massFel0 + s.producedFel - s.massFel) / felDen,
		mafResidual: (s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf) / mafDen,
		maxOre,
		orePopulated,
		finite: s.finite,
		rigidError: s.rigidError,
		quatError: s.quatError
	};
}

function outside(value, lo, hi) {
	if (value < lo) return (lo - value) / Math.max(lo, 1e-12);
	if (value > hi) return (value - hi) / Math.max(hi, 1e-12);
	return 0;
}

function score(row, eligible) {
	let penalty = 0;
	penalty += 20 * outside(row.middleMeanCm, 1, 10);
	penalty += 20 * outside(row.continental, 0.15, 0.4);
	penalty += 10 * outside(row.plates, 6, 40);
	penalty += 100 * Math.max(Math.abs(row.felResidual), Math.abs(row.mafResidual));
	penalty += 10 * Math.max(0, row.boundaryChange - 0.05) / 0.05;
	if (!row.finite || row.rigidError >= 1e-9 || row.quatError >= 1e-9 || row.maxOre > 1) penalty += 1000;
	if (eligible && row.craton <= 0) penalty += 20;
	if (eligible && (!row.splits || !row.merges)) penalty += 20;
	for (const n of row.orePopulated) if (!n) penalty += 2;
	return penalty;
}

function run(grid, scenario, dt, config) {
	const s = new State(grid, config.seed, 1);
	s.ckptCap = 0;
	Sim.raster(s);
	let middleSpeed = 0, middleN = 0, change = 0, samples = 0, historyAt = s.histI;
	const middleLo = config.myr >= 1000 ? 500 : config.myr / 3;
	const middleHi = config.myr >= 1000 ? Math.min(1000, config.myr) : config.myr * 2 / 3;
	// Every frame writes histChanges. Keep chunks within that ring so event frames contribute
	// once to the mean instead of accidentally being the only frames sampled.
	const chunkMyr = Math.min(config.sample, dt * (s.histChanges.length - 1));
	const start = performance.now();
	while (s.t < config.myr - dt * 0.5) {
		const target = Math.min(config.myr, s.t + chunkMyr);
		Sim.advance(s, dt, Math.max(1, Math.round((target - s.t) / dt)));
		if (s.t >= middleLo - dt * 0.5 && s.t <= middleHi + chunkMyr) {
			middleSpeed += s.meanSpeed / 10000;
			middleN++;
		}
		const boundary = boundaryCount(s);
		const first = Math.max(historyAt, s.histI - s.histChanges.length);
		if (boundary) {
			for (let h = first; h < s.histI; h++) {
				change += s.histChanges[h % s.histChanges.length] / boundary;
				samples++;
			}
		}
		historyAt = s.histI;
	}
	const row = Object.assign({
		scenario: scenario.id,
		parameter: scenario.key || 'baseline',
		value: scenario.key ? scenario.value : null,
		dt,
		middleMeanCm: middleN ? middleSpeed / middleN : s.meanSpeed / 10000,
		boundaryChange: samples ? change / samples : 0,
		seconds: (performance.now() - start) / 1000
	}, finalStats(s));
	row.score = score(row, config.level === 5 && config.myr >= 1500);
	return row;
}

function printRow(row) {
	console.log([
		row.scenario.padEnd(15),
		('dt ' + row.dt.toFixed(2)).padEnd(8),
		('speed ' + row.middleMeanCm.toFixed(2)).padEnd(12),
		('cont ' + (100 * row.continental).toFixed(1) + '%').padEnd(11),
		('craton ' + (100 * row.craton).toFixed(2) + '%').padEnd(14),
		('plates ' + row.plates).padEnd(11),
		('cycle ' + row.splits + '/' + row.merges).padEnd(14),
		('flicker ' + (100 * row.boundaryChange).toFixed(2) + '%').padEnd(15),
		('score ' + row.score.toFixed(2)).padEnd(12),
		row.seconds.toFixed(1) + ' s'
	].join(' '));
}

function recommendation(rows) {
	const mean = new Map();
	for (const row of rows) {
		const old = mean.get(row.scenario) || { sum: 0, n: 0 };
		old.sum += row.score; old.n++;
		mean.set(row.scenario, old);
	}
	const result = { baseline: Params.U0 };
	for (const tuning of TUNING) {
		const ids = ['baseline', tuning.key + '-low', tuning.key + '-high'];
		let best = '', bestScore = Infinity;
		for (const id of ids) {
			const value = mean.get(id);
			if (!value || value.sum / value.n >= bestScore) continue;
			best = id; bestScore = value.sum / value.n;
		}
		result[tuning.key] = best === tuning.key + '-low' ? tuning.low
			: best === tuning.key + '-high' ? tuning.high : Params[tuning.key];
	}
	delete result.baseline;
	return result;
}

function main() {
	const config = options(process.argv);
	if (config.help) { usage(); return; }
	const work = scenarios(config.only);
	if (!work.length) throw new RangeError('the --only filter selected no scenarios');
	const defaults = {};
	for (const tuning of TUNING) defaults[tuning.key] = Params[tuning.key];
	const grid = new Grid(config.level, config.seed).build();
	const rows = [];
	console.log('Calibration sweep: L' + config.level + ', ' + config.myr + ' Myr, seed ' + config.seed
		+ ', dt ' + config.dt.join('/') + ', ' + work.length + ' scenarios');
	try {
		for (const scenario of work) {
			for (const tuning of TUNING) Params[tuning.key] = defaults[tuning.key];
			if (scenario.key) Params[scenario.key] = scenario.value;
			for (const dt of config.dt) {
				const row = run(grid, scenario, dt, config);
				rows.push(row);
				printRow(row);
			}
		}
	} finally {
		for (const tuning of TUNING) Params[tuning.key] = defaults[tuning.key];
	}
	const report = {
		format: 1,
		config: { level: config.level, myr: config.myr, seed: config.seed, sample: config.sample, dt: config.dt },
		defaults,
		candidates: TUNING,
		rows,
		recommendedOneFactor: recommendation(rows),
		acceptanceEligible: config.level === 5 && config.myr >= 1500
	};
	console.log('One-factor recommendation: ' + JSON.stringify(report.recommendedOneFactor));
	if (config.out) {
		fs.writeFileSync(config.out, JSON.stringify(report, null, 2) + '\n');
		console.log('Wrote ' + config.out);
	}
}

main();

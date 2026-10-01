// Catalogue statistics of a grown world: counts, tonnage and grade percentiles per family,
// and the whole-world scan time. Usage: node experiments/deposit-stats.js [level] [myr] [seed]
const Grid = require('../js/geodesics.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');
const Deposits = require('../js/deposits.js');
const level = +(process.argv[2] || 4), myr = +(process.argv[3] || 800), seed = +(process.argv[4] || 7);
const world = new State(new Grid(level, seed).build(), seed, true);
world.ckptCap = 0;
Sim.raster(world);
Sim.advance(world, 0.1, myr * 10);
const t0 = Date.now();
const snap = Deposits.snapshot(world, 'hot');
const t1 = Date.now();
const sc = Deposits.scenario(snap, 1);
Deposits.scan(sc, 0, Deposits.tileCount());
const t2 = Date.now();
const all = Deposits.allBodies(sc);
const pct = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
console.log('level', level, 'myr', myr, 'snapshot ms', t1 - t0, 'scan ms', t2 - t1, 'bodies', all.length,
	'json MB', (Deposits.json(sc).length / 1e6).toFixed(2));
for (const key of ['vms', 'arc', 'orogenic']) {
	const list = all.filter((b) => b.family === key);
	const ore = list.map((b) => b.oreTonnes).sort((a, b) => a - b);
	const burial = list.map((b) => b.burialTopM).sort((a, b) => a - b);
	console.log(key, list.length, 'ore Mt p10/50/90', [0.1, 0.5, 0.9].map((p) => (pct(ore, p) / 1e6).toFixed(2)).join('/'),
		'burial m p10/50/90', [0.1, 0.5, 0.9].map((p) => Math.round(pct(burial, p))).join('/'));
}
const pot = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'].map((f, k) => {
	const a = Array.from(snap.pot.subarray(k * snap.cells, (k + 1) * snap.cells)).sort((x, y) => x - y);
	return f + ' p50/p90/max ' + [0.5, 0.9, 0.9999].map((p) => pct(a, p).toFixed(3)).join('/');
});
console.log(pot.join('\n'));
const hostCount = {};
for (const h of snap.host) hostCount[Deposits.HOSTS[h]] = (hostCount[Deposits.HOSTS[h]] || 0) + 1;
console.log(JSON.stringify(hostCount));

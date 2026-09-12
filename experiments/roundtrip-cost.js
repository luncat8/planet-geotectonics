/* roundtrip-cost.js - the JS cost of the mirror round trip, measured headless on the stub
   device (tests/gpu-stub.js). The device calls are no-ops here, so these are the CPU-side
   pack, event cycle and unpack - the part that blocks the main thread inside a frame. The
   browser rig adds the queue drain and the real buffer copies on top. Usage:
     node experiments/roundtrip-cost.js [--level=5] [--reps=9] [--myr=1]
   download/upload are idempotent and are timed in a loop; Events.cycle mutates the mirror,
   so it is timed once on the live world (it is ~1% of the round trip). Two warm-up reps are
   discarded: the loops JIT-warm, and an unwarmed median overstates the cost by ~10x. */
'use strict';
const path = require('node:path');
const JS = path.join(__dirname, '..', 'js');
const Grid = require(path.join(JS, 'geodesics.js'));
const Params = require(path.join(JS, 'params.js'));
const State = require(path.join(JS, 'state.js'));
const Sim = require(path.join(JS, 'sim.js'));
const Events = require(path.join(JS, 'events.js'));
const GpuSim = require(path.join(JS, 'gpu', 'sim-gpu.js'));
const { makeDevice } = require(path.join(__dirname, '..', 'tests', 'gpu-stub.js'));

function arg(name, dflt) {
	for (const a of process.argv.slice(2)) if (a.startsWith('--' + name + '=')) return a.slice(name.length + 3);
	return dflt;
}
const level = parseInt(arg('level', Params.level), 10);
const reps = parseInt(arg('reps', '9'), 10);
const myr = parseFloat(arg('myr', '1'));
const WARMUP = 2;

function med(list) { const s = list.slice().sort((a, b) => a - b); return s[s.length >> 1]; }
function fmt(list) { return med(list).toFixed(2) + '/' + Math.min.apply(null, list).toFixed(2); }

async function bench(tag, fn) {
	const out = [];
	for (let r = -WARMUP; r < reps; r++) {
		const t = process.hrtime.bigint();
		await fn();
		if (r >= 0) out.push(Number(process.hrtime.bigint() - t) / 1e6);
	}
	return out;
}

(async () => {
	const state = new State(new Grid(level, Params.seed).build(), Params.seed);
	state.reset(Params.seed);
	state.ckptCap = 0;
	Sim.raster(state);
	Sim.runTo(state, 0.1, myr);
	await GpuSim.init(state, { device: makeDevice() });
	const S = GpuSim.S, size = n => S.buf[n].size;
	const mb = list => (list.reduce((s, n) => s + size(n), 0) / 1e6).toFixed(2);
	const dlFull = await bench('full down', () => GpuSim.download(state));
	const upFull = await bench('full up', () => GpuSim.uploadState(state));
	const dlEv = await bench('event down', () => GpuSim.downloadEvents(state));
	const upEv = await bench('event up', () => GpuSim.uploadEvents(state));
	// The cycle mutates the mirror, so it gets one timed call - on a path already warm
	// from a throwaway world, because a cold Events.cycle reads 16 ms instead of ~2.
	const warm = new State(new Grid(level, Params.seed + 1).build(), Params.seed + 1);
	warm.reset(Params.seed + 1);
	warm.ckptCap = 0;
	Sim.raster(warm);
	Sim.runTo(warm, 0.1, myr);
	Events.cycle(warm, Params.eventCadence);
	const t = process.hrtime.bigint();
	Events.cycle(state, Params.eventCadence);
	const cyc = Number(process.hrtime.bigint() - t) / 1e6;
	const min = list => Math.min.apply(null, list);
	console.log('L' + level + ' · V ' + S.l.V + ' · colCap ' + S.l.colCap + ' · ' + state.n + ' columns · '
		+ state.plateCount + ' plates · t ' + state.t.toFixed(1) + ' Myr · min of ' + reps + ' reps (ms)');
	console.log('  full   download ' + min(dlFull).toFixed(2) + ' · upload ' + min(upFull).toFixed(2)
		+ ' · total ' + (min(dlFull) + min(upFull)).toFixed(2) + ' ms · mirror ' + mb(GpuSim.FULL) + ' MB');
	console.log('  events download ' + min(dlEv).toFixed(2) + ' · cycle ' + cyc.toFixed(2) + ' · upload '
		+ min(upEv).toFixed(2) + ' · total ' + (min(dlEv) + cyc + min(upEv)).toFixed(2) + ' ms · reads '
		+ mb(GpuSim.EVENT_READS) + ' MB · writes ' + mb(GpuSim.EVENT_WRITES) + ' MB');
	console.log('  (medians, for the noise floor: full ' + fmt(dlFull) + '/' + fmt(upFull) + ' · events '
		+ fmt(dlEv) + '/' + fmt(upEv) + ')');
})();

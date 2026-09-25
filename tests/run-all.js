// Two profiles over the same test files:
//   short (default) - every test except the four histories whose runtime scales with simulated
//     time: kinematics (2 x 5000 frames), ores (an 800 Myr hot start), alloc (2000 frames under
//     two forced GCs) and longrun (1500 + 300 Myr, or 4500 + 500 Myr with --release).
//   full (--full) - adds those four. That is the regression gate on a real machine; in a 2-core
//     sandbox it is ~15 min against ~1 min for short (longrun alone is ~10 min), and anything
//     that reaches a GPU there runs on SwiftShader, so do not run full in a sandbox - run
//     run_full_test.py (double-click) on a real machine instead (AGENTS.md, "tests").
// --release implies --full: the release profile lives in longrun and the strict throughput
// proxy in perf.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const argv = process.argv.slice(2);
const release = argv.includes('--release');
const full = release || argv.includes('--full');
const HISTORIES = ['kinematics', 'ores', 'alloc', 'longrun'];
const SHORT = ['browser-scripts', 'gui', 'grid', 'quat', 'mantle', 'plates', 'edges', 'forces',
	'determinism', 'water', 'raster', 'conveyor', 'rift', 'isostasy', 'erosion', 'adj', 'collapse', 'split',
	'checkpoint', 'view-dir', 'rotations', 'gpml-plates', 'earth', 'paleo', 'reconstruct', 'perf', 'clipboard', 'wgsl-struct', 'gpu-play', 'gpu-readback',
	'gpu-d1diff', 'gpu-parity-ui', 'render3d'];
const names = full ? SHORT.concat(HISTORIES) : SHORT;
console.log('profile ' + (full ? 'full' : 'short') + ': ' + names.length + ' tests'
	+ (full ? '' : ' (--full adds ' + HISTORIES.join(', ') + ')'));
const started = Date.now();
for (const name of names) {
	const args = ['--expose-gc', path.join(__dirname, name + '.js')];
	if (release && (name === 'perf' || name === 'longrun')) args.push('--release');
	const t0 = Date.now();
	const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
	const ms = Date.now() - t0;
	if (result.status !== 0) {
		console.log('FAIL ' + name + ' after ' + ms + ' ms');
		process.exit(result.status || 1);
	}
	console.log('ok ' + name + ' ' + ms + ' ms');
}
console.log('PASS all tests (' + (full ? 'full' : 'short') + ' profile, ' + names.length + ' tests in '
	+ Math.round((Date.now() - started) / 1000) + ' s)');

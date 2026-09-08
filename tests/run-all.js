const { spawnSync } = require('node:child_process');
const path = require('node:path');
const release = process.argv.includes('--release');
for (const name of ['browser-scripts', 'grid', 'quat', 'mantle', 'plates', 'edges', 'forces', 'determinism',
	'raster', 'kinematics', 'conveyor', 'rift', 'isostasy', 'erosion', 'collapse', 'split', 'checkpoint',
	'ores', 'wgsl', 'gpu-parity', 'perf', 'alloc', 'longrun']) {
	const args = ['--expose-gc', path.join(__dirname, name + '.js')];
	if (release && (name === 'perf' || name === 'longrun')) args.push('--release');
	const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
	if (result.status !== 0) process.exit(result.status || 1);
}
console.log('PASS all tests');

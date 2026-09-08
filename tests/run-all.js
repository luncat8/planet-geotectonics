const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const name of ['browser-scripts', 'grid', 'quat', 'mantle', 'plates', 'edges', 'forces', 'determinism',
	'raster', 'kinematics', 'conveyor', 'rift', 'isostasy', 'erosion', 'collapse', 'perf', 'alloc']) {
	const result = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, name + '.js')], { stdio: 'inherit' });
	if (result.status !== 0) process.exit(result.status || 1);
}
console.log('PASS all tests');

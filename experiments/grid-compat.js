// Offline grid audit, not loaded by the page. No climate engine is vendored.
// node experiments/grid-compat.js /path/to/planet-climate [minLevel=3] [maxLevel=7]
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');
var crypto = require('node:crypto');
var child = require('node:child_process');
var GlobeGrid = require('../js/geodesics.js');

function loadGrid(source, filename) {
	var context = { module: { exports: {} } };
	vm.createContext(context);
	vm.runInContext(source, context, { filename: filename });
	var exported = context.module.exports;
	var Grid = typeof exported === 'function' ? exported : exported.Grid || context.Grid;
	if (typeof Grid !== 'function') throw new Error('Climate Grid constructor not found');
	return Grid;
}

function compare(g, c) {
	for (var key of ['V', 'W', 'H', 'lookupW', 'lookupH']) {
		if (g[key] !== c[key]) throw new Error(key + ' mismatch: ' + g[key] + ' vs ' + c[key]);
	}
	if (c.cellA.length < c.V * 4 || c.nbrA.length < c.W * c.H * 24 || c.lookup.length !== g.lookup.length) {
		throw new Error('Climate buffer dimensions mismatch');
	}
	var maxAngle = 0, maxCell = 0, ringMismatches = 0, lookupMismatches = 0;
	for (var i = 0; i < g.V; i++) {
		var ax = g.pos[i * 3], ay = g.pos[i * 3 + 1], az = g.pos[i * 3 + 2];
		var bx = c.cellA[i * 4], by = c.cellA[i * 4 + 1], bz = c.cellA[i * 4 + 2];
		var aLen = Math.hypot(ax, ay, az), bLen = Math.hypot(bx, by, bz);
		if (!Number.isFinite(aLen + bLen) || aLen === 0 || bLen === 0) throw new Error('Invalid centre at cell ' + i);
		// atan2(cross, dot) ignores float32 radial error and resolves tiny angles.
		var cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
		var angle = Math.atan2(cross, ax * bx + ay * by + az * bz);
		if (angle > maxAngle) { maxAngle = angle; maxCell = i; }
		for (var slot = 0; slot < 6; slot++) {
			var offset = (i + slot * c.W * c.H) * 4;
			var valid = c.nbrA[offset + 3];
			if (valid !== (slot < g.ringN[i] ? 1 : 0)) ringMismatches++;
			else if (valid && c.nbrA[offset] !== g.ring[i * 6 + slot]) ringMismatches++;
		}
	}
	for (var j = 0; j < g.lookup.length; j++) {
		if (g.lookup[j] !== c.lookup[j]) lookupMismatches++;
	}
	return {
		level: g.level, V: g.V, W: g.W, H: g.H,
		maxAngleRad: maxAngle, maxDistanceM: maxAngle * 6371000, maxCell: maxCell,
		ringMismatches: ringMismatches, lookupMismatches: lookupMismatches,
		pass: maxAngle <= 1e-6 && ringMismatches === 0 && lookupMismatches === 0
	};
}

function main(args) {
	if (args.length < 1 || args.length > 3) throw new Error('Usage: node experiments/grid-compat.js <climate-checkout> [minLevel] [maxLevel]');
	var root = path.resolve(args[0]), min = args[1] === undefined ? 3 : Number(args[1]);
	var max = args[2] === undefined ? 7 : Number(args[2]);
	if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 7 || min > max) throw new Error('Levels must be integers with 0 <= min <= max <= 7');
	var file = path.join(root, 'planet/geodesics.js'), source = fs.readFileSync(file, 'utf8');
	var ClimateGrid = loadGrid(source, file);
	var revision = child.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	var dirty = child.execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'planet/geodesics.js'], { encoding: 'utf8' }).trim() !== '';
	var rows = [];
	for (var level = min; level <= max; level++) {
		rows.push(compare(new GlobeGrid(level, 12345).build(), new ClimateGrid(level, 12345).build()));
	}
	var report = {
		climateRevision: revision, climateGridDirty: dirty,
		climateGridSha256: crypto.createHash('sha256').update(source).digest('hex'),
		seed: 12345, angleToleranceRad: 1e-6, rows: rows,
		pass: rows.every(function (row) { return row.pass; })
	};
	console.log(JSON.stringify(report, null, '\t'));
	if (!report.pass) process.exitCode = 1;
}

if (require.main === module) {
	try { main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { loadGrid: loadGrid, compare: compare };

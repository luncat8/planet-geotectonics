// Offline 0.9.1 counterpart rehearsal; no WebGL/browser claim and no runtime dependency.
// node experiments/climate-rehearsal.js /path/to/planet-climate [level=3]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const child = require('node:child_process');
const GlobeGrid = require('../js/geodesics.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');
const Checkpoint = require('../js/checkpoint.js');
const Surface = require('../js/climate-surface.js');
const Session = require('../js/session.js');

function main(args) {
	if (args.length < 1 || args.length > 2)
		throw new Error('Usage: node experiments/climate-rehearsal.js <climate-checkout> [level=3]');
	const root = path.resolve(args[0]), level = args[1] === undefined ? 3 : Number(args[1]);
	if (!Number.isInteger(level) || level < 0 || level > 7) throw new Error('level must be an integer from 0 to 7');
	const context = vm.createContext({ console, performance, btoa, atob });
	for (const name of ['geodesics.js', 'params.js', 'engine.js']) {
		const file = path.join(root, 'planet', name);
		vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
	}
	const revision = child.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const grid = new GlobeGrid(level, 7).build();
	const state = new State(grid, 7);
	state.ckptCap = 0;
	Sim.raster(state);
	Sim.advance(state, 0.1, 50); // include any temporary NaN/uncovered cells in the contract
	const params = vm.runInContext('defaultParams()', context);
	const climateGrid = vm.runInContext('new Grid(' + level + ', 12345, defaultParams()).build()', context);
	if (climateGrid.V !== grid.V) throw new Error('active cell count mismatch');
	const surface = {
		format: Surface.FORMAT, version: 1, level: level, V: grid.V,
		lookupW: grid.lookupW, lookupH: grid.lookupH,
		lookup: grid.lookup, elevation: new Float64Array(state.z),
		seaLevel: 0, tMyr: state.t
	};
	const planet = {
		grid: climateGrid, params: params, texCellB: {}, texCellC: {}, writes: 0,
		writeTex: function () { this.writes++; }
	};
	const mapped = Surface.apply(planet, surface);
	if (planet.writes !== 2) throw new Error('surface did not upload both static geometry textures');
	for (let i = 0; i < grid.V; i++) {
		const source = Surface.sourceCell(surface, climateGrid.cellA[i * 4], climateGrid.cellA[i * 4 + 1], climateGrid.cellA[i * 4 + 2]);
		const expected = Number.isNaN(state.z[source]) || state.z[source] < 0 ? 0 : 1;
		if (climateGrid.cellB[i * 4 + 3] !== expected) throw new Error('land mapping mismatch at cell ' + i);
	}
	const textures = [];
	for (let i = 0; i < 8; i++) textures.push(new Float32Array(climateGrid.W * climateGrid.H * 4));
	context.raw = {
		version: 1, level: level, W: climateGrid.W, H: climateGrid.H,
		simTime: 0, stepCount: 0, params: params, bounds: {}, A: textures
	};
	const encoded = vm.runInContext('encodePlanetState(raw)', context);
	const payload = { format: 'pgt-climate-state', version: 1, state: encoded, surface: Surface.encode(surface) };
	Session.validateClimate(payload);
	const bytes = Session.encode(Checkpoint.save(state), payload);
	const decoded = Session.decode(bytes);
	context.encoded = decoded.climate.state;
	const restored = vm.runInContext('decodePlanetState(encoded)', context);
	for (let i = 0; i < 8; i++) {
		if (restored.A[i].length !== climateGrid.W * climateGrid.H * 4)
			throw new Error('decoded texture ' + i + ' has the wrong padded length');
	}
	console.log(JSON.stringify({
		climateRevision: revision, level: level, cells: grid.V,
		mappedLandCells: mapped.landCells, mappedGapCells: mapped.gapCells, textureUploads: planet.writes,
		sessionBytes: bytes.byteLength, paddedTextureLength: restored.A[0].length,
		checks: 'real climate Grid/defaultParams/state codec + real globe State/Checkpoint; no WebGL',
		pass: true
	}, null, '\t'));
}
try { main(process.argv.slice(2)); }
catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }

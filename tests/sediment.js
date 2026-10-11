// sediment.js tests (0.4.8): the modern-pack sediment contract. The raster path replaces the
// sediment bank with the quantized CRUST1.0 extract and moves z only on a thickness-bound
// hit. The point path is fixture-only — there is no observations file, and this test does
// not treat calibration_points.json as a sediment dataset.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { assert } = require('./helpers.js');
const Earth = require('../js/earth.js');
const S = require('../tools/earth/sediment.js');

const ROOT = path.join(__dirname, '..');
const EXTRACT = path.join(ROOT, 'data/earth/sediment-crust1.bin');
const BASELINE = path.join(ROOT, 'data/earth/sediment-baseline.json');

function sha(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}
function md5(file) {
	return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

// --- quantization and the containing-cell sample ------------------------------------
assert.equal(S.quantizeSed(-10), 0);
assert.equal(S.quantizeSed(49), 0);
assert.equal(S.quantizeSed(50), 100);
assert.equal(S.quantizeSed(21000), 21000);
assert.equal(S.quantizeSed(30000), 25500, 'the pack step caps at 255');

const grid = S.loadCrust1(EXTRACT);
assert.equal(grid.w, 360);
assert.equal(grid.h, 180);
let minS = grid.sed[0], maxS = grid.sed[0], zeros = 0;
for (let i = 0; i < grid.sed.length; i++) {
	if (grid.sed[i] < minS) minS = grid.sed[i];
	if (grid.sed[i] > maxS) maxS = grid.sed[i];
	if (grid.sed[i] === 0) zeros++;
}
assert.equal(minS, 0, 'modelled zero is stored as zero');
assert.equal(maxS, 21000);
assert.ok(zeros > 0, 'the extract contains modelled zeros');
// 0.5° centres share the containing 1° cell. Longitude wraps; the south pole clamps.
assert.equal(S.sampleCrust1(grid, 12.25, -59.75), S.sampleCrust1(grid, 12.75, -59.25));
assert.equal(S.sampleCrust1(grid, 0, 179.5), S.sampleCrust1(grid, 0, -180.5));
assert.equal(S.sampleCrust1(grid, -90, 10), S.sampleCrust1(grid, -89.5, 10));
for (const turns of [-3, -1, 0, 1, 3]) {
	assert.equal(S.sampleCrust1(grid, 12.5, 10.5 + 360 * turns), S.sampleCrust1(grid, 12.5, 10.5));
}

// --- envelope: keep z, except a thickness bound the loader cannot carry ---------------
// A round-tripping column is left alone.
assert.ok(S.roundTrips(400, 255, 2000, 1));
const kept = S.envelopeZ(400, 255, 2000, 1);
assert.equal(kept.moved, false);
assert.equal(kept.z, 400);
assert.equal(kept.residual, 0);

// Thick ocean sediment on a deep column hits the hMaf floor. z becomes that elevation
// and the new pair round-trips. Continental maf = 0 is not this bound.
const deep = S.envelopeZ(-4000, 20, 18000, 0);
assert.equal(deep.moved, true);
assert.ok(S.roundTrips(deep.z, 20, 18000, 0), 'clamped elevation round-trips');
const again = S.envelopeZ(deep.z, 20, 18000, 0);
assert.equal(again.moved, false, 'a clamped cell is a fixed point');
assert.equal(again.z, deep.z);

// Transitional continental crust: the 5-iteration invert leaves a residual and does not
// hit hFel 1 km or 80 km. Chasing a distant integer would move the shelf; z stays.
const shelf = S.envelopeZ(-580, 255, 9800, 1);
assert.equal(shelf.moved, false);
assert.equal(shelf.z, -580);
assert.ok(shelf.residual > 1 && shelf.residual < 80, 'residual labelled, not chased: ' + shelf.residual);

// --- observations: provenance, and the point path does not move z ---------------------
function row(over) {
	return Object.assign({
		id: 'a', lat: 10, lon: 20, field: 'sediment_thickness', crust: 'continental',
		role: 'interpreted', holdout: false, source_id: 'crust1', dataset_version: '1.0',
		extraction: 'containing cell', record: 'bnds', footprint_m: 100000,
		value: 4000, unit: 'm', uncertainty_m: 500
	}, over);
}
assert.equal(S.validateObservations({ observations: [row()] }).ok, true);
const dup = S.validateObservations({ observations: [row(), row({ id: 'a', lat: 1 })] });
assert.ok(!dup.ok && dup.errors.some((e) => /duplicate/.test(e)));
const bare = S.validateObservations({ observations: [row({ source_id: '', value: 0, uncertainty_m: null })] });
assert.ok(!bare.ok && bare.errors.some((e) => /source_id/.test(e)));
assert.ok(bare.errors.some((e) => /zero is not unknown/.test(e)));
const missing = S.validateObservations({ observations: [row({ dataset_version: undefined })] });
assert.ok(!missing.ok);
for (const key of ['id', 'source_id', 'dataset_version', 'extraction', 'record']) {
	for (const value of [undefined, null, '', '  ', 0, {}, []]) {
		const result = S.validateObservations({ observations: [row({ [key]: value })] });
		assert.ok(!result.ok && result.errors.some((e) => e.includes(key)), key + ' requires text');
	}
}
for (const key of ['lat', 'lon', 'value', 'footprint_m', 'uncertainty_m', 'radius_m']) {
	for (const value of [NaN, Infinity, -Infinity, '500', true]) {
		assert.equal(S.validateObservations({ observations: [row({ [key]: value })] }).ok, false,
			key + ' must reject ' + value);
	}
}
for (const over of [{ lat: 91 }, { lon: -181 }, { footprint_m: -1 }, { value: -1 },
	{ radius_m: 0 }, { radius_m: null }, { uncertainty_m: -1 }, { value: 0, uncertainty_m: null }]) {
	assert.equal(S.validateObservations({ observations: [row(over)] }).ok, false);
}
for (const unknown_reason of [undefined, null, '', ' ', 1]) {
	assert.equal(S.validateObservations({ observations: [row({ value: null, unknown_reason })] }).ok, false);
}
assert.equal(S.validateObservations({ observations: [row({ value: 0, uncertainty_m: 0 })] }).ok, true);
assert.equal(S.validateObservations({ observations: [row({ value: 4000, uncertainty_m: null })] }).ok, true);
assert.equal(S.validateObservations({ observations: [null, [], 'row'] }).ok, false);


const points = {
	w: 4, h: 2,
	kind: Uint8Array.from([1, 1, 1, 1, 0, 0, 0, 0]),
	z: Float64Array.from([200, 200, 200, 200, -4000, -4000, -4000, -4000]),
	age: Float64Array.from([255, 255, 255, 255, 20, 20, 20, 20]),
	sed: Float64Array.from([2000, 2000, 2000, 2000, 1000, 1000, 1000, 1000])
};
const ll0 = S.cellLatLon(4, 2, 0);
const llOcean = S.cellLatLon(4, 2, 4);
const unknown = row({ id: 'unknown', lat: ll0[0], lon: ll0[1], value: null, unknown_reason: 'not sampled' });
assert.equal(S.validateObservations({ observations: [unknown] }).ok, true);
const unknownOnly = S.correctPoints(points, [unknown]);
assert.equal(unknownOnly.touched, 0, 'unknown observations do not support a correction');
assert.deepEqual(unknownOnly.sed, points.sed, 'unknown preserves the prior, not zero');
const measured = row({ id: 'measured', lat: ll0[0], lon: ll0[1], value: 4000 });
assert.deepEqual(S.correctPoints(points, [unknown, measured]), S.correctPoints(points, [measured]),
	'unknown must not dilute the measured IDW sum');
const zero = S.correctPoints(points, [row({ lat: ll0[0], lon: ll0[1], value: 0, uncertainty_m: 0 })]);
assert.equal(zero.touched, 1, 'measured zero contributes');
assert.equal(zero.sed[0], 0);
assert.throws(() => S.correctPoints(points, [row({ value: NaN })]), /value/);
for (const radiusM of [0, -1, NaN, Infinity, '500', null]) {
	assert.throws(() => S.correctPoints(points, [], { radiusM }), /radiusM/);
}

const holdoutOnly = S.correctPoints(points, [row({ lat: ll0[0], lon: ll0[1], holdout: true, value: 9000 })]);
assert.equal(holdoutOnly.touched, 0);
assert.equal(holdoutOnly.sed[0], 2000, 'a holdout does not move the prior');
const otherClass = S.correctPoints(points, [row({
	lat: llOcean[0], lon: llOcean[1], crust: 'continental', value: 9000, radius_m: 1e7
})]);
assert.equal(otherClass.sed[4], 1000, 'no blend across the crust class');
const pulled = S.correctPoints(points, [row({
	id: 'basin', lat: llOcean[0], lon: llOcean[1], crust: 'oceanic', value: 18000, radius_m: 1e7
})]);
assert.ok(pulled.pulled > 0, 'sediment walks back until the stored z round-trips');
assert.ok(pulled.sed[4] < 18000 && pulled.sed[4] >= 1000);
assert.ok(S.roundTrips(points.z[4], points.age[4], pulled.sed[4], 0));
assert.equal(points.z[4], -4000, 'the point path does not rewrite z');

// --- the committed modern packs are the fixed point of the raster rule ----------------
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
assert.equal(md5(EXTRACT), baseline.extractMd5);
assert.equal(sha(fs.readFileSync(EXTRACT)), baseline.extractSha256);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/earth/manifest.json'), 'utf8'));
for (const rel of Object.keys(manifest.files)) {
	assert.equal(md5(path.join(ROOT, rel)), manifest.files[rel], rel + ' matches the manifest');
}

const BANKS = {
	'js/data/earth-1deg.js': {
		datum: -460, plates: 25,
		age: 'ec9cd10faf9e62e9c6a796f97a9d6a87731e198a552d04be7099ad96217a4190',
		kind: '854dc2ec6e510a84bbe123e8b12987d1c60da622a4672a4bc852be8eb0d4294a',
		ids: '72d86c5d3bc60cc747ae0c9f637d34cfdb8f95d03e0e2c33c4fed31ec014cca8'
	},
	'js/data/earth-05deg.js': {
		datum: -444, plates: 25,
		age: '07f55d9db3092282fff46ce590cb6de760ac6cc81f177e7d5da0531338e77865',
		kind: '3ec57b3a4dfd90c9678027eb5023ff3621bec8ede4a61e712867cded169ea5a1',
		ids: 'c78743fd1fc97fb42d16fefa527594a68f2ac3127b47171bfc1cd43c0e883916'
	}
};
for (const rel of Object.keys(BANKS)) {
	const pack = S.loadPack(path.join(ROOT, rel));
	assert.equal(pack.name, 'earth');
	assert.equal(pack.epoch, 0);
	assert.equal(pack.datum, BANKS[rel].datum, rel + ' datum');
	assert.equal(pack.plates.count, BANKS[rel].plates);
	assert.ok(/CRUST1\.0 sediment \(not GlobSed\)/.test(pack.source), rel + ' names the fallback');
	assert.ok(!/live hSed/.test(pack.source));
	const d = Earth.decode(pack);
	assert.equal(sha(Earth.decodeBase64(pack.banks.age)), BANKS[rel].age, rel + ' age');
	assert.equal(sha(Earth.decodeBase64(pack.banks.kind)), BANKS[rel].kind, rel + ' kind');
	assert.equal(sha(Earth.decodeBase64(pack.plates.ids)), BANKS[rel].ids, rel + ' plates');
	const applied = S.applyRaster(d, pack.w, pack.h, grid);
	let sedMismatch = 0, zMismatch = 0, boundResidual = 0, maxResidual = 0;
	for (let i = 0; i < d.z.length; i++) {
		const ll = S.cellLatLon(pack.w, pack.h, i);
		if (Math.round(d.sed[i]) !== S.quantizeSed(S.sampleCrust1(grid, ll[0], ll[1]))) sedMismatch++;
		if (applied.z[i] !== d.z[i] || applied.sed[i] !== Math.round(d.sed[i] / 100)) zMismatch++;
		const cont = d.kind[i] & 1;
		const gap = Math.abs(S.derivedZ(d.z[i], d.age[i], d.sed[i], cont) - d.z[i]);
		if (gap <= 1) continue;
		if (gap > maxResidual) maxResidual = gap;
		const inv = { fel: 0, maf: 0 };
		Earth.invert(d.z[i], cont ? 500 : d.age[i], d.sed[i], cont, inv);
		if (S.thicknessBound(inv, cont)) boundResidual++;
	}
	assert.equal(sedMismatch, 0, rel + ' sediment is the containing cell');
	assert.equal(zMismatch, 0, rel + ' is a fixed point of applyRaster');
	assert.equal(boundResidual, 0, rel + ' residuals are not thickness bounds');
	assert.ok(maxResidual < 80, rel + ' residual ' + maxResidual.toFixed(1) + ' m');
	const banks = { z: Buffer.alloc(d.z.length * 2), sed: Buffer.alloc(d.z.length) };
	for (let i = 0; i < d.z.length; i++) {
		banks.z.writeInt16LE(Math.round(d.z[i]), i * 2);
		banks.sed[i] = Math.round(d.sed[i] / 100);
	}
	assert.equal(sha(banks.z), baseline.accepted[rel].zSha256, rel + ' z');
	assert.equal(sha(banks.sed), baseline.accepted[rel].sedSha256, rel + ' sed');
	assert.notEqual(sha(banks.z), baseline.prior[rel].zSha256);
	assert.notEqual(sha(banks.sed), baseline.prior[rel].sedSha256);
	console.log('  ' + rel + ' residual max ' + maxResidual.toFixed(1) + ' m, wet ' + pack.ocean);
}

// --- text patch: age, kind and datum stay; a second apply is the same bytes -----------
function tinyPack(z, age, sed, kind) {
	const zBuf = Buffer.alloc(2);
	zBuf.writeInt16LE(z);
	const b64 = (b) => Buffer.from(b).toString('base64');
	return '// synthetic\n(function () {\n'
		+ '\tvar globalObject = typeof global !== \'undefined\' ? global : this;\n'
		+ '\tif (!globalObject.EarthPacks) globalObject.EarthPacks = [];\n'
		+ '\tglobalObject.EarthPacks.push({\n'
		+ '\t\tname: \'earth\',\n\t\tepoch: 0,\n\t\tw: 1,\n\t\th: 1,\n'
		+ '\t\tsource: \'synthetic\',\n\t\tdatum: -460.0,\n\t\tocean: 0.5000,\n'
		+ '\t\tscale: { z: 1, age: 1, sed: 0.1 },\n\t\tbanks: {\n'
		+ '\t\t\tz: \'' + b64(zBuf) + '\',\n'
		+ '\t\t\tage: \'' + b64(Buffer.from([age])) + '\',\n'
		+ '\t\t\tsed: \'' + b64(Buffer.from([sed])) + '\',\n'
		+ '\t\t\tkind: \'' + b64(Buffer.from([kind])) + '\'\n'
		+ '\t\t},\n\t\tplates: { count: 1, ids: \'' + b64(Buffer.from([0])) + '\','
		+ ' seeds: [[0, 0, 1]], poles: [[0, 0, 1, 0]] }\n\t});\n})();\n';
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgt-sediment-'));
try {
	const tmp = path.join(tmpDir, 'tiny.js');
	fs.writeFileSync(tmp, tinyPack(-2000, 40, 10, 0));
	const beforeAge = fs.readFileSync(tmp, 'utf8').match(/age: '[^']+'/)[0];
	const beforeKind = fs.readFileSync(tmp, 'utf8').match(/kind: '[^']+'/)[0];
	const { spawnSync } = require('child_process');
	function runApply(packFile, sedimentFile = EXTRACT) {
		return spawnSync(process.execPath, [
			path.join(ROOT, 'tools/earth/sediment.js'),
			'--apply', '--pack', packFile, '--sediment', sedimentFile
		], { encoding: 'utf8' });
	}
	const first = runApply(tmp);
	assert.equal(first.status, 0, first.stderr);
	const once = fs.readFileSync(tmp);
	const text = once.toString('utf8');
	assert.ok(text.indexOf(beforeAge) >= 0, 'age bank preserved');
	assert.ok(text.indexOf(beforeKind) >= 0, 'kind bank preserved');
	assert.ok(text.indexOf('datum: -460.0') >= 0, 'datum preserved');
	assert.ok(/CRUST1\.0 sediment \(not GlobSed\)/.test(text));
	const second = runApply(tmp);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(fs.readFileSync(tmp).equals(once), true, 'second apply is byte-identical');


	const hist = path.join(tmpDir, '250.js');
	fs.copyFileSync(path.join(ROOT, 'js/data/earth-250Ma.js'), hist);
	const histBefore = sha(fs.readFileSync(hist));
	const refused = runApply(hist);
	assert.notEqual(refused.status, 0);
	assert.ok(/refused/.test(refused.stderr));
	assert.equal(sha(fs.readFileSync(hist)), histBefore, 'a historical pack is not written');
	fs.unlinkSync(hist);

	// Malformed extracts must fail before touching the destination pack.
	const badExtract = path.join(tmpDir, 'bad.bin');
	for (const [w, h] of [[0, 0], [1, 1], [180, 360]]) {
		const buf = Buffer.alloc(16 + w * h * 2);
		buf.write('PGTSED01');
		buf.writeUInt16LE(w, 8);
		buf.writeUInt16LE(h, 10);
		fs.writeFileSync(badExtract, buf);
		assert.throws(() => S.loadCrust1(badExtract), /360x180/);
		const result = runApply(tmp, badExtract);
		assert.notEqual(result.status, 0);
		assert.deepEqual(fs.readFileSync(tmp), once, 'invalid dimensions cannot overwrite a pack');
	}
	for (const buf of [Buffer.alloc(16), fs.readFileSync(EXTRACT).subarray(0, 20)]) {
		fs.writeFileSync(badExtract, buf);
		assert.throws(() => S.loadCrust1(badExtract), /PGTSED01|length/);
	}

	// Extraction rejects invalid boundaries rather than turning them into modelled zeros.
	const bnds = path.join(tmpDir, 'crust1.bnds');
	const output = path.join(tmpDir, 'extracted.bin');
	const goodRow = '0 -1 -2 -3 -5 -6 -10 -20 -30';
	function runExtract(firstRow, count = 64800) {
		fs.writeFileSync(bnds, firstRow + '\n' + (goodRow + '\n').repeat(count - 1));
		return spawnSync(process.execPath, [path.join(ROOT, 'tools/earth/sediment.js'),
			'--extract-bnds', bnds, '--out', output], { encoding: 'utf8' });
	}
	const extracted = runExtract(goodRow);
	assert.equal(extracted.status, 0, extracted.stderr);
	const extractedBytes = fs.readFileSync(output);
	assert.ok(S.loadCrust1(output).sed.every((v) => v === 4000), 'water and ice excluded');
	for (const firstRow of [
		'0 -1 -2 NaN -5 -6 -10 -20 -30',
		'0 -1 -2 -3 -5 -Infinity -10 -20 -30',
		'0 -1 -2 -1 -5 -6 -10 -20 -30',
		'0 -1 -2 -3 -5 -70 -80 -90 -100',
		'0 -1 -2 -3 -5 -6 -10 -20'
	]) {
		const result = runExtract(firstRow);
		assert.notEqual(result.status, 0, 'invalid boundary row refused');
		assert.deepEqual(fs.readFileSync(output), extractedBytes, 'failed extract preserves output');
	}
	assert.notEqual(runExtract(goodRow, 1).status, 0, 'incomplete grid refused');

	// The validation-only CLI reports machine-readable errors and never edits its input.
	const observationsFile = path.join(tmpDir, 'observations.json');
	for (const [observations, ok] of [[[row(), unknown], true], [[row({ source_id: null })], false]]) {
		const doc = JSON.stringify({ observations });
		fs.writeFileSync(observationsFile, doc);
		const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/earth/sediment.js'),
			'--validate-observations', observationsFile], { encoding: 'utf8' });
		assert.equal(result.status, ok ? 0 : 1, result.stderr);
		assert.equal(JSON.parse(result.stdout).ok, ok);
		assert.equal(fs.readFileSync(observationsFile, 'utf8'), doc);
	}
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('PASS sediment: extract sample, envelope rule, point schema, modern packs fixed');

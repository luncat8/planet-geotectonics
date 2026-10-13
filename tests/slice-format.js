// pgt-slice-pack v2 contract: raw-schema refusal, canonical identities and path geometry.
const { assert } = require('./helpers.js');
const fs = require('node:fs');
const path = require('node:path');
const SP = require('../port/slice-format.js');

const fixturePath = path.join(__dirname, '../port/fixtures/slice-pack-v2.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8').trim();
const fixtureRaw = JSON.parse(fixtureText);
const fixture = SP.decode(fixtureText);
const CHECKSUM = '2d3941bda088d8d2';
const PATH_CHECKSUM = 'cc5cd21d5ddc5712';

function raw() {
	return JSON.parse(fixtureText);
}
function refuse(name, edit, match) {
	const candidate = raw();
	edit(candidate);
	assert.throws(function () { SP.decode(JSON.stringify(candidate)); }, match, name);
}
function reseal(edit) {
	const pack = SP.decode(fixtureText);
	edit(pack);
	SP.seal(pack);
	return pack;
}

assert.equal(SP.FORMAT, 'pgt-slice-pack');
assert.equal(SP.VERSION, 2);
assert.equal(SP.FIELDS.length, 17);
assert.deepEqual(SP.POTENTIALS, ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla']);
assert.equal(fixture.checksum, CHECKSUM);
assert.equal(SP.pathChecksum(fixture.path), PATH_CHECKSUM);
assert.equal(SP.validate(fixture), '');
assert.equal(SP.verify(fixture), '');
assert.equal(SP.encode(fixture), fixtureText, 'decode/encode returns the canonical fixture bytes');
assert.ok(fixture.sKm instanceof Float64Array);
assert.ok(fixture.pot instanceof Float32Array);
assert.ok(fixture.host instanceof Uint8Array);
assert.deepEqual(Array.from(fixture.bnd), [0, 1, 2, 3, 4, 0, 0], 'fixture carries every boundary code');
assert.deepEqual(fixture.plates.map(function (plate) { return plate.n; }), [3, 3], 'plate counts exclude the gap');
assert.equal(SP.normalize, undefined, 'v2 has no public normalize-first reader path');
const writerPack = raw();
writerPack.source.built = '2026-10-13T23:31:00.000Z';
SP.seal(writerPack);
assert.ok(writerPack.sKm instanceof Float64Array && writerPack.host instanceof Uint8Array,
	'seal validates plain writer fields before giving them declared types');
assert.equal(SP.decode(SP.encode(writerPack)).checksum, writerPack.checksum);

// Full identity covers every semantic group. Geographic identity covers only the canonical line:
// cellKm is source-grid metadata, while the origin/azimuth/arc name the line itself.
const sourceEdits = [
	function (pack) { pack.source.repo += '-mirror'; },
	function (pack) { pack.source.commit = '0000000000000000000000000000000000000000'; },
	function (pack) { pack.source.pack += '-other'; },
	function (pack) { pack.source.epochMa += 1; },
	function (pack) { pack.source.rotModel += '-other'; },
	function (pack) { pack.source.tMyr += 1; },
	function (pack) { pack.source.level += 1; },
	function (pack) { pack.source.gridSeed += 1; },
	function (pack) { pack.source.simSeed += 1; }
];
for (const edit of sourceEdits) {
	const changed = reseal(edit);
	assert.notEqual(changed.checksum, CHECKSUM, 'source metadata changes full identity');
	assert.equal(SP.pathChecksum(changed.path), PATH_CHECKSUM, 'source metadata does not change path identity');
}
const seaChanged = reseal(function (pack) { pack.sea.mode = 'level'; });
const plateChanged = reseal(function (pack) { pack.plates[0].wx += 0.01; });
const licenseChanged = reseal(function (pack) { pack.license += ' amended'; });
const payloadChanged = reseal(function (pack) { pack.zM[0] += 1; });
for (const changed of [seaChanged, plateChanged, licenseChanged, payloadChanged]) {
	assert.notEqual(changed.checksum, CHECKSUM);
	assert.equal(SP.pathChecksum(changed.path), PATH_CHECKSUM);
}
const cellBudgetChanged = reseal(function (pack) { pack.path.cellKm = 7100; });
assert.notEqual(cellBudgetChanged.checksum, CHECKSUM);
assert.equal(SP.pathChecksum(cellBudgetChanged.path), PATH_CHECKSUM, 'cell budget is not geographic identity');
const pathChanged = reseal(function (pack) { pack.path.lat0 += 1; });
assert.notEqual(pathChanged.checksum, CHECKSUM);
assert.notEqual(SP.pathChecksum(pathChanged.path), PATH_CHECKSUM);
const builtChanged = SP.decode(fixtureText);
builtChanged.source.built = '2026-10-14T00:00:00.000Z';
assert.equal(SP.verify(builtChanged), '', 'capture timestamp is excluded from full identity');
assert.equal(builtChanged.checksum, CHECKSUM);
assert.notEqual(SP.encode(builtChanged), fixtureText, 'capture timestamp remains visible provenance');

// Raw fields are proved before typed-array conversion. These would have been truncated or
// silently zero-filled by the v1 normalize-first reader.
refuse('v1 has a clear version refusal', function (pack) { pack.version = 1; }, /pack version 1, this build reads 2/);
refuse('missing array is not zero-filled', function (pack) { delete pack.hFelM; }, /missing hFelM/);
refuse('wrong raw length is rejected', function (pack) { pack.pot.pop(); }, /field pot has 41 values/);
refuse('fractional integer is not truncated', function (pack) { pack.host[0] = 1.5; }, /not a u8/);
refuse('out-of-range integer is not wrapped', function (pack) { pack.pol[0] = 128; }, /not a i8/);
refuse('null is not converted to zero', function (pack) { pack.ageMyr[0] = null; }, /not finite/);
refuse('array-shaped object is not accepted', function (pack) { pack.host = Object.assign({}, pack.host); }, /must be a JSON array/);
refuse('unknown top-level field requires a version', function (pack) { pack.extra = 1; }, /unknown field extra/);
refuse('unknown source field requires a version', function (pack) { pack.source.branch = 'main'; }, /unknown field branch/);
refuse('unknown path field requires a version', function (pack) { pack.path.normal = [0, 1, 0]; }, /unknown field normal/);
refuse('unknown plate field requires a version', function (pack) { pack.plates[0].code = 'AF'; }, /unknown field code/);
refuse('missing checksum is rejected', function (pack) { delete pack.checksum; }, /missing checksum/);
refuse('uppercase checksum is non-canonical', function (pack) { pack.checksum = pack.checksum.toUpperCase(); }, /16 lowercase hex/);
refuse('invalid built timestamp is rejected', function (pack) { pack.source.built = 'today'; }, /ISO-8601/);
refuse('empty provenance string is rejected', function (pack) { pack.source.repo = ''; }, /must not be empty/);

// Every semantic group is inside the full checksum, independently of structural validation.
refuse('path edit is detected', function (pack) { pack.path.lat0 += 1; }, /checksum mismatch/);
refuse('sea edit is detected', function (pack) { pack.sea.mode = 'level'; }, /checksum mismatch/);
refuse('plate table edit is detected', function (pack) { pack.plates[0].wx += 0.01; }, /checksum mismatch/);
refuse('payload edit is detected', function (pack) { pack.zM[0] += 1; }, /checksum mismatch/);
refuse('license edit is detected', function (pack) { pack.license += ' amended'; }, /checksum mismatch/);

// Cross-field semantics: canonical gaps, host law, boundary polarity and plate references.
refuse('gap material is rejected', function (pack) { pack.hSedM[5] = 1; }, /host code does not match|gap row/);
refuse('gap elevation is the rounded fractional sea level', function (pack) { pack.zM[5] = 126; }, /rounded sea level/);
refuse('gap potential is rejected', function (pack) { pack.pot[5 * 6] = 0.1; }, /gap row has non-zero potential/);
refuse('host must match the carried thicknesses', function (pack) { pack.host[0] = 2; }, /host code does not match/);
refuse('subduction needs a signed polarity', function (pack) { pack.pol[3] = 0; }, /subduction polarity/);
refuse('non-subduction cannot carry polarity', function (pack) { pack.pol[1] = 1; }, /only subduction/);
refuse('vp is a magnitude', function (pack) { pack.vp[0] = -1; }, /vp must be non-negative/);
refuse('plate rows stay ordered', function (pack) { pack.plates.reverse(); }, /ordered by ascending unique id/);
refuse('plate counts are recomputed from live rows', function (pack) { pack.plates[0].n += 1; }, /does not match live samples/);
refuse('live plate id must have a table row', function (pack) {
	pack.plate[6] = 2;
	pack.plates[1].n = 2;
}, /plate 2 is absent/);
refuse('gap plate id must also have a table row', function (pack) {
	for (let i = 0; i < pack.n; i++) if (pack.alive[i]) pack.plate[i] = 1;
	pack.plates = [{ id: 1, n: 6, wx: 0, wy: 0, wz: 0 }];
}, /sample plate 0 is absent/);

assert.equal(SP.hostCode(0, 0, 0), 0);
assert.equal(SP.hostCode(0, 7000, 2000), 1);
assert.equal(SP.hostCode(8000, 7000, 2000), 2);
assert.equal(SP.hostCode(45000, 7000, 2000), 2);
assert.equal(SP.hostCode(45001, 7000, 2000), 3);
assert.equal(SP.hostCode(1000, 2000, 2001), 4);
assert.equal(SP.hostCode(1000, 3000, 3000), 1, 'sediment must be strictly dominant');
assert.equal(SP.edgeCode(SP.GLOBE_EDGE.interior, 2), SP.EDGE.none);
assert.equal(SP.edgeCode(SP.GLOBE_EDGE.transform, -1), SP.EDGE.neutral);
assert.equal(SP.edgeCode(SP.GLOBE_EDGE.divergent, 1), SP.EDGE.open);
assert.equal(SP.edgeCode(SP.GLOBE_EDGE.convergent, -1), SP.EDGE.subduct);
assert.equal(SP.edgePolarity(SP.GLOBE_EDGE.convergent, -1), -1);
assert.equal(SP.edgeCode(SP.GLOBE_EDGE.convergent, 2), SP.EDGE.collide);
assert.equal(SP.edgePolarity(SP.GLOBE_EDGE.convergent, 2), 0);
assert.throws(function () { SP.edgeCode(SP.GLOBE_EDGE.convergent, 0); }, /polarity/);
assert.throws(function () { SP.edgeCode(99, 0); }, /unknown globe edge/);
const gap = SP.decode(fixtureText);
gap.hFelM[0] = 100;
gap.pot[0] = 0.5;
SP.setGap(gap, 0);
assert.deepEqual([
	gap.zM[0], gap.hFelM[0], gap.hMafM[0], gap.hSedM[0], gap.host[0], gap.plate[0],
	gap.bnd[0], gap.pol[0], gap.alive[0], gap.wet[0], gap.vt[0], gap.vp[0], gap.pot[0]
], [125, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// Circle construction is canonical and directed through the second world point.
const circle = SP.circleThrough([1, 0, 0], [0, 0, 1], SP.R_KM, 7000);
assert.ok(Math.abs(circle.lat0) < 1e-12 && Math.abs(circle.lon0) < 1e-12);
assert.ok(Math.abs(circle.az0 - 90) < 1e-12);
const quarter = SP.directionAt(circle, circle.arcKm / 4, new Float64Array(3));
assert.ok(Math.abs(quarter[0]) < 1e-12 && Math.abs(quarter[1]) < 1e-12 && Math.abs(quarter[2] - 1) < 1e-12);
const tangent = SP.tangentAt(circle, 0, new Float64Array(3));
assert.ok(Math.abs(tangent[0]) < 1e-12 && Math.abs(tangent[1]) < 1e-12 && Math.abs(tangent[2] - 1) < 1e-12);
const close = SP.directionAt(circle, circle.arcKm, new Float64Array(3));
assert.ok(Math.abs(close[0] - 1) < 1e-12 && Math.abs(close[1]) < 1e-12 && Math.abs(close[2]) < 1e-12);
assert.throws(function () { SP.circleThrough([1, 0, 0], [1, 0, 0], SP.R_KM, 1); }, /neither coincident nor antipodal/);
assert.throws(function () { SP.circleThrough([1, 0, 0], [-1, 0, 0], SP.R_KM, 1); }, /neither coincident nor antipodal/);
const roundedPath = Object.assign({}, fixture.path, { lat0: fixture.path.lat0 + 1e-8 });
assert.equal(SP.pathChecksum(roundedPath), PATH_CHECKSUM, 'path identity uses six significant digits');
assert.throws(function () {
	SP.pathChecksum({ kind: 'polyline', closes: false, arcKm: 1, cellKm: 1, verts: [0, 0, 0, 1] });
}, /at least three/);

// Reserved polyline mode already has one geometry/validation path; 0.8.1 simply declines to
// expose it in the first UI.
const poly = reseal(function (pack) {
	const verts = [0, 0, 0, 179, 0, -2];
	pack.path = {
		kind: 'polyline', closes: false,
		arcKm: SP.polylineArc({ verts: verts, closes: false }, pack.planet.rKm),
		cellKm: 7000,
		verts: verts
	};
});
assert.equal(SP.validate(poly), '');
assert.notEqual(SP.pathChecksum(poly.path), PATH_CHECKSUM);
const polyEnd = SP.latLonAt(poly, poly.path.arcKm, new Float64Array(2));
assert.ok(Math.abs(polyEnd[0]) < 1e-8 && Math.abs(polyEnd[1] + 2) < 1e-4,
	'polyline reaches its final vertex: ' + Array.from(polyEnd));
refuse('polyline arc is checked against vertices', function (pack) {
	pack.path = { kind: 'polyline', closes: false, arcKm: 100, cellKm: 100, verts: [0, 0, 0, 10, 10, 10] };
}, /does not match its vertices/);

// A caller that only swaps after decode cannot lose its accepted object on any refusal.
const shown = { pack: fixture };
const corrupt = raw();
corrupt.sea.mode = 'level';
try { shown.pack = SP.decode(JSON.stringify(corrupt)); } catch (error) {}
assert.equal(shown.pack, fixture, 'malformed candidate leaves caller state unchanged');

console.log('PASS slice-format v2: canonical fixture, complete identities, raw validation and path geometry');

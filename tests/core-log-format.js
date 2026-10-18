// Independent globe-side gate for the shared pgt-core-log v2 law.
const { assert } = require('./helpers.js');
const fs = require('node:fs');
const vm = require('node:vm');
const CF = require('../port/core-log-format.js');
const fixtureText = fs.readFileSync(require('node:path').join(__dirname, '../port/fixtures/core-log-v2.json'), 'utf8');
const fixture = CF.parse(fixtureText);
const SP = require('../port/slice-format.js');
const pack = SP.decode(fs.readFileSync(require('node:path').join(__dirname, '../port/fixtures/slice-pack-v2.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(fixture));
const stamp = m => { m.checksum = CF.checksum(m); return m; };
function refuse(label, mutate, expected, keepChecksum) {
	const m = clone(); mutate(m); if (!keepChecksum) stamp(m);
	assert.ok(CF.validate(m).includes(expected), label + ': ' + CF.validate(m));
}

assert.equal(CF.FORMAT, 'pgt-core-log');
assert.equal(CF.VERSION, 2);
assert.equal(CF.LITHOLOGY_SCHEMA, 'section-lith-1');
assert.deepEqual(Array.from(CF.LITH), ['sed', 'fel', 'maf', 'tephra', 'lava', 'sill']);
assert.deepEqual(Array.from(CF.FLAGS), ['wet', 'ore', 'unconf', 'intr']);
assert.equal(CF.LAYER_CAP, 96);
assert.equal(fixture.pathChecksum, SP.pathChecksum(pack.path));
assert.equal(fixture.packChecksum, pack.checksum);
assert.equal(fixture.checksum, '42bb102c7e2e5af5');
assert.equal(CF.encode(CF.parse(fixtureText)), fixtureText.replace(/\n$/, ''));
assert.equal(CF.validate(fixture), '');

// Full law corpus. Every case is re-stamped so the intended P5 refusal, not an old hash,
// is the reason it fails.
const cases = [
	['foreign format', m => { m.format = 'pgt-coupling'; }, 'not a pgt-core-log'],
	['foreign version', m => { m.version = 1; }, 'log version 1'],
	['missing schema', m => { delete m.lithologySchema; }, 'missing lithologySchema'],
	['unknown schema', m => { m.lithologySchema = 'section-lith-2'; }, 'unknown lithology schema'],
	['bad path identity', m => { m.pathChecksum = 'abc'; }, 'pathChecksum must be 16 hex'],
	['missing full identity', m => { delete m.packChecksum; }, 'missing packChecksum'],
	['bad full identity', m => { m.packChecksum = 'x'; }, 'packChecksum must be 16 hex'],
	['zero arc', m => { m.arcKm = 0; }, 'arcKm is not positive'],
	['negative time', m => { m.tMyr = -1; }, 'tMyr out of range'],
	['non-finite epoch', m => { m.epochMa = null; }, 'epochMa is not finite'],
	['empty records', m => { m.records = []; }, 'at least one record'],
	['off-cut record', m => { m.records[3].sKm = m.arcKm + 1; }, 'off the cut'],
	['unsorted records', m => { [m.records[0], m.records[1]] = [m.records[1], m.records[0]]; }, 'ascending arc'],
	['duplicate record', m => { m.records[1].sKm = m.records[0].sKm; }, 'ascending arc'],
	['negative divergence', m => { m.records[0].div = -0.1; }, 'diverged fraction'],
	['zero total crust', m => { m.records[3].hTotM = 0; }, 'carries no crust'],
	['empty beds', m => { m.records[3].beds = []; }, 'has no beds'],
	['too many beds', m => { m.records[3].beds = Array.from({length: CF.LAYER_CAP + 1}, (_, i) => [2, 10, i, 0]); m.records[3].hTotM = 10 * (CF.LAYER_CAP + 1); }, 'exceeds the layer cap'],
	['short bed tuple', m => { m.records[0].beds[0] = [1, 2]; }, 'is not [lith'],
	['long bed tuple', m => { m.records[0].beds[0].push(9); }, 'is not [lith'],
	['unknown lithology', m => { m.records[0].beds[0][0] = CF.LITH.length; }, 'not a lithology'],
	['fractional lithology', m => { m.records[0].beds[0][0] = 1.5; }, 'not a lithology'],
	['zero thickness', m => { m.records[0].beds[0][1] = 0; }, 'thicker than zero'],
	['negative thickness', m => { m.records[0].beds[0][1] = -1; }, 'thicker than zero'],
	['missing formation age', m => { m.records[0].beds[0][2] = null; }, 'no formation time'],
	['wide flags', m => { m.records[0].beds[0][3] = 16; }, 'four bits'],
	['fractional flags', m => { m.records[0].beds[0][3] = 1.5; }, 'four bits'],
	['sum mismatch', m => { m.records[0].beds[0][1] += 9000; }, 'do not sum'],
	['unflagged age inversion', m => { m.records[2].beds[2][3] &= ~CF.FLAG.intr; m.records[2].beds[1][2] = 12.1; m.records[2].beds[2][2] = 2; }, 'not monotone'],
	['unknown top field', m => { m.extra = 1; }, 'unknown field extra'],
	['unknown record field', m => { m.records[0].note = 'x'; }, 'unknown field note'],
	['checksum shape', m => { m.checksum = 'xyz'; }, 'checksum must be 16 hex', true]
];
for (const [label, mutate, expected, keep] of cases) refuse(label, mutate, expected, keep);
assert.equal(CF.validate('x').includes('must be an object'), true);
const staleHash = clone(); staleHash.tMyr = CF.round(staleHash.tMyr + 1);
assert.equal(CF.validate(staleHash), 'checksum mismatch');

const artifact = { pathChecksum: fixture.pathChecksum, packChecksum: fixture.packChecksum, arcKm: fixture.arcKm };
assert.equal(CF.identity(fixture, artifact).status, 'current');
const stale = clone(); stale.packChecksum = '0123456789abcdef'; stamp(stale);
assert.equal(CF.identity(stale, artifact).status, 'stale');
const foreign = clone(); foreign.pathChecksum = '0123456789abcdef'; stamp(foreign);
assert.equal(CF.identity(foreign, artifact).status, 'foreign');
const intr = clone(); intr.records[2].beds[2][3] &= ~CF.FLAG.intr;
intr.records[2].beds[1][3] |= CF.FLAG.intr; intr.records[2].beds[3][3] |= CF.FLAG.intr; stamp(intr);
assert.equal(CF.validate(intr), '', 'either side of both intrusive contacts permits the inversion');

for (const mutate of [m => { delete m.checksum; }, m => { m.checksum = 'xyz'; }, m => { m.records[0].beds[0][1] += 9000; }]) {
	const m = clone(); mutate(m);
	if (m.checksum !== undefined && m.checksum !== 'xyz') stamp(m);
	assert.throws(() => CF.parse(JSON.stringify(m)));
}
const offGrid = clone(); offGrid.records[0].div = 0.01234567;
assert.equal(CF.parse(JSON.stringify(offGrid)).records[0].div, 0.0123457);
stamp(offGrid);
assert.throws(() => CF.parse(JSON.stringify(offGrid)), /checksum mismatch/);
assert.throws(() => CF.parse(fixtureText.slice(0, 80)), /not valid JSON/);
assert.throws(() => CF.parse({}), /must be JSON text/);

const classicContext = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../port/core-log-format.js'), 'utf8'), classicContext);
assert.equal(classicContext.CoreLogFormat.encode(classicContext.CoreLogFormat.parse(fixtureText)), CF.encode(fixture));
assert.equal(classicContext.CoreLogFormat.identity(fixture, artifact).status, 'current');
console.log('PASS core-log-format: fixture round trip, 32 refusal classes, parse strictness, identities and classic parity');

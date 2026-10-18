// Shared-port drift gate. It is deliberately local: compatibility never depends on a network.
const { assert } = require('./helpers.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SP = require('../port/slice-format.js');
const CF = require('../port/core-log-format.js');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'port/PORT.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
function sha(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

assert.equal(manifest.format, 'pgt-port-manifest');
assert.equal(manifest.version, 2);
assert.equal(manifest.contract, 'pgt-slice-pack-v2');
assert.deepEqual(manifest.repositories.map(function (entry) { return entry.role; }),
	['globe-writer', 'section-reader']);
assert.deepEqual(manifest.files.map(function (entry) { return entry.path; }),
	['port/slice-format.js', 'port/fixtures/slice-pack-v2.json',
		'port/core-log-format.js', 'port/fixtures/core-log-v2.json']);
assert.ok(!manifest.files.some(function (entry) { return /deposit-(models|economics)/.test(entry.path); }),
	'stale deposit models are not part of the v2 port');

for (const entry of manifest.files) {
	assert.match(entry.sha256, /^[0-9a-f]{64}$/);
	const bytes = fs.readFileSync(path.join(root, entry.path));
	assert.equal(sha(bytes), entry.sha256, entry.path + ' matches PORT.json');
	const changed = Buffer.from(bytes);
	changed[Math.floor(changed.length / 2)] ^= 1;
	assert.notEqual(sha(changed), entry.sha256, entry.path + ' one-byte drift is detected');
}

const codecSource = fs.readFileSync(path.join(root, 'port/slice-format.js'), 'utf8');
const fixtureText = fs.readFileSync(path.join(root, 'port/fixtures/slice-pack-v2.json'), 'utf8').trim();
const context = vm.createContext({});
vm.runInContext(codecSource, context, { filename: 'port/slice-format.js' });
const classic = context.SlicePack;
assert.ok(classic, 'classic script exposes SlicePack');
assert.equal(classic.FORMAT, SP.FORMAT);
assert.equal(classic.VERSION, SP.VERSION);
assert.deepEqual(Array.from(classic.HOSTS), Array.from(SP.HOSTS));
assert.deepEqual(Array.from(classic.POTENTIALS), Array.from(SP.POTENTIALS));
const nodePack = SP.decode(fixtureText);
const classicPack = classic.decode(fixtureText);
assert.equal(classicPack.checksum, nodePack.checksum);
assert.equal(classic.pathChecksum(classicPack.path), SP.pathChecksum(nodePack.path));
assert.equal(classic.encode(classicPack), fixtureText);
assert.equal(nodePack.checksum, '2d3941bda088d8d2');
assert.equal(SP.pathChecksum(nodePack.path), 'cc5cd21d5ddc5712');

const coreText = fs.readFileSync(path.join(root, 'port/fixtures/core-log-v2.json'), 'utf8');
const core = CF.parse(coreText);
assert.equal(CF.encode(CF.parse(coreText)), coreText.replace(/\n$/, ''), 'core-log fixture has one canonical spelling');
assert.equal(core.pathChecksum, SP.pathChecksum(nodePack.path), 'core-log fixture path locks to pack fixture');
assert.equal(core.packChecksum, nodePack.checksum, 'core-log fixture pack locks to pack fixture');
assert.equal(core.checksum, '42bb102c7e2e5af5');
assert.equal(CF.identity(core, { pathChecksum: core.pathChecksum, packChecksum: core.packChecksum, arcKm: core.arcKm }).status, 'current');
const coreSource = fs.readFileSync(path.join(root, 'port/core-log-format.js'), 'utf8');
vm.runInContext(coreSource, context, { filename: 'port/core-log-format.js' });
assert.equal(context.CoreLogFormat.encode(context.CoreLogFormat.parse(coreText)), CF.encode(core));

console.log('PASS port: four-file manifest hashes, fixture lock and Node/classic codec parity');

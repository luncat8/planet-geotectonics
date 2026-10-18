const { assert } = require('./helpers.js');
const fs = require('node:fs');
const CF = require('../port/core-log-format.js');
const CoreLog = require('../js/core-log.js');
const fixture = fs.readFileSync(require('node:path').join(__dirname, '../port/fixtures/core-log-v2.json'), 'utf8');
const parsed = CF.parse(fixture);
const table = CoreLog.createTable();
const artifact = { pathChecksum: parsed.pathChecksum, packChecksum: parsed.packChecksum, arcKm: parsed.arcKm };
const beforeWorld = { frame: 9, stateHash: 'unchanged' };
let result = CoreLog.importText(table, fixture, artifact, { importedAt: 123 });
assert.equal(result.status, 'current');
assert.equal(result.committed, true);
assert.equal(table.order.length, 1);
const entry = result.entry;
assert.equal(entry.key, parsed.pathChecksum + ':' + parsed.packChecksum);
assert.equal(Object.isFrozen(entry), true);
assert.equal(Object.isFrozen(entry.records[0].beds[0]), true);
assert.equal(CoreLog.freshness(entry, artifact).status, 'current');
assert.equal(CoreLog.nearest(entry, 3600).record.sKm, 3500);
assert.match(CoreLog.display(entry, artifact), /Observed section log · current/);
assert.deepEqual(beforeWorld, { frame: 9, stateHash: 'unchanged' }, 'importer has no world/state handle');

// Invalid text and foreign identity leave the last accepted table exactly as it was.
const snapshot = JSON.stringify({ keys: table.order, entry: table.entries[entry.key] });
assert.throws(() => CoreLog.importText(table, '{broken', artifact));
const foreign = JSON.parse(fixture); foreign.pathChecksum = '0123456789abcdef'; foreign.checksum = CF.checksum(foreign);
result = CoreLog.importText(table, JSON.stringify(foreign), artifact);
assert.equal(result.status, 'foreign');
assert.equal(result.committed, false);
assert.equal(JSON.stringify({ keys: table.order, entry: table.entries[entry.key] }), snapshot);

// Same path / same arc / different full pack is only archived after explicit confirmation.
const stale = JSON.parse(fixture); stale.packChecksum = '0123456789abcdef'; stale.checksum = CF.checksum(stale);
result = CoreLog.importText(table, JSON.stringify(stale), artifact);
assert.equal(result.status, 'confirmation-required');
assert.equal(result.committed, false);
assert.equal(table.order.length, 1);
result = CoreLog.importText(table, JSON.stringify(stale), artifact, { confirmStale: true, importedAt: 456 });
assert.equal(result.status, 'stale');
assert.equal(result.committed, true);
assert.equal(result.entry.staleReason.includes('source pack'), true);
assert.equal(CoreLog.freshness(result.entry, artifact).status, 'stale');
assert.equal(CoreLog.freshness(entry, artifact, 'world time changed').status, 'stale');
assert.match(CoreLog.display(result.entry, artifact), /stale/);
assert.equal(table.order.length, 2);

const wrongArc = { ...artifact, arcKm: artifact.arcKm + 1 };
result = CoreLog.importText(table, fixture, wrongArc, { confirmStale: true });
assert.equal(result.status, 'foreign', 'arc mismatch is foreign and cannot be confirmed stale');
assert.equal(table.order.length, 2);

// The shared law's public vocabulary and bound are the importer's only section assumptions.
assert.equal(CoreLog.LAYER_CAP, 96);
assert.deepEqual(Array.from(CoreLog.LITH), ['sed', 'fel', 'maf', 'tephra', 'lava', 'sill']);
assert.deepEqual(Array.from(CoreLog.FLAGS), ['wet', 'ore', 'unconf', 'intr']);
console.log('PASS core-log: current import, foreign refusal, confirm-only stale archive, immutable side table');

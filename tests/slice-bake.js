// The deterministic Earth-start section bake (0.8.2): one authoritative generation path.
// What is pinned here:
//   1. a baked pack is the interactive writer's own output - same walk, same field mapping,
//      same codec - not a second section format;
//   2. fixed arguments plus a fixed --built are byte-identical, and changing only --built
//      leaves both identities unchanged while touching that one provenance value;
//   3. provenance names the resolved Earth pack, its epoch, the preset's rotation model and
//      the pack's own license, with tMyr = 0 and zero potentials as the honest t=0 state;
//   4. the CLI refuses every malformed invocation and every refused run leaves no output,
//      never a misleading success;
//   5. a generated real pack survives the shared strict reader and refuses a single-byte edit.
const { assert, Grid, State, Sim } = require('./helpers.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Earth = require('../js/earth.js');
const Slice = require('../js/slice.js');
const SP = require('../port/slice-format.js');
const Resolution = require('../js/resolution.js');
const bakeSection = require('../tools/earth/bake_section.js');

const root = path.join(__dirname, '..');
const BUILT = '2026-10-15T00:00:00.000Z';
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
const BASE = { start: 'earth', level: 5, seed: 7, preset: 'game', circle: [0, 0, 90], built: BUILT, commit: COMMIT };

// The walk invariants a baked circle owes, exactly as a captured one does.
function checkWalk(grid, runs, label) {
	assert.ok(runs.n >= 2, label + ': at least two runs');
	assert.equal(runs.starts[0], 0, label + ': the ring starts at zero arc');
	let sum = 0;
	for (let i = 0; i < runs.n; i++) {
		const next = runs.cells[(i + 1) % runs.n];
		let legal = next === runs.cells[i];
		for (let k = 0; !legal && k < grid.ringN[runs.cells[i]]; k++)
			legal = grid.ring[runs.cells[i] * 6 + k] === next;
		assert.ok(legal, label + ': run ' + i + ' joins neighbours');
		const end = i + 1 < runs.n ? runs.starts[i + 1] : runs.arcKm;
		const span = end - runs.starts[i];
		assert.ok(span > 0, label + ': positive span at ' + i);
		assert.ok(span <= Slice.cellKmFor(grid) * 1.5, label + ': span at ' + i + ' within the cell budget');
		sum += span;
	}
	assert.ok(Math.abs(sum - runs.arcKm) < 1e-9, label + ': the runs tile the whole arc');
}

// --- 1. the baked pack is the interactive writer's output -----------------------------------
const baked = bakeSection.bake(BASE);
const pack = baked.result.pack;
assert.equal(SP.validate(pack), '', 'a baked pack passes the shared validator');
assert.equal(SP.verify(pack), '', 'a baked pack carries its own checksum');
assert.equal(pack.version, SP.VERSION, 'the bake writes the current contract');
assert.equal(baked.result.checksum, pack.checksum, 'the reported identity is the pack\'s own');
assert.equal(baked.result.pathChecksum, SP.pathChecksum(pack.path), 'the reported path identity is derived, not stamped');
const encoded = SP.encode(pack);
const text = encoded;
assert.equal(SP.decode(encoded).checksum, pack.checksum, 'the encoded bake survives the strict reader');
checkWalk(baked.grid, baked.result.runs, 'baked equator');
assert.ok(pack.source.tMyr === 0, 'a bake is a fresh world at its start');

// One byte anywhere in the payload is refused, so a baked pack is a real checksummed
// artifact. `source.built` is deliberately outside the checksum (it is provenance, and the
// codec excludes it so a re-stamp cannot change an identity), so the offsets are payload.
const offsets = [text.indexOf('"plates":[') + 12, text.indexOf('"sKm":[') + 10,
	text.indexOf('"license":"') + 12, text.length - 40];
for (const at of offsets) {
	assert.ok(at > 0 && at < text.length, 'a payload offset was found');
	const broken = text.slice(0, at) + (text[at] === '7' ? '8' : '7') + text.slice(at + 1);
	assert.throws(() => SP.decode(broken), /checksum|version|field|range|NaN|missing/i,
		'a one-byte edit of a baked pack is refused at offset ' + at);
}

// --- 2. determinism and the built-only provenance -------------------------------------------
const again = bakeSection.bake(BASE);
assert.equal(SP.encode(again.result.pack), encoded, 'fixed arguments and a fixed built are byte-identical');
const later = bakeSection.bake(Object.assign({}, BASE, { built: '2027-03-04T05:06:07.000Z' }));
assert.equal(later.result.checksum, pack.checksum, 'built is not part of the full identity');
assert.equal(later.result.pathChecksum, baked.result.pathChecksum, 'built is not part of the path identity');
const stripBuilt = text => text.replace(/"built":"[^"]*"/, '');
assert.notEqual(SP.encode(later.result.pack), encoded, 'built changes the bytes');
assert.equal(stripBuilt(SP.encode(later.result.pack)), stripBuilt(encoded),
	'built is the only value that moved');
assert.equal(later.result.pack.source.built, '2027-03-04T05:06:07.000Z');

// --- 3. provenance, epoch and the honest t=0 fields -----------------------------------------
assert.equal(pack.source.pack, 'earth', 'the resolved modern pack is named');
assert.equal(pack.source.epochMa, 0, 'the modern pack has no input epoch');
assert.equal(pack.source.rotModel, 'procedural', 'the game preset does not claim a rotation model');
assert.equal(pack.source.level, 5);
assert.equal(pack.source.gridSeed, 7);
assert.equal(pack.source.simSeed, 7);
assert.equal(pack.source.commit, COMMIT, 'an explicit revision is carried, never guessed');
assert.equal(pack.source.repo, Slice.REPO);
assert.ok(pack.license.indexOf('Earth start earth · ') === 0, 'the license names the start and the pack');
assert.ok(pack.license.indexOf(baked.pack.source) > 0, 'the license preserves the pack attribution');
assert.equal(pack.sea.mode, 'level', 'a bake exports the level-mode display sea');
assert.equal(pack.sea.levelM, 0, 'at the physics datum, the same water the page exports');
// A t=0 world has no accumulated potentials and no damage: they are the state the start
// initializer supplies, not a surveyed absence and not modelled deposits.
let potentials = 0;
for (let i = 0; i < pack.n; i++) for (let f = 0; f < SP.POTENTIALS.length; f++) potentials += pack.pot[i * SP.POTENTIALS.length + f];
assert.equal(potentials, 0, 'a t=0 bake carries zero ore potentials');
// Every live sample books its plate, so the plate table accounts for the whole circle.
let booked = 0;
for (let i = 0; i < pack.plates.length; i++) booked += pack.plates[i].n;
assert.equal(booked, pack.n, 'the plate table accounts for every run at t=0');
assert.ok(pack.plates.every(entry => Number.isFinite(entry.wx)), 'Euler poles travel with the table');
// A bake without an explicit revision carries the writer's own, so a shipped artifact is
// never anonymous - and the 0.8.1 placeholder is a failing state, not a silent one.
assert.match(Slice.COMMIT, /^[0-9a-f]{40}$/, 'the writer names a real revision');
assert.notEqual(Slice.COMMIT, '0'.repeat(40), 'the COMMIT placeholder was replaced in the release change');
const defaulted = bakeSection.bake({ start: 'earth', level: 5, seed: 7, preset: 'game', circle: [0, 0, 90], built: BUILT });
assert.equal(defaulted.result.pack.source.commit, Slice.COMMIT, 'a bake without --commit carries the writer revision');

// A historical start: nonzero input epoch, the pack's own name, the model's provenance.
const historic = bakeSection.bake({ start: 'cretaceous', level: 5, seed: 7, preset: 'realistic', circle: [0, 0, 90], built: BUILT, commit: COMMIT });
assert.equal(historic.pack.name, 'earth-100Ma', 'the start value resolves through Earth.pick, not a filename switch');
assert.equal(historic.result.pack.source.epochMa, 100, 'epochMa is the pack input epoch');
assert.equal(historic.result.pack.source.tMyr, 0, 'epochMa and tMyr are not the same clock');
assert.equal(historic.result.pack.source.rotModel, 'PALEOMAP', 'the realistic preset names its rotation model');
assert.equal(SP.validate(historic.result.pack), '', 'a historical bake validates too');
assert.equal(historic.result.pathChecksum, baked.result.pathChecksum,
	'path identity is geographic: the same circle from another start is the same path');
assert.notEqual(historic.result.checksum, baked.result.checksum, 'the payload differs by start');
// The tilted circle is a different geography, so a different path identity.
const tilted = bakeSection.bake({ start: 'cretaceous', level: 5, seed: 7, preset: 'realistic', circle: [20, 0, 90], built: BUILT, commit: COMMIT });
assert.notEqual(tilted.result.pathChecksum, baked.result.pathChecksum, 'a tilted circle has its own identity');
assert.ok(tilted.result.runs.n >= 2 && tilted.result.runs.n !== baked.result.runs.n,
	'the tilted circle crosses a different number of cells (' + tilted.result.runs.n + ' runs)');

// The CLI's world is the page's world: the same fresh state through the same writer gives
// the same payload fields. Provenance is checked above, so only the payload is compared.
function referenceWorld(options) {
	const grid = new Grid(options.level, options.seed).build();
	const state = new State(grid, options.seed);
	const pack = Earth.pick(options.level, options.start);
	Earth.apply(state, pack, { realistic: options.preset === 'realistic' });
	const circle = bakeSection.circleFor(options.circle, Slice.cellKmFor(grid));
	return Slice.pack(state, circle, { mode: 'level', levelM: 0, volScale: 1 },
		{ pack: pack.name, epochMa: pack.epoch || 0, rotModel: 'procedural', built: BUILT, commit: COMMIT },
		'Earth start ' + pack.name + ' · ' + pack.source).pack;
}
const reference = referenceWorld(BASE);
assert.equal(reference.path.lat0, pack.path.lat0, 'the CLI circle is the writer circle');
assert.equal(reference.path.az0, pack.path.az0);
for (const field of ['sKm', 'zM', 'hFelM', 'hMafM', 'hSedM', 'ageMyr', 'fert', 'damage', 'host', 'plate', 'alive', 'wet', 'bnd', 'pol', 'vt', 'vp', 'pot'])
	assert.equal(Buffer.compare(Buffer.from(pack[field].buffer), Buffer.from(reference[field].buffer)), 0,
		field + ' matches a direct Slice.pack on the same fresh state');
assert.deepEqual(JSON.parse(JSON.stringify(pack.plates)), JSON.parse(JSON.stringify(reference.plates)),
	'the plate table matches a direct write');

// --- 4. the committed example corpus --------------------------------------------------------
// data/sections/ holds the reviewed examples (0.8.2 plan §5). The arguments are read back out
// of each pack itself - start, level, seed, preset and circle - and the bake is repeated under
// the provenance the file records, so a silent change in the Earth loader, the walker or the
// writer turns this red instead of leaving a stale example behind.
const corpusDir = path.join(root, 'data/sections');
for (const name of fs.readdirSync(corpusDir).filter(file => file.endsWith('.json')).sort()) {
	const file = path.join(corpusDir, name);
	const committed = fs.readFileSync(file, 'utf8');
	const stored = SP.decode(committed);
	assert.equal(SP.validate(stored), '', name + ' is a valid v2 pack');
	const starts = ['earth'].concat(Object.keys(Earth.history));
	const start = starts.find(value => Earth.pick(stored.source.level, value)
		&& Earth.pick(stored.source.level, value).name === stored.source.pack);
	assert.ok(start, name + ' names a start this tree can resolve (' + stored.source.pack + ')');
	const reproduced = bakeSection.bake({
		start: start, level: stored.source.level, seed: stored.source.simSeed,
		preset: stored.source.rotModel === 'PALEOMAP' ? 'realistic' : 'game',
		circle: [stored.path.lat0, stored.path.lon0, stored.path.az0],
		built: stored.source.built, commit: stored.source.commit
	});
	assert.equal(SP.encode(reproduced.result.pack), committed,
		name + ' is byte-identical to a fresh bake of its own recorded arguments');
}

// The modern example is the plan's first corpus item: a full circle that crosses ocean,
// continent, at least one boundary and the antimeridian seam.
const modern = SP.decode(fs.readFileSync(path.join(corpusDir, 'earth-l5-gc0.json'), 'utf8'));
const fullArc = 2 * Math.PI * Slice.radiusKm();
assert.ok(Math.abs(modern.path.arcKm - fullArc) < 1e-6 * fullArc,
	'the example is a closed great circle (stored to six significant digits)');
assert.ok(modern.host.some(host => host === 1) && modern.host.some(host => host >= 2),
	'the example crosses oceanic and continental crust');
assert.ok(modern.bnd.some(bnd => bnd !== 0), 'the example crosses at least one plate boundary');
let seam = false;
const probe = new Float64Array(2);
for (let s = 0; s < modern.path.arcKm && !seam; s += modern.path.arcKm / 720) {
	SP.latLonAt(modern, s, probe);
	seam = Math.abs(probe[1]) > 179;
}
assert.ok(seam, 'the example crosses the antimeridian seam');

// --- 5. the CLI surface --------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pgt-bake-'));
const target = path.join(work, 'section.json');
const cli = (args) => spawnSync(process.execPath, [path.join(root, 'tools/earth/bake_section.js')].concat(args), { encoding: 'utf8' });

const written = cli(['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game',
	'--circle', '0', '0', '90', '--out', target, '--built', BUILT, '--commit', COMMIT,
	'--report', path.join(work, 'section.report.json')]);
assert.equal(written.status, 0, 'a documented command exits 0: ' + written.stderr);
assert.match(written.stdout, /^pgt-slice-pack v2 earth L5 seed 7 t 0 Myr \d+ runs \d+ B\n/, 'the release line is printed');
assert.match(written.stdout, new RegExp('path ' + baked.result.pathChecksum + ' pack ' + pack.checksum + '\n'),
	'the printed identities are the written pack\'s');
const onDisk = fs.readFileSync(target, 'utf8');
assert.equal(onDisk, encoded, 'the file holds exactly the validated payload');
const report = JSON.parse(fs.readFileSync(path.join(work, 'section.report.json'), 'utf8'));
assert.equal(report.identity.checksum, pack.checksum, 'the report carries the full identity');
assert.equal(report.identity.pathChecksum, baked.result.pathChecksum, 'the report carries the path identity');
assert.equal(report.source.pack, 'earth');
assert.equal(report.source.epochMa, 0);
assert.equal(report.args.built, BUILT);
assert.equal(report.args.commit, COMMIT);
assert.equal(report.validation.validate, '', 'the report records a clean validation');
assert.ok(report.output.runs > 0 && report.output.bytes === Buffer.byteLength(encoded) && report.output.ms >= 0,
	'the report records the measured cost');

// A nonempty output is refused without --force and nothing is overwritten.
const refused = cli(['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game',
	'--circle', '0', '0', '90', '--out', target, '--built', BUILT]);
assert.equal(refused.status, 2, 'a nonempty output is refused without --force');
assert.match(refused.stderr, /--force/, 'the refusal names the flag that would allow it');
assert.equal(fs.readFileSync(target, 'utf8'), onDisk, 'a refused run leaves the file alone');
const forced = cli(['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game',
	'--circle', '0', '0', '90', '--out', target, '--built', BUILT, '--commit', COMMIT, '--force']);
assert.equal(forced.status, 0, '--force overwrites deliberately');
assert.equal(fs.readFileSync(target, 'utf8'), onDisk, 'the rewrite is identical');

// Every malformed invocation is refused with a message and no output.
const bad = path.join(work, 'bad.json');
const refusals = [
	[[], /--start is required/],
	[['--start', 'atlantis', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad], /unknown start/],
	[['--start', 'earth', '--level', '4', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad], /--level/],
	[['--start', 'earth', '--level', '5', '--seed', '-1', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad], /--seed/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'sandbox', '--circle', '0', '0', '90', '--out', bad], /--preset/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--out', bad], /--circle/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '90', '--out', bad], /--circle/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90'], /--out is required/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '99', '0', '90', '--out', bad], /latitude/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad, '--built', 'last tuesday'], /--built/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad, '--commit', 'not-a-sha'], /--commit/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', bad, '--turbo'], /unknown flag/],
	[['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game', '--circle', '0', '0', '90', '--out', path.join(root, 'js/data/section-bake.json')], /js\/data/],
];
for (const [args, pattern] of refusals) {
	const result = cli(args);
	assert.equal(result.status, 2, 'refused: ' + args.join(' '));
	assert.match(result.stderr, pattern, 'the refusal explains itself: ' + args.join(' '));
	assert.ok(!result.stdout.trim(), 'a refused run prints no release line');
}
assert.ok(!fs.existsSync(bad), 'no refused invocation left an output file');
assert.ok(!fs.existsSync(path.join(root, 'js/data/section-bake.json')), 'js/data/ is never written');

// An unwritable destination is an I/O refusal after the bake, still with no output.
const unwritable = cli(['--start', 'earth', '--level', '5', '--seed', '7', '--preset', 'game',
	'--circle', '0', '0', '90', '--out', work]);
assert.equal(unwritable.status, 2, 'a directory destination is refused');
assert.match(unwritable.stderr, /bake_section:/, 'an I/O refusal is reported as one');

// The parser itself: --flag=value, the three-value --circle and nothing else accepted.
const parsed = bakeSection.parseArgv(['--start=earth', '--level=6', '--seed=7', '--preset=realistic',
	'--circle', '20', '0', '90', '--out', 'x.json', '--built=' + BUILT, '--force']);
assert.equal(parsed.start, 'earth');
assert.equal(parsed.level, '6');
assert.equal(parsed.force, true);
assert.deepEqual(parsed.circle, [20, 0, 90], '--circle lifts its three values out of the token list');
assert.equal(parsed.built, BUILT);
assert.throws(() => bakeSection.parseArgv(['--start', 'earth', 'extra']), /unexpected argument/);
assert.throws(() => bakeSection.parseArgv(['--level']), /--level needs a value/);

fs.rmSync(work, { recursive: true, force: true });
console.log('PASS slice bake: one writer path, determinism, provenance, CLI refusals, strict reader');

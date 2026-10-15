#!/usr/bin/env node
/* tools/earth/bake_section.js - deterministic Earth-start section bakes (0.8.2).
 *
 * A reproducible headless route to the SAME pgt-slice-pack v2 JSON the map cutter writes:
 * one authoritative generation path, so a baked pack is indistinguishable from a captured
 * one and neither repository grows a second section format. It exists for reproducible
 * examples, regression fixtures and file:// demos - not as a second section renderer and
 * not as a way to recreate an arbitrary interactive world at a later simulation time (use
 * the interactive export or a verified checkpoint for that).
 *
 * The sequence is the page's own: register the data packs exactly as index.html's script
 * tags do, resolve the start through Earth.pick, build Grid+State, Earth.apply, construct
 * the circle with the writer's own geometry, hand the fresh state to Slice.pack, then
 * validate and encode through the shared codec and write only after validation succeeded.
 * Nothing here re-decodes an Earth raster, inverts K9, walks cells or checksums: the load
 * order in main() is the whole point.
 *
 * Usage:
 *   node tools/earth/bake_section.js --start earth --level 5 --seed 7 --preset game \
 *       --circle <lat0-deg> <lon0-deg> <azimuth-deg> --out <file.json> \
 *       [--built <ISO-8601>] [--commit <sha>] [--report <file.json>] [--force]
 *
 * Exit codes: 0 written, 2 refused (bad arguments, a missing pack, an unwritable or nonempty
 * output without --force, or a pack the shared validator rejects - nothing is written in
 * that case). Generated sections belong in an ignored out/ or a caller-chosen directory,
 * never in js/data/.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const dataDir = path.join(root, 'js/data');
// The page's script order for the Earth packs, reproduced from the directory: every
// js/data/earth-*.js registers itself on the shared EarthPacks table, so Earth.pick
// resolves a start exactly as the Start select does.
const packFiles = fs.readdirSync(dataDir).filter(name => /^earth-.*\.js$/.test(name)).sort();
for (const name of packFiles) require(path.join(dataDir, name));

const Grid = require(path.join(root, 'js/geodesics.js'));
const State = require(path.join(root, 'js/state.js'));
const Params = require(path.join(root, 'js/params.js'));
const Earth = require(path.join(root, 'js/earth.js'));
const Slice = require(path.join(root, 'js/slice.js'));
const SP = require(path.join(root, 'port/slice-format.js'));

const LEVELS = [5, 6, 7];
const PRESETS = ['game', 'realistic'];
const FLAGS = ['start', 'level', 'seed', 'preset', 'out', 'built', 'commit', 'report'];
// One degree along the great circle fixes the circle's direction: far enough that the
// azimuth the codec derives from the two points is exact to double precision, close enough
// that the pair is nowhere near the coincident/antipodal refusal.
const STEP_DEG = 1;
const AZ_TOLERANCE_DEG = 1e-6;

// --- argument parsing ---------------------------------------------------------------------
// --circle is the only multi-value flag, so it is lifted out first and the rest is parsed
// generically. Every refusal names the flag: a CLI whose error is a stack trace teaches
// nobody the interface.
function parseArgv(argv) {
	const rest = argv.slice();
	const args = { built: '', commit: '', report: '', force: false };
	const at = rest.findIndex(token => token === '--circle' || token.startsWith('--circle='));
	if (at >= 0) {
		const eq = rest[at].indexOf('=');
		const values = eq < 0 ? rest.slice(at + 1, at + 4)
			: [rest[at].slice(eq + 1)].concat(rest.slice(at + 1, at + 3));
		if (values.length < 3 || values.some(value => value === undefined || value.startsWith('--')))
			throw new RangeError('--circle needs three values: --circle lat lon azimuth');
		args.circle = values.map(Number);
		rest.splice(at, eq < 0 ? 4 : 3);
	}
	const value = (name, index) => {
		const next = rest[index + 1];
		if (next === undefined || next.startsWith('--')) throw new RangeError('--' + name + ' needs a value');
		return next;
	};
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (!token.startsWith('--')) throw new RangeError('unexpected argument "' + token + '"');
		const eq = token.indexOf('=');
		const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
		if (name === 'force' && eq < 0) { args.force = true; continue; }
		if (name === 'force') throw new RangeError('--force takes no value');
		if (FLAGS.indexOf(name) < 0) throw new RangeError('unknown flag --' + name);
		args[name] = eq < 0 ? value(name, index++) : token.slice(eq + 1);
	}
	return args;
}

function checkArgs(args) {
	const starts = ['earth'].concat(Object.keys(Earth.history));
	if (!args.start) throw new RangeError('--start is required (' + starts.join('|') + ')');
	if (starts.indexOf(args.start) < 0)
		throw new RangeError('unknown start "' + args.start + '" (' + starts.join('|') + ')');
	if (!args.out) throw new RangeError('--out is required');
	const level = Number(args.level);
	if (!args.level || !Number.isInteger(level) || LEVELS.indexOf(level) < 0)
		throw new RangeError('--level must be one of ' + LEVELS.join('|'));
	const seed = Number(args.seed);
	if (!args.seed || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
		throw new RangeError('--seed must be an unsigned 32-bit integer');
	if (!args.preset || PRESETS.indexOf(args.preset) < 0)
		throw new RangeError('--preset must be one of ' + PRESETS.join('|'));
	if (!args.circle || args.circle.length !== 3 || args.circle.some(value => !Number.isFinite(value)))
		throw new RangeError('--circle needs three finite numbers: --circle lat lon azimuth');
	if (Math.abs(args.circle[0]) > 90)
		throw new RangeError('--circle latitude must be within ±90 degrees');
	if (args.built && !Number.isFinite(Date.parse(args.built)))
		throw new RangeError('--built must be an ISO-8601 timestamp');
	if (args.commit && !/^[0-9a-f]{7,40}$/.test(args.commit))
		throw new RangeError('--commit must be a hex git revision');
	return { start: args.start, level: level, seed: seed, preset: args.preset, circle: args.circle,
		out: args.out, built: args.built, commit: args.commit, report: args.report, force: args.force };
}

// --- the one generation path --------------------------------------------------------------
// The asked-for circle is built from the codec's own geodesic step, so `--circle 0 0 90`
// here and an equator click in the browser are one canonical path, not two that happen to
// agree. The derived azimuth is checked against the request rather than trusted.
function circleFor(circle, cellKm) {
	const rKm = Slice.radiusKm();
	const asked = { kind: 'circle', closes: true, arcKm: 2 * Math.PI * rKm, cellKm: cellKm,
		lat0: circle[0], lon0: circle[1], az0: circle[2] };
	const origin = new Float64Array(3), ahead = new Float64Array(3);
	SP.directionAt(asked, 0, origin);
	SP.directionAt(asked, rKm * STEP_DEG * Math.PI / 180, ahead);
	const built = Slice.circleThrough(origin, ahead, rKm, cellKm);
	const off = Math.abs(((built.az0 - circle[2] + 540) % 360) - 180);
	if (off > AZ_TOLERANCE_DEG)
		throw new RangeError('circle azimuth ' + circle[2] + ' came back as ' + built.az0.toFixed(9));
	return built;
}

// Provenance names what the start actually is, so a reader can never mistake a procedural
// preset for a PALEOMAP-constrained one. epochMa is the pack's own input epoch and tMyr is
// 0: a fresh world at its start, which is exactly what a bake is. A historical pack's
// epochMa = 100 with tMyr = 0 is that, not a contradiction.
function provenanceFor(pack, preset, built, commit) {
	return {
		pack: pack.name, epochMa: pack.epoch || 0,
		rotModel: preset === 'realistic' ? 'PALEOMAP' : 'procedural',
		built: built || new Date().toISOString(), commit: commit || Slice.COMMIT
	};
}

function licenseFor(pack) {
	return 'Earth start ' + pack.name + ' · ' + pack.source;
}

// Pure bake: no filesystem, no process exit. Everything the writer can refuse is refused
// here, so the CLI's only remaining failure mode is I/O.
function bake(options) {
	const grid = new Grid(options.level, options.seed).build();
	const state = new State(grid, options.seed);
	const pack = Earth.pick(options.level, options.start);
	if (!pack)
		throw new RangeError('no Earth pack is registered for start ' + options.start + ' at L' + options.level);
	Earth.apply(state, pack, { realistic: options.preset === 'realistic' });
	const circle = circleFor(options.circle, Slice.cellKmFor(grid));
	// The display sea in level mode at the physics datum - the same effective water the page
	// exports, never a hidden shortcut. Volume mode belongs to an interactive capture, where
	// the water slider that produced it is on screen.
	const sea = { mode: 'level', levelM: Params.sea, volScale: Params.seaVolScale };
	const result = Slice.pack(state, circle, sea,
		provenanceFor(pack, options.preset, options.built, options.commit), licenseFor(pack));
	const invalid = SP.validate(result.pack) || SP.verify(result.pack);
	if (invalid) throw new RangeError('the baked pack does not validate: ' + invalid);
	return { result: result, pack: pack, grid: grid, state: state, text: SP.encode(result.pack) };
}

// The release-record line: one line a handoff can quote verbatim.
function summaryLine(options, baked) {
	const result = baked.result;
	return 'pgt-slice-pack v2 ' + options.start + ' L' + options.level + ' seed ' + options.seed
		+ ' t 0 Myr ' + result.runs.n + ' runs ' + Buffer.byteLength(baked.text) + ' B\n'
		+ 'path ' + result.pathChecksum + ' pack ' + result.checksum;
}

// Separate from the portable payload: what a reader needs to trust it - the exact
// arguments, the resolved source, the measured cost and the two identities.
function reportFor(options, baked, ms) {
	const result = baked.result, source = result.pack.source;
	return {
		tool: 'tools/earth/bake_section.js', contract: SP.FORMAT + '-v' + SP.VERSION,
		args: { start: options.start, level: options.level, seed: options.seed, preset: options.preset,
			circle: options.circle, built: source.built, commit: source.commit },
		source: { pack: source.pack, epochMa: source.epochMa, tMyr: source.tMyr, rotModel: source.rotModel,
			level: source.level, gridSeed: source.gridSeed, simSeed: source.simSeed,
			license: result.pack.license, attribution: baked.pack.source },
		output: { runs: result.runs.n, bytes: Buffer.byteLength(baked.text), ms: ms },
		identity: { pathChecksum: result.pathChecksum, checksum: result.checksum },
		validation: { validate: SP.validate(result.pack), verify: SP.verify(result.pack) }
	};
}

function writeOutput(options, baked, ms) {
	const target = path.resolve(options.out);
	if (target.startsWith(path.join(root, 'js/data') + path.sep))
		throw new RangeError('refusing to write into js/data/; use an ignored out/ or a chosen directory');
	if (fs.existsSync(target) && fs.statSync(target).size > 0 && !options.force)
		throw new RangeError(target + ' is not empty; pass --force to overwrite it');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, baked.text);
	if (options.report) {
		const reportTarget = path.resolve(options.report);
		fs.mkdirSync(path.dirname(reportTarget), { recursive: true });
		fs.writeFileSync(reportTarget, JSON.stringify(reportFor(options, baked, ms), null, 1) + '\n');
	}
}

function main(argv) {
	let options;
	try {
		options = checkArgs(parseArgv(argv));
	} catch (error) {
		console.error('bake_section: ' + error.message);
		return 2;
	}
	let baked;
	try {
		const started = Date.now();
		baked = bake(options);
		writeOutput(options, baked, Date.now() - started);
	} catch (error) {
		console.error('bake_section: ' + error.message);
		return 2;
	}
	console.log(summaryLine(options, baked));
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { bake: bake, parseArgv: parseArgv, checkArgs: checkArgs, circleFor: circleFor, main: main };

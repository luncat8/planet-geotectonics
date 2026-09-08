// Structural checks on the WebGPU kernel pack, runnable without a GPU. Every entry point
// named by a module must exist in its generated WGSL, sources must be brace-balanced, and
// every arena/constant identifier a kernel names must be one the prelude defines — the two
// failure modes a GPU compile would only report at page load. Real compilation and numeric
// parity are the browser harness's job (tests/gpu-parity.js); this file is the cheap net.
const assert = require('node:assert/strict');
const { Grid, State } = require('./helpers.js');
const { GpuLayout } = require('../js/gpu/layout.js');
const GpuCommon = require('../js/gpu/common.wgsl.js');
const GpuSim = require('../js/gpu/sim-gpu.js');

const MODULES = ['scan', 'mantle', 'plates', 'columns', 'bin', 'raster', 'edges', 'contact',
	'column', 'surface', 'forces', 'diag', 'events']
	.map(name => ({ name, mod: require('../js/gpu/' + name + '.wgsl.js') }));

const g = new Grid(4, 7).build();
const layout = new GpuLayout(g);
const state = new State(g, 7);
const sim = new GpuSim(g, state);
let checks = 0;

// 1. Entry points: declared, present in source, unique across the pack.
const seen = new Set();
for (const { name, mod } of MODULES) {
	const src = mod();
	assert.ok(mod.entry.length > 0, name + ' declares no entries');
	const open = (src.match(/{/g) || []).length, close = (src.match(/}/g) || []).length;
	assert.equal(open, close, name + ' brace balance');
	const parenOpen = (src.match(/\(/g) || []).length, parenClose = (src.match(/\)/g) || []).length;
	assert.equal(parenOpen, parenClose, name + ' paren balance');
	for (const e of mod.entry) {
		assert.ok(!seen.has(e), 'duplicate entry ' + e);
		seen.add(e);
		assert.ok(src.includes('fn ' + e + '('), name + ' missing fn ' + e);
		checks++;
	}
}
checks++;

// 2. Prelude is itself balanced and defines the helper families the kernels call.
const prelude = GpuCommon.prelude(layout);
assert.equal((prelude.match(/{/g) || []).length, (prelude.match(/}/g) || []).length, 'prelude braces');
const letters = ['S', 'C', 'X', 'B', 'M'];
const defined = new Set();
for (const m of prelude.matchAll(/\bfn ([a-zA-Z][a-zA-Z0-9]*)\(/g)) defined.add(m[1]);
for (const { name, mod } of MODULES) {
	for (const m of mod().matchAll(/\bfn ([a-zA-Z][a-zA-Z0-9]*)\(/g)) defined.add(name + '.' + m[1]);
}
for (const { name, mod } of MODULES) {
	for (const m of mod().matchAll(/\b([a-z][a-zA-Z0-9]*)\s+[A-Z]\s*\(/g)) {
		// `addU M(x)` — a helper name split from its arena letter by a space — parses as a call
		// of the undefined single-letter name. No legitimate call looks like this.
		assert.ok(defined.has(name + '.' + m[1]) || defined.has(m[1]),
			name + ' calls undefined helper "' + m[1] + '" before an arena letter');
		checks++;
	}
	for (const m of mod().matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\(/g)) {
		const call = m[1];
		if (/^(ld|st|add|sub|minU|maxU|minI|addI|ldF|stF|ldI|stI)[SCXB]$/.test(call) || /^(ld|st|add|sub|minU|maxU|minI|addI|ldF|stF|ldI|stI)M$/.test(call)) {
			assert.ok(defined.has(call), name + ' calls undefined helper ' + call);
		}
		assert.ok(!/^(ld|st|add|sub|addI|minI|minU|maxU|ldF|stF|ldI|stI)[A-Z]{2,}$/.test(call) || defined.has(call),
			name + ' calls unknown helper ' + call);
		checks++;
	}
}

// 3. Every A_/N_ identifier a kernel names is a layout const; every K_/H_/Z_/COLL_/unit
// constant is in the prelude's CONST_TABLE or its fixed units.
const layoutConsts = new Set();
for (const m of layout.wgsl().matchAll(/const ([A-Z_0-9]+) =/g)) layoutConsts.add(m[1]);
const tableConsts = new Set(['CU', 'OU', 'ZU']);
for (const m of GpuCommon.prelude(layout).matchAll(/const ([A-Z_0-9]+) =/g)) tableConsts.add(m[1]);
for (const { name, mod } of MODULES) {
	const src = mod();
	for (const m of src.matchAll(/\bA_[A-Z0-9_]+/g)) {
		assert.ok(layoutConsts.has(m[0]), name + ' unknown ' + m[0]);
		checks++;
	}
	for (const m of src.matchAll(/\bN_[A-Z0-9_]+/g)) {
		assert.ok(layoutConsts.has(m[0]) || tableConsts.has(m[0]), name + ' unknown ' + m[0]);
		checks++;
	}
	for (const m of src.matchAll(/\b(?:K|H|Z|COLL)_[A-Z0-9_]+/g)) {
		assert.ok(tableConsts.has(m[0]), name + ' unknown constant ' + m[0]);
		checks++;
	}
}

// 4. Layout sanity: word-aligned arenas, fields inside bounds, no overlapping fields.
for (let a = 0; a < 5; a++) assert.equal(layout.arenaBytes[a] % 4, 0, 'arena ' + a + ' alignment');
const spans = [];
for (const fieldName of Object.keys(layout.field)) {
	const f = layout.field[fieldName];
	assert.ok(f.offset + f.stride * f.count <= layout.arenaWords[f.arena],
		fieldName + ' overruns arena ' + f.arena);
	spans.push([f.arena, f.offset, f.offset + f.stride * f.count, fieldName]);
	checks++;
}
spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
for (let i = 1; i < spans.length; i++) {
	if (spans[i][0] === spans[i - 1][0] && spans[i][1] < spans[i - 1][2]) {
		assert.fail(spans[i][3] + ' overlaps ' + spans[i - 1][3]);
	}
}

// 5. Field coverage: every layout field either has a CPU source or is declared scratch —
// an unlisted field would silently stay zero after upload.
const scratch = new Set(['consumed', 'dead', 'spawnFlag', 'spawnSlot', 'binCount', 'binOffset', 'binEntries',
	'glCount', 'glCursor', 'glList', 'm6', 'rhs', 'subRate', 'subCount', 'arcFeed', 'arcFeedN',
	'belt', 'inflow', 'inflowFel', 'inflowPla', 'outflow', 'outflowFel', 'outflowPla',
	'doseArc', 'doseBas', 'dosePla', 'scanPart', 'freeList',
	// spawnLimit is a computed static (rSpawn·nbrDist in uploadStatics), not a state copy.
	'spawnLimit',
	// wEq is GPU-only scratch (kForces writes, kReduceAccum reads).
	'wEq']);
for (const fieldName of Object.keys(layout.field)) {
	if (scratch.has(fieldName) || fieldName.startsWith('g')) continue;
	assert.ok(GpuFieldSourceOf(fieldName), 'no cpu source for layout field ' + fieldName);
	checks++;
}
function GpuFieldSourceOf(name) {
	// sim.upload() is device-bound; copyField against the real state exercises the mapping.
	try {
		sim.copyField(name);
		return true;
	} catch (e) {
		return false;
	}
}

// 6. Fixed-point strides match the conventions the kernels compile against.
const oreField = layout.field.ore;
assert.ok(oreField.stride === 6 && oreField.count === layout.colCap, 'ore stride 6');
assert.ok(layout.field.zdyn.count === layout.colCap, 'zdyn per column');
assert.ok(layout.field.spawnSlot.count === layout.V + 1, 'spawnSlot sized for scan total');
assert.ok(layout.field.scanPart.count >= Math.ceil((layout.V + 1) / 256), 'scanPart covers bins');
checks++;

// 7. Readback plans pack fields from zero and carry the globals tail.
const eventPlan = sim.makePlan(['q', 'omega', 'cells', 'pairLen']);
assert.ok(eventPlan.bytes > 0 && eventPlan.byName.q.offset === 0, 'plan packs from zero');
assert.ok(eventPlan.globalsWords === layout.arenaWords[4] - layout.field.gT.offset, 'plan globals tail');
checks++;

// 8. sim-gpu.js references: every globals or field name the orchestrator names must exist —
// a typo here survives until the first browser frame otherwise.
const globalNames = new Set(layout.globals);
const simSrc = require('node:fs').readFileSync(require.resolve('../js/gpu/sim-gpu.js'), 'utf8');
for (const m of simSrc.matchAll(/\bgi\.([a-zA-Z0-9_]+)/g)) {
	assert.ok(globalNames.has(m[1]), 'sim-gpu references unknown global ' + m[1]);
	checks++;
}
for (const m of simSrc.matchAll(/\bword\('([a-zA-Z0-9_]+)'\)/g)) {
	assert.ok(globalNames.has(m[1]), 'sim-gpu reads unknown global ' + m[1]);
	checks++;
}
for (const m of simSrc.matchAll(/\bfield\.([a-zA-Z0-9_]+)/g)) {
	assert.ok(layout.field[m[1]], 'sim-gpu references unknown field ' + m[1]);
	checks++;
}

// 9. Dispatch coverage: every kernel sim-gpu.js dispatches by name is an entry point of some
// module, including the three baked scan jobs it builds dynamically.
const entries = new Set(seen);
for (const job of ['Bins', 'Spawn', 'Gather']) {
	for (const stage of ['kScanBlocks', 'kScanTops', 'kScanApply']) entries.add(stage + job);
}
for (const m of simSrc.matchAll(/'(k[A-Z][A-Za-z0-9]*)'/g)) {
	const concatenated = /^\s*\+/.test(simSrc.slice(m.index + m[0].length, m.index + m[0].length + 4));
	assert.ok(concatenated || entries.has(m[1]), 'sim-gpu dispatches unknown kernel ' + m[1]);
	checks++;
}

// 10. Memory: every arena stays under the 128 MiB storage-binding limit at L7 (plan §H5).
const L7 = new GpuLayout(new Grid(7, 7).build());
for (let a = 0; a < 5; a++) assert.ok(L7.arenaBytes[a] <= 128 * 1048576, 'arena ' + a + ' exceeds 128 MiB');
checks++;

console.log('PASS wgsl: ' + MODULES.length + ' modules, ' + seen.size + ' entries, ' + checks + ' checks · L7 ' + L7.report());

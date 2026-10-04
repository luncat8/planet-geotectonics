// Structural checks on the WGSL kernel pack, runnable without a GPU: every kernel's full
// source (prelude for its groups + body) must be brace/paren balanced, contain its entry
// point, and every SCREAMING_CASE identifier it references must be defined somewhere in
// that source - the two failure modes a real compile only reports at page load (the
// 'failed gpu implementation' branch shipped ten modules with undefined constants).
// Real compilation and numeric parity stay the browser harness's job (tests/gpu-parity.js).
const { assert, Grid, State } = require('./helpers.js');
const Params = require('../js/params.js');
const CommonWGSL = require('../js/gpu/wgsl-common.js');
const GpuSim = require('../js/gpu/sim-gpu.js');

const state = new State(new Grid(3, 7).build(), 7);
const layout = GpuSim.layout(state);

// wgsl-scan exports a single {groups, code(N)} spec instantiated per width; the rest are
// arrays of kernel specs.
const scanSpec = require('../js/gpu/wgsl-scan.js');
const MODULES = {
	scan: { mod: [scanSpec], widths: [layout.V, layout.colCap] },
	columns: { mod: require('../js/gpu/wgsl-columns.js') },
	mantle: { mod: require('../js/gpu/wgsl-mantle.js') },
	plates: { mod: require('../js/gpu/wgsl-plates.js') },
	edges: { mod: require('../js/gpu/wgsl-edges.js') },
	contact: { mod: require('../js/gpu/wgsl-contact.js') },
	column: { mod: require('../js/gpu/wgsl-column.js') },
	surface: { mod: require('../js/gpu/wgsl-surface.js') },
	diag: { mod: require('../js/gpu/wgsl-diag.js') }
};

let checks = 0;
const sources = [];
// What a call may be besides something declared in the source: WGSL builtin functions and
// types, statements that take parenthesised heads, and attribute argument names.
const WGSL_BUILTINS = ('abs acos all any asarray asin asbool asf16 asf32 asi32 asu32 atan atan2 atan22 ceil clamp ' +
	'cos cosh countLeadingZeros countOneBits countTrailingZeros cross degrees determinant distance dot exp exp2 ' +
	'faceForward firstLeadingBit firstTrailingBit floor fma fract frexp inverseSqrt ldexp ' +
	'length log log2 max min mix normalize pack2x16float pack2x16snorm pack2x16unorm pack4x8snorm pack4x8unorm ' +
	'pow radians reflect refract reverseBits round select sign sin sinh smoothstep sqrt step tan tanh transpose ' +
	'trunc unpack2x16float unpack2x16snorm unpack2x16unorm unpack4x8snorm unpack4x8unorm ' +
	'array atomic atomicAdd atomicAnd atomicCompareExchangeWeak atomicExchange atomicLoad atomicMax atomicMin ' +
	'atomicOr atomicStore atomicSub atomicXor bitcast bool f16 f32 i32 u32 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 ' +
	'mat3x4 mat4x2 mat4x3 mat4x4 ptr textureSample textureSampleLevel textureLoad textureDimensions ' +
	'textureNumLayers textureNumLevels textureNumSamples vec2 vec3 vec4 workgroupBarrier storageBarrier ' +
	'dpdx dpdy fwidth textureStore textureSampleLevel ' +
	'for if return while switch case default let var const fn struct group binding builtin location workgroup_size ' +
	'compute fragment vertex input output').split(/\s+/);
for (const name in MODULES) {
	const entry = MODULES[name];
	for (const spec of entry.mod) {
		const variants = spec.variants ? spec.variants : [undefined];
		const baseName = spec.name || name;
		for (const v of variants) {
			const bodies = entry.widths
				? entry.widths.map((w) => spec.code(w))
				: [v === undefined
					? (typeof spec.code === 'function' ? spec.code() : spec.code)
					: spec.code(v)];
			for (const body of bodies) {
				const src = CommonWGSL.module(spec.groups, Params, layout) + body;
				sources.push({ name: baseName + (v === undefined ? '' : String(v)), src });
			}
		}
	}
}
// The renderer shader, built the way render-gpu.js builds it (consts patched in).
const Renderer = require('../js/gpu/render-gpu.js');
const consts = ['const V = ' + layout.V + 'u;', 'const W = ' + state.grid.lookupW + 'u;',
	'const H = ' + state.grid.lookupH + 'u;', 'const SPLIT_DAMAGE = ' + JSON.stringify(Params.splitDamage) + ';'];
const rendererSrc = Renderer.SHADER.replace('// layout constants appended here (V, W, H, SPLIT_DAMAGE)',
	consts.join('\n'));
sources.push({ name: 'renderer', src: rendererSrc });
// The relief ramp is a uniform (0.3.3), so moving it is a uniform write and not a pipeline
// rebuild: no baked ramp may survive in the elevation branch.
assert.ok(rendererSrc.includes('zRange: f32'), 'the draw uniform carries the relief ramp');
assert.ok(rendererSrc.includes('max(0.0, 1.0 + z / u.zRange)'), 'the deep-water floor follows the ramp');
assert.ok(rendererSrc.includes('min(1.0, z / u.zRange)'), 'and so does the land cap');
assert.ok(!/\b6500\b/.test(rendererSrc), 'no baked ramp is left in the renderer');
sources.push({ name: 'rendererBlit', src: Renderer.BLIT });
// The 3D view (0.5.0/0.5.5): the gather in both z-source variants (the one engine
// difference) and the draw module in both normal-source variants (0.5.5), built through
// the same code the renderer init runs.
const Render3D = require('../js/render3d.js');
sources.push({ name: 'render3dGatherCellF', src: Render3D.gatherCode('cellF', Render3D.TW, Render3D.TH, 1024, 512) });
sources.push({ name: 'render3dGatherCellZ', src: Render3D.gatherCode('cellZ', Render3D.TW, Render3D.TH, 1024, 512) });
sources.push({ name: 'render3dVertexCellF', src: Render3D.gatherCode('cellF', Render3D.TW, Render3D.TH, 1024, 512, 'vertex') });
sources.push({ name: 'render3dVertexCellZ', src: Render3D.gatherCode('cellZ', Render3D.TW, Render3D.TH, 1024, 512, 'vertex') });
sources.push({ name: 'render3dDeriv', src: Render3D.renderCode(2048, 1024, 'deriv') });
sources.push({ name: 'render3dAnalytic', src: Render3D.renderCode(2048, 1024, 'analytic') });

for (const { name, src } of sources) {
	// Strip comments so words/braces inside them count neither as definitions nor references.
	const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
	// Every module-scope resource declaration carries @group and @binding (WGSL parse
	// error otherwise - the bug that black-screened the 3D view on real Chrome), and no
	// name is declared twice (the marker-drift way to reach the same black screen).
	// Module-scope decls are unindented in this codebase; fn bodies are tab-indented.
	for (const line of bare.split('\n')) {
		if (!/^var[<(]/.test(line) || /^var<workgroup/.test(line)) continue;
		assert.ok(line.includes('@group') && line.includes('@binding'),
			name + ': resource var without binding: ' + line.trim());
	}
	// Names from module-scope decls only: unindented (attributes and all); fn-local vars
	// are tab-indented and must not count, or every kernel fails here.
	const declNames = [];
	for (const m of bare.matchAll(/^(?:@\w+\([^)]*\)\s+)*var(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
		declNames.push(m[1]);
	}
	assert.equal(new Set(declNames).size, declNames.length,
		name + ': duplicate resource declaration');
	assert.equal((bare.match(/{/g) || []).length, (bare.match(/}/g) || []).length, name + ' brace balance');
	assert.equal((bare.match(/\(/g) || []).length, (bare.match(/\)/g) || []).length, name + ' paren balance');
	// Entry point: every kernel module is a compute shader (scan uses scanA/scanB/scanC as
	// its entries, the renderer is a fragment shader with fs).
	assert.ok(bare.includes('fn main(') || bare.includes('@compute') || bare.includes('@fragment'),
		name + ' entry point');
	// Defined: const NAME = ... / fn name( / var<...> NAME / let NAME ... / struct NAME.
	const defined = new Set();
	for (const m of bare.matchAll(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)/g)) defined.add(m[1]);
	for (const m of bare.matchAll(/\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)) defined.add(m[1]);
	for (const m of bare.matchAll(/\bvar(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)/g)) defined.add(m[1]);
	for (const m of bare.matchAll(/\blet\s+([A-Za-z_][A-Za-z0-9_]*)/g)) defined.add(m[1]);
	for (const m of bare.matchAll(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/g)) defined.add(m[1]);
	// Referenced: SCREAMING_CASE tokens (kernel constants like P_EPSHI, CELL_EPS, V, FO_PLATE0).
	for (const m of bare.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)) {
		const tok = m[1];
		if (defined.has(tok)) continue;
		assert.ok(false, name + ' references undefined constant ' + tok);
	}
	// Called: every called name must be declared in-source or be a WGSL builtin/statement -
	// catches prelude helpers lost when a kernel's group list drops their declaration group.
	for (const m of bare.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
		const tok = m[1];
		if (defined.has(tok) || WGSL_BUILTINS.includes(tok)) continue;
		assert.ok(false, name + ' calls undefined function ' + tok);
	}
	checks++;
}
assert.ok(sources.length > 40, 'the pack has a known size: ' + sources.length);

// The JS side of two kernel contracts, pinned against the generated WGSL rather than
// restated: the DIAG slot table (pull() unpacks by it, so a drift silently renames every
// diagnostic) and zeroFrame's branch layout (the dispatch count comes from zeroThreads()).
const diagPrelude = CommonWGSL.diag(CommonWGSL.B, layout);
for (const key of Object.keys(GpuSim.DIAG)) {
	const m = diagPrelude.match(new RegExp('const D_' + key + ': u32 = (\\d+)u;'));
	assert.ok(m, 'wgsl-common declares D_' + key);
	assert.equal(+m[1], GpuSim.DIAG[key], 'DIAG.' + key + ' slot matches the WGSL constant');
}
assert.equal(layout.diagOut, Math.max(...Object.values(GpuSim.DIAG)) + 1, 'diagOut covers the last slot');

// The reduce scratch must actually hold the regions winnerB writes, reduceB writes and
// diagB folds: the ledger partials, the winnerA arc-feed partials, the relaxation witness.
const reducePrelude = CommonWGSL.reduce(CommonWGSL.B, layout);
const redRelax = +reducePrelude.match(/const RED_RELAX: u32 = RED_WPART \+ NWG10 \* PLATECAP \* (\d+)u;/)[1];
assert.equal(redRelax, 2, 'RED_RELAX starts after the winner partials');
assert.ok(layout.nwg10 * layout.plateCap * redRelax + layout.plateCap <= layout.reduceF,
	'reduceF covers RED_RELAX + plateCap');

// The frameIn slot table, the JS side against the generated WGSL: the two slots 0.3.3
// promoted (the friction and erosion sliders) are placed by GpuSim.FIN_* and read through
// the F_* constants, so a drift would have a slider move a different number - or, worse,
// the plume table. Only kernels that already bind frameIn may use them.
const framePrelude = CommonWGSL.frameIn(CommonWGSL.B, layout);
for (const [name, slot] of [['FRICTION', GpuSim.FIN_FRICTION], ['EROSCALE', GpuSim.FIN_EROSCALE]]) {
	const m = framePrelude.match(new RegExp('const F_' + name + ': u32 = (\\d+)u;'));
	assert.ok(m, 'wgsl-common declares F_' + name);
	assert.equal(+m[1], slot, 'F_' + name + ' matches GpuSim.FIN_' + name);
	assert.ok(slot < GpuSim.FIN_FIELDS, 'and is inside the block GpuSim uploads');
	assert.ok(framePrelude.includes('return FIN[F_' + name + '];'), 'the accessor reads its own slot');
}
const erodeSrc = sources.find((s) => s.name === 'erode').src;
assert.ok(erodeSrc.includes('let q = zc / P_ZKNEE;'), 'erode uses the quadratic knee');
assert.ok(erodeSrc.includes('P_KERO * fEroScale() * zc * q * q'), 'with the slider scaling the intake');
const forcesSrc = sources.find((s) => s.name === 'forces').src;
assert.ok(forcesSrc.includes('exp(-P_EA * fFriction() * (1.0 / fTM() - 1.0))'),
	'forces scales Ea with the friction slider, in the CPU expression\'s order');
assert.ok(CommonWGSL.params(Params, layout).includes('const P_ZKNEE: f32 = ' + Params.zKnee + ';'),
	'the knee is a calibrated const, not a slider');

const zeroSrc = sources.find((s) => s.name === 'zeroFrame').src;
for (const shape of ['t < 6u', 't < 6u + PLATECAP * 3u', 't < 6u + PLATECAP * 3u + COLCAP',
	't < 6u + PLATECAP * 3u + COLCAP + PLATECAP', '7u * COLCAP']) {
	assert.ok(zeroSrc.includes(shape), 'zeroFrame still branches on ' + shape);
}
// The 3D module's own contracts, pinned against the generated sources: the engine
// difference is exactly the z read, the constants are baked where they are constants and
// nowhere else (exag, sea and the relief ramp ride the uniform), and the fragment ramps
// are the same four-line formula the 2D renderers were pinned to.
const gatherF = sources.find((s) => s.name === 'render3dGatherCellF').src;
const gatherZ = sources.find((s) => s.name === 'render3dGatherCellZ').src;
assert.ok(gatherF.includes('CELLF[c * 8u].w') && !gatherF.includes('ZSRC[c]'),
	'the cellF gather reads the sim z at its vec4 slot');
assert.ok(gatherZ.includes('return ZSRC[c];') && !gatherZ.includes('CELLF'),
	'the cellZ gather reads the plain f32 upload, and nothing else differs structurally');
for (const g of [gatherF, gatherZ]) {
	assert.ok(g.includes('const GAP_Z = -1e9;') && g.includes('if (z != z) { z = GAP_Z; }'),
		'a NaN gap lands on the marker, not a hole');
	assert.ok(g.includes('@workgroup_size(8, 8)'), 'one thread per texel, 8x8 groups');
}
// The 0.5.6 vertex gather: the record variant carries the record binding and reads the
// weights back as the same integers the CPU reference accumulates; the hex variant must not
// grow a record read, and both keep the shared frame contract. The constants are pinned
// against js/heightfield.js, which is the only other place the layout exists.
const HeightField = require('../js/heightfield.js');
const vertexF = sources.find((s) => s.name === 'render3dVertexCellF').src;
const vertexZ = sources.find((s) => s.name === 'render3dVertexCellZ').src;
assert.equal(Render3D.REC_U32, HeightField.RECORD_FLOATS, 'the gather reads HeightField\'s four-u32 record');
for (const [name, src] of [['vertex cellF', vertexF], ['vertex cellZ', vertexZ]]) {
	assert.ok(src.includes('@group(0) @binding(3) var<storage, read> REC: array<vec4<u32>>;'),
		name + ': the record buffer is declared at binding 3');
	assert.ok(src.includes('let rec = REC[gid.y * W + gid.x];'), name + ': one record per height texel');
	assert.ok(src.includes('const INVALID_Z = GAP_Z * 0.5;') && HeightField.GAP * 0.5 === -5e8,
		name + ': the gap threshold is the CPU reference\'s own, from the same marker');
	assert.ok(src.includes('let q0 = f32(packed & 65535u);') && src.includes('let q1 = f32((packed >> 16u) & 65535u);'),
		name + ': the packed word is split by mask, so q0 is the low half and q1 the high half');
	assert.ok(src.includes('let q2 = 65535.0 - q0 - q1;'), name + ': the third weight is the exact remainder');
	assert.equal(HeightField.QUANT, 65535, 'and 65535 is the quantization the CPU packs with');
	assert.ok(src.includes('if (h0 > INVALID_Z) { sum += q0 * h0; weight += q0; }'),
		name + ': a gap drops out of both sums and the rest renormalize, in the CPU order');
	assert.ok(src.includes('var z = GAP_Z;') && src.includes('if (weight > 0.0) { z = sum / weight; }'),
		name + ': three gaps keep the marker');
	assert.ok(!src.includes('LOOK[sy * LW + sx]'), name + ': the vertex variant reads no nearest cell');
	assert.ok(src.includes('@workgroup_size(8, 8)') && src.includes('if (z != z) { z = GAP_Z; }'),
		name + ': and the same dispatch and NaN contract as the base gather');
}
const hexF = sources.find((s) => s.name === 'render3dGatherCellF').src;
assert.ok(!hexF.includes('REC'), 'the hex gather never declares or reads the record buffer');
assert.ok(hexF.includes('@workgroup_size(8, 8)') && hexF.includes('var z = zAt(u32(LOOK[sy * LW + sx]));'),
	'the nearest-cell body is unchanged');
for (const src of [vertexF, vertexZ]) {
	assert.ok(src.includes('CELLF[c * 8u].w') || src.includes('return ZSRC[c];'),
		'the vertex variant keeps the engine difference in zAt alone');
	assert.ok(!src.includes(Render3D.M_REC) && !src.includes(Render3D.M_TEXEL)
		&& !src.includes(Render3D.M_GATHER) && !src.includes(Render3D.M_Z),
		'every injection marker is replaced in the vertex gather');
}

const r3dSrc = sources.find((s) => s.name === 'render3dDeriv').src;
assert.ok(r3dSrc.includes('const R_INV'), 'the radius inverse is baked from Params');
assert.ok(r3dSrc.includes('const Z_FLOOR') && r3dSrc.includes('max(heightAt(uv), Z_FLOOR)'),
	'the displacement floor clamps below at the gap-pit bound');
assert.ok(r3dSrc.includes('1.0 + Z_RIM * u.knob.x * R_INV'),
	'the rim shell scales with exag, so no peak can pierce it');
assert.ok(!/\b6500\b/.test(r3dSrc) && r3dSrc.includes('u.knob.z'),
	'no baked relief range: the 3D ramp rides the uniform like the 2D one');
assert.ok(r3dSrc.includes('heightAt(uvOf(normalize(in.dir)))') && !r3dSrc.includes('in.uv'),
	'fragments rebuild uv from the interpolated direction - a uv varying interpolates'
	+ ' across the texture cut and paints a pole-to-pole strip of the wrong hemisphere');
assert.ok(r3dSrc.includes('15.0 + 23.0 * s') && r3dSrc.includes('100.0 + 145.0 * hi'),
	'the 3D ramp is the 2D relief ramp, sea-relative, verbatim');
assert.ok(!/textureSample\b/.test(r3dSrc),
	'r32float is unfilterable: every height read is a textureLoad tap, no sampler in the group');
// The two normal sources (0.5.5): the same varying and the same three call sites, so the
// only difference is the injected block - and neither may carry a half-injected marker.
const r3dAnalytic = sources.find((s) => s.name === 'render3dAnalytic').src;
for (const [name, src] of [['deriv', r3dSrc], ['analytic', r3dAnalytic]]) {
	assert.ok(!src.includes(Render3D.M_NORMAL) && !src.includes(Render3D.M_RENDER)
		&& !src.includes(Render3D.M_Z) && !src.includes(Render3D.M_GATHER),
		name + ': every injection marker is replaced');
	assert.ok(src.includes('o.nrm = vertexNormal(dir, uv);'), name + ': the land pass fills the normal varying');
	assert.ok(src.includes('o.nrm = dir;'), name + ': the sea shell and the rim stay radial');
	assert.equal((src.match(/surfaceNormal\(in\.wp, in\.nrm\)/g) || []).length, 3,
		name + ': all three fragments light with the varying');
}
assert.ok(r3dSrc.includes('dpdx(wp)') && r3dSrc.includes('dpdy(wp)') && !r3dSrc.includes('textureLoad(HEIGHT, vec2<i32>(xm'),
	'the derivative source is the screen-space one, with no height taps in a normal');
assert.ok(!r3dAnalytic.includes('dpdx') && !r3dAnalytic.includes('dpdy'),
	'the analytic source never differentiates the surface per fragment');
assert.ok(r3dAnalytic.includes('textureLoad(HEIGHT, vec2<i32>(xm, y), 0).x') && r3dAnalytic.includes('(hL - hR)')
	&& r3dAnalytic.includes('6.28318530718 / f32(W)') && r3dAnalytic.includes('3.14159265359 / f32(H)'),
	'the analytic normal differences one texel either way, scaled by the true arc lengths');
assert.ok(r3dAnalytic.includes('max(sqrt(max(1.0 - dir.y * dir.y, 0.0)), 0.001)'),
	'with a cos(lat) floor, so a pole vertex stays finite');
assert.ok(r3dAnalytic.includes('let x = (i32(floor(p.x)) + i32(W)) % i32(W);'),
	'analytic taps wrap the centre before computing neighbours at the longitude seam');
// Evaluate the shader's integer-index expressions; the stub cannot execute WGSL.
function analyticTap(name, p, W) {
	const expression = Render3D.NORM_ANALYTIC.match(new RegExp('let ' + name + ' = ([^;]+);'))[1];
	const code = expression.replace(/i32\(/g, 'Math.trunc(').replace(/floor\(/g, 'Math.floor(');
	return Function('p', 'W', 'x', 'select', 'return ' + code)(p, W,
		name === 'x' ? 0 : analyticTap('x', p, W), (a, b, condition) => condition ? b : a);
}
for (const u of [0, 1]) {
	const p = { x: u * Render3D.TW - 0.5 };
	assert.deepEqual(['xm', 'x', 'xp'].map(name => analyticTap(name, p, Render3D.TW)),
		[Render3D.TW - 2, Render3D.TW - 1, 0], 'both seam endpoints use identical valid taps');
}
for (const u of [0.0001, 0.25, 0.5, 0.9999]) {
	for (const name of ['xm', 'x', 'xp']) {
		const tap = analyticTap(name, { x: u * Render3D.TW - 0.5 }, Render3D.TW);
		assert.ok(tap >= 0 && tap < Render3D.TW, 'every analytic longitude tap is in bounds');
	}
}
assert.ok(r3dAnalytic.includes('if (abs(dir.y) > 0.9999) { return dir; }'),
	'pole vertices return radial direction without division by zero');

console.log('PASS wgsl-struct: ' + checks + ' kernel sources balanced, entry-pointed, constants defined');

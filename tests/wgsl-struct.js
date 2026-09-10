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
	'dpdx dpdy fwidth ' +
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

for (const { name, src } of sources) {
	// Strip comments so words/braces inside them count neither as definitions nor references.
	const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
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
console.log('PASS wgsl-struct: ' + checks + ' kernel sources balanced, entry-pointed, constants defined');

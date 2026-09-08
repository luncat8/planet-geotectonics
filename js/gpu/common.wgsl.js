/* gpu/common.wgsl.js — builds the shader prelude shared by every kernel: the five arena
   bindings, the layout constants from GpuLayout, the tuned constants from Params, and the
   atomic access / fixed-point conversion helpers. Every arena is array<atomic<u32>> so any
   word can be an accumulation target; plain reads and writes go through atomicLoad/Store. */
var CommonParams = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;

function fnum(v) {
	if (typeof v !== 'number' || !isFinite(v)) throw new Error('bad shader constant ' + v);
	if (Number.isInteger(v)) return v.toFixed(1);
	var s = String(v);
	return /[.e]/.test(s) ? s : s + '.0';
}

// Tuned constants the kernels read directly; keep in one place so sweeps flow through.
var CONST_TABLE = [
	['epsHi', 'EPS_HI'], ['epsLo', 'EPS_LO'], ['hOceanic', 'H_OCEANIC'],
	['hRiftBreakup', 'H_RIFT_BREAKUP'], ['hCollapse', 'H_COLLAPSE'], ['collThickness', 'COLL_THICK'],
	['ageSlab', 'AGE_SLAB'], ['vRef', 'V_REF'], ['sedScrape', 'SED_CUT'],
	['kArc', 'K_ARC'], ['arcMafShare', 'ARC_MAF_SHARE'], ['kA', 'K_A'], ['kRec', 'K_REC'],
	['zTrench', 'Z_TRENCH'], ['fertLo', 'FERT_LO'], ['kV', 'K_V'], ['kM2', 'K_M2'],
	['kCollapse', 'K_COLLAPSE'], ['kDam', 'K_DAM'], ['extRef', 'EXT_REF'], ['kDamT', 'K_DAM_T'],
	['kHeal', 'K_HEAL'], ['kLip', 'K_LIP'], ['kM', 'K_M'], ['kO', 'K_O'], ['kDecay', 'K_DECAY'],
	['hOro', 'H_ORO'], ['kFlex', 'K_FLEX'], ['zPlume', 'Z_PLUME'],
	['kB2', 'K_B2'], ['hBas', 'H_BAS'], ['zBasin', 'Z_BASIN'],
	['kEro', 'K_ERO'], ['slopeRef', 'SLOPE_REF'], ['deltaZ', 'DELTA_Z'],
	['kPlacer', 'K_PLACER'], ['kB', 'K_B'], ['kPlume', 'K_PLUME'], ['beta', 'BETA'],
	['nPhi', 'N_PHI'], ['nWave', 'N_WAVE']
];

var ARENA_BINDINGS = ['SA', 'CA', 'XA', 'BA', 'MA'];
var ARENA_LETTERS = ['S', 'C', 'X', 'B', 'M'];

function prelude(layout) {
	var out = '', a, i, L, t;
	for (a = 0; a < 5; a++) {
		out += '@group(0) @binding(' + a + ') var<storage, read_write> ' + ARENA_BINDINGS[a] + ': array<atomic<u32>>;\n';
	}
	out += '\n' + layout.wgsl() + '\n';
	for (i = 0; i < CONST_TABLE.length; i++) {
		t = CONST_TABLE[i];
		out += 'const ' + t[1] + ' = ' + fnum(CommonParams[t[0]]) + ';\n';
	}
	out += '\n';
	// Fixed-point units: crust millimetres, ore 1e-6, zDyn centimetres.
	out += 'const CU = 1000.0;\nconst OU = 1000000.0;\nconst ZU = 100.0;\n\n';
	for (a = 0; a < 5; a++) {
		L = ARENA_LETTERS[a];
		out += 'fn ld' + L + '(i:u32) -> u32 { return atomicLoad(&' + ARENA_BINDINGS[a] + '[i]); }\n';
		out += 'fn st' + L + '(i:u32, v:u32) { atomicStore(&' + ARENA_BINDINGS[a] + '[i], v); }\n';
		out += 'fn add' + L + '(i:u32, v:u32) -> u32 { return atomicAdd(&' + ARENA_BINDINGS[a] + '[i], v); }\n';
		out += 'fn sub' + L + '(i:u32, v:u32) -> u32 { return atomicSub(&' + ARENA_BINDINGS[a] + '[i], v); }\n';
		out += 'fn addI' + L + '(i:u32, v:i32) -> u32 { return atomicAdd(&' + ARENA_BINDINGS[a] + '[i], bitcast<u32>(v)); }\n';
		out += 'fn minI' + L + '(i:u32, v:i32) -> u32 { return atomicMin(&' + ARENA_BINDINGS[a] + '[i], bitcast<u32>(v)); }\n';
		out += 'fn minU' + L + '(i:u32, v:u32) -> u32 { return atomicMin(&' + ARENA_BINDINGS[a] + '[i], v); }\n';
		out += 'fn maxU' + L + '(i:u32, v:u32) -> u32 { return atomicMax(&' + ARENA_BINDINGS[a] + '[i], v); }\n';
		out += 'fn ldF' + L + '(i:u32) -> f32 { return bitcast<f32>(atomicLoad(&' + ARENA_BINDINGS[a] + '[i])); }\n';
		out += 'fn stF' + L + '(i:u32, v:f32) { atomicStore(&' + ARENA_BINDINGS[a] + '[i], bitcast<u32>(v)); }\n';
		out += 'fn ldI' + L + '(i:u32) -> i32 { return bitcast<i32>(atomicLoad(&' + ARENA_BINDINGS[a] + '[i])); }\n';
		out += 'fn stI' + L + '(i:u32, v:i32) { atomicStore(&' + ARENA_BINDINGS[a] + '[i], bitcast<u32>(v)); }\n';
	}
	out += '\n';
	// 64-bit accumulate: lo wraps (u32 add is two's complement for either sign), the carry
	// from the wrapping low word is exactly one high-word increment.
	out += `fn toMm(x:f32) -> u32 { return u32(max(0.0, floor(x * CU + 0.5))); }
fn fMm(u:u32) -> f32 { return f32(u) / CU; }
fn toOre(x:f32) -> u32 { return u32(clamp(x, 0.0, 1.0) * OU + 0.5); }
fn fOre(u:u32) -> f32 { return f32(u) / OU; }
fn toCm(x:f32) -> i32 { return i32(round(x * ZU)); }
fn fCm(v:i32) -> f32 { return f32(v) / ZU; }
fn add64(lo:u32, hi:u32, v:u32) {
	let old = atomicAdd(&MA[lo], v);
	if (old + v < old) { atomicAdd(&MA[hi], 1u); }
}
fn add64I(lo:u32, hi:u32, v:i32) { add64(lo, hi, bitcast<u32>(v)); }
fn smooth01(x:f32, lo:f32, hi:f32) -> f32 {
	let t = clamp((x - lo) / (hi - lo), 0.0, 1.0);
	return t * t * (3.0 - 2.0 * t);
}
// Hash tie-break shared with the CPU contact pass.
fn colHash(cell:u32, frame:u32) -> u32 {
	var h = u32(bitcast<i32>((cell ^ 0x9E3779B1u) * 0x85EBCA6Bu)) ^ u32(bitcast<i32>((frame + 1u) * 0xC2B2AE35u));
	return h ^ (h >> 15u);
}
`;
	return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { prelude: prelude, fnum: fnum };

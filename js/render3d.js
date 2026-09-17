/* render3d.js - the 3D planet view (0.5.0): a dense static icosphere displaced radially
   from a per-frame height texture, a translucent water shell at the 0.3.5 display sea
   level, and an additive limb halo. Renderer-only: it takes a device (the page owns the
   adapter), reads the sim's own segment-final heights (the GPU engine's cellF buffer
   directly, or a per-frame cellZ upload on the CPU engine) and never touches sim state.
   The frame contract mirrors GpuRenderer's: append(enc) rides the play segment encoder
   (gather + land + water + rim, once per rAF), redraw() is the paused/view-only own
   encoder, present() is the canvas blit submitted on a drained queue - a canvas pass
   inside a heavy encoder would present black (the 2D black-frame fix, verbatim).
   The height texture is R32Float, which is unfilterable in core WebGPU, so the bilinear
   filtering is spelled out as four textureLoad taps in the shader (heightAt) - no
   sampler, exact f32 heights, and the u seam wraps in the tap indices. */
var R3DNode = typeof module !== 'undefined' && module.exports;
var R3DParams = typeof Params !== 'undefined' ? Params : (R3DNode ? require('./params.js') : null);
// The blit is one source: the page loads render-gpu.js first, so the global is there; the
// node tests take it through the module, never the bare require (a classic-script context
// has no require at all - it must not even be evaluated).
var R3DBlit = typeof GpuRenderer !== 'undefined' ? GpuRenderer.BLIT
	: (R3DNode ? require('./gpu/render-gpu.js').BLIT : null);

function Render3D(canvas) {
	this.canvas = canvas;
	this.exag = 10;
	this.yaw = 0.65; this.pitch = 0.42; this.dist = 3.0;
	this.tsOn = false; this.tsBusy = false;
	this.tsMs = new Float64Array(4);
}

Render3D.TW = 2048; Render3D.TH = 1024;
Render3D.FOV = 40 * Math.PI / 180;
Render3D.NEAR = 0.2; Render3D.FAR = 30;
Render3D.DIST_MIN = 1.5; Render3D.DIST_MAX = 10;
Render3D.PITCH_MAX = 89.5 * Math.PI / 180;
Render3D.TS_NAMES = ['gather', 'land', 'water', 'rim'];
// Spec GPUTextureUsage / GPUBufferUsage / GPUShaderStage bits, as everywhere in this repo.
// 0x1 COPY_SRC (buffer+texture), 0x2 COPY_DST (buffer), 0x4 TEXTURE_BINDING,
// 0x8 STORAGE+COPY_DST disambiguated by namespace, 0x10 INDEX/RENDER_ATTACHMENT,
// 0x20 VERTEX, 0x40 UNIFORM, 0x80 STORAGE.

// Injection markers, single-sourced: the templates embed them (interpolated) and
// gatherCode/renderCode replace by them, so the two can never drift apart again.
Render3D.M_GATHER = '// layout constants appended here (W, H, LW, LH, GAP_Z)';
Render3D.M_Z = '// z binding + read appended here (CELLF | CELLZ)';
Render3D.M_RENDER = '// layout constants appended here (W, H, R_INV, Z_FLOOR, Z_RIM)';

/* The gather: one thread per height texel, the 2D shader's sourceCell convention (lookup
   row 0 = south, no flip anywhere). The one engine difference - where z comes from - is
   injected at the marker: cellF (vec4 grid, z at [c*8].w) or the CPU upload (plain f32). */
Render3D.GATHER = `@group(0) @binding(0) var<storage, read> LOOK: array<f32>;
@group(0) @binding(2) var HEIGHT: texture_storage_2d<r32float, write>;
${Render3D.M_GATHER}
${Render3D.M_Z}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (gid.x >= W || gid.y >= H) { return; }
	let lon = (f32(gid.x) + 0.5) / f32(W) * 6.28318530718 - 3.14159265359;
	let lat = (f32(gid.y) + 0.5) / f32(H) * 3.14159265359 - 1.57079632679;
	let sx = u32(clamp(floor((lon / 6.28318530718 + 0.5) * f32(LW)), 0.0, f32(LW - 1u)));
	let sy = u32(clamp(floor((lat / 3.14159265359 + 0.5) * f32(LH)), 0.0, f32(LH - 1u)));
	var z = zAt(u32(LOOK[sy * LW + sx]));
	if (z != z) { z = GAP_Z; }
	textureStore(HEIGHT, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(z, 0.0, 0.0, 1.0));
}
`;

Render3D.cellFRead = 'fn zAt(c: u32) -> f32 { return CELLF[c * 8u].w; }';
Render3D.cellZRead = 'fn zAt(c: u32) -> f32 { return ZSRC[c]; }';
Render3D.cellFBinding = '@group(0) @binding(1) var<storage, read> CELLF: array<vec4<f32>>;';
Render3D.cellZBinding = '@group(0) @binding(1) var<storage, read> ZSRC: array<f32>;';

/* The draw module: three thin vertex entries (land / water / rim) over the shared
   helpers, one fragment entry per pass. Every height read - the vertex displacement and
   both colour ramps - goes through the same heightAt, so colour and geometry coastlines
   agree to the tap. Normals are screen-space derivatives, flipped to face the eye. */
Render3D.RENDER = `struct U { vp: mat4x4<f32>, eye: vec4<f32>, knob: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var HEIGHT: texture_2d<f32>;
${Render3D.M_RENDER}

const LIGHT = vec3<f32>(0.5497513, 0.2998646, -0.7796479);
const SKY = vec3<f32>(0.35, 0.52, 0.78);

fn uvOf(dir: vec3<f32>) -> vec2<f32> {
	let lat = asin(clamp(dir.y, -1.0, 1.0));
	let lon = atan2(dir.z, dir.x);
	let sx = lon * 0.15915494309189535 + 0.5;
	let sy = clamp(lat * 0.3183098861837907 + 0.5, 0.0, 1.0);
	return vec2<f32>(sx, sy);
}

// Bilinear height in metres: four texel taps, u wraps across the antimeridian, v clamps.
fn heightAt(uv: vec2<f32>) -> f32 {
	let p = vec2<f32>(uv.x * f32(W), uv.y * f32(H)) - vec2<f32>(0.5);
	let fl = floor(p);
	let t = p - fl;
	var x0 = i32(fl.x);
	x0 = select(x0, i32(W) - 1, x0 < 0);
	let x1 = select(x0 + 1, 0, x0 >= i32(W) - 1);
	let y0 = clamp(i32(fl.y), 0, i32(H) - 1);
	let y1 = min(y0 + 1, i32(H) - 1);
	let z00 = textureLoad(HEIGHT, vec2<i32>(x0, y0), 0).x;
	let z10 = textureLoad(HEIGHT, vec2<i32>(x1, y0), 0).x;
	let z01 = textureLoad(HEIGHT, vec2<i32>(x0, y1), 0).x;
	let z11 = textureLoad(HEIGHT, vec2<i32>(x1, y1), 0).x;
	return mix(mix(z00, z10, t.x), mix(z01, z11, t.x), t.y);
}

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) dir: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) wp: vec3<f32> };

@vertex fn vsLand(@location(0) dirIn: vec3<f32>) -> VOut {
	let dir = dirIn;
	let uv = uvOf(dir);
	let r = 1.0 + max(heightAt(uv), Z_FLOOR) * u.knob.x * R_INV;
	var o: VOut;
	o.pos = u.vp * vec4<f32>(dir * r, 1.0);
	o.dir = dir;
	o.uv = uv;
	o.wp = dir * r;
	return o;
}

@vertex fn vsWater(@location(0) dirIn: vec3<f32>) -> VOut {
	let dir = dirIn;
	let uv = uvOf(dir);
	let r = 1.0 + max(u.knob.y, Z_FLOOR) * u.knob.x * R_INV;
	var o: VOut;
	o.pos = u.vp * vec4<f32>(dir * r, 1.0);
	o.dir = dir;
	o.uv = uv;
	o.wp = dir * r;
	return o;
}

@vertex fn vsRim(@location(0) dirIn: vec3<f32>) -> VOut {
	let dir = dirIn;
	let uv = uvOf(dir);
	let r = 1.0 + Z_RIM * u.knob.x * R_INV;
	var o: VOut;
	o.pos = u.vp * vec4<f32>(dir * r, 1.0);
	o.dir = dir;
	o.uv = uv;
	o.wp = dir * r;
	return o;
}

// The world position rides its own varying: a fragment stage's @builtin(position) is
// framebuffer coordinates, not the clip position, and the derivative normals need the
// true interpolated surface point.
fn surfaceNormal(wp: vec3<f32>) -> vec3<f32> {
	var n = normalize(cross(dpdx(wp), dpdy(wp)));
	if (dot(n, u.eye.xyz - wp) < 0.0) { n = -n; }
	return n;
}

// The 2D relief ramp (render.js / render-gpu.js), sea-relative, verbatim.
fn rampColor(z: f32) -> vec3<f32> {
	if (z < u.knob.y) {
		let s = max(0.0, 1.0 - (u.knob.y - z) / u.knob.z);
		return vec3<f32>(15.0 + 23.0 * s, 40.0 + 95.0 * s, 69.0 + 100.0 * s) / 255.0;
	}
	let hi = min(1.0, (z - u.knob.y) / u.knob.z);
	return vec3<f32>(100.0 + 145.0 * hi, 156.0 + 79.0 * hi, 112.0 + 113.0 * hi) / 255.0;
}

struct FOut { @location(0) color: vec4<f32> };

@fragment fn fsLand(in: VOut) -> FOut {
	let n = surfaceNormal(in.wp);
	let col = rampColor(heightAt(in.uv));
	let lam = 0.25 + 0.75 * max(0.0, dot(n, LIGHT));
	let limb = 0.75 + 0.25 * dot(n, normalize(u.eye.xyz - in.wp));
	var o: FOut;
	o.color = vec4<f32>(col * lam * limb, 1.0);
	return o;
}

@fragment fn fsWater(in: VOut) -> FOut {
	let n = surfaceNormal(in.wp);
	let s = max(0.0, 1.0 - (u.knob.y - heightAt(in.uv)) / u.knob.z);
	let col = vec3<f32>(15.0 + 23.0 * s, 40.0 + 95.0 * s, 69.0 + 100.0 * s) / 255.0;
	let v = normalize(u.eye.xyz - in.wp);
	let halfv = normalize(LIGHT + v);
	let spec = pow(max(0.0, dot(n, halfv)), 60.0) * 0.3;
	let facing = max(0.0, dot(n, v));
	let alpha = 0.45 + 0.25 * (1.0 - facing) * (1.0 - facing);
	var o: FOut;
	o.color = vec4<f32>(col + vec3<f32>(spec), alpha);
	return o;
}

@fragment fn fsRim(in: VOut) -> FOut {
	let n = surfaceNormal(in.wp);
	let facing = max(0.0, dot(n, normalize(u.eye.xyz - in.wp)));
	let d = 1.0 - facing;
	var o: FOut;
	o.color = vec4<f32>(SKY * d * d * d, 1.0);
	return o;
}
`;

// The template's baked constants, the way render-gpu.js injects its layout ones.
Render3D.gatherConsts = function (w, h, lw, lh) {
	return ['const W = ' + w + 'u;', 'const H = ' + h + 'u;', 'const LW = ' + lw + 'u;',
		'const LH = ' + lh + 'u;', 'const GAP_Z = -1e9;'].join('\n');
};
Render3D.renderConsts = function (w, h) {
	return ['const W = ' + w + 'u;', 'const H = ' + h + 'u;',
		'const R_INV = ' + (1 / R3DParams.radius) + ';',
		'const Z_FLOOR = -15000.0;', 'const Z_RIM = 15000.0;'].join('\n');
};
Render3D.gatherCode = function (zSource, w, h, lw, lh) {
	var cellF = zSource !== 'cellZ';
	return Render3D.GATHER
		.replace(Render3D.M_GATHER, Render3D.gatherConsts(w, h, lw, lh))
		.replace(Render3D.M_Z,
			(cellF ? Render3D.cellFBinding : Render3D.cellZBinding) + '\n' +
			(cellF ? Render3D.cellFRead : Render3D.cellZRead));
};
Render3D.renderCode = function (w, h) {
	return Render3D.RENDER.replace(Render3D.M_RENDER,
		Render3D.renderConsts(w, h));
};

/* Unit icosphere, k midpoint-subdivision rounds. Vertices 10*4^k + 2, faces 20*4^k; the
   seed faces are CCW outward and subdivision preserves that. The dedup cache keys the
   sorted endpoint pair, so every midpoint is built once. */
Render3D.mesh = function (k) {
	var nV = 10 * Math.pow(4, k) + 2, nF = 20 * Math.pow(4, k);
	var pos = new Float32Array(nV * 3), idx = new Uint32Array(nF * 3);
	var t = (1 + Math.sqrt(5)) / 2;
	var seed = [
		-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
		0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
		t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1
	];
	var i;
	for (i = 0; i < 12; i++) {
		var x = seed[i * 3], y = seed[i * 3 + 1], z = seed[i * 3 + 2];
		var inv = 1 / Math.hypot(x, y, z);
		pos[i * 3] = x * inv; pos[i * 3 + 1] = y * inv; pos[i * 3 + 2] = z * inv;
	}
	var faces = new Uint32Array([
		0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
		1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
		3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
		4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1
	]);
	var vCount = 12;
	for (var s = 0; s < k; s++) {
		var next = new Uint32Array(faces.length * 4), w = 0;
		var cache = new Map();
		var between = function (a, b) {
			var key = a < b ? a * nV + b : b * nV + a;
			var hit = cache.get(key);
			if (hit !== undefined) return hit;
			var mx = pos[a * 3] + pos[b * 3], my = pos[a * 3 + 1] + pos[b * 3 + 1], mz = pos[a * 3 + 2] + pos[b * 3 + 2];
			var minv = 1 / Math.hypot(mx, my, mz);
			var m = vCount++;
			pos[m * 3] = mx * minv; pos[m * 3 + 1] = my * minv; pos[m * 3 + 2] = mz * minv;
			cache.set(key, m);
			return m;
		};
		for (i = 0; i < faces.length; i += 3) {
			var a = faces[i], b = faces[i + 1], c = faces[i + 2];
			var ab = between(a, b), bc = between(b, c), ca = between(c, a);
			next[w++] = a; next[w++] = ab; next[w++] = ca;
			next[w++] = b; next[w++] = bc; next[w++] = ab;
			next[w++] = c; next[w++] = ca; next[w++] = bc;
			next[w++] = ab; next[w++] = bc; next[w++] = ca;
		}
		faces = next;
	}
	idx.set(faces);
	return { pos: pos, idx: idx, vCount: vCount };
};

// Combined view*projection (column-major) for the orbit camera, plus the eye point.
// Scratch lives at module scope: this runs per camera move, never per vertex.
var VP_P = new Float64Array(16), VP_V = new Float64Array(16);
Render3D.matVP = function (out, eye, yaw, pitch, dist, aspect) {
	var cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
	var ex = dist * cp * sy, ey = dist * sp, ez = dist * cp * cy;
	var fx = -ex / dist, fy = -ey / dist, fz = -ez / dist;
	// right = normalize(cross(forward, up)), up = (0,1,0); pitch is clamped away from the poles.
	var rl = Math.hypot(fz, fx);
	var rx = -fz / rl, ry = 0, rz = fx / rl;
	var ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
	VP_V[0] = rx; VP_V[1] = ux; VP_V[2] = -fx; VP_V[3] = 0;
	VP_V[4] = ry; VP_V[5] = uy; VP_V[6] = -fy; VP_V[7] = 0;
	VP_V[8] = rz; VP_V[9] = uz; VP_V[10] = -fz; VP_V[11] = 0;
	VP_V[12] = -(rx * ex + ry * ey + rz * ez);
	VP_V[13] = -(ux * ex + uy * ey + uz * ez);
	VP_V[14] = fx * ex + fy * ey + fz * ez;
	VP_V[15] = 1;
	var fo = 1 / Math.tan(Render3D.FOV / 2), n = Render3D.NEAR, f = Render3D.FAR;
	VP_P[0] = fo / aspect; VP_P[1] = 0; VP_P[2] = 0; VP_P[3] = 0;
	VP_P[4] = 0; VP_P[5] = fo; VP_P[6] = 0; VP_P[7] = 0;
	VP_P[8] = 0; VP_P[9] = 0; VP_P[10] = f / (n - f); VP_P[11] = -1;
	VP_P[12] = 0; VP_P[13] = 0; VP_P[14] = n * f / (n - f); VP_P[15] = 0;
	for (var col = 0; col < 4; col++) {
		for (var row = 0; row < 4; row++) {
			out[col * 4 + row] = VP_P[row] * VP_V[col * 4] + VP_P[4 + row] * VP_V[col * 4 + 1]
				+ VP_P[8 + row] * VP_V[col * 4 + 2] + VP_P[12 + row] * VP_V[col * 4 + 3];
		}
	}
	eye[0] = ex; eye[1] = ey; eye[2] = ez; eye[3] = 1;
};

Render3D.prototype.setOrbit = function (yaw, pitch, dist) {
	this.yaw = yaw;
	this.pitch = Math.max(-Render3D.PITCH_MAX, Math.min(Render3D.PITCH_MAX, pitch));
	this.dist = Math.max(Render3D.DIST_MIN, Math.min(Render3D.DIST_MAX, dist));
	if (!this.vpW) return;
	Render3D.matVP(this.vpW, this.eyeW, this.yaw, this.pitch, this.dist, this.aspect);
};

Render3D.prototype.setDetail = function (k) {
	this.k = k;
	var device = this.device;
	if (this.posBuf) this.posBuf.destroy();
	if (this.idxBuf) this.idxBuf.destroy();
	this.mesh = Render3D.mesh(k);
	this.vCount = this.mesh.vCount; this.iCount = this.mesh.idx.length;
	this.posBuf = device.createBuffer({ size: this.mesh.pos.byteLength, usage: 0x20 | 0x8 });
	this.idxBuf = device.createBuffer({ size: this.mesh.idx.byteLength, usage: 0x10 | 0x8 });
	device.queue.writeBuffer(this.posBuf, 0, this.mesh.pos);
	device.queue.writeBuffer(this.idxBuf, 0, this.mesh.idx);
};

Render3D.prototype.init = function (opts) {
	var device = this.device = opts.device;
	var canvas = this.canvas;
	this.zSource = opts.zSource;
	this.k = opts.k;
	this.aspect = canvas.width / canvas.height;
	this.context = canvas.getContext('webgpu');
	this.format = 'rgba8unorm';
	this.context.configure({ device: device, format: this.format, alphaMode: 'opaque' });
	this.mesh = Render3D.mesh(this.k);
	this.vCount = this.mesh.vCount; this.iCount = this.mesh.idx.length;
	this.posBuf = device.createBuffer({ size: this.mesh.pos.byteLength, usage: 0x20 | 0x8 });
	this.idxBuf = device.createBuffer({ size: this.mesh.idx.byteLength, usage: 0x10 | 0x8 });
	device.queue.writeBuffer(this.posBuf, 0, this.mesh.pos);
	device.queue.writeBuffer(this.idxBuf, 0, this.mesh.idx);
	this.height = device.createTexture({
		size: [Render3D.TW, Render3D.TH], format: 'r32float', usage: 0x8 | 0x4
	});
	this.heightView = this.height.createView();
	this.target = device.createTexture({
		size: [canvas.width, canvas.height], format: this.format, usage: 0x10 | 0x4 | 0x1
	});
	this.targetView = this.target.createView();
	this.depth = device.createTexture({
		size: [canvas.width, canvas.height], format: 'depth24plus', usage: 0x10
	});
	this.depthView = this.depth.createView();
	this.uniform = device.createBuffer({ size: 96, usage: 0x40 | 0x8 });
	this.uniformBytes = new ArrayBuffer(96);
	this.vpW = new Float32Array(this.uniformBytes, 0, 16);
	this.eyeW = new Float32Array(this.uniformBytes, 64, 4);
	this.knobW = new Float32Array(this.uniformBytes, 80, 4);
	this.setOrbit(this.yaw, this.pitch, this.dist);
	// The lookup raster: the sim device already holds it (GpuRenderer uploaded it); an
	// own-device session takes the array and uploads its own copy.
	if (opts.look instanceof Float32Array) {
		this.ownsLook = true;
		this.look = device.createBuffer({ size: opts.look.length * 4, usage: 0x80 | 0x8 });
		device.queue.writeBuffer(this.look, 0, opts.look);
	} else {
		this.ownsLook = false;
		this.look = opts.look;
	}
	if (this.zSource === 'cellZ') {
		this.zScratch = new Float32Array(opts.V);
		this.cellZ = device.createBuffer({ size: Math.max(16, opts.V * 4), usage: 0x80 | 0x8 });
	} else {
		this.cellF = opts.cellF;
	}
	var shader = device.createShaderModule({ code: Render3D.renderCode(canvas.width, canvas.height) });
	this.drawLayout = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: 0x1 | 0x2, buffer: { type: 'uniform' } },
		{ binding: 1, visibility: 0x1 | 0x2, texture: { sampleType: 'unfilterable-float' } }
	] });
	var pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.drawLayout] });
	var vbLayout = [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }];
	var DS_ON = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
	var DS_TEST = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' };
	var ALPHA = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
		alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
	var ADD = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
		alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
	this.landPipe = device.createRenderPipeline({
		layout: pipeLayout,
		vertex: { module: shader, entryPoint: 'vsLand', buffers: vbLayout },
		fragment: { module: shader, entryPoint: 'fsLand', targets: [{ format: this.format }] },
		primitive: { cullMode: 'back' }, depthStencil: DS_ON
	});
	this.waterPipe = device.createRenderPipeline({
		layout: pipeLayout,
		vertex: { module: shader, entryPoint: 'vsWater', buffers: vbLayout },
		fragment: { module: shader, entryPoint: 'fsWater', targets: [{ format: this.format, blend: ALPHA }] },
		primitive: { cullMode: 'back' }, depthStencil: DS_TEST
	});
	this.rimPipe = device.createRenderPipeline({
		layout: pipeLayout,
		vertex: { module: shader, entryPoint: 'vsRim', buffers: vbLayout },
		fragment: { module: shader, entryPoint: 'fsRim', targets: [{ format: this.format, blend: ADD }] },
		primitive: { cullMode: 'back' }, depthStencil: DS_TEST
	});
	this.group = device.createBindGroup({ layout: this.drawLayout, entries: [
		{ binding: 0, resource: { buffer: this.uniform } },
		{ binding: 1, resource: this.heightView }
	] });
	var gatherMod = device.createShaderModule({ code: Render3D.gatherCode(this.zSource,
		Render3D.TW, Render3D.TH, opts.lw, opts.lh) });
	this.gatherLayout = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: 0x4, buffer: { type: 'read-only-storage' } },
		{ binding: 1, visibility: 0x4, buffer: { type: 'read-only-storage' } },
		{ binding: 2, visibility: 0x4, storageTexture: { access: 'write-only', format: 'r32float' } }
	] });
	this.gatherPipe = device.createComputePipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [this.gatherLayout] }),
		compute: { module: gatherMod, entryPoint: 'main' }
	});
	this.gatherGroup = device.createBindGroup({ layout: this.gatherLayout, entries: [
		{ binding: 0, resource: { buffer: this.look } },
		{ binding: 1, resource: { buffer: this.zSource === 'cellZ' ? this.cellZ : this.cellF } },
		{ binding: 2, resource: this.heightView }
	] });
	var blitMod = device.createShaderModule({ code: R3DBlit });
	this.blitPipe = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module: blitMod, entryPoint: 'vs' },
		fragment: { module: blitMod, entryPoint: 'fs', targets: [{ format: this.format }] }
	});
	this.blitGroup = device.createBindGroup({
		layout: this.blitPipe.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
			{ binding: 1, resource: this.targetView }
		]
	});
	// Pass descriptors, allocated once: the land pass clears colour and depth, the water
	// and rim passes load both. Timestamp slots are fixed (gather 0/1, land 2/3, ...).
	this.landDesc = { colorAttachments: [{ view: this.targetView, loadOp: 'clear', storeOp: 'store',
		clearValue: { r: 20 / 255, g: 26 / 255, b: 39 / 255, a: 1 } }],
		depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } };
	this.waterDesc = { colorAttachments: [{ view: this.targetView, loadOp: 'load', storeOp: 'store' }],
		depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store', depthClearValue: 1 } };
	this.rimDesc = { colorAttachments: [{ view: this.targetView, loadOp: 'load', storeOp: 'store' }],
		depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store', depthClearValue: 1 } };
	this.gatherDesc = {};
	this.tsSlot = 0; this.tsWritten = [false, false];
	try {
		this.tsQ = device.createQuerySet({ type: 'timestamp', count: 8 });
		this.tsResolve = [0, 1].map(function () {
			return device.createBuffer({ size: 64, usage: 0x4 | 0x200 });
		});
		this.tsMap = [0, 1].map(function () {
			return device.createBuffer({ size: 64, usage: 0x1 | 0x8 });
		});
		// Timestamps assume a 1 ns period (Dawn/Metal/Vulkan in practice), like GpuSim.ts.
		this.landDesc.timestampWrites = { querySet: this.tsQ, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 };
		this.waterDesc.timestampWrites = { querySet: this.tsQ, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 };
		this.rimDesc.timestampWrites = { querySet: this.tsQ, beginningOfPassWriteIndex: 6, endOfPassWriteIndex: 7 };
		this.gatherDesc.timestampWrites = { querySet: this.tsQ, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
		this.tsOn = true;
	} catch (e) {
		this.tsOn = false;   // adapter without timestamp-query: no 3D strip line
	}
	return this;
};

// state.z -> f32 scratch, gaps to the marker; the scratch is allocated once per session.
Render3D.prototype.packZ = function (state) {
	var z = state.z, out = this.zScratch;
	for (var c = 0; c < out.length; c++) {
		var v = z[c];
		out[c] = v === v ? v : -1e9;
	}
};

// Gather + the three draws, into an encoder the caller owns (the play segment tail).
Render3D.prototype.append = function (enc) {
	var device = this.device;
	this.knobW[0] = this.exag;
	this.knobW[1] = R3DParams.sea;
	this.knobW[2] = R3DParams.zRange;
	device.queue.writeBuffer(this.uniform, 0, this.uniformBytes);
	var g = enc.beginComputePass(this.gatherDesc);
	g.setPipeline(this.gatherPipe);
	g.setBindGroup(0, this.gatherGroup);
	g.dispatchWorkgroups(Render3D.TW / 8, Render3D.TH / 8);
	g.end();
	var p = enc.beginRenderPass(this.landDesc);
	p.setPipeline(this.landPipe);
	p.setBindGroup(0, this.group);
	p.setIndexBuffer(this.idxBuf, 'uint32');
	p.setVertexBuffer(0, this.posBuf);
	p.drawIndexed(this.iCount);
	p.end();
	p = enc.beginRenderPass(this.waterDesc);
	p.setPipeline(this.waterPipe);
	p.setBindGroup(0, this.group);
	p.setIndexBuffer(this.idxBuf, 'uint32');
	p.setVertexBuffer(0, this.posBuf);
	p.drawIndexed(this.iCount);
	p.end();
	p = enc.beginRenderPass(this.rimDesc);
	p.setPipeline(this.rimPipe);
	p.setBindGroup(0, this.group);
	p.setIndexBuffer(this.idxBuf, 'uint32');
	p.setVertexBuffer(0, this.posBuf);
	p.drawIndexed(this.iCount);
	p.end();
	if (this.tsOn) {
		enc.resolveQuerySet(this.tsQ, 0, 8, this.tsResolve[this.tsSlot], 0);
		enc.copyBufferToBuffer(this.tsResolve[this.tsSlot], 0, this.tsMap[this.tsSlot], 0, 64);
		this.tsWritten[this.tsSlot] = true;
		this.tsSlot ^= 1;
	}
};

// The paused / view-only / CPU-engine frame: own encoder (cellZ packed and uploaded
// first in the CPU mode), the canvas untouched - present() shows it on the drained queue.
Render3D.prototype.redraw = function (state) {
	if (this.zSource === 'cellZ') {
		this.packZ(state);
		this.device.queue.writeBuffer(this.cellZ, 0, this.zScratch);
	}
	var enc = this.device.createCommandEncoder();
	this.append(enc);
	this.device.queue.submit([enc.finish()]);
};

Render3D.prototype.present = function () {
	if (!this.target) return;
	var enc = this.device.createCommandEncoder();
	var p = enc.beginRenderPass({ colorAttachments: [{
		view: this.context.getCurrentTexture().createView(),
		loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 }
	}] });
	p.setPipeline(this.blitPipe);
	p.setBindGroup(0, this.blitGroup);
	p.draw(3);
	p.end();
	this.device.queue.submit([enc.finish()]);
};

Render3D.prototype.presentWhenDrained = function () {
	var self = this;
	this.device.queue.onSubmittedWorkDone().then(function () { self.present(); });
};

// The 2 Hz strip line: one collect per tick maps the last completed slot pair.
Render3D.prototype.collect = function () {
	if (this.tsBusy || !this.tsWritten[this.tsSlot ^ 1]) return;
	var self = this, buf = this.tsMap[this.tsSlot ^ 1];
	this.tsBusy = true;
	buf.mapAsync(0x1).then(function () {
		var q = new BigUint64Array(buf.getMappedRange());
		for (var i = 0; i < 4; i++) self.tsMs[i] = Number(q[i * 2 + 1] - q[i * 2]) / 1e6;
		buf.unmap();
		self.tsBusy = false;
	}, function () { self.tsBusy = false; });
};

Render3D.prototype.tsLine = function () {
	if (!this.tsOn) return '';
	this.collect();
	var ms = this.tsMs, i;
	for (i = 0; i < 4; i++) if (!(ms[i] >= 0)) return '';
	return '3d ' + Render3D.TS_NAMES[0] + ' ' + ms[0].toFixed(2)
		+ ' · ' + Render3D.TS_NAMES[1] + ' ' + ms[1].toFixed(2)
		+ ' · ' + Render3D.TS_NAMES[2] + ' ' + ms[2].toFixed(2)
		+ ' · ' + Render3D.TS_NAMES[3] + ' ' + ms[3].toFixed(2) + ' ms';
};

// Readback rig (the smoke's pixel checks), the GpuRenderer pattern: the 3D target is a
// legal copy source; the canvas is not.
Render3D.prototype.initReadback = function () {
	var w = this.canvas.width, h = this.canvas.height;
	this.readRow = Math.ceil(w * 4 / 256) * 256;
	this.readSize = this.readRow * h;
	this.staging = this.device.createBuffer({ size: this.readSize, usage: 0x1 | 0x8 });
	return this;
};

Render3D.prototype.readPixels = async function () {
	var enc = this.device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: this.target },
		{ buffer: this.staging, bytesPerRow: this.readRow },
		[this.canvas.width, this.canvas.height]);
	this.device.queue.submit([enc.finish()]);
	await this.staging.mapAsync(0x1);
	var range = this.staging.getMappedRange();
	var bytes = new Uint8Array(range.byteLength);
	bytes.set(new Uint8Array(range));
	this.staging.unmap();
	return bytes;
};

// Everything the session allocated; called on 3D-off, world rebuild and engine switch.
// The sim's own buffers (a borrowed LOOK or cellF) are not ours to destroy.
Render3D.prototype.release = function () {
	if (this.posBuf) { this.posBuf.destroy(); this.posBuf = null; }
	if (this.idxBuf) { this.idxBuf.destroy(); this.idxBuf = null; }
	if (this.uniform) { this.uniform.destroy(); this.uniform = null; }
	if (this.ownsLook && this.look) { this.look.destroy(); this.look = null; }
	if (this.cellZ) { this.cellZ.destroy(); this.cellZ = null; }
	if (this.height) { this.height.destroy(); this.height = null; }
	if (this.target) { this.target.destroy(); this.target = null; }
	if (this.depth) { this.depth.destroy(); this.depth = null; }
	if (this.landPipe && this.landPipe.destroy) this.landPipe.destroy();
	if (this.waterPipe && this.waterPipe.destroy) this.waterPipe.destroy();
	if (this.rimPipe && this.rimPipe.destroy) this.rimPipe.destroy();
	if (this.blitPipe && this.blitPipe.destroy) this.blitPipe.destroy();
	if (this.tsQ && this.tsQ.destroy) { this.tsQ.destroy(); this.tsOn = false; }
	this.staging = null;
	this.zScratch = null;
};

if (typeof module !== 'undefined' && module.exports) module.exports = Render3D;

/* gpu/render-gpu.js - the GPU twin of render.js: same layers, same palettes, computed in a
   fragment shader that samples the lookup raster and reads the sim buffers directly, so a
   frame needs no readback at all. One fullscreen-triangle draw per frame; the layer id and
   view quaternion ride a small uniform. The CPU mirror stays one event cycle old (download
   runs there).
   The draw always lands on the renderer's own world texture; the canvas receives only a
   blit of it, submitted on a drained device queue (present) - never a pass queued behind a
   sim segment, which would finish after the next compositor refresh and present an
   undrawn (black) drawing buffer. `init(state, { readback: true })` adds the staging the
   parity rigs read the world texture out through - see initReadback. */
// Like the kernel modules, this file runs both as a classic script (GpuSim is already a
// global) and under node, where the renderer's readback path is tested on the stub device.
var GpuRendererNode = typeof module !== 'undefined' && module.exports;
var GpuSimRef = typeof GpuSim !== 'undefined' ? GpuSim : (GpuRendererNode ? require('./sim-gpu.js') : null);
var GpuRendererParams = typeof Params !== 'undefined' ? Params : require('../params.js');

function GpuRenderer(canvas) {
	this.canvas = canvas;
	this.layer = 0;
	this.viewQ = new Float32Array([0, 0, 0, 1]);
}

GpuRenderer.LAYERS = { plate: 0, type: 1, z: 2, damage: 3, owner: 4, sediment: 5,
	oVms: 10, oMaf: 11, oArc: 12, oOro: 13, oBas: 14, oPla: 15,
	speed: 20, age: 21, force: 22, dir: 23, forceDir: 24 };

GpuRenderer.SHADER = `struct U { layer: u32, viewQ: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> LOOK: array<f32>;
@group(0) @binding(2) var<storage, read> GRIDI: array<i32>;
@group(0) @binding(3) var<storage, read> COLF: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> COLI: array<i32>;
@group(0) @binding(5) var<storage, read> CELLF: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> CELLI: array<i32>;
@group(0) @binding(7) var<storage, read> EDGES: array<i32>;
// layout constants appended here (V, W, H, SPLIT_DAMAGE)

fn owner(c: u32) -> i32 { return CELLI[c * 13u]; }
fn plate(i: u32) -> i32 { return COLI[i * 4u]; }
fn edgeType(e: u32) -> u32 { return u32(EDGES[e * 4u + 2u] & 0xff); }
fn edgePol(e: u32) -> i32 { return ((EDGES[e * 4u + 2u] >> 8) & 0xff) - 1; }
fn ringN(c: u32) -> u32 { return u32(GRIDI[6u * V + c]); }
fn cellZ(c: u32) -> f32 { return CELLF[c * 8u].w; }
fn colH(i: u32) -> vec4<f32> { return COLF[i * 6u + 2u]; }
// Ore six-pack: oVms/oMaf/oArc are vec4 3 yzw, oOro/oBas/oPla are vec4 4 xyz.
fn colOre(i: u32, k: u32) -> f32 {
	if (k < 3u) { return COLF[i * 6u + 3u][k + 1u]; }
	return COLF[i * 6u + 4u][k - 3u];
}

fn palette(p: u32) -> vec3<f32> {
	let a = f32(p) * 2.3999632297;
	return vec3(135.0 + 90.0 * cos(a), 145.0 + 80.0 * cos(a + 2.1), 155.0 + 80.0 * cos(a + 4.2));
}

// HSL -> RGB helpers for the plate-motion view.
fn hue2rgb(pn: f32, qn: f32, t: f32) -> f32 {
	var tt = t;
	if (tt < 0.0) { tt = tt + 1.0; }
	if (tt > 1.0) { tt = tt - 1.0; }
	if (tt < 1.0 / 6.0) { return pn + (qn - pn) * 6.0 * tt; }
	if (tt < 0.5) { return qn; }
	if (tt < 2.0 / 3.0) { return pn + (qn - pn) * (2.0 / 3.0 - tt) * 6.0; }
	return pn;
}

fn hslToRgb(hue: f32, sat: f32, lum: f32) -> vec3<f32> {
	if (sat <= 0.0) { return vec3(lum, lum, lum); }
	let h = hue / 360.0;
	var qn = lum * (1.0 + sat);
	if (lum >= 0.5) { qn = lum + sat - lum * sat; }
	let pn = 2.0 * lum - qn;
	return vec3(hue2rgb(pn, qn, h + 1.0 / 3.0), hue2rgb(pn, qn, h), hue2rgb(pn, qn, h - 1.0 / 3.0));
}

// Plate motion view (0.3 plan): direction -> hue (exactly one wheel wrap), speed -> lightness.
// Anchors E 120 green, N 240 blue, W 0 red, S 60 yellow; see render.js dirHue for the
// +360 unwrapped rise and why west is red (the rejected W-yellow wish list winds 0).
fn dirHue(velocity: vec2<f32>) -> f32 {
	var t = fract(atan2(velocity.y, velocity.x) * 0.15915494309189535);
	var hue = 120.0 + 480.0 * t;
	hue = select(hue, 240.0 + 240.0 * t, t >= 0.5);
	return hue - floor(hue / 360.0) * 360.0;
}

fn speedToHsl(velocity: vec2<f32>, speedContrast: f32) -> vec3<f32> {
	let speed = length(velocity);
	let normalizedSpeed = min(speed * 0.166666667, 1.0);
	let lightness = 0.05 + 0.65 * pow(normalizedSpeed, speedContrast);
	return vec3(dirHue(velocity), 0.90, lightness);
}

// The view quaternion maps a world direction into the displayed map. The shader applies
// its conjugate to turn each output pixel back into a world direction before reading LOOK.
fn worldDirection(screen: vec3<f32>) -> vec3<f32> {
	let qx = -u.viewQ.x; let qy = -u.viewQ.y; let qz = -u.viewQ.z; let qw = u.viewQ.w;
	let tx = 2.0 * (qy * screen.z - qz * screen.y);
	let ty = 2.0 * (qz * screen.x - qx * screen.z);
	let tz = 2.0 * (qx * screen.y - qy * screen.x);
	return vec3(
		screen.x + qw * tx + qy * tz - qz * ty,
		screen.y + qw * ty + qz * tx - qx * tz,
		screen.z + qw * tz + qx * ty - qy * tx);
}

fn sourceCell(px: u32, py: u32) -> u32 {
	let lon = (f32(px) + 0.5) / f32(W) * 6.28318530718 - 3.14159265359;
	let lat = 1.57079632679 - (f32(py) + 0.5) / f32(H) * 3.14159265359;
	let cl = cos(lat);
	let screen = vec3(cl * cos(lon), sin(lat), cl * sin(lon));
	let world = worldDirection(screen);
	let sourceLat = asin(clamp(world.y, -1.0, 1.0));
	let sourceLon = atan2(world.z, world.x);
	var sx = i32(floor((sourceLon / 6.28318530718 + 0.5) * f32(W)));
	if (sx < 0) { sx = sx + i32(W); }
	if (sx >= i32(W)) { sx = sx - i32(W); }
	let sy = u32(clamp(floor((sourceLat / 3.14159265359 + 0.5) * f32(H)), 0.0, f32(H - 1u)));
	return u32(LOOK[sy * W + u32(sx)]);
}

// Same branches and hues as Renderer.draw, evaluated per fragment.
fn cellColor(c: u32, px: u32, py: u32) -> vec3<f32> {
	let o = owner(c);
	var base = vec3(20.0, 26.0, 39.0);
	if (o < 0) { return base; }
	let oi = u32(o);
	let layer = u.layer;
	if (layer == 4u) { return vec3(78.0, 197.0, 167.0); }
	// The ore six-pack is ids 10..15; the range must be closed at both ends or the
	// speed/age/force/dir ids (20..23) land here and colOre indexes past the vec4.
	if (layer >= 10u && layer <= 15u) {
		let v = min(1.0, colOre(oi, layer - 10u));
		return vec3(24.0 + 231.0 * v, 30.0 + 190.0 * v * v, 44.0 + 40.0 * v);
	}
	if (layer == 3u) {
		let d = colH(oi).w;
		let hot = select(40.0, 90.0, d > SPLIT_DAMAGE);
		let m = min(1.0, d);
		return vec3(30.0 + 225.0 * m, 30.0 + hot * m, 46.0);
	}
	if (layer == 1u) {
		var kind = 0u;
		for (var k = 0u; k < ringN(c); k = k + 1u) {
			let e = c * 6u + k;
			let t = edgeType(e);
			if (t == 1u && edgePol(e) == 2) { kind = 4u; break; }
			if (t == 1u && kind < 3u) { kind = 3u; } else if (t == 2u && kind < 2u) { kind = 2u; } else if (t == 3u && kind < 1u) { kind = 1u; }
		}
		if (kind == 4u) { return vec3(186.0, 92.0, 214.0); }
		if (kind == 3u) { return vec3(214.0, 72.0, 64.0); }
		if (kind == 2u) { return vec3(232.0, 196.0, 74.0); }
		if (kind == 1u) { return vec3(214.0, 214.0, 220.0); }
		return palette(u32(plate(oi))) * 0.45;
	}
	if (layer == 0u) { return palette(u32(plate(oi))); }
	if (layer == 5u) {
		let sed = min(1.0, colH(oi).y / 5000.0);
		return vec3(52.0 + 170.0 * sed, 42.0 + 110.0 * sed, 30.0 + 55.0 * sed);
	}
	// Same ramps as Renderer.draw: cell vel block 0, wEq block 7, column age colH.z.
	if (layer == 20u) {
		let v = min(1.0, length(CELLF[c * 8u].xyz) / 80000.0);
		return vec3(12.0 + 236.0 * v, 16.0 + 234.0 * v, 28.0 + 227.0 * v);
	}
	if (layer == 21u) {
		let a = min(1.0, colH(oi).z / 1000.0);
		return vec3(234.0 - 202.0 * a, 112.0 - 66.0 * a, 48.0 + 52.0 * a);
	}
	if (layer == 22u) {
		let f = sqrt(min(1.0, length(CELLF[c * 8u + 7u].xyz) / 500000.0));
		return vec3(16.0 + 239.0 * f, 16.0 + 204.0 * f * f, 30.0 + 26.0 * f);
	}
	if (layer == 23u || layer == 24u) {
		var v = CELLF[c * 8u].xyz;
		if (layer == 24u) { v = CELLF[c * 8u + 7u].xyz; }
		// Equirectangular pixel -> lon/lat, then the local tangent basis (East, North).
		let fx = (f32(px) + 0.5) / f32(W);
		let fy = (f32(py) + 0.5) / f32(H);
		let lon = fx * 6.28318530718 - 3.14159265359;
		let lat = 1.57079632679 - fy * 3.14159265359;
		let clo = cos(lon); let slo = sin(lon);
		let cla = cos(lat); let sla = sin(lat);
		let vEast = v.x * (-slo) + v.z * clo;
		let vNorth = v.x * (-sla * clo) + v.y * cla + v.z * (-sla * slo);
		let uv = vec2(vEast, vNorth) / 13333.3333;
		let hsl = speedToHsl(uv, 0.6);
		return hslToRgb(hsl.x, hsl.y, hsl.z) * 255.0;
	}
	let z = cellZ(c);
	if (z < 0.0) {
		let shallow = max(0.0, 1.0 + z / 6500.0);
		return vec3(15.0 + 23.0 * shallow, 40.0 + 95.0 * shallow, 69.0 + 100.0 * shallow);
	}
	let high = min(1.0, z / 6500.0);
	return vec3(100.0 + 145.0 * high, 156.0 + 79.0 * high, 112.0 + 113.0 * high);
}

@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {
	var p = array<vec2<f32>, 3>(vec2(-1.0, -3.0), vec2(3.0, 1.0), vec2(-1.0, 1.0));
	return vec4(p[v], 0.0, 1.0);
}

struct Out { @location(0) color: vec4<f32> };

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> Out {
	let x = u32(clamp(pos.x, 0.0, f32(W - 1u)));
	let y = u32(clamp(pos.y, 0.0, f32(H - 1u)));
	var c: u32;
	if (abs(u.viewQ.x) < 1e-7 && abs(u.viewQ.y) < 1e-7 && abs(u.viewQ.z) < 1e-7 && u.viewQ.w > 0.999999) {
		c = u32(LOOK[(H - 1u - y) * W + x]);
	} else {
		c = sourceCell(x, y);
	}
	var o: Out;
	o.color = vec4(cellColor(c, x, y) / 255.0, 1.0);
	return o;
}
`;

// One-triangle blit of the world texture onto the canvas. The uv rides the same
// fullscreen triangle and the sampler is nearest, so the blit is a texel-for-texel copy:
// what the parity check reads out of the world texture is what the map shows.
GpuRenderer.BLIT = `@group(0) @binding(0) var SAMP: sampler;
@group(0) @binding(1) var TEX: texture_2d<f32>;

struct BlitOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex fn vs(@builtin(vertex_index) v: u32) -> BlitOut {
	var p = array<vec2<f32>, 3>(vec2(-1.0, -3.0), vec2(3.0, 1.0), vec2(-1.0, 1.0));
	var o: BlitOut;
	o.pos = vec4(p[v], 0.0, 1.0);
	o.uv = p[v] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
	return o;
}

struct Out { @location(0) color: vec4<f32> }

@fragment fn fs(in: BlitOut) -> Out {
	var o: Out;
	o.color = textureSample(TEX, SAMP, in.uv);
	return o;
}
`;

GpuRenderer.prototype.init = function (state, opts) {
	var S = GpuSimRef.S, device = S.device, g = state.grid;
	this.context = this.canvas.getContext('webgpu');
	this.canvas.width = g.lookupW;
	this.canvas.height = g.lookupH;
	var consts = ['const V = ' + S.l.V + 'u;', 'const W = ' + g.lookupW + 'u;',
		'const H = ' + g.lookupH + 'u;', 'const SPLIT_DAMAGE = ' + JSON.stringify(GpuRendererParams.splitDamage) + ';'];
	var code = GpuRenderer.SHADER.replace('// layout constants appended here (V, W, H, SPLIT_DAMAGE)',
		consts.join('\n'));
	this.format = navigator.gpu.getPreferredCanvasFormat();
	// The canvas keeps the spec's default usage (RENDER_ATTACHMENT alone). Asking for
	// COPY_SRC there does not work on a real swapchain: Chrome/D3D backs the canvas with a
	// D3DSharedImage whose usage it chooses itself, so `copyTextureToBuffer` out of
	// `getCurrentTexture()` fails validation on hardware ("usage (TextureBinding|
	// RenderAttachment) doesn't include TextureUsage::CopySrc") even though the same call is
	// legal on a software adapter. Readback therefore renders into our own texture, which
	// carries COPY_SRC, and blits it to the canvas for the visible map.
	this.context.configure({ device: device, format: this.format, alphaMode: 'opaque' });
	// The lookup raster is static per grid, so it rides its own read-only buffer, uploaded once.
	if (!S.buf.lookup) {
		S.buf.lookup = device.createBuffer({ size: g.lookup.length * 4, usage: 0x80 | 0x4 | 0x8 });
		device.queue.writeBuffer(S.buf.lookup, 0, g.lookup);
	}
	this.uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x8 });
	this.uniformBytes = new ArrayBuffer(32);
	this.layerWord = new Uint32Array(this.uniformBytes);
	this.viewWord = new Float32Array(this.uniformBytes, 16, 4);
	this.viewWord.set(this.viewQ);
	var shaderModule = device.createShaderModule({ code: code });
	var layout = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: 0x2, buffer: { type: 'uniform' } },
		{ binding: 1, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 2, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 3, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 4, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 5, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 6, visibility: 0x2, buffer: { type: 'read-only-storage' } },
		{ binding: 7, visibility: 0x2, buffer: { type: 'read-only-storage' } }
	] });
	this.group = device.createBindGroup({ layout: layout, entries: [
		{ binding: 0, resource: { buffer: this.uniform } },
		{ binding: 1, resource: { buffer: S.buf.lookup } },
		{ binding: 2, resource: { buffer: S.buf.gridI } },
		{ binding: 3, resource: { buffer: S.buf.colF } },
		{ binding: 4, resource: { buffer: S.buf.colI } },
		{ binding: 5, resource: { buffer: S.buf.cellF } },
		{ binding: 6, resource: { buffer: S.buf.cellI } },
		{ binding: 7, resource: { buffer: S.buf.edges } }
	] });
	this.pipeline = device.createRenderPipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		vertex: { module: shaderModule, entryPoint: 'vs' },
		fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format: this.format }] }
	});
	// The world texture: the renderer's working image, every mode. Every layer draw
	// (appendTo, redraw) lands here; the canvas only ever receives a blit of it. This
	// split is the black-frame fix: the spec replaces a presented canvas's drawing
	// buffer with a fresh transparent-black one on each getCurrentTexture after the
	// presentation, and the compositor shows whatever is in it at the next refresh -
	// so a layer pass queued behind a sim segment finishes after that refresh and the
	// frame presents black (every setting whose per-frame GPU work outruns the refresh:
	// L6 1 step, L5 5 steps, "so any heavy"). The blit is a sub-millisecond pass the
	// caller submits on a drained queue, so it always completes before its presentation.
	var w = this.canvas.width, h = this.canvas.height;
	this.world = device.createTexture({
		size: [w, h], format: this.format,
		// All three usages are load-bearing: drawn into (RENDER_ATTACHMENT), sampled
		// by the blit (TEXTURE_BINDING), copied out by the parity check (COPY_SRC).
		// TextureUsage COPY_SRC is 0x1 - 0x4 is BufferUsage's COPY_SRC, and that
		// mix-up made the copy fail validation on hardware with the stub never
		// complaining.
		usage: 0x10 | 0x4 | 0x1
	});
	this.worldView = this.world.createView();
	var blit = device.createShaderModule({ code: GpuRenderer.BLIT });
	this.blitPipeline = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module: blit, entryPoint: 'vs' },
		fragment: { module: blit, entryPoint: 'fs', targets: [{ format: this.format }] }
	});
	this.blitGroup = device.createBindGroup({
		layout: this.blitPipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
			{ binding: 1, resource: this.worldView }
		]
	});
	if (opts && opts.readback) this.initReadback(device);
	return this;
};

// The renderer's own resources (the world texture, the blit pipeline): a level switch
// re-inits the sim arenas through GpuSim.release, but the renderer outlives its state,
// so its textures go here - 2 MB at the lookup raster per level otherwise.
GpuRenderer.prototype.release = function () {
	if (this.world) { this.world.destroy(); this.world = null; }
	if (this.blitPipeline && this.blitPipeline.destroy) this.blitPipeline.destroy();
	if (this.staging) { this.staging.destroy(); this.staging = null; }
};

// Readback rig (the smoke's pixel-parity check): the staging buffer the world texture is
// copied out through. The texture itself is owned by every renderer (init), because the
// canvas blit samples it in the app's mode too. Allocated once, so a layer sweep is
// allocation-free apart from the mapped-range view.
GpuRenderer.prototype.initReadback = function (device) {
	var w = this.canvas.width, h = this.canvas.height;
	this.readRow = Math.ceil(w * 4 / 256) * 256;
	this.readSize = this.readRow * h;
	this.staging = device.createBuffer({ size: this.readSize, usage: 0x1 | 0x8 });   // MAP_READ | COPY_DST
	return this;
};

// The pixels of the last world draw, row-padded to bytesPerRow, in the canvas format's
// byte order (bgra8unorm on every current adapter: B at offset 0). The source is the
// world texture, never a swapchain texture. Awaited, so it belongs to the smoke and the
// parity rigs, never to the frame loop.
GpuRenderer.prototype.readPixels = async function () {
	var device = GpuSimRef.S.device;
	if (this.readPending) await this.readPending;
	var enc = device.createCommandEncoder();
	enc.copyTextureToBuffer({ texture: this.world },
		{ buffer: this.staging, bytesPerRow: this.readRow },
		[this.canvas.width, this.canvas.height]);
	device.queue.submit([enc.finish()]);
	this.readPending = this.staging.mapAsync(0x1);
	await this.readPending;
	this.readPending = null;
	// Copy the pixels OUT before unmap: getMappedRange hands back a view on the
	// transient mapping, and unmap() invalidates it - a returned view is empty by the
	// time the caller touches it (owner's rig: 16 x "readback short 0 bytes", which is
	// why the pixel parity never actually compared). GpuSim.pull consumes its ranges
	// before its unmaps, which is why the mirror was fine while this was not.
	var range = this.staging.getMappedRange();
	var bytes = new Uint8Array(range.byteLength);
	bytes.set(new Uint8Array(range));
	this.staging.unmap();
	return bytes;
};

GpuRenderer.prototype.setView = function (qx, qy, qz, qw) {
	var q = arguments.length === 1 ? qx : null;
	if (q) { qy = q[1]; qz = q[2]; qw = q[3]; qx = q[0]; }
	this.viewQ[0] = qx; this.viewQ[1] = qy; this.viewQ[2] = qz; this.viewQ[3] = qw;
	if (this.viewWord) this.viewWord.set(this.viewQ);
};
GpuRenderer.prototype.resetView = function () {
	this.setView(0, 0, 0, 1);
};

// One render pass into `view` with the layer uniform already written.
GpuRenderer.prototype.passInto = function (enc, view) {
	var pass = enc.beginRenderPass({ colorAttachments: [{
		view: view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 }
	}] });
	pass.setPipeline(this.pipeline);
	pass.setBindGroup(0, this.group);
	pass.draw(3);
	pass.end();
};

// Append the layer draw to an encoder the caller owns and submits. It targets the world
// texture, never the canvas: a canvas pass inside a segment encoder would finish after
// the segment's compute, i.e. after the next compositor refresh, and present black (see
// init). The play path appends it as its render tail (one sim submit per rAF still holds
// for the world); the canvas blit is present(), on the page's drained-queue gate.
GpuRenderer.prototype.appendTo = function (enc, layer) {
	var id = GpuRenderer.LAYERS[layer];
	if (id === undefined) id = 0;
	this.layerWord[0] = id;
	var device = GpuSimRef.S.device;
	device.queue.writeBuffer(this.uniform, 0, this.uniformBytes);
	this.passInto(enc, this.worldView);
};

// The standalone world draw: the paused / view-only / rig path. Own encoder, own submit;
// the canvas is not touched (present() shows the result, when the page wants it).
GpuRenderer.prototype.redraw = function (layer) {
	var device = GpuSimRef.S.device;
	var enc = device.createCommandEncoder();
	this.appendTo(enc, layer);
	device.queue.submit([enc.finish()]);
};

// The canvas blit: world -> current texture, one sub-millisecond pass on its own
// encoder. Contract: the caller submits it on a drained queue (queue.onSubmittedWorkDone
// resolved), or the presented frame can still be in flight at the refresh - the black
// frames this split exists to remove. The world is only sampled here, so the blit reads
// the last completed state by construction.
GpuRenderer.prototype.present = function () {
	var device = GpuSimRef.S.device;
	var enc = device.createCommandEncoder();
	var blit = enc.beginRenderPass({ colorAttachments: [{
		view: this.context.getCurrentTexture().createView(),
		loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 }
	}] });
	blit.setPipeline(this.blitPipeline);
	blit.setBindGroup(0, this.blitGroup);
	blit.draw(3);
	blit.end();
	device.queue.submit([enc.finish()]);
};

if (typeof module !== "undefined" && module.exports) module.exports = GpuRenderer;

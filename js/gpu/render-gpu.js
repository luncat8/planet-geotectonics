/* gpu/render-gpu.js - the GPU twin of render.js: same layers, same palettes, computed in a
   fragment shader that samples the lookup raster and reads the sim buffers directly, so a
   frame needs no readback at all. One fullscreen-triangle draw per frame; the layer id rides
   in a four-byte uniform. The CPU mirror stays one event cycle old (download runs there). */
function GpuRenderer(canvas) {
	this.canvas = canvas;
	this.layer = 0;
}

GpuRenderer.LAYERS = { plate: 0, type: 1, z: 2, damage: 3, owner: 4, sediment: 5,
	oVms: 10, oMaf: 11, oArc: 12, oOro: 13, oBas: 14, oPla: 15,
	speed: 20, age: 21, force: 22, dir: 23 };

GpuRenderer.SHADER = `struct U { layer: u32 };
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
	if (layer == 23u) {
		let v = CELLF[c * 8u].xyz;
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
	let c = u32(LOOK[(H - 1u - y) * W + x]);
	var o: Out;
	o.color = vec4(cellColor(c, x, y) / 255.0, 1.0);
	return o;
}
`;

GpuRenderer.prototype.init = function (state) {
	var S = GpuSim.S, device = S.device, g = state.grid;
	this.context = this.canvas.getContext('webgpu');
	this.canvas.width = g.lookupW;
	this.canvas.height = g.lookupH;
	var consts = ['const V = ' + S.l.V + 'u;', 'const W = ' + g.lookupW + 'u;',
		'const H = ' + g.lookupH + 'u;', 'const SPLIT_DAMAGE = ' + JSON.stringify(Params.splitDamage) + ';'];
	var code = GpuRenderer.SHADER.replace('// layout constants appended here (V, W, H, SPLIT_DAMAGE)',
		consts.join('\n'));
	this.format = navigator.gpu.getPreferredCanvasFormat();
	this.context.configure({ device: device, format: this.format, alphaMode: 'opaque' });
	// The lookup raster is static per grid, so it rides its own read-only buffer, uploaded once.
	if (!S.buf.lookup) {
		S.buf.lookup = device.createBuffer({ size: g.lookup.length * 4, usage: 0x80 | 0x4 | 0x8 });
		device.queue.writeBuffer(S.buf.lookup, 0, g.lookup);
	}
	this.uniform = device.createBuffer({ size: 16, usage: 0x40 | 0x8 });
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
	this.layerWord = new Uint32Array(4);
	return this;
};

GpuRenderer.prototype.draw = function (layer) {
	var id = GpuRenderer.LAYERS[layer];
	if (id === undefined) id = 0;
	this.layerWord[0] = id;
	var device = GpuSim.S.device;
	device.queue.writeBuffer(this.uniform, 0, this.layerWord);
	var enc = device.createCommandEncoder();
	var pass = enc.beginRenderPass({ colorAttachments: [{
		view: this.context.getCurrentTexture().createView(),
		loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 }
	}] });
	pass.setPipeline(this.pipeline);
	pass.setBindGroup(0, this.group);
	pass.draw(3);
	pass.end();
	device.queue.submit([enc.finish()]);
};

if (typeof module !== "undefined" && module.exports) module.exports = GpuRenderer;

/* gpu/render-gpu.js — the GPU twin of render.js: same layers, same palettes, computed in a
   fragment shader that samples the lookup and reads the cell/column arenas directly, so a
   frame needs no readback at all. One fullscreen-triangle draw per frame; the layer id rides
   in a four-byte uniform. Plate colours recompute the CPU palette's golden-angle formula.
   Crust fields are millimetre words here (fMm), potentials 1e-6 words (fOre). */
function GpuRenderer(canvas, sim) {
	this.canvas = canvas;
	this.sim = sim;
	this.layer = 0;
}

GpuRenderer.LAYERS = { plate: 0, owner: 1, type: 2, sediment: 3, damage: 4, z: 5,
	oVms: 10, oMaf: 11, oArc: 12, oOro: 13, oBas: 14, oPla: 15 };

GpuRenderer.SHADER = `struct Uniforms { layer: u32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> SA: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> CA: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> XA: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> BA: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> MA: array<atomic<u32>>;
// layout constants appended here (A_*, W, H)
fn ldS(i:u32) -> u32 { return atomicLoad(&SA[i]); }
fn ldC(i:u32) -> u32 { return atomicLoad(&CA[i]); }
fn ldX(i:u32) -> u32 { return atomicLoad(&XA[i]); }
fn ldF(i:u32) -> f32 { return bitcast<f32>(atomicLoad(&SA[i])); }
fn ldFC(i:u32) -> f32 { return bitcast<f32>(atomicLoad(&CA[i])); }
fn ldFX(i:u32) -> f32 { return bitcast<f32>(atomicLoad(&XA[i])); }
fn ldIX(i:u32) -> i32 { return bitcast<i32>(atomicLoad(&XA[i])); }
fn fMm(u:u32) -> f32 { return f32(u) / 1000.0; }
fn fOre(u:u32) -> f32 { return f32(u) / 1000000.0; }

@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {
	var p = array<vec2<f32>, 3>(vec2(-1.0, -3.0), vec2(3.0, 1.0), vec2(-1.0, 1.0));
	return vec4(p[v], 0.0, 1.0);
}

struct Out { @location(0) color: vec4<f32> };

fn palette(p: u32) -> vec3<f32> {
	let a = f32(p) * 2.3999632297;
	return vec3(135.0 + 90.0 * cos(a), 145.0 + 80.0 * cos(a + 2.1), 155.0 + 80.0 * cos(a + 4.2));
}

fn cellColor(c: u32) -> vec3<f32> {
	let owner = ldIX(A_OWNER + c);
	var base = vec3(20.0, 26.0, 39.0);
	if (owner < 0) { return base; }
	let o = u32(owner);
	let layer = u.layer;
	if (layer == 1u) { return vec3(78.0, 197.0, 167.0); }
	if (layer >= 10u) {
		let v = min(1.0, fOre(ldC(A_ORE + o * 6u + (layer - 10u))));
		return vec3(24.0 + 231.0 * v, 30.0 + 190.0 * v * v, 44.0 + 40.0 * v);
	}
	if (layer == 4u) {
		let d = ldFC(A_DAMAGE + o);
		let hot = select(40.0, 90.0, d > SPLIT_DAMAGE);
		return vec3(30.0 + 225.0 * min(1.0, d), 30.0 + hot * min(1.0, d), 46.0);
	}
	if (layer == 2u) {
		var kind = 0u;
		let rn = u32(ldS(A_RINGN + c));
		for (var k = 0u; k < rn; k++) {
			let e = c * 6u + k;
			let t = ldX(A_ETYPE + e);
			let pol = ldIX(A_POL + e);
			if (t == 1u && pol == 2) { kind = 4u; break; }
			if (t == 1u && kind < 3u) { kind = 3u; } else if (t == 2u && kind < 2u) { kind = 2u; } else if (t == 3u && kind < 1u) { kind = 1u; }
		}
		if (kind == 4u) { return vec3(186.0, 92.0, 214.0); }
		if (kind == 3u) { return vec3(214.0, 72.0, 64.0); }
		if (kind == 2u) { return vec3(232.0, 196.0, 74.0); }
		if (kind == 1u) { return vec3(214.0, 214.0, 220.0); }
		return palette(ldC(A_PLATE + o)) * 0.45;
	}
	if (layer == 0u) { return palette(ldC(A_PLATE + o)); }
	if (layer == 3u) {
		let sed = min(1.0, fMm(ldC(A_SED + o)) / 5000.0);
		return vec3(52.0 + 170.0 * sed, 42.0 + 110.0 * sed, 30.0 + 55.0 * sed);
	}
	let z = ldFX(A_Z + c);
	if (z < 0.0) {
		let shallow = max(0.0, 1.0 + z / 6500.0);
		return vec3(15.0 + 23.0 * shallow, 40.0 + 95.0 * shallow, 69.0 + 100.0 * shallow);
	}
	let high = min(1.0, z / 6500.0);
	return vec3(100.0 + 145.0 * high, 156.0 + 79.0 * high, 112.0 + 113.0 * high);
}

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> Out {
	var x = u32(clamp(pos.x, 0.0, f32(W - 1u)));
	var y = u32(clamp(pos.y, 0.0, f32(H - 1u)));
	let c = u32(ldF(A_LOOKUP + (H - 1u - y) * W + x));
	var o: Out;
	o.color = vec4(cellColor(c) / 255.0, 1.0);
	return o;
}
`;

GpuRenderer.prototype.init = function () {
	var canvas = this.canvas, sim = this.sim, L = sim.layout;
	this.context = canvas.getContext('webgpu');
	canvas.width = sim.grid.lookupW;
	canvas.height = sim.grid.lookupH;
	// Layout constants: the lookup raster size plus every A_ offset the shader names.
	var consts = ['const W = ' + sim.grid.lookupW + 'u;', 'const H = ' + sim.grid.lookupH + 'u;'];
	for (var name in L.field) {
		consts.push('const A_' + name.toUpperCase() + ' = ' + L.field[name].offset + 'u;');
	}
	consts.push('const SPLIT_DAMAGE = ' + JSON.stringify(Params.splitDamage) + ';');
	var code = GpuRenderer.SHADER.replace(
		'// layout constants appended here (A_*, W, H)', consts.join('\n'));
	this.format = navigator.gpu.getPreferredCanvasFormat();
	this.context.configure({ device: sim.device, format: this.format, alphaMode: 'opaque' });
	var shaderModule = sim.device.createShaderModule({ code: code });
	this.pipeline = sim.device.createRenderPipeline({
		layout: 'auto',
		vertex: { module: shaderModule, entryPoint: 'vs' },
		fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format: this.format }] },
		primitive: { topology: 'triangle-list' }
	});
	this.uniform = sim.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	this.bind = sim.device.createBindGroup({
		layout: this.pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: this.uniform } }
		].concat(L.arenaBytes.map(function (bytes, i) {
			return { binding: i + 1, resource: { buffer: sim.arenaBuf[i] } };
		}))
	});
	return this;
};

GpuRenderer.prototype.draw = function (layer) {
	var id = GpuRenderer.LAYERS[layer] !== undefined ? GpuRenderer.LAYERS[layer] : 5;
	var u = new Uint32Array(4);
	u[0] = id;
	this.sim.device.queue.writeBuffer(this.uniform, 0, u.buffer);
	var enc = this.sim.device.createCommandEncoder();
	var pass = enc.beginRenderPass({
		colorAttachments: [{
			view: this.context.getCurrentTexture().createView(),
			clearValue: { r: 0, g: 0, b: 0, a: 1 },
			loadOp: 'clear',
			storeOp: 'store'
		}]
	});
	pass.setPipeline(this.pipeline);
	pass.setBindGroup(0, this.bind);
	pass.draw(3);
	pass.end();
	this.sim.device.queue.submit([enc.finish()]);
};

if (typeof module !== 'undefined' && module.exports) module.exports = GpuRenderer;

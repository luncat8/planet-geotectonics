/* gpu-readback.js - the renderer's readback path on the stub device (tests/gpu-stub.js).
   No pixel values survive here - the stub records commands instead of executing them - so
   what this pins is the part a real device would reject or silently get wrong:
     1. the parity check never copies from a presented canvas texture. Chrome/D3D gives a
        swapchain texture the usage it wants, so `configure({ usage: COPY_SRC })` does not
        make `getCurrentTexture()` a legal copy source (owner's rig: 32 validation errors,
        16 empty comparisons). The renderer owns an offscreen RENDER_ATTACHMENT|COPY_SRC
        texture and copies from that.
     2. the order within one submit is draw -> blit, and the copy is its own submit after
        it, so the staging buffer holds the layer that was just drawn.
     3. the canvas keeps the default usage: the app's renderer never reads itself back.
   Run: node tests/gpu-readback.js */
'use strict';
const { assert, Grid, State } = require('./helpers.js');
const GpuSim = require('../js/gpu/sim-gpu.js');
const GpuRenderer = require('../js/gpu/render-gpu.js');
const { makeDevice } = require('./gpu-stub.js');

const RENDER_ATTACHMENT = 0x10, COPY_SRC = 0x4, MAP_READ = 0x1, COPY_DST = 0x8;

// The renderer asks the browser for the canvas format; under node that is the only global
// it needs, and bgra8unorm is what every current adapter returns. node 22 ships a read-only
// `navigator`, so it takes a defineProperty rather than an assignment.
Object.defineProperty(globalThis, 'navigator', {
	value: { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } },
	configurable: true, writable: true
});

function recordingDevice(log) {
	const device = makeDevice();
	device.presented = 0;
	device.createTexture = (d) => {
		log.push({ op: 'createTexture', usage: d.usage, size: d.size.slice(), format: d.format });
		return { usage: d.usage, size: d.size.slice(), createView: () => ({ of: 'offscreen' }) };
	};
	device.createSampler = () => ({ of: 'sampler' });
	// layout: 'auto' means the pipeline is the layout's source, so it must answer
	// getBindGroupLayout like the real one does.
	device.createRenderPipeline = () => ({ of: 'blitPipeline', getBindGroupLayout: () => ({ of: 'blitLayout' }) });
	device.createBindGroup = () => ({ of: 'blitGroup' });
	const realEncoder = device.createCommandEncoder;
	device.createCommandEncoder = () => {
		const enc = realEncoder.call(device);
		enc.beginRenderPass = (d) => {
			const view = d.colorAttachments[0].view;
			log.push({ op: 'renderPass', target: view.of || 'canvas' });
			if ((view.of || 'canvas') === 'canvas') device.presented++;
			return { setPipeline: () => {}, setBindGroup: () => {}, draw: () => {}, end: () => {} };
		};
		enc.copyTextureToBuffer = (src, dst, size) => {
			log.push({ op: 'copyTextureToBuffer', from: src.texture.size ? 'offscreen' : 'canvas',
				bytesPerRow: dst.bytesPerRow, size: size.slice(), usage: src.texture.usage });
		};
		return enc;
	};
	// The canvas texture a real context would hand out, with the usage a real swapchain
	// gives it: RENDER_ATTACHMENT only. If anything copies from this, the assertions below
	// fail the way the owner's rig did.
	const canvasContext = {
		configure: (c) => { log.push({ op: 'configure', usage: c.usage === undefined ? 'default' : c.usage }); },
		getCurrentTexture: () => {
			log.push({ op: 'getCurrentTexture' });
			return { usage: RENDER_ATTACHMENT, createView: () => ({ of: 'canvas' }) };
		}
	};
	return { device, canvasContext };
}

// The renderer takes any object with width/height/getContext('webgpu'); the context is the
// recording stub's, so `configure` and `getCurrentTexture` are both observable.
let canvasStub = null;
function canvasOf() {
	return { width: 0, height: 0, getContext: () => canvasStub };
}

(async () => {
	const state = new State(new Grid(3, 7).build(), 7);
	// init builds the arenas; the device is then swapped per case for a recording one.
	await GpuSim.init(state, { device: makeDevice() });

	// 1. readback mode: offscreen texture, reused staging, draw -> blit -> copy.
	// The recorder closes over this array, so it is emptied in place (log.length = 0) rather
	// than rebound - a new array would leave every later push in the one nobody reads.
	const log = [];
	const rig = recordingDevice(log);
	GpuSim.S.device = rig.device;
	canvasStub = rig.canvasContext;
	const canvas = canvasOf();
	const renderer = new GpuRenderer(canvas).init(state, { readback: true });
	const configure = log.find((e) => e.op === 'configure');
	assert.equal(configure.usage, 'default', 'the canvas keeps the default usage - COPY_SRC there is a lie on a real swapchain');
	const tex = log.find((e) => e.op === 'createTexture');
	assert.ok(tex, 'readback mode creates its own texture');
	assert.equal(tex.usage, RENDER_ATTACHMENT | COPY_SRC, 'that texture is a legal copy source');
	assert.deepEqual(tex.size, [state.grid.lookupW, state.grid.lookupH], 'sized to the lookup raster');
	assert.equal(renderer.readRow % 256, 0, 'bytesPerRow is 256-aligned');
	assert.equal(renderer.readSize, renderer.readRow * state.grid.lookupH, 'the staging buffer covers every row');
	assert.equal(renderer.staging.usage, MAP_READ | COPY_DST, 'the staging buffer is a legal copy destination');
	assert.equal(renderer.staging.size, renderer.readSize, 'and exactly the image size');

	log.length = 0;
	renderer.draw('plate');
	const passes = log.filter((e) => e.op === 'renderPass').map((e) => e.target);
	assert.deepEqual(passes, ['offscreen', 'canvas'], 'the layer is drawn offscreen, then blitted to the canvas');
	assert.equal(log.filter((e) => e.op === 'copyTextureToBuffer').length, 0, 'draw() copies nothing');

	log.length = 0;
	const bytes = await renderer.readPixels();
	const copies = log.filter((e) => e.op === 'copyTextureToBuffer');
	assert.equal(copies.length, 1, 'readPixels is one copy');
	assert.equal(copies[0].from, 'offscreen', 'the copy source is the offscreen texture, never the canvas');
	assert.equal(copies[0].usage & COPY_SRC, COPY_SRC, 'and that texture carries COPY_SRC');
	assert.equal(copies[0].bytesPerRow, renderer.readRow, 'bytesPerRow matches the staging buffer');
	assert.equal(bytes.length, renderer.readSize, 'readPixels hands back the whole image');
	const staging = renderer.staging;
	await renderer.readPixels();
	assert.equal(renderer.staging, staging, 'the staging buffer is reused, not reallocated');
	assert.equal(log.filter((e) => e.op === 'createTexture').length, 0, 'a second read allocates nothing');

	// 2. the app's mode: one pass straight to the canvas, no offscreen texture at all.
	log.length = 0;
	const rig2 = recordingDevice(log);
	GpuSim.S.device = rig2.device;
	canvasStub = rig2.canvasContext;
	const plain = new GpuRenderer(canvasOf()).init(state);
	assert.equal(plain.offscreen, undefined, 'the app renderer has no readback rig');
	assert.equal(plain.staging, undefined, 'and no staging buffer');
	log.length = 0;
	plain.draw('z');
	assert.deepEqual(log.filter((e) => e.op === 'renderPass').map((e) => e.target), ['canvas'],
		'one pass, straight to the canvas');
	assert.equal(rig2.device.presented, 1, 'the canvas texture is acquired exactly once per draw');
	assert.equal(log.filter((e) => e.op === 'copyTextureToBuffer').length, 0, 'nothing is ever copied out of it');

	console.log('PASS gpu-readback: parity reads an offscreen COPY_SRC texture (draw -> blit -> copy), '
		+ 'the canvas keeps the default usage, and the app path is still one pass');
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });

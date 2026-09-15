/* gpu-readback.js - the renderer's texture paths on the stub device (tests/gpu-stub.js).
   No pixel values survive here - the stub records commands instead of executing them - so
   what this pins is the part a real device would reject or present black:
     1. every renderer owns a world texture (RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC),
        the draw target in the app's mode and the copy source in the parity rigs'. The
        canvas keeps the default usage: a swapchain texture is not a legal copy source
        (owner's rig: 32 validation errors, 16 empty comparisons), and the readback
        never touches it.
     2. no encoder may hold both the layer draw and the canvas blit. The spec replaces a
        presented canvas's drawing buffer with a fresh transparent-black one on each
        getCurrentTexture after the presentation, and the compositor shows whatever is in
        it at the next refresh - a canvas pass queued behind a sim segment finishes after
        that refresh and presents black (the black frames every setting heavier than the
        refresh used to flash). The blit is its own encoder, submitted on a drained queue.
     3. the order across submits is world draw -> canvas blit -> (readback) copy, so the
        canvas and the staging buffer both hold the layer that was just drawn.
   Run: node tests/gpu-readback.js */
'use strict';
const { assert, Grid, State } = require('./helpers.js');
const GpuSim = require('../js/gpu/sim-gpu.js');
const GpuRenderer = require('../js/gpu/render-gpu.js');
const { makeDevice } = require('./gpu-stub.js');

// TextureUsage, not BufferUsage: COPY_SRC is 0x1 there. BufferUsage's 0x4 is
// TEXTURE_BINDING, and the one mix-up of the two shipped a readback texture that was a
// legal draw target and blit source but an illegal copy source - hardware only.
const RENDER_ATTACHMENT = 0x10, TEXTURE_BINDING = 0x4, COPY_SRC = 0x1, MAP_READ = 0x1, COPY_DST = 0x8;

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
		const t = { usage: d.usage, size: d.size.slice(), destroyed: false, createView: () => ({ of: 'offscreen' }) };
		t.destroy = () => { t.destroyed = true; };
		return t;
	};
	device.createSampler = () => ({ of: 'sampler' });
	// layout: 'auto' means the pipeline is the layout's source, so it must answer
	// getBindGroupLayout like the real one does.
	device.createRenderPipeline = () => ({ of: 'blitPipeline', getBindGroupLayout: () => ({ of: 'blitLayout' }) });
	device.createBindGroup = () => ({ of: 'blitGroup' });
	// Encoders are numbered so an assertion can tell which passes share an encoder: the
	// black-frame fix is "no encoder holds both the world draw and the canvas blit", and
	// a per-op log without the encoder id cannot express that.
	const realEncoder = device.createCommandEncoder;
	let encSeq = 0;
	device.createCommandEncoder = () => {
		const enc = realEncoder.call(device);
		const id = ++encSeq;
		enc.beginRenderPass = (d) => {
			const view = d.colorAttachments[0].view;
			log.push({ op: 'renderPass', target: view.of || 'canvas', enc: id });
			if ((view.of || 'canvas') === 'canvas') device.presented++;
			return { setPipeline: () => {}, setBindGroup: () => {}, draw: () => {}, end: () => {} };
		};
		enc.copyTextureToBuffer = (src, dst, size) => {
			log.push({ op: 'copyTextureToBuffer', from: src.texture.size ? 'offscreen' : 'canvas',
				enc: id, bytesPerRow: dst.bytesPerRow, size: size.slice(), usage: src.texture.usage });
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
// Every pass a log covers, grouped by encoder id: the assertion 2 shape.
function passesByEnc(log) {
	const byEnc = {};
	for (const e of log) if (e.op === 'renderPass') (byEnc[e.enc] = byEnc[e.enc] || []).push(e.target);
	return byEnc;
}

(async () => {
	const state = new State(new Grid(3, 7).build(), 7);
	// init builds the arenas; the device is then swapped per case for a recording one.
	await GpuSim.init(state, { device: makeDevice() });

	// 1. readback mode: world texture, reused staging, world draw -> (blit) -> copy.
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
	assert.ok(tex, 'the renderer owns its world texture');
	assert.equal(tex.usage, RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
		'the world texture is a legal draw target, blit source and copy source');
	assert.deepEqual(tex.size, [state.grid.lookupW, state.grid.lookupH], 'sized to the lookup raster');
	assert.equal(renderer.readRow % 256, 0, 'bytesPerRow is 256-aligned');
	assert.equal(renderer.readSize, renderer.readRow * state.grid.lookupH, 'the staging buffer covers every row');
	assert.equal(renderer.staging.usage, MAP_READ | COPY_DST, 'the staging buffer is a legal copy destination');
	assert.equal(renderer.staging.size, renderer.readSize, 'and exactly the image size');

	log.length = 0;
	renderer.redraw('plate');
	assert.deepEqual(log.filter((e) => e.op === 'renderPass').map((e) => e.target), ['offscreen'],
		'redraw paints the world texture alone: the canvas never shares an encoder with a layer draw');
	assert.equal(log.filter((e) => e.op === 'copyTextureToBuffer').length, 0, 'redraw copies nothing');

	log.length = 0;
	renderer.present();
	assert.deepEqual(log.filter((e) => e.op === 'renderPass').map((e) => e.target), ['canvas'],
		'present is its own encoder: one canvas blit, the world is only sampled');

	// 2. the app's mode: the same world texture, no staging buffer, and the same split -
	// the canvas blit is never a pass inside a layer draw's encoder.
	log.length = 0;
	const rig2 = recordingDevice(log);
	GpuSim.S.device = rig2.device;
	canvasStub = rig2.canvasContext;
	const plain = new GpuRenderer(canvasOf()).init(state);
	const plainTex = log.find((e) => e.op === 'createTexture');
	assert.ok(plainTex, 'the app renderer keeps the world texture (the canvas blit samples it)');
	assert.equal(plainTex.usage, RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
		'with the full usage, so a readback rig can be added without re-creating it');
	assert.equal(plain.staging, undefined, 'and no staging buffer');
	log.length = 0;
	plain.redraw('z');
	assert.deepEqual(log.filter((e) => e.op === 'renderPass').map((e) => e.target), ['offscreen'],
		'one world pass, the canvas is not touched');
	assert.equal(rig2.device.presented, 0, 'no canvas acquisition by a world draw');
	log.length = 0;
	plain.present();
	assert.deepEqual(log.filter((e) => e.op === 'renderPass').map((e) => e.target), ['canvas'],
		'the blit acquires the canvas, on its own encoder');
	assert.equal(rig2.device.presented, 1, 'one present, one acquisition');

	// 3. back to the readback rig: a full frame (world draw, blit, copy) keeps the order
	// draw -> blit -> copy, and no encoder mixes the two pass kinds.
	log.length = 0;
	renderer.redraw('z');
	renderer.present();
	const bytes = await renderer.readPixels();
	const copies = log.filter((e) => e.op === 'copyTextureToBuffer');
	assert.equal(copies.length, 1, 'readPixels is one copy');
	assert.equal(copies[0].from, 'offscreen', 'the copy source is the world texture, never the canvas');
	assert.equal(copies[0].usage & COPY_SRC, COPY_SRC, 'and that texture carries COPY_SRC');
	assert.equal(copies[0].bytesPerRow, renderer.readRow, 'bytesPerRow matches the staging buffer');
	assert.equal(bytes.length, renderer.readSize, 'readPixels hands back the whole image');
	for (const id in passesByEnc(log)) {
		const targets = passesByEnc(log)[id];
		assert.ok(targets.every((t) => t === targets[0]),
			'encoder ' + id + ' holds one pass kind only (' + targets.join(',') + ')');
	}
	const staging = renderer.staging;
	await renderer.readPixels();
	assert.equal(renderer.staging, staging, 'the staging buffer is reused, not reallocated');
	assert.equal(log.filter((e) => e.op === 'createTexture').length, 0, 'a second read allocates nothing');

	// 4. release: a level switch re-inits the sim arenas through GpuSim.release; the
	// renderer's own allocations go through its release, not a GC.
	renderer.release();
	assert.equal(renderer.world, null, 'release destroys the world texture');
	assert.equal(plain.world.destroyed, false, 'and leaves the other renderer alone');

	console.log('PASS gpu-readback: the world texture carries every draw and every copy, '
		+ 'no encoder mixes a layer draw with the canvas blit (the black-frame fix), '
		+ 'the canvas keeps the default usage, and release frees the renderer\u2019s allocations');
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });

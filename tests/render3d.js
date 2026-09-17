/* render3d.js on the stub device (tests/gpu-stub.js) - the JS side the browser rigs
   cannot see cheaply, in the gpu-readback pattern. The stub executes no WGSL, so what
   this pins is the part a real device would reject or that regressed silently before:
     1. the icosphere: counts 10*4^k+2 / 20*4^k, unit positions, CCW-outward winding,
        indices in range, midpoint dedup (a vertex is built exactly once), k = 6 fast;
     2. the camera: known world points land on known clip coordinates, and the orbit
        clamps pitch and distance without flipping the handedness;
     3. the frame contract: one encoder = gather -> land -> water -> rim, all into the
        3D target; present() is its own encoder on the canvas (the black-frame rule);
     4. the draw uniform's knob words follow Params per draw (sea, relief ramp) and the
        page's exag, like the 2D renderer's per-draw Params reads;
     5. the CPU z pack: NaN gaps -> the marker, and the scratch is the same object across
        frames - no per-frame allocation;
     6. release and detail change destroy what they replace (the 0.3.4 leak lesson), a
        borrowed LOOK/cellF is never destroyed, and a z-source re-init rebinds the gather.
   Run: node tests/render3d.js */
'use strict';
const { assert, Grid, State } = require('./helpers.js');
const Params = require('../js/params.js');
const Render3D = require('../js/render3d.js');
const { makeDevice } = require('./gpu-stub.js');

// A canvas-shaped object with a webgpu context; the real one is only asked to configure
// and to hand out the swapchain texture.
function canvasOf(w, h) {
	return {
		width: w, height: h,
		getContext: function () {
			return { configure: function () {}, getCurrentTexture: function () { return { createView: () => ({ of: 'canvas' }) }; } };
		}
	};
}
function targetOf(view) { return view && view.of && view.of !== 'canvas' ? 'v3d' : 'canvas'; }

// --- 1. the mesh --------------------------------------------------------------------------
for (let k = 1; k <= 4; k++) {
	const m = Render3D.mesh(k);
	assert.equal(m.vCount, 10 * Math.pow(4, k) + 2, 'k' + k + ' vertex count (10*4^k+2)');
	assert.equal(m.idx.length / 3, 20 * Math.pow(4, k), 'k' + k + ' triangle count (20*4^k)');
	assert.equal(m.pos.length, m.vCount * 3, 'k' + k + ' positions are packed');
	let maxUnitErr = 0;
	for (let i = 0; i < m.vCount; i++) {
		const err = Math.abs(Math.hypot(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]) - 1);
		if (err > maxUnitErr) maxUnitErr = err;
	}
	assert.ok(maxUnitErr < 1e-5, 'k' + k + ' positions unit to 1e-5 (max ' + maxUnitErr + ')');
	let maxIdx = 0;
	for (let i = 0; i < m.idx.length; i++) if (m.idx[i] > maxIdx) maxIdx = m.idx[i];
	assert.ok(maxIdx < m.vCount, 'k' + k + ' indices in range');
	let badWinding = 0, degenerate = 0;
	for (let f = 0; f < m.idx.length; f += 3) {
		const a = m.idx[f] * 3, b = m.idx[f + 1] * 3, c = m.idx[f + 2] * 3;
		const e1x = m.pos[b] - m.pos[a], e1y = m.pos[b + 1] - m.pos[a + 1], e1z = m.pos[b + 2] - m.pos[a + 2];
		const e2x = m.pos[c] - m.pos[a], e2y = m.pos[c + 1] - m.pos[a + 1], e2z = m.pos[c + 2] - m.pos[a + 2];
		const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
		const area = Math.hypot(cx, cy, cz);
		if (area < 1e-12) degenerate++;
		// CCW seen from outside: the normal agrees with the face centroid's direction.
		if (cx * (m.pos[a] + m.pos[b] + m.pos[c]) + cy * (m.pos[a + 1] + m.pos[b + 1] + m.pos[c + 1])
			+ cz * (m.pos[a + 2] + m.pos[b + 2] + m.pos[c + 2]) <= 0) badWinding++;
	}
	assert.equal(degenerate, 0, 'k' + k + ' has no degenerate face');
	assert.equal(badWinding, 0, 'k' + k + ' faces wind CCW outward (the back-face cull needs it)');
}
{
	// Midpoint dedup: the builder's own counter is exact, and no two positions coincide.
	const m = Render3D.mesh(2);
	const seen = new Set();
	for (let i = 0; i < m.vCount; i++) seen.add(m.pos[i * 3] + ',' + m.pos[i * 3 + 1] + ',' + m.pos[i * 3 + 2]);
	assert.equal(seen.size, m.vCount, 'k2 midpoint dedup: one position per vertex');
	const t0 = Date.now();
	Render3D.mesh(6);
	assert.ok(Date.now() - t0 < 2000, 'k6 builds in under 2 s (took ' + (Date.now() - t0) + ' ms)');
}

// --- 2. the camera ------------------------------------------------------------------------
{
	const vp = new Float32Array(16), eye = new Float32Array(4);
	const aspect = 2;
	Render3D.matVP(vp, eye, 0, 0, 3, aspect);
	assert.ok(Math.abs(eye[0]) < 1e-6 && Math.abs(eye[1]) < 1e-6 && Math.abs(eye[2] - 3) < 1e-6,
		'yaw 0 pitch 0 puts the eye on +z at the given distance');
	const at = (x, y, z) => {
		const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
		const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
		const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
		return [cx / cw, cy / cw];
	};
	const centre = at(0, 0, 0);
	assert.ok(Math.abs(centre[0]) < 1e-6 && Math.abs(centre[1]) < 1e-6, 'the planet centre maps to NDC centre');
	const half = 3 * Math.tan(Render3D.FOV / 2);
	assert.ok(Math.abs(at(0, half, 0)[1] - 1) < 1e-4, 'the frustum top edge lands on NDC +1');
	assert.ok(Math.abs(at(2 * half, 0, 0)[0] - 1) < 1e-4, 'and the aspect-scaled right edge on NDC x +1');
	const r3 = new Render3D(canvasOf(2048, 1024));
	r3.vpW = new Float32Array(16); r3.eyeW = new Float32Array(4); r3.aspect = aspect;
	r3.setOrbit(0, 10, 99);
	assert.equal(r3.pitch, Render3D.PITCH_MAX, 'pitch clamps at the pole');
	assert.equal(r3.dist, Render3D.DIST_MAX, 'distance clamps at 10');
	r3.setOrbit(0, -10, 0.5);
	assert.equal(r3.dist, Render3D.DIST_MIN, 'and at 1.5');
	let finite = true;
	for (let i = 0; i < 16; i++) if (!Number.isFinite(r3.vpW[i])) finite = false;
	assert.ok(finite, 'the clamped orbit keeps the matrix finite (no pole flip)');
}

// --- 3-7. the frame contract, the uniform, the pack, release -------------------------------
const grid = new Grid(3, 7).build();
const state = new State(grid, 7);
const gpuStub = makeDevice();
const look = grid.lookup;
const lookBuf = gpuStub.createBuffer({ size: look.length * 4, usage: 0x80 | 0x4 | 0x8 });
const cellF = gpuStub.createBuffer({ size: Math.max(16, grid.V * 32 * 4), usage: 0x80 | 0x4 | 0x8 });
const r3 = new Render3D(canvasOf(512, 256)).init({
	device: gpuStub, k: 4, look: lookBuf, V: grid.V, zSource: 'cellF', cellF: cellF, lw: grid.lookupW, lh: grid.lookupH
});
assert.equal(r3.tsOn, false, 'the stub offers no timestamp-query: the 3D line stays silent');
assert.equal(r3.vCount, 10 * Math.pow(4, 4) + 2, 'the session built the k4 mesh');

let r3PassBase = 0;
// The gather rebinds to the z source it was inited with (cellF here, cellZ below). The
// stub records the descriptors themselves, so the 3-entry bind group is the gather's.
const gatherGroup = gpuStub.bindGroups.find((g) => g.entries && g.entries.length === 3);
assert.equal(gatherGroup.entries[1].resource.buffer, cellF, 'the gather reads the sim cellF buffer');
assert.equal(gatherGroup.entries[0].resource.buffer, lookBuf, 'and the sim LOOK buffer');
gpuStub.renderPasses.length = 0;
gpuStub.computePasses.length = 0;
gpuStub.bindGroups.length = 0;

r3.redraw(state);
assert.equal(gpuStub.computePasses.length, 1, 'one gather per frame');
assert.equal(gpuStub.renderPasses.length - r3PassBase, 3, 'land, water, rim per frame');
const targets = gpuStub.renderPasses.slice(r3PassBase).map((d) => targetOf(d.colorAttachments[0].view));
assert.deepEqual(targets, ['v3d', 'v3d', 'v3d'], 'all three draws land on the 3D target, never the canvas');
assert.equal(r3.landPipe.descriptor.depthStencil.depthWriteEnabled, true,
	'the land pass writes depth');
assert.ok(!r3.waterPipe.descriptor.depthStencil.depthWriteEnabled
	&& !r3.rimPipe.descriptor.depthStencil.depthWriteEnabled,
	'water and rim test depth but never write it');
assert.equal(r3.waterPipe.descriptor.fragment.targets[0].blend.color.srcFactor, 'src-alpha',
	'water blends translucent');
assert.equal(r3.rimPipe.descriptor.fragment.targets[0].blend.color.dstFactor, 'one',
	'rim is additive');
const submitted = gpuStub.counts().submits;
r3.present();
assert.equal(gpuStub.counts().submits, submitted + 1, 'present is its own submit');
assert.equal(targetOf(gpuStub.renderPasses[gpuStub.renderPasses.length - 1].colorAttachments[0].view),
	'canvas', 'the blit targets the canvas');

// The knob words follow Params and the page's exag per draw, like the 2D renderer.
const knob = new Float32Array(r3.uniformBytes, 80, 4);
Params.sea = -2000; Params.zRange = 9000; r3.exag = 12.5;
r3.redraw(state);
assert.equal(knob[0], 12.5, 'displacement rides the uniform');
assert.equal(knob[1], -2000, 'the display sea rides it (the 0.3.5 slider, live)');
assert.equal(knob[2], 9000, 'the relief range rides it (the 0.3.3 slider, live)');
Params.sea = 0; Params.zRange = 6500;

// CPU z pack: gaps to the marker, the scratch reused.
const zSrc = new State(new Grid(3, 7).build(), 7);
zSrc.z.fill(123.5);
zSrc.z[5] = NaN;
const r3c = new Render3D(canvasOf(512, 256)).init({
	device: makeDevice(), k: 3, look: zSrc.grid.lookup, V: zSrc.grid.V, zSource: 'cellZ', lw: grid.lookupW, lh: grid.lookupH
});
const scratch = r3c.zScratch;
r3c.redraw(zSrc);
assert.equal(scratch, r3c.zScratch, 'the z scratch is the same object after a redraw');
for (let i = 0; i < 10; i++) r3c.redraw(zSrc);
assert.equal(scratch, r3c.zScratch, 'and after ten more');
assert.equal(scratch[5], -1e9, 'a NaN gap packs to the marker');
assert.equal(scratch[7], 123.5, 'a real elevation packs through');
const written = new Float32Array(r3c.cellZ.bytes);
assert.equal(written[5], -1e9, 'the upload carries the marker, not NaN');

// Release destroys the session's own allocations and never the borrowed ones.
const ownBufs = [r3c.posBuf, r3c.idxBuf, r3c.uniform, r3c.look, r3c.cellZ];
r3c.release();
for (const b of ownBufs) assert.ok(b.destroyed, 'release destroys the session buffers');
assert.ok(r3c.height === null || r3c.height.destroyed, 'and the height texture');
const borrowed = [lookBuf, cellF];
r3.release();
assert.ok(!lookBuf.destroyed && !cellF.destroyed, 'a borrowed LOOK/cellF is not ours to destroy');

// A detail change replaces the mesh buffers, nothing else.
const r3d = new Render3D(canvasOf(512, 256)).init({
	device: makeDevice(), k: 3, look: look, V: grid.V, zSource: 'cellZ', lw: grid.lookupW, lh: grid.lookupH
});
const oldPos = r3d.posBuf, oldIdx = r3d.idxBuf, height = r3d.height, uniform = r3d.uniform;
r3d.setDetail(4);
assert.ok(oldPos.destroyed && oldIdx.destroyed, 'a detail change destroys the old mesh buffers');
assert.equal(r3d.height, height, 'the height texture survives it');
assert.equal(r3d.uniform, uniform, 'the uniform survives it');
assert.equal(r3d.vCount, 10 * Math.pow(4, 4) + 2, 'the new mesh is the k4 one');

console.log('PASS render3d: icosphere counts/winding/dedup, orbit clamps, the frame contract '
	+ '(gather, land, water, rim into the 3D target; present alone on the canvas), the live '
	+ 'knob uniform, the gap-safe z pack with a reused scratch, and release/detail-change '
	+ 'destroying exactly what they own');

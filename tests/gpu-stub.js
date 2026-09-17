/* gpu-stub.js - the smallest in-process WebGPU device that lets GpuSim run headless:
   real backing stores behind every buffer, so writeBuffer / copyBufferToBuffer / mapAsync
   carry bytes and the mirror round trip is faithful. No WGSL is compiled or executed and
   no dispatch runs, so this covers the JS side of the engine only - the mirror pack and
   unpack, and the scheduling of the play path. The kernel graph stays the browser rigs'
   job (tests/gpu-parity.js, webgpu-smoke.html). */
'use strict';

function FakeBuffer(size, usage) {
	this.size = size;
	this.usage = usage;
	this.bytes = new ArrayBuffer(size);
	this.mapped = false;
	this.destroyed = false;
}
// The map state is enforced, not just tracked: reading a buffer that was not mapped for
// *this* transfer is the OperationError the real device raises, and a stub that lets it
// through cannot catch a partial mirror download reusing a stale staging buffer.
FakeBuffer.prototype.mapAsync = function () {
	if (this.mapped) return Promise.reject(new Error('stub: mapAsync on a mapped buffer'));
	this.mapped = true;
	return Promise.resolve();
};
FakeBuffer.prototype.getMappedRange = function () {
	if (!this.mapped) throw new Error('stub: getMappedRange failed (buffer is not mapped)');
	return this.bytes;
};
FakeBuffer.prototype.unmap = function () { this.mapped = false; };
FakeBuffer.prototype.destroy = function () { this.destroyed = true; };

function makeDevice() {
	var writes = 0, submits = 0;
	var queue = {
		writeBuffer: function (buf, offset, data, dataOff, size) {
			if (buf.mapped) throw new Error('stub: writeBuffer to a mapped buffer');
			writes++;
			// Spec: TypedArray dataOffset is in elements, size is in bytes. A range
			// past the view throws the same OperationError the real queue does.
			var srcOff = (dataOff || 0) * (data.BYTES_PER_ELEMENT || 1);
			var srcBytes = size !== undefined ? size : data.byteLength - srcOff;
			if (srcOff + srcBytes > data.byteLength) {
				throw new Error('Number of bytes to write is too large');
			}
			new Uint8Array(buf.bytes).set(new Uint8Array(data.buffer, data.byteOffset + srcOff, srcBytes), offset);
		},
		submit: function () { submits++; },
		onSubmittedWorkDone: function () { return Promise.resolve(); }
	};
	// Every dynamic offset passed to setBindGroup, in call order: the Phase V
	// batch pins one per frameIn-binding kernel per batched frame.
	var dynamicOffsets = [];
	var bindGroups = [];
	var bindGroupLayouts = [];
	// The render side (0.5.0's render3d, the blit rigs): descriptors recorded in call
	// order, no execution. computePasses/renderPasses carry their descriptors so a test
	// can pin what ran in which encoder against what.
	var computePasses = [];
	var renderPasses = [];
	var device = {
		counts: function () { return { writes: writes, submits: submits }; },
		dynamicOffsets: dynamicOffsets,
		bindGroups: bindGroups,
		bindGroupLayouts: bindGroupLayouts,
		computePasses: computePasses,
		renderPasses: renderPasses,
		limits: { maxStorageBuffersPerShaderStage: 16, minStorageBufferOffsetAlignment: 32 },
		features: new Set(),
		lost: new Promise(function () {}),
		queue: queue,
		createBuffer: function (d) { return new FakeBuffer(d.size, d.usage); },
		createTexture: function (d) {
			var t = { size: d.size.slice(), format: d.format, usage: d.usage, destroyed: false,
				createView: function () { return { of: t }; } };
			t.destroy = function () { t.destroyed = true; };
			return t;
		},
		createSampler: function () { return { of: 'sampler' }; },
		createQuerySet: function () { throw new Error('stub: no timestamp-query'); },
		createShaderModule: function () { return { getCompilationInfo: function () { return Promise.resolve({ messages: [] }); } }; },
		createBindGroupLayout: function (d) { bindGroupLayouts.push(d); return d || {}; },
		createBindGroup: function (d) { bindGroups.push(d); return d || {}; },
		createPipelineLayout: function () { return {}; },
		createComputePipeline: function () { return {}; },
		// layout: 'auto' means the pipeline is the layout's source, so it must answer
		// getBindGroupLayout like the real one does.
		createRenderPipeline: function (d) { return { descriptor: d, getBindGroupLayout: function () { return {}; } }; },
		createCommandEncoder: function () {
			// Strict where Dawn is strict: a buffer copied onto itself is rejected and
			// the WHOLE encoder is invalidated (the submit then runs nothing and
			// onSubmittedWorkDone returns in a fraction of a millisecond - which is how
			// the Phase V tail self-copy looked from the bench). A lenient stub performs
			// the in-place memcpy and stays green, so the rule lives here, not in a test
			// that routes around it.
			var invalid = null;
			return {
				copyBufferToBuffer: function (src, srcOff, dst, dstOff, size) {
					if (src === dst) {
						invalid = 'source and destination are the same buffer';
						return;
					}
					new Uint8Array(dst.bytes).set(new Uint8Array(src.bytes, srcOff, size), dstOff);
				},
				resolveQuerySet: function () {},
				copyTextureToBuffer: function (src, dst, size) {
					// Recorded so the readback rigs can pin what was copied from where.
					this.copies = (this.copies || 0) + 1;
				},
				// Dispatches are accepted and dropped: the stub runs the scheduling, not WGSL.
				beginComputePass: function (d) {
					computePasses.push(d || {});
					return { setPipeline: function () {},
						setBindGroup: function (slot, group, offsets) {
							if (offsets && offsets.length) Array.prototype.push.apply(dynamicOffsets, offsets);
						},
						dispatchWorkgroups: function () {}, end: function () {} };
				},
				beginRenderPass: function (d) {
					renderPasses.push(d || {});
					return { setPipeline: function () {}, setBindGroup: function () {},
						setIndexBuffer: function () {}, setVertexBuffer: function () {},
						draw: function () {}, drawIndexed: function () {}, end: function () {} };
				},
				finish: function () {
					if (invalid) throw new Error('stub: encoder invalid (' + invalid +
						') - Dawn invalidates the whole command buffer and the submit runs nothing');
					return {};
				}
			};
		}
	};
	return device;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeDevice: makeDevice };

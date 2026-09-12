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
		writeBuffer: function (buf, offset, data) {
			if (buf.mapped) throw new Error('stub: writeBuffer to a mapped buffer');
			writes++;
			new Uint8Array(buf.bytes).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
		},
		submit: function () { submits++; },
		onSubmittedWorkDone: function () { return Promise.resolve(); }
	};
	return {
		counts: function () { return { writes: writes, submits: submits }; },
		limits: { maxStorageBuffersPerShaderStage: 16 },
		features: new Set(),
		lost: new Promise(function () {}),
		queue: queue,
		createBuffer: function (d) { return new FakeBuffer(d.size, d.usage); },
		createQuerySet: function () { throw new Error('stub: no timestamp-query'); },
		createShaderModule: function () { return { getCompilationInfo: function () { return Promise.resolve({ messages: [] }); } }; },
		createBindGroupLayout: function () { return {}; },
		createBindGroup: function () { return {}; },
		createPipelineLayout: function () { return {}; },
		createComputePipeline: function () { return {}; },
		createCommandEncoder: function () {
			return {
				copyBufferToBuffer: function (src, srcOff, dst, dstOff, size) {
					new Uint8Array(dst.bytes).set(new Uint8Array(src.bytes, srcOff, size), dstOff);
				},
				// Dispatches are accepted and dropped: the stub runs the scheduling, not WGSL.
				beginComputePass: function () {
					return { setPipeline: function () {}, setBindGroup: function () {},
						dispatchWorkgroups: function () {}, end: function () {} };
				},
				finish: function () { return {}; }
			};
		}
	};
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeDevice: makeDevice };

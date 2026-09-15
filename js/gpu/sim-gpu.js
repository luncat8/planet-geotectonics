/* sim-gpu.js - WebGPU execution of the same kernel graph as the CPU Sim (design §2).
   One buffer per array family, one module per kernel with only the groups it touches,
   and one fixed dispatch order that mirrors Sim.step. The CPU state stays the owner of
   everything sequential (events, mantle bookkeeping, checkpoints); the GPU owns the
   per-column and per-cell kernels. uploadState pushes the mirror in, downloadState
   pulls the results back out, so a checkpoint taken from the mirror is a checkpoint of
   the GPU run. */
var GpuCommon = typeof module !== 'undefined' && module.exports ? require('./wgsl-common.js') : CommonWGSL;
var GpuParams = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;
var GpuMantle = typeof module !== 'undefined' && module.exports ? require('../mantle.js') : Mantle;
var GpuGrid = typeof module !== 'undefined' && module.exports ? require('../geodesics.js') : Grid;
var GpuKernels = typeof module !== 'undefined' && module.exports ? {
	columns: require('./wgsl-columns.js'),
	mantle: require('./wgsl-mantle.js'),
	plates: require('./wgsl-plates.js'),
	edges: require('./wgsl-edges.js'),
	contact: require('./wgsl-contact.js'),
	column: require('./wgsl-column.js'),
	surface: require('./wgsl-surface.js'),
	diag: require('./wgsl-diag.js')
} : null;

var GpuPerf = typeof module !== 'undefined' && module.exports
	? require('../perf.js') : (typeof Perf !== 'undefined' ? Perf : null);

var GpuSim = {
	// Workgroup sizes are fixed per kernel family; SwiftShader caps at 256 invocations.
	WG: 128,
	ELEMS: 1024,
	// The spec's required maxComputeWorkgroupsPerDimension. dispatchWorkgroups past
	// this is a validation error that invalidates the whole command buffer - the GPU
	// runs nothing and nothing on the JS side ever notices (the L7 loserRank bug).
	// Kernels that would need more workgroups loop grid-stride instead (loserRank).
	WGDIM: 65535,
	// Phase V batches up to this many frames in one command buffer. frameIn becomes
	// FIN_MAX per-frame blocks; each block is padded to the device's dynamic-storage
	// offset alignment (a bind group is bound with i * blockBytes).
	FIN_MAX: 20,
	FIN_FIELDS: 74,
	// The adapter init() got, kept for the one-line capture header (Env.gpu). Null until a
	// device has been built, and kept across inits that reuse one.
	adapter: null,
	// Phase I1: timestamp queries. Two per dispatch (pass start/end), up to TS_MAX
	// dispatches per frame. Adapters without the timestamp-query feature (some
	// SwiftShader builds) fall back: no queries, no per-kernel GPU ms.
	TS_MAX: 70,
	// The DIAG buffer's slot table, the JS twin of the D_* constants in wgsl-common.js.
	// tests/wgsl-struct.js pins every entry against the generated WGSL, so the two cannot
	// drift; layout.diagOut is the size of this table.
	DIAG: { MEANV: 0, MASSFEL: 1, MASSMAF: 2, MASSSED: 3, ORE0: 4, GAPS: 10, COLS: 11,
		QUATERR: 12, RIGID2: 13, DT: 14, ALPHA: 15, RELAXERR: 16 },

	layout: function (state, alignBytes) {
		var g = state.grid, p = GpuParams;
		var V = g.V, colCap = state.colCap, plateCap = state.plateCap;
		// Dynamic storage offsets have a device-dependent alignment (spec default
		// 32 B, some Metal backends ask for 256); round the block up once.
		var blockBytes = GpuSim.FIN_FIELDS * 4;
		var strideBytes = Math.ceil(blockBytes / (alignBytes || 32)) * (alignBytes || 32);
		var finStride = strideBytes / 4;
		var l = {
			V: V, colCap: colCap, plateCap: plateCap,
			A0ref: 4 * Math.PI * p.radius * p.radius / V,
			foLedger0: 14, foPlate0: 28,
			finStride: finStride,
			nwg10: 64, nwgD: 0, chunkD: 0
		};
		l.chunk10 = Math.ceil(V / l.nwg10);
		l.chunk10e = Math.ceil(V * 6 / l.nwg10);
		l.chunkD = 2048;
		l.nwgD = Math.ceil(colCap / l.chunkD);
		l.chunkL = 2048;
		l.nwgL = Math.ceil(colCap / l.chunkL);
		// winnerA's column chunk: nwg10 workgroups cover colCap so a run's alive columns
		// (which can exceed V after a spawn wave) always land in some chunk.
		l.chunkW = Math.ceil(colCap / l.nwg10);
		l.nBlocksMax = Math.ceil(colCap / GpuSim.ELEMS);
		l.gridF = 83 * V;
		l.gridI = 7 * V;
		l.colF = colCap * 24;
		l.colI = colCap * 4;
		l.plateF = plateCap * 32;
		l.plateI = plateCap * 4;
		l.cellF = V * 32;
		l.cellI = V * 13;
		l.edges = V * 24;
		l.bins = V + colCap;
		l.lose = colCap * 3;
		l.reduceF = l.nwg10 * plateCap * 12 + l.nwg10 * plateCap + l.nwgD * 12 + l.nwgD * 4
			+ 7 * colCap + 7 * l.nwgL + l.nwg10 * plateCap * 2 + plateCap;
		l.scan = 2 * colCap + 1 + l.nBlocksMax;
		l.frameIn = finStride * GpuSim.FIN_MAX;
		l.frameOut = l.foPlate0 + plateCap * 5;
		// 0..13 world diagnostics, 14..16 the K10 relaxation witnesses (defect D1).
		l.diagOut = 1 + Object.keys(GpuSim.DIAG).reduce(function (m, k) {
			return Math.max(m, GpuSim.DIAG[k]);
		}, 0);
		return l;
	},

	// zeroFrame's thread count, in the order the kernel walks it: the frame counters, three
	// atomic slots per plate, the scan input, one relaxation witness per plate and the seven
	// per-column ledger deltas. Every dispatch site uses this, so the kernel's branch layout
	// and the shape it is dispatched with cannot drift apart.
	zeroThreads: function (l) {
		return 6 + l.plateCap * 4 + l.colCap * 8;
	},

	// Static grid pack: positions, face normals, flux normals, edge lengths, collapse
	// weights, gradient inverses and the precomputed per-cell contact limits. The limits
	// are unit-sphere squared chords (Grid.chord), exactly like the CPU state pack.
	packGrid: function (state, l) {
		var g = state.grid, p = GpuParams, R = p.radius, V = g.V;
		var f = new Float32Array(l.gridF), i = new Int32Array(l.gridI);
		var P4 = V * 4, P22 = V * 22, P40 = V * 40, P58 = V * 58, P64 = V * 64, P70 = V * 70, P79 = V * 79;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3;
			f[c * 4] = g.pos[b]; f[c * 4 + 1] = g.pos[b + 1]; f[c * 4 + 2] = g.pos[b + 2];
			f[c * 4 + 3] = g.A0[c];
			for (var k = 0; k < 6; k++) {
				var e = c * 6 + k;
				f[P4 + e * 3] = g.faceN[e * 3]; f[P4 + e * 3 + 1] = g.faceN[e * 3 + 1]; f[P4 + e * 3 + 2] = g.faceN[e * 3 + 2];
				f[P22 + e * 3] = g.faceT[e * 3]; f[P22 + e * 3 + 1] = g.faceT[e * 3 + 1]; f[P22 + e * 3 + 2] = g.faceT[e * 3 + 2];
				f[P40 + e * 3] = g.fluxN[e * 3]; f[P40 + e * 3 + 1] = g.fluxN[e * 3 + 1]; f[P40 + e * 3 + 2] = g.fluxN[e * 3 + 2];
				f[P58 + e] = g.edgeLen[e];
				f[P64 + e] = g.collapseWeight[e];
				i[c * 6 + k] = g.ring[c * 6 + k];
			}
			for (var q = 0; q < 9; q++) f[P70 + c * 9 + q] = g.gradInv[c * 9 + q];
			var gapChord = GpuGrid.chord(p.rGap * g.nbrDist[c]);
			var contactChord = GpuGrid.chord(p.rContact * g.nbrDist[c]);
			f[P79 + c * 4] = g.nbrDist[c];
			f[P79 + c * 4 + 1] = gapChord * gapChord;
			f[P79 + c * 4 + 2] = contactChord * contactChord;
			f[P79 + c * 4 + 3] = p.rSpawn * g.nbrDist[c] * 256;
			i[6 * V + c] = g.ringN[c];
		}
		return { f: f, i: i };
	},

	// Drop a session's device resources. Re-init is a normal GUI action now - the level
	// select, Reset world, the bench's one planet per level - and at L7 a single set of
	// arenas is ~120 MB, so waiting on a GC that is free to hold them lets a few level
	// switches pile up. Destroying is legal while submitted commands are still in flight
	// (the device keeps the allocation until it is done with it); what it is not legal
	// against is a *mapped* buffer, which is why js/ui.js waits for the in-flight transfer
	// to settle before it rebuilds a world.
	release: function (S) {
		S = S || GpuSim.S;
		if (!S) return;
		if (GpuSim.S === S) GpuSim.S = null;
		var name, i;
		for (name in S.buf) S.buf[name].destroy();
		if (S.stage) for (name in S.stage) S.stage[name].destroy();
		for (name in S.K) if (S.K[name].pipe.destroy) S.K[name].pipe.destroy();
		for (i = 0; S.tsResolve && i < S.tsResolve.length; i++) S.tsResolve[i].destroy();
		for (i = 0; S.tsMap && i < S.tsMap.length; i++) S.tsMap[i].destroy();
		if (S.ts && S.ts.destroy) S.ts.destroy();
	},

	init: async function (state, opts) {
		var t0 = Date.now();
		opts = opts || {};
		// The world being replaced, if any: its arenas go before the new ones are created.
		GpuSim.release();
		var device = opts.device;
		if (!device) {
			// The parity rig wants SwiftShader (opts.fallback); the app wants real hardware
			// first and only falls back to a software adapter when none is present.
			var adapter = await navigator.gpu.requestAdapter(
				opts.fallback === false ? {} : { forceFallbackAdapter: true });
			if (!adapter && opts.fallback === false) {
				adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
			}
			if (!adapter) throw new Error('no WebGPU adapter');
			// Kept on the engine so a capture header can name the device by type without the
			// page asking for a second adapter (Env.gpu).
			GpuSim.adapter = adapter;
			// The fattest kernels (spawn, columnStep) bind 9 storage buffers; the default
			// stage limit is 8, so ask for the adapter's own ceiling when it is higher.
			var req = {};
		if (adapter.limits.maxStorageBuffersPerShaderStage > 8) {
			req.requiredLimits = { maxStorageBuffersPerShaderStage:
				Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 16) };
		}
		// Per-kernel GPU timing (0.3-plan Phase I1) needs the timestamp-query
		// feature; ask for it when the adapter offers it, stay silent when not.
		if (adapter.features && adapter.features.has('timestamp-query')) {
			req.requiredFeatures = ['timestamp-query'];
		}
		device = await adapter.requestDevice(req);
		}
		var l = GpuSim.layout(state, device.limits && device.limits.minStorageBufferOffsetAlignment);
		var S = { state: state, device: device, l: l, K: {}, warnings: [] };
		GpuSim.device = device;
		GpuSim.S = S;
		// Timestamp ring (Phase I1): four resolve+map buffer pairs, so a collect reads
		// the frame two submits back while the next two slots are still free - the map
		// of a completed buffer returns in ms, well before the slot is reused.
		// Usage bits are the WebGPU spec GPUBufferUsage values throughout this file:
		// 0x1 MAP_READ, 0x2 MAP_WRITE, 0x4 COPY_SRC, 0x8 COPY_DST, 0x10 INDEX, 0x20 VERTEX,
		// 0x40 UNIFORM, 0x80 STORAGE, 0x100 INDIRECT, 0x200 QUERY_RESOLVE. Bits above
		// 0x200 are reserved: in Dawn 0x400 is the texel-buffer usage and fails
		// CreateBuffer with "WGSLLanguageFeatureName::TexelBuffers is not enabled".
		S.tsOn = false; S.ts = null; S.tsResolve = null; S.tsMap = null;
		S.tsPassDesc = null; S.tsWrites = null;
		S.tsSlotNames = new Int32Array(GpuSim.TS_MAX * 4);
		S.tsSlotUsed = new Int32Array(4);
		S.tsSlot = 0; S.tsRingI = 0; S.tsActive = false;
		S.tsCollecting = false; S.tsValid = false;
		// Phase IV: the K11 diag passes run only on demand (the HUD's ~6 Hz tick) or
		// before a full download; a play frame leaves the flag false and skips them.
		S.diagWanted = false;
		S.tsNameTab = []; S.tsNameIdx = {};
		S.tsMs = new Float64Array(GpuSim.TS_MAX);
		try {
		S.ts = device.createQuerySet({ type: 'timestamp', count: GpuSim.TS_MAX * 2 });
		S.tsOn = true;
		// Per slot: resolve lands in a QUERY_RESOLVE | COPY_SRC buffer, then a copy
		// into a MAP_READ | COPY_DST buffer carries the readback - the spec allows
		// MAP_READ combined with nothing but COPY_DST, so one buffer cannot do both.
		S.tsResolve = [0, 1, 2, 3].map(function () {
			return device.createBuffer({ size: GpuSim.TS_MAX * 2 * 8, usage: 0x4 | 0x200 });
		});
		S.tsMap = [0, 1, 2, 3].map(function () {
			return device.createBuffer({ size: GpuSim.TS_MAX * 2 * 8, usage: 0x1 | 0x8 });
		});
		// Reused per dispatch: pass timestamps come from the beginComputePass
		// descriptor (spec GPUComputePassTimestampWrites), never a per-frame literal.
		S.tsWrites = { querySet: S.ts };
		S.tsPassDesc = { timestampWrites: null };
		} catch (e) {
		S.tsOn = false;   // adapter without timestamp-query: wall-clock only
		}
		S.buf = {};
		var sizes = { gridF: l.gridF * 4, gridI: l.gridI * 4, colF: l.colF * 4, colI: l.colI * 4,
			plateF: l.plateF * 4, plateI: l.plateI * 4, cellF: l.cellF * 4, cellI: l.cellI * 4,
			edges: l.edges * 4, bins: l.bins * 4, lose: l.lose * 4, reduceF: l.reduceF * 4,
			scan: l.scan * 4, frameIn: l.frameIn * 4, frameOut: l.frameOut * 4, diagOut: l.diagOut * 4 };
		for (var name in sizes) {
			S.buf[name] = device.createBuffer({ size: Math.max(16, sizes[name]), usage: 0x80 | 0x4 | 0x8 });
		}
		var pack = GpuSim.packGrid(state, l);
		device.queue.writeBuffer(S.buf.gridF, 0, pack.f);
		device.queue.writeBuffer(S.buf.gridI, 0, pack.i);
		await GpuSim.buildKernels(S);
		await GpuSim.uploadState(state);
		S.built = Date.now() - t0;
		return S;
	},

	// One module + pipeline + bind group per kernel. Variant kernels (trench dilations,
	// scan widths) are instantiated by suffix.
	buildKernels: async function (S) {
		var device = S.device, l = S.l, p = GpuParams, B = GpuCommon.B;
		var groupBufs = {
			gridF: ['gridF'], gridI: ['gridI'], grid: ['gridF', 'gridI'],
			colF: ['colF'], colI: ['colI'], col: ['colF', 'colI'],
			plateF: ['plateF'], plate: ['plateF'],
			cellF: ['cellF'], cellI: ['cellI'], cell: ['cellF', 'cellI'],
			edges: ['edges'], bins: ['bins', 'scan'], scanAlone: ['scan'],
			lose: ['lose'], reduce: ['reduceF'],
			frameIn: ['frameIn'], frameOut: ['frameOut'], diag: ['diagOut']
		};
		async function makeKernel(name, groups, code) {
			var src = GpuCommon.module(groups, p, l) + code;
			var mod = device.createShaderModule({ code: src });
			var info = await mod.getCompilationInfo();
			for (var i = 0; i < info.messages.length; i++) {
				var m = info.messages[i];
				if (m.type === 'error') throw new Error(name + ' wgsl: ' + m.lineNum + ':' + m.linePos + ' ' + m.message);
			}
			var entries = [], seen = {};
			for (var g = 0; g < groups.length; g++) {
				var bufs = groupBufs[groups[g]];
				for (var b = 0; b < bufs.length; b++) {
				if (seen[bufs[b]]) continue;
				seen[bufs[b]] = 1;
				// A dynamic-offset binding MUST name its size: without it the range is
				// the whole buffer, and offset 512 on a 20-block frameIn (10240 B) is
				// out of bounds even though offset 0 happens to fit. Dawn: "Did you
				// forget to specify the binding's size?"
				var resource = { buffer: S.buf[bufs[b]] };
				if (bufs[b] === 'frameIn') {
					resource.offset = 0;
					resource.size = l.finStride * 4;
				}
				entries.push({ binding: B[bufs[b]], resource: resource });
			}
		}
		if (entries.length > device.limits.maxStorageBuffersPerShaderStage) {
			throw new Error(name + ' binds ' + entries.length + ' storage buffers (limit '
				+ device.limits.maxStorageBuffersPerShaderStage + ')');
		}
		var dynamic = groups.indexOf('frameIn') >= 0;
		var layout = device.createBindGroupLayout({ entries: entries.map(function (e) {
			var ro = e.binding === B.gridF || e.binding === B.gridI || e.binding === B.frameIn;
			// frameIn carries one 74-float block per batched frame; the bind group is
			// reused with a dynamic offset, so the same WGSL FIN[...] indexes block i.
			var buffer = { type: ro ? 'read-only-storage' : 'storage' };
			if (e.binding === B.frameIn) {
				buffer.hasDynamicOffset = true;
				buffer.minBindingSize = GpuSim.FIN_FIELDS * 4;
			}
			return { binding: e.binding, visibility: 4, buffer: buffer };
		}) });
			var group = device.createBindGroup({ layout: layout, entries: entries });
			var pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				compute: { module: mod, entryPoint: 'main' } });
			S.K[name] = { pipe: pipe, group: group, layout: layout, dynamic: dynamic };
		}
		var files = GpuKernels || { columns: ColumnsWGSL, mantle: MantleWGSL, plates: PlatesWGSL,
			edges: EdgesWGSL, contact: ContactWGSL, column: ColumnWGSL, surface: SurfaceWGSL, diag: DiagWGSL };
		for (var fname in files) {
			var specs = files[fname];
			for (var s = 0; s < specs.length; s++) {
				var spec = specs[s];
				if (spec.variants) {
					for (var v = 0; v < spec.variants.length; v++) {
						await makeKernel(spec.name + v, spec.groups, spec.code(spec.variants[v]));
					}
				} else {
					await makeKernel(spec.name, spec.groups, typeof spec.code === 'function' ? spec.code() : spec.code);
				}
			}
		}
		// Two scan instances: N = V (bins + spawn ranks) and N = colCap (loser offsets).
		var ScanSrc = typeof module !== 'undefined' && module.exports ? require('./wgsl-scan.js') : ScanWGSL;
		for (var instance = 0; instance < 2; instance++) {
			var N = instance === 0 ? l.V : l.colCap;
			var tag = instance === 0 ? 'V' : 'C';
			var src = GpuCommon.module(ScanSrc.groups, p, l) + ScanSrc.code(N);
			var mod = device.createShaderModule({ code: src });
			var info = await mod.getCompilationInfo();
			for (var mi = 0; mi < info.messages.length; mi++) {
				if (info.messages[mi].type === 'error') throw new Error('scan' + tag + ': ' + info.messages[mi].lineNum + ' ' + info.messages[mi].message);
			}
			var entries = ['scan', 'bins', 'cellI', 'frameOut'].map(function (n) {
				return { binding: B[n], resource: { buffer: S.buf[n] } };
			});
			var layout = device.createBindGroupLayout({ entries: entries.map(function (e) {
				return { binding: e.binding, visibility: 4, buffer: { type: 'storage' } };
			}) });
			var group = device.createBindGroup({ layout: layout, entries: entries });
			var entries = { A: 'scanA', B: 'scanB', C: 'scanC', CBins: 'scanCBins', CRank: 'scanCRank', spawnCount: 'spawnCount' };
			for (var suffix in entries) {
				S.K['scan' + tag + suffix] = { pipe: device.createComputePipeline({
					layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
					compute: { module: mod, entryPoint: entries[suffix] } }), group: group, layout: layout };
			}
		}
	},

	// Mirror transfer sets. FULL is everything; the event cadence needs less. Measured
	// (experiments/roundtrip-cost.js, plus an array-diff of Events.cycle): the cycle reads
	// the columns, the plate table, owner/cellPlate, the edge classification and the frame
	// counters, and it writes only the columns, the plate table and the counters. It never
	// writes owner, cellPlate, relN, relT, edgeType, polarity or any cell float - and those
	// are exactly the arrays the frame kernels recompute from the columns every frame
	// (raster, velocities, relatives, polarity, elevationZ), so shipping them back to the
	// device is pure cost. Checkpoints keep the full set: Checkpoint.save serializes it.
	FULL: ['colF', 'colI', 'plateF', 'plateI', 'cellF', 'cellI', 'edges', 'bins', 'scan', 'frameOut', 'diagOut'],
	EVENT_READS: ['colF', 'colI', 'plateF', 'plateI', 'cellI', 'edges', 'frameOut', 'diagOut'],
	EVENT_WRITES: ['colF', 'colI', 'plateF', 'plateI', 'frameOut'],

	// Pack scratch, allocated once per engine. queue.writeBuffer copies the bytes at call
	// time, so one set of arrays can back every transfer (no 4.5 MB per event cycle).
	scratch: function (S) {
		if (S.pack) return S.pack;
		var l = S.l;
		S.pack = {
			colF: new Float32Array(l.colF), colI: new Int32Array(l.colI),
			plateF: new Float32Array(l.plateF), plateI: new Int32Array(l.plateI),
			cellF: new Float32Array(l.cellF), cellI: new Int32Array(l.cellI),
			edges: new Int32Array(l.edges)
		};
		return S.pack;
	},

	// Pack the dynamic mirror into the GPU buffers. Everything the frame kernels read.
	uploadState: async function (state) {
		return GpuSim.push(state, GpuSim.FULL);
	},
	uploadEvents: async function (state) {
		return GpuSim.push(state, GpuSim.EVENT_WRITES);
	},
	push: async function (state, names) {
		var S = GpuSim.S, l = S.l, d = S.device, g = state.grid, V = g.V, n = state.n, P = GpuSim.scratch(S);
		if (names.indexOf('colF') >= 0 || names.indexOf('colI') >= 0) {
			var colF = P.colF, colI = P.colI;
			// Alive rows only: the device already ignores rows at or past aliveN, and the
			// alive flag past n is zeroed below so a stale row can never come back to life.
			for (var i = 0; i < n; i++) {
				var b = i * 6, o = i * 4, w = i * 3;
				colF[b * 4] = state.body[w]; colF[b * 4 + 1] = state.body[w + 1]; colF[b * 4 + 2] = state.body[w + 2]; colF[b * 4 + 3] = state.area[i];
				colF[(b + 1) * 4] = state.world[w]; colF[(b + 1) * 4 + 1] = state.world[w + 1]; colF[(b + 1) * 4 + 2] = state.world[w + 2]; colF[(b + 1) * 4 + 3] = state.hFel[i];
				colF[(b + 2) * 4] = state.hMaf[i]; colF[(b + 2) * 4 + 1] = state.hSed[i]; colF[(b + 2) * 4 + 2] = state.age[i]; colF[(b + 2) * 4 + 3] = state.damage[i];
				colF[(b + 3) * 4] = state.fert[i]; colF[(b + 3) * 4 + 1] = state.oVms[i]; colF[(b + 3) * 4 + 2] = state.oMaf[i]; colF[(b + 3) * 4 + 3] = state.oArc[i];
				colF[(b + 4) * 4] = state.oOro[i]; colF[(b + 4) * 4 + 1] = state.oBas[i]; colF[(b + 4) * 4 + 2] = state.oPla[i]; colF[(b + 4) * 4 + 3] = state.zDyn[i];
				colF[(b + 5) * 4] = state.zDynNext[i]; colF[(b + 5) * 4 + 1] = state.collapseDelta[i];
				colI[o] = state.plate[i]; colI[o + 1] = state.cell[i]; colI[o + 2] = state.consumedBy[i]; colI[o + 3] = state.alive[i];
			}
			for (var dead = n; dead < l.colCap; dead++) colI[dead * 4 + 3] = 0;
			if (names.indexOf('colF') >= 0) d.queue.writeBuffer(S.buf.colF, 0, colF);
			if (names.indexOf('colI') >= 0) d.queue.writeBuffer(S.buf.colI, 0, colI);
		}
		// One plate table block: plateF carries plateI.
		if (names.indexOf('plateF') >= 0) {
			var plateF = P.plateF, plateI = P.plateI;
			for (var p = 0; p < l.plateCap; p++) {
				var pb = p * 8, po = p * 4, pw = p * 3, qb = p * 4;
				plateF[pb * 4] = state.q[qb]; plateF[pb * 4 + 1] = state.q[qb + 1]; plateF[pb * 4 + 2] = state.q[qb + 2]; plateF[pb * 4 + 3] = state.q[qb + 3];
				plateF[(pb + 1) * 4] = state.omega[pw]; plateF[(pb + 1) * 4 + 1] = state.omega[pw + 1]; plateF[(pb + 1) * 4 + 2] = state.omega[pw + 2]; plateF[(pb + 1) * 4 + 3] = state.plateBirth[p];
				plateF[(pb + 2) * 4] = state.omegaTarget[pw]; plateF[(pb + 2) * 4 + 1] = state.omegaTarget[pw + 1]; plateF[(pb + 2) * 4 + 2] = state.omegaTarget[pw + 2];
				plateF[(pb + 3) * 4] = state.M[p * 9]; plateF[(pb + 3) * 4 + 1] = state.M[p * 9 + 1]; plateF[(pb + 3) * 4 + 2] = state.M[p * 9 + 2];
				plateF[(pb + 4) * 4] = state.M[p * 9 + 3]; plateF[(pb + 4) * 4 + 1] = state.M[p * 9 + 4]; plateF[(pb + 4) * 4 + 2] = state.M[p * 9 + 5];
				plateF[(pb + 5) * 4] = state.M[p * 9 + 6]; plateF[(pb + 5) * 4 + 1] = state.M[p * 9 + 7]; plateF[(pb + 5) * 4 + 2] = state.M[p * 9 + 8];
				plateF[(pb + 6) * 4] = state.rhs[pw]; plateF[(pb + 6) * 4 + 1] = state.rhs[pw + 1]; plateF[(pb + 6) * 4 + 2] = state.rhs[pw + 2]; plateF[(pb + 6) * 4 + 3] = state.arcFeed[p];
				plateF[(pb + 7) * 4] = state.subRate[p]; plateF[(pb + 7) * 4 + 1] = state.seeds[p * 3]; plateF[(pb + 7) * 4 + 2] = state.seeds[p * 3 + 1]; plateF[(pb + 7) * 4 + 3] = state.seeds[p * 3 + 2];
				plateI[po] = state.plateParent[p];
			}
			d.queue.writeBuffer(S.buf.plateF, 0, plateF);
			d.queue.writeBuffer(S.buf.plateI, 0, plateI);
		}
		if (names.indexOf('cellI') >= 0) {
			var cellI = P.cellI;
			for (var c = 0; c < V; c++) {
				var co = c * 13;
				cellI[co] = state.owner[c]; cellI[co + 1] = state.cellPlate[c]; cellI[co + 2] = state.low[c];
				cellI[co + 3] = state.spawnSlot[c]; cellI[co + 4] = state.gapPlate[c];
				cellI[co + 5] = state.gapDonor[c * 3]; cellI[co + 6] = state.gapDonor[c * 3 + 1]; cellI[co + 7] = state.gapDonor[c * 3 + 2];
				var frames = Math.min(state.gapFrames[c], 0xffff);
				cellI[co + 8] = (state.trenchDist[c] & 3) | (frames << 4);
				cellI[co + 9] = state.distance[c] === Infinity ? 0x7fffffff : Math.round(state.distance[c] * 256);
				cellI[co + 10] = Math.round(state.gapTime[c] * 1e5);
				cellI[co + 12] = state.gapDonorN[c];
			}
			d.queue.writeBuffer(S.buf.cellI, 0, cellI);
		}
		if (names.indexOf('cellF') >= 0) {
			var cellF = P.cellF;
			for (var c2 = 0; c2 < V; c2++) {
				var fb = c2 * 8, cb = c2 * 3;
				cellF[fb * 4] = state.vel[cb]; cellF[fb * 4 + 1] = state.vel[cb + 1]; cellF[fb * 4 + 2] = state.vel[cb + 2]; cellF[fb * 4 + 3] = state.z[c2];
				cellF[(fb + 1) * 4] = state.gradZ[cb]; cellF[(fb + 1) * 4 + 1] = state.gradZ[cb + 1]; cellF[(fb + 1) * 4 + 2] = state.gradZ[cb + 2]; cellF[(fb + 1) * 4 + 3] = state.slope[c2];
				cellF[(fb + 2) * 4] = state.uMantle[cb]; cellF[(fb + 2) * 4 + 1] = state.uMantle[cb + 1]; cellF[(fb + 2) * 4 + 2] = state.uMantle[cb + 2]; cellF[(fb + 2) * 4 + 3] = state.plumeT[c2];
				cellF[(fb + 3) * 4] = state.mobile[c2]; cellF[(fb + 3) * 4 + 1] = state.mobileFel[c2]; cellF[(fb + 3) * 4 + 2] = state.mobilePla[c2]; cellF[(fb + 3) * 4 + 3] = state.ext[c2];
			}
			d.queue.writeBuffer(S.buf.cellF, 0, cellF);
		}
		if (names.indexOf('edges') >= 0) {
			var edges = P.edges;
			for (var e = 0; e < V * 6; e++) {
				edges[e * 4] = reinterpretI32(state.relN[e]);
				edges[e * 4 + 1] = reinterpretI32(state.relT[e]);
				edges[e * 4 + 2] = (state.edgeType[e] & 0xff) | (((state.polarity[e] + 1) & 0xff) << 8);
			}
			d.queue.writeBuffer(S.buf.edges, 0, edges);
		}
		if (names.indexOf('frameOut') >= 0) {
			// frameOut: n + cumulative counters + 64-bit ledger pairs + per-plate atomics.
			var fo = P.frameOut || (P.frameOut = new Int32Array(l.frameOut));
			var ledBuf = P.ledBuf || (P.ledBuf = new ArrayBuffer(4));
			var ledF32 = P.ledF32 || (P.ledF32 = new Float32Array(ledBuf)), ledI32 = P.ledI32 || (P.ledI32 = new Int32Array(ledBuf));
			fo[0] = state.n;
			var ledgers = [state.producedFel, state.producedMaf, state.erodedFel, state.erodedMaf,
				state.subductedMaf, state.subductedSed, state.subductedArea];
			for (var k = 0; k < 7; k++) {
				// Running totals as f64-like hi/lo f32 pairs: the ledgerReduce kernels
				// fold each frame's deltas in with twoSum, so nothing is lost to f32.
				var v = ledgers[k];
				ledF32[0] = v;
				var hi = ledF32[0];
				ledF32[0] = v - hi;
				fo[l.foLedger0 + k * 2 + 1] = ledI32[0];
				ledF32[0] = hi;
				fo[l.foLedger0 + k * 2] = ledI32[0];
			}
			for (var p2 = 0; p2 < l.plateCap; p2++) {
				fo[l.foPlate0 + p2 * 5] = state.plateCells[p2];
				fo[l.foPlate0 + p2 * 5 + 3] = state.plateLost[p2];
				fo[l.foPlate0 + p2 * 5 + 4] = state.plateSpawned[p2];
			}
			d.queue.writeBuffer(S.buf.frameOut, 0, fo);
		}
		await GpuSim.uploadFrame(state, GpuParams.dt);
	},

	// Fill one 74-float block at float offset `off`. Mantle bookkeeping stays on
	// the CPU (cheap, sequential RNG), the per-cell flow is the GPU kernel.
	// precess and the plume respawn loop read state.t, and a batched encoder
	// precomputes n blocks before the JS clock advances, so the simulated time
	// and frame are explicit arguments; state.t is restored by the caller.
	fillFrame: function (state, fin, off, dt, t, frame) {
		var p = GpuParams;
		state.t = t;
		state.Tm = GpuMantle.Tm(t, state.Tm0);
		GpuMantle.precess(state);
		for (var i = 0; i < state.plumeCount; i++) {
			while (t >= state.plumeBirth[i] + state.plumeLife[i]) {
				GpuMantle.spawnPlume(state, i, state.plumeBirth[i] + state.plumeLife[i]);
			}
		}
		var speed = p.U0 * Math.pow(state.Tm, 2.5);
		var sig = p.plumeRad / p.radius;
		fin[off] = t; fin[off + 1] = dt; fin[off + 2] = state.Tm;
		fin[off + 3] = state.mantleScale * speed; fin[off + 4] = speed; fin[off + 5] = 1 / (sig * sig);
		fin[off + 6] = state.plateCount; fin[off + 7] = frame;
		for (var w = 0; w < p.nWave; w++) {
			fin[off + 8 + w * 3] = state.waveDir[w * 3]; fin[off + 8 + w * 3 + 1] = state.waveDir[w * 3 + 1]; fin[off + 8 + w * 3 + 2] = state.waveDir[w * 3 + 2];
			fin[off + 32 + w] = state.waveFreq[w]; fin[off + 40 + w] = state.wavePhase[w]; fin[off + 48 + w] = state.waveAmp[w];
		}
		for (var q = 0; q < state.plumeCount; q++) {
			fin[off + 56 + q * 4] = state.plumePos[q * 3]; fin[off + 56 + q * 4 + 1] = state.plumePos[q * 3 + 1];
			fin[off + 56 + q * 4 + 2] = state.plumePos[q * 3 + 2]; fin[off + 56 + q * 4 + 3] = state.plumeStr[q];
		}
		fin[off + 72] = state.plateCount;
		fin[off + 73] = state.grid.A0[0];
	},

	// The single-frame upload (step, the parity harness, the boot raster): the
	// first 74 floats of the same block layout a batch uses.
	uploadFrame: function (state, dt) {
		var S = GpuSim.S;
		if (!S.finSingle) S.finSingle = new Float32Array(GpuSim.FIN_FIELDS);
		var realT = state.t, realFrame = state.frame;
		GpuSim.fillFrame(state, S.finSingle, 0, dt, realT, realFrame);
		state.t = realT; state.frame = realFrame;
		S.device.queue.writeBuffer(S.buf.frameIn, 0, S.finSingle);
	},

	// n blocks in one upload for a batched encoder: the CPU mantle bookkeeping
	// for all n frames, exactly as n uploadFrame calls would have run it.
	frameBlocks: function (state, dt, n) {
		var S = GpuSim.S, l = S.l;
		if (n > GpuSim.FIN_MAX) throw new Error('batch of ' + n + ' exceeds FIN_MAX ' + GpuSim.FIN_MAX);
		if (!S.finBlocks || S.finBlocks.length < l.finStride * n) {
			S.finBlocks = new Float32Array(l.finStride * GpuSim.FIN_MAX);
		}
		S.finBlocks.fill(0, 0, l.finStride * n);
		var realT = state.t, realFrame = state.frame;
		// t advances by the same per-frame adds step() uses - never run*dt - so
		// every block sees the bit-identical t and frame of its single-step frame.
		var tt = realT;
		for (var i = 0; i < n; i++) {
			GpuSim.fillFrame(state, S.finBlocks, i * l.finStride, dt, tt, realFrame + i);
			tt += dt;
		}
		state.t = realT; state.frame = realFrame;
		// Subarray, not dataOffset: Chrome/SwiftShader reject a nonzero dataOffset
		// with "Number of bytes to write is too large" even when the range fits.
		S.device.queue.writeBuffer(S.buf.frameIn, 0, S.finBlocks.subarray(0, l.finStride * n));
		return n;
	},

	groups: Math.ceil,

	// Dispatch helpers: `run` takes a thread count, `runGroups` a workgroup count.
	run: function (S, enc, name, threads, wg) {
		GpuSim.runGroups(S, enc, name, Math.ceil(threads / wg), wg);
	},
	runGroups: function (S, enc, name, groups, wg) {
		var k = S.K[name];
		if (!k) throw new Error('missing kernel ' + name);
		// Fail here, at the call site with the kernel's name, rather than as a dropped
		// encoder: an over-limit dispatchWorkgroups is a validation error whose only
		// spec-mandated symptom is that the segment's submit runs nothing (the map
		// freezes while the frame loop keeps ticking). Grid-stride the kernel instead.
		if (groups > GpuSim.WGDIM) {
			throw new Error(name + ' dispatches ' + groups + ' workgroups, over the '
				+ GpuSim.WGDIM + ' maxComputeWorkgroupsPerDimension dimension limit');
		}
		// Phase I1: one start and one end timestamp per dispatch, tagged with the
		// kernel name for the 2 Hz report. Only inside a timed frame (tsActive),
		// so the boot raster and test paths stay untouched. The spec writes pass
		// timestamps from the beginComputePass descriptor (timestampWrites), not
		// a mid-pass insertTimestamp call.
		var desc = null, w = S.tsWrites;
		if (S.tsOn && S.tsActive) {
			if (S.tsSlot >= GpuSim.TS_MAX) throw new Error('timestamp slots exhausted');
			var idx = S.tsNameIdx[name];
			if (idx === undefined) {
				idx = S.tsNameTab.length;
				S.tsNameIdx[name] = idx;
				S.tsNameTab.push(name);
			}
			S.tsSlotNames[S.tsRingI * GpuSim.TS_MAX + S.tsSlot] = idx;
			w.beginningOfPassWriteIndex = S.tsSlot * 2;
			w.endOfPassWriteIndex = S.tsSlot * 2 + 1;
			S.tsPassDesc.timestampWrites = w;
			S.tsSlot++;
			desc = S.tsPassDesc;
		}
		var pass = enc.beginComputePass(desc);
		pass.setPipeline(k.pipe);
		// Kernels binding frameIn take one dynamic offset, the batched frame's block.
		if (k.dynamic) pass.setBindGroup(0, k.group, [S.finOffset || 0]);
		else pass.setBindGroup(0, k.group);
		pass.dispatchWorkgroups(groups);
		pass.end();
	},

	// The full per-frame dispatch list in Sim.step order, appended to any
	// encoder. resolve runs six times for the longest loser chain (each dispatch
	// is one barrier-separated pointer jump). frame() owns the single-frame
	// encoder and the timestamp resolve; batch() appends n copies with per-frame
	// frameIn offsets, one encoder and one submit per rAF. `diag` gates K11:
	// step() and the parity harnesses pay for it every frame, play() only on a
	// frame the HUD asked for (GpuSim.wantDiag); the diagA/diagC traversals are
	// ~0.9 ms/step on a clean queue, up to ~2.5 ms under live play, and nothing
	// on the device reads their output. A full download (GpuSim.download ->
	// diagFrame) folds the current frame's numbers on demand.
	dispatchGraph: function (S, enc, state, diag, l) {
		var V = l.V, colCap = l.colCap, WG = GpuSim.WG;
		GpuSim.run(S, enc, 'zeroFrame', GpuSim.zeroThreads(l), WG);
		GpuSim.run(S, enc, 'integrate', l.plateCap, WG);
		GpuSim.run(S, enc, 'move', colCap, WG);
		GpuSim.run(S, enc, 'binCount', colCap, WG);
		GpuSim.runGroups(S, enc, 'scanVA', Math.ceil(V / 1024), 256);
		GpuSim.runGroups(S, enc, 'scanVB', 1, 256);
		GpuSim.run(S, enc, 'scanVCBins', V, WG);
		GpuSim.run(S, enc, 'binScatter', colCap, WG);
		GpuSim.run(S, enc, 'raster', V, WG);
		GpuSim.run(S, enc, 'mantle', V, WG);
		GpuSim.run(S, enc, 'velocities', V, WG);
		GpuSim.run(S, enc, 'relatives', V, WG);
		GpuSim.run(S, enc, 'polarity', V, WG);
		GpuSim.run(S, enc, 'trenchA', V, WG);
		GpuSim.run(S, enc, 'trenchDilate0', V, WG);
		GpuSim.run(S, enc, 'trenchDilate1', V, WG);
		GpuSim.run(S, enc, 'extension', V, WG);
		GpuSim.run(S, enc, 'overlaps', colCap, WG);
		GpuSim.run(S, enc, 'gaps', V, 64);
		for (var r = 0; r < 6; r++) GpuSim.run(S, enc, 'resolve', colCap, WG);
		GpuSim.run(S, enc, 'loserZero', colCap, WG);
		GpuSim.run(S, enc, 'loserCount', colCap, WG);
		GpuSim.runGroups(S, enc, 'scanCA', Math.ceil(colCap / 1024), 256);
		GpuSim.runGroups(S, enc, 'scanCB', 1, 256);
		GpuSim.run(S, enc, 'scanCC', colCap, WG);
		GpuSim.run(S, enc, 'loserScatter', colCap, WG);
		// one workgroup per winner column (lanes split the bin's comparisons), capped at
		// the dispatch dimension limit - colCap workgroups would exceed it at L7 and
		// invalidate every encoder in the segment (the device ran nothing)
		GpuSim.runGroups(S, enc, 'loserRank', Math.min(colCap, GpuSim.WGDIM), 64);
		GpuSim.run(S, enc, 'gather', colCap, 64);
		GpuSim.run(S, enc, 'ownerClear', V, WG);
		GpuSim.run(S, enc, 'winnerA', l.nwg10, WG);
		GpuSim.run(S, enc, 'winnerB', l.plateCap, WG);
		GpuSim.runGroups(S, enc, 'subRateA', l.nwg10, WG);
		GpuSim.run(S, enc, 'subRateB', l.plateCap, WG);
		GpuSim.run(S, enc, 'arcs', colCap, 64);
		GpuSim.run(S, enc, 'spawnFlags', V, WG);
		GpuSim.runGroups(S, enc, 'scanVA', Math.ceil(V / 1024), 256);
		GpuSim.runGroups(S, enc, 'scanVB', 1, 256);
		GpuSim.run(S, enc, 'scanVCRank', V, WG);
		GpuSim.run(S, enc, 'scanVspawnCount', 1, 1);
		GpuSim.run(S, enc, 'riftMark', V, 64);
		GpuSim.run(S, enc, 'spawn', V, 64);
		GpuSim.run(S, enc, 'thinning', colCap, 64);
		GpuSim.run(S, enc, 'collapseDelta', colCap, WG);
		GpuSim.run(S, enc, 'collapseApply', colCap, WG);
		GpuSim.run(S, enc, 'belt', V * 6, WG);
		GpuSim.run(S, enc, 'columnStep', colCap, 64);
		GpuSim.run(S, enc, 'dynamics', colCap, WG);
		GpuSim.run(S, enc, 'zdynCommit', colCap, WG);
		GpuSim.run(S, enc, 'elevationZ', V, WG);
		GpuSim.run(S, enc, 'elevationG', V, WG);
		GpuSim.run(S, enc, 'basins', colCap, WG);
		GpuSim.run(S, enc, 'erode', colCap, 64);
		GpuSim.run(S, enc, 'routeOut', V, WG);
		GpuSim.run(S, enc, 'stay', V, WG);
		GpuSim.run(S, enc, 'deposit', colCap, 64);
		GpuSim.run(S, enc, 'elevationZ', V, WG);
		if (!state.prescribedOmega) {
			GpuSim.run(S, enc, 'forces', V, WG);
			GpuSim.runGroups(S, enc, 'reduceA', l.nwg10, WG);
			GpuSim.run(S, enc, 'reduceB', l.plateCap, WG);
		}
		if (diag) {
			GpuSim.run(S, enc, 'diagA', l.nwgD, 1);
			GpuSim.run(S, enc, 'diagC', Math.ceil(V / l.chunkD), 1);
			GpuSim.run(S, enc, 'diagB', 1, 1);
		}
		GpuSim.runGroups(S, enc, 'ledgerReduceA', l.nwgL, WG);
		GpuSim.run(S, enc, 'ledgerReduceB', 7, WG);
	},

	frame: function (state, dt, diag) {
		var S = GpuSim.S, l = S.l;
		if (diag === undefined) diag = true;
		GpuSim.uploadFrame(state, dt);
		var enc = S.device.createCommandEncoder();
		if (S.tsOn) { S.tsActive = true; S.tsSlot = 0; }
		GpuSim.dispatchGraph(S, enc, state, diag, l);
		GpuSim.tsResolve(S, enc);
		S.device.queue.submit([enc.finish()]);
	},

	// Resolve this encoder's timestamp slot into the ring's map buffer. Called
	// once per encoder; only the dispatches made while tsActive was set wrote
	// queries (a batched encoder times its first frame - the per-kernel costs are
	// the same on every frame, and one frame fits TS_MAX).
	tsResolve: function (S, enc) {
		if (!S.tsOn) return;
		S.tsActive = false;
		// Resolve, then copy to the map buffer (MAP_READ cannot carry QUERY_RESOLVE).
		var pair = S.tsRingI, size = GpuSim.TS_MAX * 2 * 8;
		enc.resolveQuerySet(S.ts, 0, S.tsSlot * 2, S.tsResolve[pair], 0);
		enc.copyBufferToBuffer(S.tsResolve[pair], 0, S.tsMap[pair], 0, size);
		S.tsSlotUsed[pair] = S.tsSlot;
		S.tsRingI = (pair + 1) % 4;
	},

	// Phase V: n frames in one command buffer. n frameIn blocks are precomputed
	// on the CPU (the same sequential mantle bookkeeping, once per frame) and
	// uploaded once; the dispatch graph repeats with a per-frame dynamic offset.
	// Same dispatch order and inputs as n frame() calls, so same-device results
	// are bit-identical. Only frame 0 writes timestamp queries (one frame fits
	// TS_MAX and every repeat has the same per-kernel costs). `diagAt` is the
	// frame index running K11 (-1 = none); play puts a wanted diagnostic frame
	// last in its segment.
	// Build one segment's encoder: the n frames' dispatch graph, the timestamp
	// resolve, then the render tail. The tail (GpuRenderer.appendTo) draws the world
	// texture, never the canvas, so its position only decides which frame's state the
	// world shows - last is the freshest. play() submits the encoder after a queue
	// drain (one segment deep); direct callers use batch(), which encodes and commits
	// in one call.
	encodeBatch: function (state, dt, n, diagAt, tail) {
		var S = GpuSim.S, l = S.l;
		GpuSim.frameBlocks(state, dt, n);
		var strideBytes = l.finStride * 4;
		var enc = S.device.createCommandEncoder();
		for (var i = 0; i < n; i++) {
			// Timestamp frame 0 only: per-kernel costs are identical on every
			// repeat, and a full n-frame graph would exhaust the query set.
			if (S.tsOn && i === 0) { S.tsActive = true; S.tsSlot = 0; }
			S.finOffset = i * strideBytes;
			GpuSim.dispatchGraph(S, enc, state, diagAt === i, l);
			if (S.tsOn && i === 0) S.tsActive = false;
		}
		S.finOffset = 0;
		GpuSim.tsResolve(S, enc);
		if (tail) tail(enc);
		return enc;
	},

	batch: function (state, dt, n, diagAt, tail) {
		var enc = GpuSim.encodeBatch(state, dt, n, diagAt, tail);
		GpuSim.commitBatch(enc, n);
		return enc;
	},

	// Submit a segment encoder, then restore the single-frame invariant: block 0 of
	// frameIn holds the most recent frame's scalars, so an on-demand diagFrame (which
	// reads fPlates() from offset 0 after a mid-batch spawn) sees the current plate
	// count. The bytes go out as a queue writeBuffer queued AFTER the submit, not an
	// in-encoder copy: WebGPU rejects a buffer copied onto itself, and the rejection
	// invalidates the whole encoder - the old tail copy discarded every n>1 batch
	// (the GPU ran nothing, the bench iso measured a dead submit, and the smoke
	// compared a GPU world that had never advanced past boot). The driver copies the
	// bytes at queue time, so the reused finBlocks scratch is safe to rewrite by the
	// next frameBlocks.
	commitBatch: function (enc, n) {
		var S = GpuSim.S, l = S.l;
		S.device.queue.submit([enc.finish()]);
		if (n > 1) {
			S.device.queue.writeBuffer(S.buf.frameIn, 0, S.finBlocks.subarray(
				(n - 1) * l.finStride, (n - 1) * l.finStride + GpuSim.FIN_FIELDS));
		}
	},

	// Read the timestamps of the frame two submits back (its ring slot is free by
	// now) and fold them into the per-kernel EMA. Runs off the frame path (2 Hz
	// from the HUD, or per step in the node/test paths); never blocks a submit.
	// Timestamp period is assumed 1 ns, the ANGLE/SwiftShader convention.
	tsCollect: async function () {
		var S = GpuSim.S;
		if (!S || !S.tsOn || !S.tsMap || S.tsCollecting) return;
		S.tsCollecting = true;
		// ringI points at the next slot to be written; two behind it sits the
		// frame whose work (and resolve) has long since completed.
		var slot = (S.tsRingI + 1) % 4, buf = S.tsMap[slot], used = S.tsSlotUsed[slot];
		try {
			await buf.mapAsync(1);
			if (used > 0) {
				var range = buf.getMappedRange();
				var u32 = new Uint32Array(range);
				var f64 = new Float64Array(S.tsMs.length);
				for (var s = 0; s < used; s++) {
					var b = s * 4, i = S.tsSlotNames[slot * GpuSim.TS_MAX + s];
					var t0 = (u32[b + 1] * 4294967296 + u32[b]) / 1e6;
					var t1 = (u32[b + 3] * 4294967296 + u32[b + 2]) / 1e6;
					f64[i] += t1 - t0;
				}
				for (var m = 0; m < S.tsMs.length; m++) {
					S.tsMs[m] += (f64[m] - S.tsMs[m]) * 0.25;
				}
				S.tsValid = true;
			}
			S.tsSlotUsed[slot] = 0;
			buf.unmap();
		} catch (e) {
			S.tsOn = false;   // buffer raced or device lost: fall back, stay quiet
		}
		S.tsCollecting = false;
	},

	// Drop the per-kernel EMA (the name table stays; the kernel set is fixed for
	// the device). A mixed-level bench resets between configs so the labelled
	// kernel line describes that config instead of whichever ran last.
	tsReset: function () {
		var S = GpuSim.S;
		if (!S) return;
		S.tsMs.fill(0);
		S.tsValid = false;
	},

	// 2 Hz HUD line: per-kernel GPU ms (EMA over collected frames), biggest first.
	tsReport: function () {
		var S = GpuSim.S;
		if (!S || !S.tsOn || !S.tsValid) return '';
		var rows = [], tab = S.tsNameTab;
		for (var i = 0; i < tab.length; i++) {
			if (S.tsMs[i] >= 0.05) rows.push([S.tsMs[i], tab[i]]);
		}
		rows.sort(function (a, b) { return b[0] - a[0]; });
		var line = '';
		for (var r = 0; r < rows.length && r < 10; r++) {
			line += (line ? ' ' : '') + rows[r][1] + ' ' + rows[r][0].toFixed(2);
		}
		return line;
	},

	// Boot pass for a freshly uploaded world: enough of the frame for painting.
	raster: function (state) {
		var S = GpuSim.S, l = S.l, V = l.V, WG = GpuSim.WG;
		// Sim.raster solves K10 with dt = tau_omega so the first painted frame carries the
		// un-relaxed fit velocities; classify then re-runs velocities with that omega.
		GpuSim.uploadFrame(state, GpuParams.tauOmega);
		var enc = S.device.createCommandEncoder();
		// zeroFrame also opens the boot pass, not only its second half: the reduce scratch is
		// uninitialized memory until something writes it, and the witness region reduceB owns
		// is only written when K10 runs. Without this the boot diagB would fold whatever the
		// buffer was born with into D_RELAXERR.
		GpuSim.run(S, enc, 'zeroFrame', GpuSim.zeroThreads(l), WG);
		GpuSim.run(S, enc, 'move', l.colCap, WG);
		GpuSim.run(S, enc, 'binCount', l.colCap, WG);
		GpuSim.runGroups(S, enc, 'scanVA', Math.ceil(V / 1024), 256);
		GpuSim.runGroups(S, enc, 'scanVB', 1, 256);
		GpuSim.run(S, enc, 'scanVCBins', V, WG);
		GpuSim.run(S, enc, 'binScatter', l.colCap, WG);
		GpuSim.run(S, enc, 'raster', V, WG);
		GpuSim.run(S, enc, 'mantle', V, WG);
		GpuSim.run(S, enc, 'elevationZ', V, WG);
		GpuSim.run(S, enc, 'elevationG', V, WG);
		GpuSim.run(S, enc, 'velocities', V, WG);
		if (!state.prescribedOmega) {
			GpuSim.run(S, enc, 'forces', V, WG);
			GpuSim.runGroups(S, enc, 'reduceA', l.nwg10, WG);
			GpuSim.run(S, enc, 'reduceB', l.plateCap, WG);
		}
		// The boot mirror of Sim.raster's tail: classify starts with a second velocities
		// pass over the just-solved omega. zeroFrame re-runs first because the CPU
		// velocities call resets its own plateCells/maxSpeed accumulators.
		GpuSim.run(S, enc, 'zeroFrame', GpuSim.zeroThreads(l), WG);
		GpuSim.run(S, enc, 'velocities', V, WG);
		GpuSim.run(S, enc, 'relatives', V, WG);
		GpuSim.run(S, enc, 'polarity', V, WG);
		GpuSim.run(S, enc, 'trenchA', V, WG);
		GpuSim.run(S, enc, 'trenchDilate0', V, WG);
		GpuSim.run(S, enc, 'trenchDilate1', V, WG);
		GpuSim.run(S, enc, 'extension', V, WG);
		GpuSim.run(S, enc, 'diagA', l.nwgD, 1);
		GpuSim.run(S, enc, 'diagC', Math.ceil(V / l.chunkD), 1);
		GpuSim.run(S, enc, 'diagB', 1, 1);
		S.device.queue.submit([enc.finish()]);
	},

	// A diagnostic-only submit: diagA/diagC/diagB over the buffers as they stand,
	// evolving nothing. A full download mirrors diagOut (meanSpeed, masses, the D1
	// witnesses), so it precedes one of these on demand - the play path skips K11
	// most frames and a probe/save/checkpoint must still pull THIS frame's numbers.
	// No zeroFrame: its counters/plate atomics are read by the same pull and would
	// be wiped; diagA/diagC overwrite their own reduce rows completely, and the
	// relaxation witnesses keep the latest K10 frame's values until reduceB runs.
	diagFrame: function (state) {
		var S = GpuSim.S;
		if (!S) return;
		var l = S.l, enc = S.device.createCommandEncoder();
		GpuSim.run(S, enc, 'diagA', l.nwgD, 1);
		GpuSim.run(S, enc, 'diagC', Math.ceil(l.V / l.chunkD), 1);
		GpuSim.run(S, enc, 'diagB', 1, 1);
		S.device.queue.submit([enc.finish()]);
	},

	// Mirror sync back. One staging buffer per source, one submit, then unpack. `names`
	// picks the set (GpuSim.FULL for an on-demand sync, GpuSim.EVENT_READS for the event
	// cadence); staging buffers are reused, and only the alive column rows are unpacked.
	download: async function (state) {
		// The full mirror includes diagOut; fold the current frame's diagnostics
		// before the copy encoder so a probe, save, deposits extract, checkpoint or
		// smoke download never reads a stale diagnostic block.
		GpuSim.diagFrame(state);
		return GpuSim.pull(state, GpuSim.FULL);
	},
	downloadEvents: async function (state) {
		return GpuSim.pull(state, GpuSim.EVENT_READS);
	},
	pull: async function (state, names) {
		var S = GpuSim.S, l = S.l, d = S.device, g = state.grid, V = g.V;
		// A second transfer can overlap this one (a probe click during an event round
		// trip); the shared staging set is only reused when it is free.
		var shared = !S.stageBusy;
		if (shared) { S.stageBusy = true; if (!S.stage) S.stage = {}; }
		var stage = shared ? S.stage : {};
		// `m` is what this transfer mapped; `stage` is the cache and can hold buffers from
		// an earlier, wider download. Unpacking must test `m`, or a light event round trip
		// reads a cached buffer that was never mapped and the device raises OperationError.
		var m = {};
		var enc = d.createCommandEncoder();
		for (var r = 0; r < names.length; r++) {
			var name = names[r];
			if (!stage[name]) stage[name] = d.createBuffer({ size: Math.max(16, S.buf[name].size), usage: 0x1 | 0x8 });
			enc.copyBufferToBuffer(S.buf[name], 0, stage[name], 0, S.buf[name].size);
			m[name] = stage[name];
		}
		var tw0 = GpuPerf ? GpuPerf.clock() : 0;
		d.queue.submit([enc.finish()]);
		var maps = [];
		for (var r2 = 0; r2 < names.length; r2++) maps.push(stage[names[r2]].mapAsync(1));
		await Promise.all(maps);
		var tw1 = GpuPerf ? GpuPerf.clock() : 0;
		// The counters come first: n bounds the column unpack.
		var fo = new Int32Array(m.frameOut.getMappedRange());
		state.n = fo[0];
		if (m.colF || m.colI) {
			var colF = new Float32Array(m.colF.getMappedRange());
			var colI = new Int32Array(m.colI.getMappedRange());
			for (var i = 0; i < state.n; i++) {
				var b = i * 6, o = i * 4, w = i * 3;
				state.body[w] = colF[b * 4]; state.body[w + 1] = colF[b * 4 + 1]; state.body[w + 2] = colF[b * 4 + 2]; state.area[i] = colF[b * 4 + 3];
				state.world[w] = colF[(b + 1) * 4]; state.world[w + 1] = colF[(b + 1) * 4 + 1]; state.world[w + 2] = colF[(b + 1) * 4 + 2]; state.hFel[i] = colF[(b + 1) * 4 + 3];
				state.hMaf[i] = colF[(b + 2) * 4]; state.hSed[i] = colF[(b + 2) * 4 + 1]; state.age[i] = colF[(b + 2) * 4 + 2]; state.damage[i] = colF[(b + 2) * 4 + 3];
				state.fert[i] = colF[(b + 3) * 4]; state.oVms[i] = colF[(b + 3) * 4 + 1]; state.oMaf[i] = colF[(b + 3) * 4 + 2]; state.oArc[i] = colF[(b + 3) * 4 + 3];
				state.oOro[i] = colF[(b + 4) * 4]; state.oBas[i] = colF[(b + 4) * 4 + 1]; state.oPla[i] = colF[(b + 4) * 4 + 2]; state.zDyn[i] = colF[(b + 4) * 4 + 3];
				state.zDynNext[i] = colF[(b + 5) * 4]; state.collapseDelta[i] = colF[(b + 5) * 4 + 1];
				state.plate[i] = colI[o]; state.cell[i] = colI[o + 1]; state.consumedBy[i] = colI[o + 2]; state.alive[i] = colI[o + 3];
			}
		}
		if (m.plateF) {
			var plateF = new Float32Array(m.plateF.getMappedRange());
			var plateI = new Int32Array(m.plateI.getMappedRange());
			for (var p = 0; p < l.plateCap; p++) {
				var pb = p * 8, pw = p * 3, qb = p * 4;
				state.q[qb] = plateF[pb * 4]; state.q[qb + 1] = plateF[pb * 4 + 1]; state.q[qb + 2] = plateF[pb * 4 + 2]; state.q[qb + 3] = plateF[pb * 4 + 3];
				state.omega[pw] = plateF[(pb + 1) * 4]; state.omega[pw + 1] = plateF[(pb + 1) * 4 + 1]; state.omega[pw + 2] = plateF[(pb + 1) * 4 + 2];
				state.plateBirth[p] = plateF[(pb + 1) * 4 + 3];
				state.omegaTarget[pw] = plateF[(pb + 2) * 4]; state.omegaTarget[pw + 1] = plateF[(pb + 2) * 4 + 1]; state.omegaTarget[pw + 2] = plateF[(pb + 2) * 4 + 2];
				state.M[p * 9] = plateF[(pb + 3) * 4]; state.M[p * 9 + 1] = plateF[(pb + 3) * 4 + 1]; state.M[p * 9 + 2] = plateF[(pb + 3) * 4 + 2];
				state.M[p * 9 + 3] = plateF[(pb + 4) * 4]; state.M[p * 9 + 4] = plateF[(pb + 4) * 4 + 1]; state.M[p * 9 + 5] = plateF[(pb + 4) * 4 + 2];
				state.M[p * 9 + 6] = plateF[(pb + 5) * 4]; state.M[p * 9 + 7] = plateF[(pb + 5) * 4 + 1]; state.M[p * 9 + 8] = plateF[(pb + 5) * 4 + 2];
				state.rhs[pw] = plateF[(pb + 6) * 4]; state.rhs[pw + 1] = plateF[(pb + 6) * 4 + 1]; state.rhs[pw + 2] = plateF[(pb + 6) * 4 + 2];
				state.arcFeed[p] = plateF[(pb + 6) * 4 + 3];
				state.subRate[p] = plateF[(pb + 7) * 4];
				state.seeds[p * 3] = plateF[(pb + 7) * 4 + 1]; state.seeds[p * 3 + 1] = plateF[(pb + 7) * 4 + 2]; state.seeds[p * 3 + 2] = plateF[(pb + 7) * 4 + 3];
				state.plateParent[p] = plateI[p * 4];
			}
		}
		if (m.cellF) {
			var cellF = new Float32Array(m.cellF.getMappedRange());
			for (var c = 0; c < V; c++) {
				var fb = c * 8, cb = c * 3;
				state.vel[cb] = cellF[fb * 4]; state.vel[cb + 1] = cellF[fb * 4 + 1]; state.vel[cb + 2] = cellF[fb * 4 + 2]; state.z[c] = cellF[fb * 4 + 3];
				state.gradZ[cb] = cellF[(fb + 1) * 4]; state.gradZ[cb + 1] = cellF[(fb + 1) * 4 + 1]; state.gradZ[cb + 2] = cellF[(fb + 1) * 4 + 2]; state.slope[c] = cellF[(fb + 1) * 4 + 3];
				state.uMantle[cb] = cellF[(fb + 2) * 4]; state.uMantle[cb + 1] = cellF[(fb + 2) * 4 + 1]; state.uMantle[cb + 2] = cellF[(fb + 2) * 4 + 2]; state.plumeT[c] = cellF[(fb + 2) * 4 + 3];
				state.mobile[c] = cellF[(fb + 3) * 4]; state.mobileFel[c] = cellF[(fb + 3) * 4 + 1]; state.mobilePla[c] = cellF[(fb + 3) * 4 + 2]; state.ext[c] = cellF[(fb + 3) * 4 + 3];
				state.outflow[c] = cellF[(fb + 4) * 4]; state.outflowFel[c] = cellF[(fb + 4) * 4 + 1]; state.outflowPla[c] = cellF[(fb + 4) * 4 + 2];
				state.stay[c] = cellF[(fb + 5) * 4]; state.stayFel[c] = cellF[(fb + 5) * 4 + 1]; state.stayPla[c] = cellF[(fb + 5) * 4 + 2];
				state.wEq[cb] = cellF[(fb + 7) * 4]; state.wEq[cb + 1] = cellF[(fb + 7) * 4 + 1]; state.wEq[cb + 2] = cellF[(fb + 7) * 4 + 2];
				state.wet[c] = state.z[c] < 0 ? 1 : 0;
			}
		}
		if (m.cellI) {
			var cellI = new Int32Array(m.cellI.getMappedRange());
			for (var c1 = 0; c1 < V; c1++) {
				var co = c1 * 13;
				state.owner[c1] = cellI[co]; state.cellPlate[c1] = cellI[co + 1]; state.low[c1] = cellI[co + 2];
				state.spawnSlot[c1] = cellI[co + 3]; state.gapPlate[c1] = cellI[co + 4];
				state.gapDonor[c1 * 3] = cellI[co + 5]; state.gapDonor[c1 * 3 + 1] = cellI[co + 6]; state.gapDonor[c1 * 3 + 2] = cellI[co + 7];
				state.trenchDist[c1] = cellI[co + 8] & 3;
				state.gapFrames[c1] = (cellI[co + 8] >>> 4) & 0xffff;
				state.distance[c1] = cellI[co + 9] === 0x7fffffff ? Infinity : cellI[co + 9] / 256;
				state.gapTime[c1] = cellI[co + 10] / 1e5;
				state.gapDonorN[c1] = cellI[co + 12];
			}
		}
		if (m.edges) {
			var edges = new Int32Array(m.edges.getMappedRange());
			for (var e = 0; e < V * 6; e++) {
				state.relN[e] = reinterpretF32(edges[e * 4]);
				state.relT[e] = reinterpretF32(edges[e * 4 + 1]);
				state.edgeType[e] = edges[e * 4 + 2] & 0xff;
				state.polarity[e] = ((edges[e * 4 + 2] >> 8) & 0xff) - 1;
			}
		}
		if (m.scan) {
			var bins = new Int32Array(m.bins.getMappedRange());
			var scan = new Int32Array(m.scan.getMappedRange());
			for (var c2 = 0; c2 < V; c2++) state.offset[c2] = scan[l.colCap + c2];
			state.offset[V] = scan[l.colCap + V];
			for (var c3 = 0; c3 < V; c3++) {
				var begin = scan[l.colCap + c3], end = c3 === V - 1 ? scan[l.colCap + V] : scan[l.colCap + c3 + 1];
				for (var at2 = begin; at2 < end; at2++) state.entries[at2] = bins[V + at2];
			}
		}
		state.overlaps = fo[1]; state.deaths = fo[2]; state.typeChanges = fo[3]; state.spawns = fo[4];
		state.maxSpeed = fo[5] / 4096; state.finite = fo[6] ? 0 : 1;
		var ledgers = ['producedFel', 'producedMaf', 'erodedFel', 'erodedMaf', 'subductedMaf', 'subductedSed', 'subductedArea'];
		for (var k = 0; k < 7; k++) {
			state[ledgers[k]] = reinterpretF32(fo[l.foLedger0 + k * 2]) + reinterpretF32(fo[l.foLedger0 + k * 2 + 1]);
		}
		for (var p2 = 0; p2 < l.plateCap; p2++) {
			state.plateCells[p2] = fo[l.foPlate0 + p2 * 5];
			state.subCount[p2] = fo[l.foPlate0 + p2 * 5 + 1];
			state.arcFeedN[p2] = fo[l.foPlate0 + p2 * 5 + 2];
			state.plateLost[p2] = fo[l.foPlate0 + p2 * 5 + 3];
			state.plateSpawned[p2] = fo[l.foPlate0 + p2 * 5 + 4];
		}
		if (m.diagOut) {
			var diag = new Float32Array(m.diagOut.getMappedRange()), D = GpuSim.DIAG;
			state.meanSpeed = diag[D.MEANV]; state.massFel = diag[D.MASSFEL];
			state.massMaf = diag[D.MASSMAF]; state.massSed = diag[D.MASSSED];
			for (var k2 = 0; k2 < 6; k2++) state.oreSum[k2] = diag[D.ORE0 + k2];
			state.gaps = diag[D.GAPS];
			state.quatError = diag[D.QUATERR]; state.rigidError = Math.sqrt(diag[D.RIGID2]);
			// Defect D1's witnesses: the dt and alpha the device's K10 ran with, and the
			// worst per-plate distance between the stored omega and the relaxed one. They
			// ride the mirror instead of a separate readback so any full download carries
			// them, and they live on the state (not on a GPU-only field) so the smoke and
			// the parity harness can assert on them like any other mirrored number.
			state.gpuDt = diag[D.DT]; state.gpuAlpha = diag[D.ALPHA]; state.gpuRelaxErr = diag[D.RELAXERR];
		}
		for (var r3 = 0; r3 < names.length; r3++) m[names[r3]].unmap();
		if (shared) S.stageBusy = false;
		if (GpuPerf) { S.dlWait = tw1 - tw0; S.dlRead = GpuPerf.clock() - tw1; }
	},

	// One mirror round trip: pull, event cycle and/or checkpoint, push. The event cadence
	// travels light (EVENT_READS / EVENT_WRITES); a checkpoint needs the whole mirror
	// because Checkpoint.save serializes it. The three phases are timed separately so the
	// strip shows where a hitch actually comes from (Phase I2).
	roundTrip: async function (state, events, ckpt, Events, Checkpoint) {
		var S = GpuSim.S;
		Events = Events || GpuSim.Events; Checkpoint = Checkpoint || GpuSim.Checkpoint;
		var t0 = GpuPerf ? GpuPerf.clock() : 0;
		await (ckpt ? GpuSim.download(state) : GpuSim.downloadEvents(state));
		var t1 = GpuPerf ? GpuPerf.clock() : 0;
		if (events) {
			// The span is taken at the due date, exactly as Sim.step's cycle sees it.
			Events.cycle(state, state.t - state.lastEvent);
			state.lastEvent = state.t;
		}
		var t2 = GpuPerf ? GpuPerf.clock() : 0;
		if (events) await GpuSim.uploadEvents(state);
		var t3 = GpuPerf ? GpuPerf.clock() : 0;
		if (ckpt) {
			Checkpoint.push(state);
			state.ckptDue = state.t + GpuSim.Params.ckptEvery;
		}
		if (!GpuPerf) return;
		GpuPerf.event(t3 - t0, t1 - t0, t2 - t1, t3 - t2, S.dlWait);
		if (ckpt) GpuPerf.ckpt(GpuPerf.clock() - t3);
	},

	// One full step with events on the CPU mirror, mirroring Sim.step's contract.
	// `diag` passes through to frame(): direct callers (the parity harness, the
	// single-Step button, the smoke) get diagnostics every frame; play() asks for
	// them only on the frames the HUD wants.
	step: async function (state, dt, Events, Checkpoint, Params, diag) {
		if (diag === undefined) diag = true;
		if (state.t - state.lastEvent >= Params.eventCadence) {
			await GpuSim.roundTrip(state, true, false, Events, Checkpoint);
		}
		GpuSim.frame(state, dt, diag);
		state.frame++;
		state.t += dt;
		if (state.ckptCap > 0 && state.t >= state.ckptDue) {
			await GpuSim.roundTrip(state, false, true, Events, Checkpoint);
		}
	},

	// The HUD asks for fresh diagnostics with GpuSim.wantDiag() (~6 Hz); the flag
	// is consumed by the next play() segment, and a full download always folds its
	// own diagFrame regardless.
	wantDiag: function () {
		if (GpuSim.S) GpuSim.S.diagWanted = true;
	},
	// The play path: n frames, batched one encoder per run between round-trip
	// boundaries. An event cycle needs the CPU mirror and an upload, so the
	// segment ends on the frame before one is due; a checkpoint's full round trip
	// ends the segment after its frame, exactly as n step() calls ordered them.
	//
	// The sim pipeline stays ONE SEGMENT DEEP: each encoder is built synchronously
	// (the render tail runs now, so the page's painted bookkeeping sees it in this
	// rAF) but its submit waits for the queue to drain. Without that, a setting
	// whose per-rAF work outruns the GPU (L6 1 step, L5 5 steps) enqueues an
	// ever-growing backlog - the canvas falls further behind every frame, and the
	// next event round trip's readback stalls behind everything queued ahead of it.
	// With it, the device runs at its own pace and the reported Myr/s is the rate
	// the sim actually achieves.
	//
	// `hold` is polled at the segment boundary - the only point an encoder can
	// stop (an encoder already submitted cannot be un-submitted); the page's view
	// gate stops a batch starting at all, so a drag catches at most one segment.
	// Returns the number of frames submitted so the frame loop counts real work.
	// opts.render(enc), if given, is the visible frame: it draws the world texture
	// (GpuRenderer.appendTo) and is consumed once - appended to the first segment
	// encoder, or, when an event is already due at the start, to its own encoder
	// before the round trip awaits, so the world state at the boundary is current.
	// Later segments of the same call do not draw again. The canvas itself is only
	// ever blitted by the page on a drained queue (GpuRenderer.present), which is
	// what keeps heavy settings from presenting undrawn, black frames.
	play: async function (state, dt, n, hold, opts) {
		var P = GpuSim.Params, S = GpuSim.S;
		var done = 0, want = !!S.diagWanted;
		S.diagWanted = false;
		var tail = opts && opts.render;
		function takeRender() { var r = tail; tail = null; return r; }
		function presentNow() {
			var r = takeRender();
			if (!r) return;
			var enc = S.device.createCommandEncoder();
			r(enc);
			S.device.queue.submit([enc.finish()]);
		}
		while (done < n) {
			if (done > 0 && hold && hold()) return done;
			if (state.t - state.lastEvent >= P.eventCadence) {
				presentNow();
				await GpuSim.roundTrip(state, true, false, GpuSim.Events, GpuSim.Checkpoint);
				if (S.diagWanted) { want = true; S.diagWanted = false; }
			}
			// Count the segment frame by frame against the same per-frame-accumulated
			// t step() would produce: an event cycle is due before a frame, a
			// checkpoint after one; either ends the encoder here.
			var run = 0, tj = state.t;
			while (done + run < n && run < GpuSim.FIN_MAX) {
				if (tj - state.lastEvent >= P.eventCadence) break;
				tj += dt; run++;
				if (state.ckptCap > 0 && tj >= state.ckptDue) break;
			}
			if (run < 1) run = 1;
			// A wanted diagnostic runs on the segment's last frame; opts.diagLast asks
			// for one on the final segment overall, so a full download afterwards reads
			// current counters (used by the batch-identity rig).
			var diagHere = want || (opts && opts.diagLast && done + run === n);
			// Build the encoder now (the tail runs synchronously), hold the submit for
			// the drain: the device is empty and this segment is the only work that
			// follows it.
			var enc = GpuSim.encodeBatch(state, dt, run, diagHere ? run - 1 : -1, takeRender());
			want = false;
			await S.device.queue.onSubmittedWorkDone();
			GpuSim.commitBatch(enc, run);
			for (var j = 0; j < run; j++) { state.t += dt; state.frame++; }
			done += run;
			if (state.ckptCap > 0 && state.t >= state.ckptDue) {
				await GpuSim.roundTrip(state, false, true, GpuSim.Events, GpuSim.Checkpoint);
				if (S.diagWanted) { want = true; S.diagWanted = false; }
			}
		}
		return n;
	}
};

// The edges buffer stores relN/relT as raw f32 bits in an i32 array, so every mirror
// transfer reinterprets two values per edge - 123k calls at L5. One shared 4-byte buffer
// instead of a fresh ArrayBuffer per call: the allocation was the whole cost of the
// transfer (measured: 105 ms vs 1 ms for the same upload, experiments/roundtrip-cost.js).
var castBuffer = new ArrayBuffer(4);
var castF32 = new Float32Array(castBuffer), castI32 = new Int32Array(castBuffer);

function reinterpretI32(f) {
	castF32[0] = f;
	return castI32[0];
}

function reinterpretF32(i) {
	castI32[0] = i;
	return castF32[0];
}
if (typeof module !== 'undefined' && module.exports) {
	module.exports = GpuSim;
	GpuSim.Events = require('../events.js');
	GpuSim.Checkpoint = require('../checkpoint.js');
	GpuSim.Params = require('../params.js');
} else {
	// Browser globals from the classic script tags; step() callers may still override.
	GpuSim.Events = typeof Events !== 'undefined' ? Events : null;
	GpuSim.Checkpoint = typeof Checkpoint !== 'undefined' ? Checkpoint : null;
	GpuSim.Params = typeof Params !== 'undefined' ? Params : null;
}

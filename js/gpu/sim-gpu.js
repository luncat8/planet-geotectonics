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
	// Phase I1: timestamp queries. Two per dispatch (pass start/end), up to TS_MAX
	// dispatches per frame. Adapters without the timestamp-query feature (some
	// SwiftShader builds) fall back: no queries, no per-kernel GPU ms.
	TS_MAX: 70,

	layout: function (state) {
		var g = state.grid, p = GpuParams;
		var V = g.V, colCap = state.colCap, plateCap = state.plateCap;
		var l = {
			V: V, colCap: colCap, plateCap: plateCap,
			A0ref: 4 * Math.PI * p.radius * p.radius / V,
			foLedger0: 14, foPlate0: 28,
			nwg10: 64, nwgD: 0, chunkD: 0
		};
		l.chunk10 = Math.ceil(V / l.nwg10);
		l.chunk10e = Math.ceil(V * 6 / l.nwg10);
		l.chunkD = 2048;
		l.nwgD = Math.ceil(colCap / l.chunkD);
		l.chunkL = 2048;
		l.nwgL = Math.ceil(colCap / l.chunkL);
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
			+ 7 * colCap + 7 * l.nwgL;
		l.scan = 2 * colCap + 1 + l.nBlocksMax;
		l.frameIn = 74;
		l.frameOut = l.foPlate0 + plateCap * 5;
		l.diagOut = 14;
		return l;
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

	init: async function (state, opts) {
		var t0 = Date.now();
		opts = opts || {};
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
		var l = GpuSim.layout(state);
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
					entries.push({ binding: B[bufs[b]], resource: { buffer: S.buf[bufs[b]] } });
				}
			}
			if (entries.length > device.limits.maxStorageBuffersPerShaderStage) {
				throw new Error(name + ' binds ' + entries.length + ' storage buffers (limit '
					+ device.limits.maxStorageBuffersPerShaderStage + ')');
			}
			var layout = device.createBindGroupLayout({ entries: entries.map(function (e) {
				var ro = e.binding === B.gridF || e.binding === B.gridI || e.binding === B.frameIn;
				return { binding: e.binding, visibility: 4, buffer: { type: ro ? 'read-only-storage' : 'storage' } };
			}) });
			var group = device.createBindGroup({ layout: layout, entries: entries });
			var pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				compute: { module: mod, entryPoint: 'main' } });
			S.K[name] = { pipe: pipe, group: group, layout: layout };
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

	// Pack the dynamic mirror into the GPU buffers. Everything the frame kernels read.
	uploadState: async function (state) {
		var S = GpuSim.S, l = S.l, d = S.device, g = state.grid, V = g.V, n = state.colCap;
		var colF = new Float32Array(l.colF), colI = new Int32Array(l.colI);
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
		d.queue.writeBuffer(S.buf.colF, 0, colF);
		d.queue.writeBuffer(S.buf.colI, 0, colI);
		var plateF = new Float32Array(l.plateF), plateI = new Int32Array(l.plateI);
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
		var cellI = new Int32Array(l.cellI);
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
		var cellF = new Float32Array(l.cellF);
		for (var c2 = 0; c2 < V; c2++) {
			var fb = c2 * 8, cb = c2 * 3;
			cellF[fb * 4] = state.vel[cb]; cellF[fb * 4 + 1] = state.vel[cb + 1]; cellF[fb * 4 + 2] = state.vel[cb + 2]; cellF[fb * 4 + 3] = state.z[c2];
			cellF[(fb + 1) * 4] = state.gradZ[cb]; cellF[(fb + 1) * 4 + 1] = state.gradZ[cb + 1]; cellF[(fb + 1) * 4 + 2] = state.gradZ[cb + 2]; cellF[(fb + 1) * 4 + 3] = state.slope[c2];
			cellF[(fb + 2) * 4] = state.uMantle[cb]; cellF[(fb + 2) * 4 + 1] = state.uMantle[cb + 1]; cellF[(fb + 2) * 4 + 2] = state.uMantle[cb + 2]; cellF[(fb + 2) * 4 + 3] = state.plumeT[c2];
			cellF[(fb + 3) * 4] = state.mobile[c2]; cellF[(fb + 3) * 4 + 1] = state.mobileFel[c2]; cellF[(fb + 3) * 4 + 2] = state.mobilePla[c2]; cellF[(fb + 3) * 4 + 3] = state.ext[c2];
		}
		d.queue.writeBuffer(S.buf.cellF, 0, cellF);
		var edges = new Int32Array(l.edges);
		for (var e = 0; e < V * 6; e++) {
			edges[e * 4] = reinterpretI32(state.relN[e]);
			edges[e * 4 + 1] = reinterpretI32(state.relT[e]);
			edges[e * 4 + 2] = (state.edgeType[e] & 0xff) | (((state.polarity[e] + 1) & 0xff) << 8);
		}
		d.queue.writeBuffer(S.buf.edges, 0, edges);
		// frameOut: n + cumulative counters + 64-bit ledger pairs + per-plate atomics.
		var fo = new Int32Array(l.frameOut);
		var ledBuf = new ArrayBuffer(4), ledF32 = new Float32Array(ledBuf), ledI32 = new Int32Array(ledBuf);
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
		await GpuSim.uploadFrame(state, 0.1);
	},

	// The per-frame scalar block: mantle bookkeeping stays on the CPU (cheap, sequential
	// RNG), the per-cell flow is the GPU kernel.
	uploadFrame: function (state, dt) {
		var S = GpuSim.S, l = S.l, p = GpuParams;
		var fin = new Float32Array(l.frameIn);
		state.Tm = GpuMantle.Tm(state.t, state.Tm0);
		GpuMantle.precess(state);
		for (var i = 0; i < state.plumeCount; i++) {
			while (state.t >= state.plumeBirth[i] + state.plumeLife[i]) {
				GpuMantle.spawnPlume(state, i, state.plumeBirth[i] + state.plumeLife[i]);
			}
		}
		var speed = p.U0 * Math.pow(state.Tm, 2.5);
		var sig = p.plumeRad / p.radius;
		fin[0] = state.t; fin[1] = dt; fin[2] = state.Tm;
		fin[3] = state.mantleScale * speed; fin[4] = speed; fin[5] = 1 / (sig * sig);
		fin[6] = state.plateCount; fin[7] = state.frame;
		for (var w = 0; w < p.nWave; w++) {
			fin[8 + w * 3] = state.waveDir[w * 3]; fin[8 + w * 3 + 1] = state.waveDir[w * 3 + 1]; fin[8 + w * 3 + 2] = state.waveDir[w * 3 + 2];
			fin[32 + w] = state.waveFreq[w]; fin[40 + w] = state.wavePhase[w]; fin[48 + w] = state.waveAmp[w];
		}
		for (var q = 0; q < state.plumeCount; q++) {
			fin[56 + q * 4] = state.plumePos[q * 3]; fin[56 + q * 4 + 1] = state.plumePos[q * 3 + 1];
			fin[56 + q * 4 + 2] = state.plumePos[q * 3 + 2]; fin[56 + q * 4 + 3] = state.plumeStr[q];
		}
		fin[72] = state.plumeCount;
		fin[73] = state.grid.A0[0];
		S.device.queue.writeBuffer(S.buf.frameIn, 0, fin);
	},

	groups: Math.ceil,

	// Dispatch helpers: `run` takes a thread count, `runGroups` a workgroup count.
	run: function (S, enc, name, threads, wg) {
		GpuSim.runGroups(S, enc, name, Math.ceil(threads / wg), wg);
	},
	runGroups: function (S, enc, name, groups, wg) {
		var k = S.K[name];
		if (!k) throw new Error('missing kernel ' + name);
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
		pass.setBindGroup(0, k.group);
		pass.dispatchWorkgroups(groups);
		pass.end();
	},

	// The whole frame, in Sim.step order. resolve is dispatched enough times for the
	// longest loser chain (each dispatch is one barrier-separated pointer jump).
	frame: function (state, dt) {
		var S = GpuSim.S, l = S.l, V = l.V, colCap = l.colCap, WG = GpuSim.WG;
		GpuSim.uploadFrame(state, dt);
		var enc = S.device.createCommandEncoder();
		if (S.tsOn) { S.tsActive = true; S.tsSlot = 0; }
		GpuSim.run(S, enc, 'zeroFrame', 6 + l.plateCap * 3 + l.colCap * 8, WG);
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
		GpuSim.run(S, enc, 'loserRank', colCap, 64);
		GpuSim.run(S, enc, 'gather', colCap, 64);
		GpuSim.run(S, enc, 'ownerClear', V, WG);
		GpuSim.run(S, enc, 'winners', l.plateCap, WG);
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
		GpuSim.run(S, enc, 'diagA', l.nwgD, 1);
		GpuSim.run(S, enc, 'diagC', Math.ceil(V / l.chunkD), 1);
		GpuSim.run(S, enc, 'diagB', 1, 1);
		GpuSim.runGroups(S, enc, 'ledgerReduceA', l.nwgL, WG);
		GpuSim.run(S, enc, 'ledgerReduceB', 7, WG);
		if (S.tsOn) {
			S.tsActive = false;
			// Resolve, then copy to the map buffer (MAP_READ cannot carry QUERY_RESOLVE).
			var pair = S.tsRingI, size = GpuSim.TS_MAX * 2 * 8;
			enc.resolveQuerySet(S.ts, 0, S.tsSlot * 2, S.tsResolve[pair], 0);
			enc.copyBufferToBuffer(S.tsResolve[pair], 0, S.tsMap[pair], 0, size);
			S.tsSlotUsed[pair] = S.tsSlot;
			S.tsRingI = (pair + 1) % 4;
		}
		S.device.queue.submit([enc.finish()]);
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
		GpuSim.run(S, enc, 'zeroFrame', 6 + l.plateCap * 3 + l.colCap * 8, WG);
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
		GpuSim.run(S, enc, 'zeroFrame', 6 + l.plateCap * 3 + l.colCap * 8, WG);
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

	// Full mirror sync back. One staging buffer per source, one submit, then unpack.
	download: async function (state) {
		var S = GpuSim.S, l = S.l, d = S.device, g = state.grid, V = g.V;
		var reads = ['colF', 'colI', 'plateF', 'plateI', 'cellF', 'cellI', 'edges', 'bins', 'scan', 'frameOut', 'diagOut'];
		var enc = d.createCommandEncoder(), stage = {};
		for (var r = 0; r < reads.length; r++) {
			var name = reads[r];
			stage[name] = d.createBuffer({ size: Math.max(16, S.buf[name].size), usage: 0x1 | 0x8 });
			enc.copyBufferToBuffer(S.buf[name], 0, stage[name], 0, S.buf[name].size);
		}
		d.queue.submit([enc.finish()]);
		var maps = [];
		for (var r2 = 0; r2 < reads.length; r2++) maps.push(stage[reads[r2]].mapAsync(1));
		await Promise.all(maps);
		var colF = new Float32Array(stage.colF.getMappedRange());
		var colI = new Int32Array(stage.colI.getMappedRange());
		for (var i = 0; i < l.colCap; i++) {
			var b = i * 6, o = i * 4, w = i * 3;
			state.body[w] = colF[b * 4]; state.body[w + 1] = colF[b * 4 + 1]; state.body[w + 2] = colF[b * 4 + 2]; state.area[i] = colF[b * 4 + 3];
			state.world[w] = colF[(b + 1) * 4]; state.world[w + 1] = colF[(b + 1) * 4 + 1]; state.world[w + 2] = colF[(b + 1) * 4 + 2]; state.hFel[i] = colF[(b + 1) * 4 + 3];
			state.hMaf[i] = colF[(b + 2) * 4]; state.hSed[i] = colF[(b + 2) * 4 + 1]; state.age[i] = colF[(b + 2) * 4 + 2]; state.damage[i] = colF[(b + 2) * 4 + 3];
			state.fert[i] = colF[(b + 3) * 4]; state.oVms[i] = colF[(b + 3) * 4 + 1]; state.oMaf[i] = colF[(b + 3) * 4 + 2]; state.oArc[i] = colF[(b + 3) * 4 + 3];
			state.oOro[i] = colF[(b + 4) * 4]; state.oBas[i] = colF[(b + 4) * 4 + 1]; state.oPla[i] = colF[(b + 4) * 4 + 2]; state.zDyn[i] = colF[(b + 4) * 4 + 3];
			state.zDynNext[i] = colF[(b + 5) * 4]; state.collapseDelta[i] = colF[(b + 5) * 4 + 1];
			state.plate[i] = colI[o]; state.cell[i] = colI[o + 1]; state.consumedBy[i] = colI[o + 2]; state.alive[i] = colI[o + 3];
		}
		var plateF = new Float32Array(stage.plateF.getMappedRange());
		var plateI = new Int32Array(stage.plateI.getMappedRange());
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
		var cellF = new Float32Array(stage.cellF.getMappedRange());
		var cellI = new Int32Array(stage.cellI.getMappedRange());
		for (var c = 0; c < V; c++) {
			var fb = c * 8, cb = c * 3, co = c * 13;
			state.vel[cb] = cellF[fb * 4]; state.vel[cb + 1] = cellF[fb * 4 + 1]; state.vel[cb + 2] = cellF[fb * 4 + 2]; state.z[c] = cellF[fb * 4 + 3];
			state.gradZ[cb] = cellF[(fb + 1) * 4]; state.gradZ[cb + 1] = cellF[(fb + 1) * 4 + 1]; state.gradZ[cb + 2] = cellF[(fb + 1) * 4 + 2]; state.slope[c] = cellF[(fb + 1) * 4 + 3];
			state.uMantle[cb] = cellF[(fb + 2) * 4]; state.uMantle[cb + 1] = cellF[(fb + 2) * 4 + 1]; state.uMantle[cb + 2] = cellF[(fb + 2) * 4 + 2]; state.plumeT[c] = cellF[(fb + 2) * 4 + 3];
			state.mobile[c] = cellF[(fb + 3) * 4]; state.mobileFel[c] = cellF[(fb + 3) * 4 + 1]; state.mobilePla[c] = cellF[(fb + 3) * 4 + 2]; state.ext[c] = cellF[(fb + 3) * 4 + 3];
			state.outflow[c] = cellF[(fb + 4) * 4]; state.outflowFel[c] = cellF[(fb + 4) * 4 + 1]; state.outflowPla[c] = cellF[(fb + 4) * 4 + 2];
			state.stay[c] = cellF[(fb + 5) * 4]; state.stayFel[c] = cellF[(fb + 5) * 4 + 1]; state.stayPla[c] = cellF[(fb + 5) * 4 + 2];
			state.wEq[cb] = cellF[(fb + 7) * 4]; state.wEq[cb + 1] = cellF[(fb + 7) * 4 + 1]; state.wEq[cb + 2] = cellF[(fb + 7) * 4 + 2];
			state.owner[c] = cellI[co]; state.cellPlate[c] = cellI[co + 1]; state.low[c] = cellI[co + 2];
			state.spawnSlot[c] = cellI[co + 3]; state.gapPlate[c] = cellI[co + 4];
			state.gapDonor[c * 3] = cellI[co + 5]; state.gapDonor[c * 3 + 1] = cellI[co + 6]; state.gapDonor[c * 3 + 2] = cellI[co + 7];
			state.trenchDist[c] = cellI[co + 8] & 3;
			state.gapFrames[c] = (cellI[co + 8] >>> 4) & 0xffff;
			state.distance[c] = cellI[co + 9] === 0x7fffffff ? Infinity : cellI[co + 9] / 256;
			state.gapTime[c] = cellI[co + 10] / 1e5;
			state.gapDonorN[c] = cellI[co + 12];
			state.wet[c] = state.z[c] < 0 ? 1 : 0;
		}
		var edges = new Int32Array(stage.edges.getMappedRange());
		for (var e = 0; e < V * 6; e++) {
			state.relN[e] = reinterpretF32(edges[e * 4]);
			state.relT[e] = reinterpretF32(edges[e * 4 + 1]);
			state.edgeType[e] = edges[e * 4 + 2] & 0xff;
			state.polarity[e] = ((edges[e * 4 + 2] >> 8) & 0xff) - 1;
		}
		var bins = new Int32Array(stage.bins.getMappedRange());
		var scan = new Int32Array(stage.scan.getMappedRange());
		for (var c2 = 0; c2 < V; c2++) state.offset[c2] = scan[l.colCap + c2];
		state.offset[V] = scan[l.colCap + V];
		for (var c3 = 0; c3 < V; c3++) {
			var begin = scan[l.colCap + c3], end = c3 === V - 1 ? scan[l.colCap + V] : scan[l.colCap + c3 + 1];
			for (var at2 = begin; at2 < end; at2++) state.entries[at2] = bins[V + at2];
		}
		var fo = new Int32Array(stage.frameOut.getMappedRange());
		state.n = fo[0];
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
		var diag = new Float32Array(stage.diagOut.getMappedRange());
		state.meanSpeed = diag[0]; state.massFel = diag[1]; state.massMaf = diag[2]; state.massSed = diag[3];
		for (var k2 = 0; k2 < 6; k2++) state.oreSum[k2] = diag[4 + k2];
		state.gaps = diag[10];
		state.quatError = diag[12]; state.rigidError = Math.sqrt(diag[13]);
		for (var r3 = 0; r3 < reads.length; r3++) stage[reads[r3]].unmap();
	},

	// One full step with events on the CPU mirror, mirroring Sim.step's contract.
	// Sync mode is for tests and the parity harness; the render loop calls frame()
	// directly and downloads on its own cadence.
	step: async function (state, dt, Events, Checkpoint, Params) {
		// Phase I2: the round trip and the checkpoint push are exactly the
		// candidates for the visible GPU-mode hitches, so the HUD sees their
		// wall time (Perf is optional: the node parity paths run without it).
		if (state.t - state.lastEvent >= Params.eventCadence) {
			var t0 = GpuPerf ? GpuPerf.clock() : 0;
			await GpuSim.download(state);
			Events.cycle(state);
			state.lastEvent = state.t;
			await GpuSim.uploadState(state);
			if (GpuPerf) GpuPerf.event(GpuPerf.clock() - t0);
		}
		GpuSim.frame(state, dt);
		state.frame++;
		state.t += dt;
		if (state.ckptCap > 0 && state.t >= state.ckptDue) {
			var t1 = GpuPerf ? GpuPerf.clock() : 0;
			await GpuSim.download(state);
			Checkpoint.push(state);
			state.ckptDue = state.t + Params.ckptEvery;
			if (GpuPerf) GpuPerf.ckpt(GpuPerf.clock() - t1);
		}
	},

	advance: async function (state, dt, frames) {
		for (var i = 0; i < frames; i++) await GpuSim.step(state, dt, GpuSim.Events, GpuSim.Checkpoint, GpuSim.Params);
	}
};

function reinterpretI32(f) {
	var b = new ArrayBuffer(4);
	new Float32Array(b)[0] = f;
	return new Int32Array(b)[0];
}

function reinterpretF32(i) {
	var b = new ArrayBuffer(4);
	new Int32Array(b)[0] = i;
	return new Float32Array(b)[0];
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

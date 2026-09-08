/* gpu/sim-gpu.js — the WebGPU twin of sim.js: same kernel order, same event cadence, same
   checkpoint ring. The CPU State stays the authoring copy: upload() mirrors it into the five
   arenas, frames run entirely on the device, and every eventCadence a small async readback
   (pair tables, plate/crust identifiers, uMantle, diagnostics) lets the event kernels run on
   the CPU unchanged — applied one cycle late, as the plan allows — after which the mutated
   arrays (plate, damage, body, world, plate table, free list) go back up.

   colHigh, the spawn bump allocator and the free-list cursor are GPU-owned between events: the
   per-frame globals write never touches them. Frames allocate a command encoder per step
   (WebGPU has no reusable recording); no other per-frame CPU allocation happens. */
var GpuLayoutMod = typeof module !== 'undefined' && module.exports ? require('./layout.js') : { GpuLayout: GpuLayout };
var GpuCommon = typeof module !== 'undefined' && module.exports ? require('./common.wgsl.js') : { prelude: prelude, fnum: fnum };
var SimParamsGpu = typeof module !== 'undefined' && module.exports ? require('../params.js') : Params;
var SimMantleGpu = typeof module !== 'undefined' && module.exports ? require('../mantle.js') : Mantle;
var SimEventsGpu = typeof module !== 'undefined' && module.exports ? require('../events.js') : Events;
var SimCheckpointGpu = typeof module !== 'undefined' && module.exports ? require('../checkpoint.js') : Checkpoint;

// Kernel bodies come from the .wgsl.js files: requires under node, the globals those files
// define as classic scripts in the browser (same order in both worlds).
var GpuKernelBodies = typeof module !== 'undefined' && module.exports
	? [require('./scan.wgsl.js'), require('./mantle.wgsl.js'), require('./plates.wgsl.js'),
		require('./columns.wgsl.js'), require('./bin.wgsl.js'), require('./raster.wgsl.js'),
		require('./edges.wgsl.js'), require('./contact.wgsl.js'), require('./column.wgsl.js'),
		require('./surface.wgsl.js'), require('./forces.wgsl.js'), require('./diag.wgsl.js'),
		require('./events.wgsl.js')]
	: [ScanWgsl, MantleWgsl, PlatesWgsl, ColumnsWgsl, BinWgsl, RasterWgsl, EdgesWgsl, ContactWgsl,
		ColumnWgsl, SurfaceWgsl, ForcesWgsl, DiagWgsl, EventsWgsl];

var f32Scratch = new Float32Array(1), u32Scratch = new Uint32Array(f32Scratch.buffer);
function bitcastWord(v) { f32Scratch[0] = v; return u32Scratch[0]; }

// CPU value -> u32 word. Crust stays u32 millimetres (f32-like precision at km scale, exact
// atomic adds), potentials 1e-6, zDyn centimetres; everything else is an f32 bitcast or raw.
function toWord(kind, v) {
	if (kind === 'f32') return bitcastWord(v);
	if (kind === 'mm') return Math.max(0, Math.round(v * 1000));
	if (kind === 'ore') return Math.round(Math.max(0, Math.min(1, v)) * 1e6);
	if (kind === 'cm') return Math.round(v * 100) | 0;
	if (kind === 'pairLen') return Math.max(0, Math.round(v));
	if (kind === 'pairVel') return Math.max(0, Math.round(v / 1000));
	return v;
}
function fromWord(kind, v) {
	if (kind === 'f32') return v;
	if (kind === 'mm') return v / 1000;
	if (kind === 'ore') return v / 1e6;
	if (kind === 'cm') return (v << 0) / 100;
	if (kind === 'pairVel') return v * 1000;
	return v;
}

// Field name -> conversion kind and CPU home. One table drives upload, readback decode and the
// parity harness; the three composite fields (pos+area, ore six-pack, plume+strength) build
// their words with get(), everything else copies straight from a CPU array.
GpuSim.ORE = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];
GpuSim.FIELD_KIND = {
	pos: 'f32', ring: 'raw', ringN: 'raw', nbrDist: 'f32', edgeLen: 'f32', faceN: 'f32', faceT: 'f32',
	fluxN: 'f32', collapseW: 'f32', gradInv: 'f32', gapLimit2: 'f32', contactLimit2: 'f32', lookup: 'f32',
	body: 'f32', world: 'f32', area: 'f32', fel: 'mm', maf: 'mm', sed: 'mm', age: 'f32', damage: 'f32',
	fert: 'f32', ore: 'ore', zdyn: 'cm', zdynNext: 'cm', alive: 'raw', plate: 'raw', cell: 'raw',
	owner: 'raw', dist: 'f32', cellPlate: 'raw', relN: 'f32', relT: 'f32', eType: 'raw', pol: 'raw',
	trench: 'raw', ext: 'f32', plumeT: 'f32', u: 'f32', vel: 'f32', z: 'f32', wet: 'raw', gradZ: 'f32',
	slope: 'f32', low: 'raw', mobile: 'mm', mobileFel: 'mm', mobilePla: 'mm', gapFrames: 'raw',
	gapTime: 'f32', gapPlate: 'raw', gapDonor: 'raw', gapDonorN: 'raw', q: 'f32', omega: 'f32',
	omegaT: 'f32', cells: 'raw', spawned: 'raw', lost: 'raw', birth: 'f32', parent: 'raw',
	pairLen: 'pairLen', pairVel: 'pairVel', pairOk: 'raw', waveDir: 'f32', waveFreq: 'f32',
	wavePhase: 'f32', waveAmp: 'f32', plume: 'f32', plumeCount: 'f32'
};
// CPU arrays with stride 3 that the GPU pads to stride 4, and the ones that rename.
GpuSim.FIELD_PAD = { pos: 4, body: 3, world: 3, u: 3, vel: 3, gradZ: 3, omega: 3, omegaT: 3, waveDir: 3, plume: 4 };
GpuSim.CPU_NAME = { fel: 'hFel', maf: 'hMaf', sed: 'hSed', dist: 'distance', eType: 'edgeType',
	trench: 'trenchDist', pol: 'polarity', collapseW: 'collapseWeight', omegaT: 'omega',
	u: 'uMantle', cells: 'plateCells', spawned: 'plateSpawned', lost: 'plateLost',
	birth: 'plateBirth', parent: 'plateParent' };

function GpuFieldSource(sim, name) {
	var kind = GpuSim.FIELD_KIND[name];
	if (!kind) return null;
	var g = sim.grid, s = sim.state;
	switch (name) {
		case 'pos': return { get: function (e, w) { return w < 3 ? g.pos[e * 3 + w] : g.A0[e]; }, kind: kind };
		case 'ore': return { get: function (e, w) { return s[GpuSim.ORE[w]][e]; }, kind: kind };
		case 'plume': return { get: function (e, w) { return w < 3 ? s.plumePos[e * 3 + w] : s.plumeStr[e]; }, kind: kind };
		case 'plumeCount': return { scalar: s.plumeCount, kind: kind };
		case 'zdyn': case 'zdynNext': return { arr: s.zDyn, kind: kind };
		case 'body': case 'world': case 'q': case 'omega': case 'omegaT': case 'waveDir':
		case 'waveFreq': case 'wavePhase': case 'waveAmp': case 'area': case 'age': case 'damage':
		case 'fert': case 'relN': case 'relT': case 'ext': case 'plumeT': case 'z': case 'slope':
		case 'gapTime': case 'birth':
			return { arr: s[GpuSim.CPU_NAME[name] || name], kind: kind };
		default:
			var home = GpuSim.CPU_NAME[name] || name;
			return { arr: home in g ? g[home] : s[home], kind: kind };
	}
}

var EVENT_FIELDS = ['q', 'omega', 'cells', 'spawned', 'lost', 'birth', 'parent', 'pairLen', 'pairVel',
	'pairOk', 'alive', 'plate', 'cell', 'damage', 'cellPlate', 'owner', 'u'];
var CKPT_FIELDS = ['body', 'area', 'fel', 'maf', 'sed', 'age', 'damage', 'zdyn', 'alive', 'plate', 'cell',
	'q', 'omega', 'cells', 'spawned', 'lost', 'birth', 'parent', 'gapFrames', 'gapTime', 'eType',
	'mobile', 'mobileFel', 'mobilePla', 'fert', 'ore'];

function GpuSim(grid, state) {
	this.grid = grid;
	this.state = state;
	this.layout = new GpuLayoutMod.GpuLayout(grid);
	this.kernels = GpuKernelBodies;
	this.eventArrived = false;
	this.eventPending = false;
	this.ckptPending = false;
	this.ckptArrived = false;
	this.staticUploaded = false;
	this.colHigh = 0;
	this.freeCount = 0;
	// CPU-side arena mirrors: plain ArrayBuffers, usable before a device exists (node tests,
	// upload preparation). init() creates only the device-side buffers and pipelines.
	this.arenaU = [];
	this.arenaF = [];
	this.arenaI = [];
	for (var a = 0; a < 5; a++) {
		var ab = new ArrayBuffer(this.layout.arenaBytes[a]);
		this.arenaU.push(new Uint32Array(ab));
		this.arenaF.push(new Float32Array(ab));
		this.arenaI.push(new Int32Array(ab));
	}
}

GpuSim.prototype.init = function () {
	var self = this, L = this.layout;
	return navigator.gpu.requestAdapter().then(function (adapter) {
		if (!adapter) throw new Error('no WebGPU adapter');
		return adapter.requestDevice();
	}).then(function (device) {
		self.device = device;
		device.onuncapturederror = function (ev) { console.error('webgpu:', ev.error && ev.error.message || ev.error); };
		self.arenaBuf = [];
		for (var a = 0; a < 5; a++) {
			self.arenaBuf.push(device.createBuffer({ size: L.arenaBytes[a], usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
		}
		var prelude = GpuCommon.prelude(L), modules = {}, firstLayout = null;
		self.pipeline = {};
		for (var k = 0; k < self.kernels.length; k++) {
			var body = self.kernels[k];
			var mod = modules[body.entry[0]];
			if (!mod) {
				mod = device.createShaderModule({ code: prelude + body() });
				modules[body.entry[0]] = mod;
				if (mod.getCompilationInfo) {
					mod.getCompilationInfo().then(function (info) {
						for (var m = 0; m < info.messages.length; m++) {
							if (info.messages[m].type === 'error') console.error('wgsl:', info.messages[m].message);
						}
					});
				}
			}
			for (var e = 0; e < body.entry.length; e++) {
				var pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: body.entry[e] } });
				self.pipeline[body.entry[e]] = pipe;
				if (!firstLayout) firstLayout = pipe.getBindGroupLayout(0);
			}
		}
		self.bindGroup = device.createBindGroup({
			layout: firstLayout,
			entries: L.arenaBytes.map(function (bytes, i) {
				return { binding: i, resource: { buffer: self.arenaBuf[i] } };
			})
		});
		self.plans = { event: self.makePlan(EVENT_FIELDS), ckpt: self.makePlan(CKPT_FIELDS) };
		for (var pi in self.plans) {
			self.plans[pi].staging = device.createBuffer({
				size: self.plans[pi].bytes,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
			});
		}
		var g0 = L.field[L.globals[0]];
		self.globalsImage = new Uint32Array(L.arenaWords[4] - g0.offset);
		self.globalsIndex = {};
		for (var n = 0; n < L.globals.length; n++) self.globalsIndex[L.globals[n]] = n;
		self.globalsBase = g0.offset;
		self.trenchFill = new Uint32Array(L.V).fill(0x03030303);
		self.onesFill = new Uint32Array(L.plateCap * L.plateCap).fill(1);
		return self;
	});
};

GpuSim.prototype.makePlan = function (fields) {
	var L = this.layout, plan = { fields: fields, entries: [], bytes: 0, byName: {} };
	for (var i = 0; i < fields.length; i++) {
		var f = L.field[fields[i]];
		plan.byName[fields[i]] = { offset: plan.bytes, words: f.stride * f.count };
		plan.entries.push({ arena: f.arena, src: f.offset * 4, bytes: f.stride * f.count * 4, dst: plan.bytes });
		plan.bytes += f.stride * f.count * 4;
	}
	var g0 = L.field[L.globals[0]];
	plan.globalsAt = plan.bytes;
	plan.globalsWords = L.arenaWords[4] - g0.offset;
	plan.entries.push({ arena: 4, src: g0.offset * 4, bytes: plan.globalsWords * 4, dst: plan.bytes });
	plan.bytes += plan.globalsWords * 4;
	return plan;
};

GpuSim.prototype.copyField = function (name) {
	var src = GpuFieldSource(this, name);
	if (!src) throw new Error('no cpu source for gpu field ' + name);
	var f = this.layout.field[name], arr = src.arr;
	var stride = src.cpuStride !== undefined ? src.cpuStride : f.stride;
	for (var e = 0; e < f.count; e++) {
		for (var w = 0; w < f.stride; w++) {
			var v;
			if (src.get) v = src.get(e, w);
			else if (src.scalar !== undefined) v = e === 0 ? src.scalar : 0;
			else v = w < stride ? arr[e * stride + w] : 0;
			this.arenaU[f.arena][f.offset + e * f.stride + w] = toWord(src.kind, v);
		}
	}
};

GpuSim.prototype.uploadStatics = function () {
	var names = ['pos', 'ring', 'ringN', 'nbrDist', 'edgeLen', 'faceN', 'faceT', 'fluxN', 'collapseW',
		'gradInv', 'gapLimit2', 'contactLimit2', 'lookup'];
	for (var i = 0; i < names.length; i++) this.copyField(names[i]);
	var L = this.layout;
	for (var c = 0; c < L.V; c++) this.arenaF[0][L.field.spawnLimit.offset + c] = SimParamsGpu.rSpawn * this.grid.nbrDist[c];
	this.staticUploaded = true;
};

GpuSim.prototype.colHighOf = function () {
	var alive = this.state.alive;
	for (var i = alive.length - 1; i >= 0; i--) if (alive[i]) return i + 1;
	return 0;
};

GpuSim.prototype.buildFreeList = function () {
	// Lowest free index first: allocation order stays deterministic between events.
	var L = this.layout, alive = this.state.alive, free = this.arenaU[4], base = L.field.freeList.offset, n = 0;
	for (var i = 0; i < L.colCap; i++) {
		if (!alive[i]) { free[base + n] = i; n++; }
	}
	this.freeCount = n;
	this.colHigh = this.colHighOf();
};

// GPU-owned globals: written only when the CPU genuinely knows them (upload, event application).
GpuSim.prototype.writeGpuOwnedGlobals = function () {
	var gi = this.globalsIndex;
	this.globalsImage[gi.gColHigh] = this.colHigh;
	this.globalsImage[gi.gFreeCount] = this.freeCount;
	this.globalsImage[gi.gSpawnBump] = this.colHigh;
	this.device.queue.writeBuffer(this.arenaBuf[4], (this.globalsBase + gi.gColHigh) * 4,
		this.globalsImage, gi.gColHigh * 4, 3 * 4);
};

GpuSim.prototype.zeroScratch = function () {
	// Transfer scratch the CPU never authors: bins, gather lists, doses, routing, accumulators.
	// The source/sink ledgers are run-cumulative (CPU rebases them only on reset), so they zero
	// here too — once, at upload — never per frame.
	var L = this.layout, i, names = ['binCount', 'binOffset', 'binEntries', 'spawnFlag', 'spawnSlot',
		'glCount', 'glCursor', 'glList', 'm6', 'rhs', 'subRate', 'subCount', 'arcFeed', 'arcFeedN'];
	for (i = 0; i < names.length; i++) {
		var f = L.field[names[i]];
		this.arenaU[f.arena].fill(0, f.offset, f.offset + f.stride * f.count);
	}
	var xNames = ['belt', 'inflow', 'inflowFel', 'inflowPla', 'outflow', 'outflowFel', 'outflowPla',
		'doseArc', 'doseBas', 'dosePla'];
	for (i = 0; i < xNames.length; i++) {
		var xf = L.field[xNames[i]];
		this.arenaU[2].fill(0, xf.offset, xf.offset + xf.stride * xf.count);
	}
	this.arenaU[1].fill(0xffffffff, L.field.consumed.offset, L.field.consumed.offset + L.colCap);
	var gi = this.globalsIndex, lo = this.globalsBase + gi.gLedProdFelLo, hi = this.globalsBase + gi.gLedSubAreaHi;
	// Both copies: the arena words ride flushArenas(), the image words ride the per-frame
	// globals write — both must start at zero or the first frames resurrect stale totals.
	this.arenaU[4].fill(0, lo, hi + 1);
	this.globalsImage.fill(0, gi.gLedProdFelLo, gi.gLedSubAreaHi + 1);
};

GpuSim.prototype.upload = function () {
	if (!this.staticUploaded) this.uploadStatics();
	var names = ['body', 'world', 'area', 'fel', 'maf', 'sed', 'age', 'damage', 'fert', 'ore',
		'zdyn', 'zdynNext', 'alive', 'plate', 'cell', 'owner', 'dist', 'cellPlate', 'relN', 'relT',
		'eType', 'pol', 'trench', 'ext', 'plumeT', 'u', 'vel', 'z', 'wet', 'gradZ', 'slope', 'low',
		'mobile', 'mobileFel', 'mobilePla', 'gapFrames', 'gapTime', 'gapPlate', 'gapDonor', 'gapDonorN',
		'q', 'omega', 'omegaT', 'cells', 'spawned', 'lost', 'birth', 'parent', 'pairLen', 'pairVel', 'pairOk',
		'waveDir', 'waveFreq', 'wavePhase', 'waveAmp', 'plume', 'plumeCount'];
	for (var i = 0; i < names.length; i++) this.copyField(names[i]);
	this.zeroScratch();
	this.buildFreeList();
	this.writeGpuOwnedGlobals();
	this.writeGlobalsImage(0.1);
	this.writeWavesPlumes();
	this.flushArenas([0, 1, 2, 3, 4]);
};

GpuSim.prototype.flushArenas = function (list) {
	for (var i = 0; i < list.length; i++) {
		this.device.queue.writeBuffer(this.arenaBuf[list[i]], 0, this.arenaU[list[i]].buffer);
	}
};

// Per-frame scalar block. Accumulators are zeroed here so the frame's GPU atomics are exactly
// what the next readback sees — the same contract as the CPU's per-frame counters.
GpuSim.prototype.writeGlobalsImage = function (dt) {
	var p = SimParamsGpu, s = this.state, gi = this.globalsIndex, img = this.globalsImage;
	var invCD = Math.exp(-p.Ea * (1 / s.Tm - 1));
	setWord(img, gi.gT, toWord('f32', s.t));
	setWord(img, gi.gDt, toWord('f32', dt));
	setWord(img, gi.gTm, toWord('f32', s.Tm));
	setWord(img, gi.gTm0, toWord('f32', s.Tm0));
	setWord(img, gi.gSpeed, toWord('f32', p.U0 * Math.pow(s.Tm, 2.5)));
	setWord(img, gi.gRidge, toWord('f32', p.kRidge * invCD));
	setWord(img, gi.gColl, toWord('f32', p.vColl / p.vRef * invCD));
	setWord(img, gi.gSlab, toWord('f32', p.vSlab * invCD / p.ageSlab));
	setWord(img, gi.gAlpha, toWord('f32', Math.min(1, dt / p.tauOmega)));
	setWord(img, gi.gRelaxDyn, toWord('f32', Math.min(1, dt / p.tauDyn)));
	setWord(img, gi.gPlumeRelax, toWord('f32', Math.min(1, dt / p.tauPlume)));
	setWord(img, gi.gDynDecay, toWord('f32', Math.exp(-dt / p.tauDyn)));
	setWord(img, gi.gInvSig, toWord('f32', Math.pow(p.radius / p.plumeRad, 2)));
	setWord(img, gi.gMantleScale, toWord('f32', s.mantleScale));
	setWord(img, gi.gRadius, toWord('f32', p.radius));
	setWord(img, gi.gCap, toWord('f32', p.vMax / p.radius));
	setWord(img, gi.gPlumeCount, toWord('f32', s.plumeCount));
	setWord(img, gi.gPlateCount, toWord('f32', s.plateCount));
	setWord(img, gi.gFrame, toWord('f32', s.frame));
	// Per-frame counters: each frame's kernels count their own events, exactly like the CPU
	// kernels that reset them at entry. Ledgers further down are NOT touched — they are
	// run-cumulative and only zeroed by zeroScratch() at upload.
	img[gi.gFinite] = 0; img[gi.gClimbOver] = 0; img[gi.gGaps] = 0; img[gi.gSpawns] = 0;
	img[gi.gDeaths] = 0; img[gi.gOverlaps] = 0; img[gi.gTypeChanges] = 0;
	img[gi.gSpeedSumLo] = 0; img[gi.gSpeedSumHi] = 0; img[gi.gSpeedN] = 0; img[gi.gMaxSpeed] = 0;
	img[gi.gMaxClimb] = 0; img[gi.gSedCut] = 0;
	this.device.queue.writeBuffer(this.arenaBuf[4], this.globalsBase * 4, img.buffer, 0, img.length * 4);
};
function setWord(img, at, v) { img[at] = v; }

GpuSim.prototype.writeWavesPlumes = function () {
	var s = this.state, L = this.layout;
	for (var w = 0; w < SimParamsGpu.nWave; w++) {
		for (var c = 0; c < 3; c++) this.arenaF[4][L.field.waveDir.offset + w * 4 + c] = s.waveDir[w * 3 + c];
		this.arenaF[4][L.field.waveFreq.offset + w] = s.waveFreq[w];
		this.arenaF[4][L.field.wavePhase.offset + w] = s.wavePhase[w];
		this.arenaF[4][L.field.waveAmp.offset + w] = s.waveAmp[w];
	}
	for (var k = 0; k < 8; k++) {
		for (var c2 = 0; c2 < 3; c2++) this.arenaF[4][L.field.plume.offset + k * 4 + c2] = k < s.plumeCount ? s.plumePos[k * 3 + c2] : 0;
		this.arenaF[4][L.field.plume.offset + k * 4 + 3] = k < s.plumeCount ? s.plumeStr[k] : 0;
	}
	this.arenaF[4][L.field.plumeCount.offset] = s.plumeCount;
	var first = L.field.waveDir.offset, last = L.field.plumeCount.offset + 1;
	this.device.queue.writeBuffer(this.arenaBuf[4], first * 4, this.arenaU[4].buffer, first * 4, (last - first) * 4);
};

GpuSim.prototype.dispatch = function (pass, name, threads, wg) {
	pass.setPipeline(this.pipeline[name]);
	pass.setBindGroup(0, this.bindGroup);
	pass.dispatchWorkgroups(Math.ceil(threads / (wg || 256)));
};

GpuSim.prototype.clear = function (enc, name) {
	var f = this.layout.field[name];
	enc.clearBuffer(this.arenaBuf[f.arena], f.offset * 4, f.stride * f.count * 4);
};

GpuSim.prototype.encodeScan = function (pass, job) {
	// job 0 bins, 1 spawn, 2 gather — the entry points bake src/dst/n.
	var names = ['Bins', 'Spawn', 'Gather'];
	var threads = job === 2 ? this.layout.colCap : this.layout.V;
	this.dispatch(pass, 'kScanBlocks' + names[job], threads, 256);
	this.dispatch(pass, 'kScanTops' + names[job], 1, 1);
	this.dispatch(pass, 'kScanApply' + names[job], threads + 1, 256);
};

// One frame in sim.step order. clearBuffer calls are the per-frame memsets (the CPU kernels'
// fill(0)); the trench pattern and pairOk ones go through queue writes before the submit.
GpuSim.prototype.encodeFrame = function () {
	var L = this.layout, V = L.V, C = L.colCap, P = SimParamsGpu.plateCap;
	var q = this.device.queue;
	q.writeBuffer(this.arenaBuf[2], L.field.trench.offset * 4, this.trenchFill.buffer);
	var enc = this.device.createCommandEncoder();
	var pass = enc.beginComputePass();
	// K1..K4
	this.dispatch(pass, 'kIntegrate', P, 64);
	this.dispatch(pass, 'kMove', C, 256);
	this.clear(enc, 'binCount');
	this.dispatch(pass, 'kBinCount', C, 256);
	this.encodeScan(pass, 0);
	this.dispatch(pass, 'kBinScatter', C, 256);
	this.dispatch(pass, 'kBinSort', V, 256);
	this.dispatch(pass, 'kRaster', V, 256);
	// K0 + K5
	this.dispatch(pass, 'kMantle', V, 256);
	this.clear(enc, 'cells');
	this.dispatch(pass, 'kVelocities', V, 256);
	this.clear(enc, 'pol');
	this.dispatch(pass, 'kRelatives', V * 6, 256);
	this.dispatch(pass, 'kPolarity', V * 6, 256);
	this.dispatch(pass, 'kTrenchA', V * 6, 256);
	this.dispatch(pass, 'kTrenchB0', V, 256);
	this.dispatch(pass, 'kTrenchB1', V, 256);
	this.dispatch(pass, 'kExtension', V, 256);
	// K6 contact scan
	this.clear(enc, 'spawnFlag');
	this.dispatch(pass, 'kOverlaps', C, 256);
	this.dispatch(pass, 'kGapScan', V, 256);
	// K7 apply: resolve, gather (count, scan, scatter, sort, run), arcs, spawn
	this.dispatch(pass, 'kResolve', C, 256);
	this.clear(enc, 'glCount');
	this.dispatch(pass, 'kGatherPrep', C, 256);
	this.encodeScan(pass, 2);
	this.dispatch(pass, 'kGatherScatter', C, 256);
	this.dispatch(pass, 'kGatherSort', C, 64);
	this.dispatch(pass, 'kGather', C, 64);
	this.dispatch(pass, 'kGatherAfter', V, 256);
	this.clear(enc, 'subRate'); this.clear(enc, 'subCount');
	this.clear(enc, 'arcFeed'); this.clear(enc, 'arcFeedN');
	this.dispatch(pass, 'kArcsRate', V * 6, 256);
	this.dispatch(pass, 'kArcs', V, 256);
	this.dispatch(pass, 'kDoseArc', C, 256);
	this.encodeScan(pass, 1);
	this.dispatch(pass, 'kSpawnApply', V, 256);
	// K8 column
	this.dispatch(pass, 'kCollapse', C, 256);
	this.clear(enc, 'belt');
	this.dispatch(pass, 'kBelt', V, 256);
	this.dispatch(pass, 'kColumn', C, 256);
	// K9 surface
	this.dispatch(pass, 'kDynamics', C, 256);
	this.dispatch(pass, 'kZdynCopy', C, 256);
	this.dispatch(pass, 'kElevation', V, 256);
	this.dispatch(pass, 'kGradient', V, 256);
	this.dispatch(pass, 'kBasins', C, 256);
	this.dispatch(pass, 'kErode', C, 256);
	this.dispatch(pass, 'kFlow', V, 256);
	this.dispatch(pass, 'kDeposit', V, 256);
	this.dispatch(pass, 'kDoseBas', C, 256);
	// K10 forces + reduce
	this.dispatch(pass, 'kForces', V, 256);
	this.clear(enc, 'm6'); this.clear(enc, 'rhs');
	this.dispatch(pass, 'kReduceAccum', V, 256);
	this.dispatch(pass, 'kReduceSolve', P, 64);
	// K11
	this.dispatch(pass, 'kDiag', C, 256);
	pass.end();
	return enc;
};

GpuSim.prototype.step = function (dt) {
	var s = this.state;
	if (this.eventArrived) {
		this.applyEvents();
		this.eventArrived = false;
	}
	s.frame++;
	s.t += dt;
	SimMantleGpu.advance(s);
	this.writeGlobalsImage(dt);
	this.writeWavesPlumes();
	var enc = this.encodeFrame();
	var L = this.layout, V = L.V;
	var eventDue = s.t - s.lastEvent >= SimParamsGpu.eventCadence;
	// One staging buffer per plan: never issue a copy while the previous map is still in
	// flight — the cadence re-triggers next frame instead.
	if (eventDue && !this.eventPending) {
		// Census for the NEXT event cycle runs now; the CPU consumes it one cycle late.
		this.clear(enc, 'cells');
		this.clear(enc, 'pairLen');
		this.clear(enc, 'pairVel');
		this.device.queue.writeBuffer(this.arenaBuf[3], L.field.pairOk.offset * 4, this.onesFill.buffer);
		var pass = enc.beginComputePass();
		this.dispatch(pass, 'kCensus', V, 256);
		this.dispatch(pass, 'kSums', L.colCap, 256);
		pass.end();
		s.lastEvent = s.t;
		this.copyPlan(enc, 'event');
	}
	// If a readback was still in flight, the pending census simply applies next frame with the
	// longer span — the cadence re-triggers because lastEvent still holds the old census time.
	if (s.t >= s.ckptDue && !this.ckptPending) {
		s.ckptDue += SimParamsGpu.ckptEvery;
		this.ckptT = s.t;
		this.copyPlan(enc, 'ckpt');
	}
	this.device.queue.submit([enc.finish()]);
	if (eventDue && !this.eventPending) this.readPlan('event');
	if (this.ckptPending) this.readPlan('ckpt');
};

GpuSim.prototype.copyPlan = function (enc, planName) {
	var plan = this.plans[planName];
	for (var i = 0; i < plan.entries.length; i++) {
		var e = plan.entries[i];
		enc.copyBufferToBuffer(this.arenaBuf[e.arena], e.src, plan.staging, e.dst, e.bytes);
	}
	this[planName + 'Pending'] = true;
};

GpuSim.prototype.readPlan = function (planName) {
	var self = this, plan = this.plans[planName];
	plan.staging.mapAsync(GPUMapMode.READ).then(function () {
		var view = new Uint32Array(plan.staging.getMappedRange()).slice();
		plan.staging.unmap();
		self[planName + 'Buf'] = view;
		if (planName === 'event') {
			self.eventArrived = true;
			self.interpretGlobals(view, plan);
		} else {
			self.ckptArrived = true;
		}
		self[planName + 'Pending'] = false;
	}).catch(function (err) {
		console.error('readback failed:', err);
		self[planName + 'Pending'] = false;
	});
};

// Globals tail: per-frame counters, speed diagnostics, ledgers and mass sums (u64 pairs).
GpuSim.prototype.interpretGlobals = function (view, plan) {
	var gi = this.globalsIndex, s = this.state, base = plan.globalsAt / 4;
	var word = function (name) { return view[base + gi[name]]; };
	var u64 = function (lo, hi) { return Number(BigInt.asIntN(64, (BigInt(word(hi)) << 32n) | BigInt(word(lo)))); };
	var u64u = function (lo, hi) { return Number((BigInt(word(hi)) << 32n) | BigInt(word(lo))); };
	var A0 = s.A0ref;
	s.spawns = word('gSpawns'); s.deaths = word('gDeaths'); s.overlaps = word('gOverlaps');
	s.gaps = word('gGaps'); s.typeChanges = word('gTypeChanges'); s.maxClimb = word('gMaxClimb');
	s.finite = (word('gFinite') | word('gClimbOver')) === 0 ? 1 : 0;
	s.meanSpeed = word('gSpeedN') ? u64u('gSpeedSumLo', 'gSpeedSumHi') * 0.01 / word('gSpeedN') : 0;
	u32Scratch[0] = word('gMaxSpeed');
	s.maxSpeed = f32Scratch[0];
	s.producedFel = u64('gLedProdFelLo', 'gLedProdFelHi') * A0 / 1000;
	s.producedMaf = u64('gLedProdMafLo', 'gLedProdMafHi') * A0 / 1000;
	s.erodedFel = u64('gLedEroFelLo', 'gLedEroFelHi') * A0 / 1000;
	s.erodedMaf = u64('gLedEroMafLo', 'gLedEroMafHi') * A0 / 1000;
	s.subductedMaf = u64('gLedSubMafLo', 'gLedSubMafHi') * A0 / 1000;
	s.subductedSed = u64('gLedSubSedLo', 'gLedSubSedHi') * A0 / 1000;
	s.subductedArea = word('gLedSubAreaLo') * A0;
	s.massFel = u64u('gMassFelLo', 'gMassFelHi') * A0 / 1000;
	s.massMaf = u64u('gMassMafLo', 'gMassMafHi') * A0 / 1000;
	s.massSed = u64u('gMassSedLo', 'gMassSedHi') * A0 / 1000;
	for (var k = 0; k < 6; k++) s.oreSum[k] = u64u('gOreSumLo' + k, 'gOreSumHi' + k) / 1e6;
	// One history-ring entry per event, mirroring Diag.check's cadence.
	var h = s.histI % s.histT.length;
	s.histT[h] = s.t; s.histMeanV[h] = s.meanSpeed; s.histMaxV[h] = s.maxSpeed;
	s.histGaps[h] = s.gaps; s.histPlates[h] = s.plateCount; s.histChanges[h] = s.typeChanges;
	s.histCols[h] = this.colHigh;
	s.histI++;
	if (s.histN < s.histT.length) s.histN++;
};

// Pull one field out of a plan view into its CPU array. kind is the CPU-side unit.
GpuSim.prototype.pull = function (view, plan, name, cpu, kind) {
	var f = this.layout.field[name], srcInfo = GpuFieldSource(this, name), at = plan.byName[name];
	var stride = srcInfo.cpuStride !== undefined ? srcInfo.cpuStride : f.stride;
	var src = view.subarray(at.offset / 4, at.offset / 4 + at.words);
	for (var e = 0; e < f.count; e++) {
		for (var w = 0; w < stride; w++) {
			cpu[e * stride + w] = fromWord(kind, src[e * f.stride + w]);
		}
	}
};

// The event cycle runs on the CPU against the refreshed view: no column compaction (dead
// slots go to the free list), then the mutated arrays and the plate table go back up.
GpuSim.prototype.applyEvents = function () {
	var s = this.state, plan = this.plans.event, view = this.eventBuf;
	this.pull(view, plan, 'q', s.q, 'f32');
	this.pull(view, plan, 'omega', s.omega, 'f32');
	this.pull(view, plan, 'cells', s.plateCells, 'raw');
	this.pull(view, plan, 'spawned', s.plateSpawned, 'raw');
	this.pull(view, plan, 'lost', s.plateLost, 'raw');
	this.pull(view, plan, 'birth', s.plateBirth, 'f32');
	this.pull(view, plan, 'parent', s.plateParent, 'raw');
	this.pull(view, plan, 'pairLen', s.pairLen, 'pairLen');
	this.pull(view, plan, 'pairVel', s.pairVel, 'pairVel');
	this.pull(view, plan, 'pairOk', s.pairOk, 'raw');
	this.pull(view, plan, 'alive', s.alive, 'raw');
	this.pull(view, plan, 'plate', s.plate, 'raw');
	this.pull(view, plan, 'cell', s.cell, 'raw');
	this.pull(view, plan, 'damage', s.damage, 'f32');
	this.pull(view, plan, 'cellPlate', s.cellPlate, 'raw');
	this.pull(view, plan, 'owner', s.owner, 'raw');
	this.pull(view, plan, 'u', s.uMantle, 'f32');
	this.colHigh = this.colHighOf();
	s.n = this.colHigh;
	// The event cycle without column compaction; census came from kCensus.
	var span = s.t - s.lastEvent;
	SimEventsGpu.suture(s, span);
	SimEventsGpu.absorb(s);
	SimEventsGpu.retire(s);
	SimEventsGpu.compactPlates(s);
	SimEventsGpu.split(s);
	// Upload everything the cycle touched, then the GPU-owned globals that follow from it.
	var names = ['plate', 'damage', 'body', 'world', 'q', 'omega', 'cells', 'spawned', 'lost', 'birth', 'parent'];
	for (var i = 0; i < names.length; i++) this.copyField(names[i]);
	this.buildFreeList();
	this.writeGpuOwnedGlobals();
	var q = this.device.queue, L = this.layout, P = SimParamsGpu.plateCap;
	q.writeBuffer(this.arenaBuf[1], L.field.plate.offset * 4, this.arenaU[1].buffer, L.field.plate.offset * 4, L.colCap * 4);
	q.writeBuffer(this.arenaBuf[1], L.field.damage.offset * 4, this.arenaU[1].buffer, L.field.damage.offset * 4, L.colCap * 4);
	q.writeBuffer(this.arenaBuf[1], L.field.body.offset * 4, this.arenaU[1].buffer, L.field.body.offset * 4, L.colCap * 16);
	q.writeBuffer(this.arenaBuf[1], L.field.world.offset * 4, this.arenaU[1].buffer, L.field.world.offset * 4, L.colCap * 16);
	q.writeBuffer(this.arenaBuf[3], L.field.q.offset * 4, this.arenaU[3].buffer, L.field.q.offset * 4, P * 16);
	q.writeBuffer(this.arenaBuf[3], L.field.omega.offset * 4, this.arenaU[3].buffer, L.field.omega.offset * 4, P * 16);
	q.writeBuffer(this.arenaBuf[3], L.field.cells.offset * 4, this.arenaU[3].buffer, L.field.cells.offset * 4, P * 4);
	q.writeBuffer(this.arenaBuf[3], L.field.spawned.offset * 4, this.arenaU[3].buffer, L.field.spawned.offset * 4, P * 4);
	q.writeBuffer(this.arenaBuf[3], L.field.lost.offset * 4, this.arenaU[3].buffer, L.field.lost.offset * 4, P * 4);
	q.writeBuffer(this.arenaBuf[3], L.field.birth.offset * 4, this.arenaU[3].buffer, L.field.birth.offset * 4, P * 4);
	q.writeBuffer(this.arenaBuf[3], L.field.parent.offset * 4, this.arenaU[3].buffer, L.field.parent.offset * 4, P * 4);
	q.writeBuffer(this.arenaBuf[4], L.field.freeList.offset * 4, this.arenaU[4].buffer, L.field.freeList.offset * 4, L.colCap * 4);
};

// Checkpoint bridge: the readback becomes a plain CPU state, and the existing ring/serializer
// take it from there. Runs when the async copy lands; the snapshot is the frame it was issued.
GpuSim.prototype.applyCkpt = function () {
	var s = this.state, plan = this.plans.ckpt, view = this.ckptBuf;
	this.pull(view, plan, 'body', s.body, 'f32');
	this.pull(view, plan, 'area', s.area, 'f32');
	this.pull(view, plan, 'fel', s.hFel, 'mm');
	this.pull(view, plan, 'maf', s.hMaf, 'mm');
	this.pull(view, plan, 'sed', s.hSed, 'mm');
	this.pull(view, plan, 'age', s.age, 'f32');
	this.pull(view, plan, 'damage', s.damage, 'f32');
	this.pull(view, plan, 'zdyn', s.zDyn, 'cm');
	this.pull(view, plan, 'alive', s.alive, 'raw');
	this.pull(view, plan, 'plate', s.plate, 'raw');
	this.pull(view, plan, 'cell', s.cell, 'raw');
	this.pull(view, plan, 'q', s.q, 'f32');
	this.pull(view, plan, 'omega', s.omega, 'f32');
	this.pull(view, plan, 'cells', s.plateCells, 'raw');
	this.pull(view, plan, 'spawned', s.plateSpawned, 'raw');
	this.pull(view, plan, 'lost', s.plateLost, 'raw');
	this.pull(view, plan, 'birth', s.plateBirth, 'f32');
	this.pull(view, plan, 'parent', s.plateParent, 'raw');
	this.pull(view, plan, 'gapFrames', s.gapFrames, 'raw');
	this.pull(view, plan, 'gapTime', s.gapTime, 'f32');
	this.pull(view, plan, 'eType', s.edgeType, 'raw');
	this.pull(view, plan, 'mobile', s.mobile, 'mm');
	this.pull(view, plan, 'mobileFel', s.mobileFel, 'mm');
	this.pull(view, plan, 'mobilePla', s.mobilePla, 'mm');
	this.pull(view, plan, 'fert', s.fert, 'f32');
	for (var k = 0; k < 6; k++) this.pull(view, plan, 'ore', s[GpuSim.ORE[k]], 'ore');
	s.n = this.colHighOf();
	SimCheckpointGpu.push(s);
};

// Boot: the same solve-once sequence as Sim.raster, so the first painted frame has velocities.
GpuSim.prototype.raster = function () {
	var s = this.state, L = this.layout, V = L.V, P = SimParamsGpu.plateCap;
	SimMantleGpu.advance(s);
	this.writeGlobalsImage(SimParamsGpu.tauOmega);
	this.writeWavesPlumes();
	var enc = this.device.createCommandEncoder();
	var pass = enc.beginComputePass();
	this.dispatch(pass, 'kMantle', V, 256);
	this.dispatch(pass, 'kMove', this.layout.colCap, 256);
	this.clear(enc, 'binCount');
	this.dispatch(pass, 'kBinCount', this.layout.colCap, 256);
	this.encodeScan(pass, 0);
	this.dispatch(pass, 'kBinScatter', this.layout.colCap, 256);
	this.dispatch(pass, 'kBinSort', V, 256);
	this.dispatch(pass, 'kRaster', V, 256);
	this.dispatch(pass, 'kElevation', V, 256);
	this.clear(enc, 'cells');
	this.dispatch(pass, 'kVelocities', V, 256);
	this.dispatch(pass, 'kForces', V, 256);
	this.clear(enc, 'm6'); this.clear(enc, 'rhs');
	this.dispatch(pass, 'kReduceAccum', V, 256);
	this.dispatch(pass, 'kReduceSolve', P, 64);
	this.clear(enc, 'pol');
	this.dispatch(pass, 'kRelatives', V * 6, 256);
	this.dispatch(pass, 'kPolarity', V * 6, 256);
	this.dispatch(pass, 'kTrenchA', V * 6, 256);
	this.dispatch(pass, 'kTrenchB0', V, 256);
	this.dispatch(pass, 'kTrenchB1', V, 256);
	this.dispatch(pass, 'kExtension', V, 256);
	this.dispatch(pass, 'kDiag', this.layout.colCap, 256);
	pass.end();
	this.device.queue.submit([enc.finish()]);
};

GpuSim.prototype.sync = function () {
	return this.device.queue.onSubmittedWorkDone();
};

// FNV-1a over the dynamic arenas as the DEVICE holds them (the CPU mirrors go stale the moment
// a frame runs). The same-device determinism requirement compares these hashes bit-for-bit.
GpuSim.prototype.hashAsync = function () {
	var self = this, L = this.layout;
	var bytes = L.arenaBytes[1] + L.arenaBytes[2] + L.arenaBytes[3] + L.arenaBytes[4];
	var staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	var enc = this.device.createCommandEncoder();
	var at = 0;
	for (var a = 1; a < 5; a++) {
		enc.copyBufferToBuffer(this.arenaBuf[a], 0, staging, at, L.arenaBytes[a]);
		at += L.arenaBytes[a];
	}
	this.device.queue.submit([enc.finish()]);
	return staging.mapAsync(GPUMapMode.READ).then(function () {
		var words = new Uint32Array(staging.getMappedRange());
		var h = 0x811c9dc5;
		for (var i = 0; i < words.length; i++) {
			h = (h ^ words[i]) >>> 0;
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		staging.unmap();
		staging.destroy();
		return h >>> 0;
	});
};

// Synchronous-ish copy of the dynamic arenas for the harness (submit, wait, map once).
GpuSim.prototype.readBackArenas = function () {
	var L = this.layout;
	var staging = this.device.createBuffer({
		size: L.arenaBytes[1] + L.arenaBytes[2] + L.arenaBytes[3],
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
	});
	var enc = this.device.createCommandEncoder();
	enc.copyBufferToBuffer(this.arenaBuf[1], 0, staging, 0, L.arenaBytes[1]);
	enc.copyBufferToBuffer(this.arenaBuf[2], 0, staging, L.arenaBytes[1], L.arenaBytes[2]);
	enc.copyBufferToBuffer(this.arenaBuf[3], 0, staging, L.arenaBytes[1] + L.arenaBytes[2], L.arenaBytes[3]);
	this.device.queue.submit([enc.finish()]);
	var self = this;
	return staging.mapAsync(GPUMapMode.READ).then(function () {
		var out = new Uint32Array(staging.getMappedRange()).slice();
		staging.unmap();
		staging.destroy();
		return out;
	});
};
GpuSim.prototype.applyArrived = function () {
	if (this.ckptArrived) {
		this.ckptArrived = false;
		this.applyCkpt();
	}
};

// On-demand snapshot into the CPU state (save/deposits under GPU mode): copy the checkpoint
// plan synchronously-then-async, apply, resolve. Separate staging from the ring's plan.
GpuSim.prototype.snapshot = function () {
	var self = this, plan = this.plans.ckpt;
	var staging = this.device.createBuffer({ size: plan.bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	var enc = this.device.createCommandEncoder();
	for (var i = 0; i < plan.entries.length; i++) {
		var e = plan.entries[i];
		enc.copyBufferToBuffer(this.arenaBuf[e.arena], e.src, staging, e.dst, e.bytes);
	}
	this.device.queue.submit([enc.finish()]);
	return staging.mapAsync(GPUMapMode.READ).then(function () {
		self.ckptBuf = new Uint32Array(staging.getMappedRange()).slice();
		staging.unmap();
		staging.destroy();
		self.applyCkpt();
	});
};

if (typeof module !== 'undefined' && module.exports) module.exports = GpuSim;

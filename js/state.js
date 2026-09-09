var StateParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var StateGrid = typeof module !== 'undefined' && module.exports ? require('./geodesics.js') : Grid;
var StateMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var StateDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
// hot: hot-start world (design §9) — no continents, Tm = TmHot, young oceanic crust everywhere.
function State(grid, seed, hot) {
	this.grid = grid;
	this.colCap = Math.ceil(grid.V * 1.5);
	this.plateCap = StateParams.plateCap;
	this.hotStart = hot === undefined ? StateParams.hotStart : (hot ? 1 : 0);
	// Nominal column footprint. Cell areas vary 0.68..1.21 of the mean, so the mass ledgers use
	// this constant: a column always represents the same crust volume wherever it sits.
	this.A0ref = 4 * Math.PI * StateParams.radius * StateParams.radius / grid.V;
	this.body = new Float64Array(this.colCap * 3);
	this.world = new Float64Array(this.colCap * 3);
	this.area = new Float64Array(this.colCap);
	this.hFel = new Float64Array(this.colCap);
	this.hMaf = new Float64Array(this.colCap);
	this.hSed = new Float64Array(this.colCap);
	this.age = new Float64Array(this.colCap);
	this.damage = new Float64Array(this.colCap);
	// Metallogeny (design §8): six saturating potentials per column, scaled by the column's
	// fertility, which is drawn once at birth and never changes afterwards.
	this.fert = new Float64Array(this.colCap);
	this.oVms = new Float64Array(this.colCap);
	this.oMaf = new Float64Array(this.colCap);
	this.oArc = new Float64Array(this.colCap);
	this.oOro = new Float64Array(this.colCap);
	this.oBas = new Float64Array(this.colCap);
	this.oPla = new Float64Array(this.colCap);
	this.zDyn = new Float64Array(this.colCap);
	this.zDynNext = new Float64Array(this.colCap);
	this.collapseDelta = new Float64Array(this.colCap);
	this.alive = new Uint8Array(this.colCap);
	this.plate = new Uint16Array(this.colCap);
	this.cell = new Int32Array(this.colCap);
	this.consumedBy = new Int32Array(this.colCap);
	this.loserList = new Int32Array(this.colCap);
	this.loserStart = new Int32Array(this.colCap + 1);
	this.loserCursor = new Int32Array(this.colCap + 1);
	this.q = new Float64Array(this.plateCap * 4);
	this.omega = new Float64Array(this.plateCap * 3);
	this.omegaTarget = new Float64Array(this.plateCap * 3);
	this.M = new Float64Array(this.plateCap * 9);
	this.rhs = new Float64Array(this.plateCap * 3);
	this.seeds = new Float64Array(this.plateCap * 3);
	this.plateCells = new Uint32Array(this.plateCap);
	this.plateSpawned = new Uint32Array(this.plateCap);
	this.plateLost = new Uint32Array(this.plateCap);
	this.plateBirth = new Float64Array(this.plateCap);
	this.plateParent = new Int32Array(this.plateCap);
	this.plateDead = new Uint8Array(this.plateCap);
	this.plateRemap = new Int32Array(this.plateCap);
	this.subRate = new Float64Array(this.plateCap);
	this.subCount = new Uint32Array(this.plateCap);
	// Recycling feed for arc potentials: the plate-mean inventory of the columns it subducts.
	this.arcFeed = new Float64Array(this.plateCap);
	this.arcFeedN = new Uint32Array(this.plateCap);
	// Plate pairs are keyed [lo * plateCap + hi]: suture timers plus the per-cycle census.
	this.sutureTime = new Float32Array(this.plateCap * this.plateCap);
	this.pairScratch = new Float32Array(this.plateCap * this.plateCap);
	this.pairLen = new Float32Array(this.plateCap * this.plateCap);
	this.pairVel = new Float32Array(this.plateCap * this.plateCap);
	this.pairOk = new Uint8Array(this.plateCap * this.plateCap);
	this.corridor = new Uint8Array(grid.V);
	// Collision/continental-transform belt, dilated one ring, for the orogenic potential.
	this.belt = new Uint8Array(grid.V);
	this.oreSum = new Float64Array(6);
	this.compLabel = new Int32Array(grid.V);
	this.fitM = new Float64Array(9);
	this.fitRhs = new Float64Array(3);
	this.fitOmega = new Float64Array(64 * 3);
	this.openSum = new Float64Array(64);
	this.openLen = new Float64Array(64);
	this.openFitted = new Uint8Array(64);
	this.compSize = new Int32Array(64);
	this.compPlate = new Int32Array(64);
	this.queue = new Int32Array(grid.V);
	this.count = new Uint32Array(grid.V);
	this.offset = new Uint32Array(grid.V + 1);
	this.cursor = new Uint32Array(grid.V);
	this.entries = new Uint32Array(this.colCap);
	this.owner = new Int32Array(grid.V);
	this.distance = new Float64Array(grid.V);
	// Static unit-sphere distance thresholds. Keeping sin() out of K4/K6 saves two
	// transcendental calls per covered cell without changing the contact geometry.
	this.gapLimit2 = new Float64Array(grid.V);
	this.contactLimit2 = new Float64Array(grid.V);
	for (var limitCell = 0; limitCell < grid.V; limitCell++) {
		var gapChord = StateGrid.chord(StateParams.rGap * grid.nbrDist[limitCell]);
		var contactChord = StateGrid.chord(StateParams.rContact * grid.nbrDist[limitCell]);
		this.gapLimit2[limitCell] = gapChord * gapChord;
		this.contactLimit2[limitCell] = contactChord * contactChord;
	}
	this.z = new Float64Array(grid.V);
	this.wet = new Uint8Array(grid.V);
	this.gradZ = new Float64Array(grid.V * 3);
	this.slope = new Float64Array(grid.V);
	this.low = new Int32Array(grid.V);
	this.cellPlate = new Uint16Array(grid.V);
	this.gapFrames = new Uint16Array(grid.V);
	this.gapTime = new Float32Array(grid.V);
	this.spawnSlot = new Int32Array(grid.V);
	this.gapPlate = new Uint16Array(grid.V);
	this.gapDonor = new Int32Array(grid.V * 3);
	// Alive donor count of a spawning gap cell, or 255 for an oceanic newborn (no thinning).
	this.gapDonorN = new Uint8Array(grid.V);
	// Cells within two hops of an open rift request, so donor thinning only walks those.
	this.riftZone = new Uint8Array(grid.V);
	this.gapScan = new Int32Array(43);   // 1 + 6 + 6*6, the widest two-hop cell list
	this.mobile = new Float64Array(grid.V);
	this.mobileFel = new Float64Array(grid.V);
	this.mobilePla = new Float64Array(grid.V);
	this.outflow = new Float64Array(grid.V);
	this.outflowFel = new Float64Array(grid.V);
	this.outflowPla = new Float64Array(grid.V);
	// K9 routing scratch in gather form (design §2): erosion per column writes what each
	// owned cell lost, the stay pass gathers inflow from the ring, the deposit pass pulls.
	this.eroSed = new Float64Array(grid.V);
	this.eroFel = new Float64Array(grid.V);
	this.eroPla = new Float64Array(grid.V);
	this.stay = new Float64Array(grid.V);
	this.stayFel = new Float64Array(grid.V);
	this.stayPla = new Float64Array(grid.V);
	this.uMantle = new Float64Array(grid.V * 3);
	this.vel = new Float64Array(grid.V * 3);
	this.wEq = new Float64Array(grid.V * 3);
	this.relN = new Float64Array(grid.V * 6);
	this.relT = new Float64Array(grid.V * 6);
	this.edgeType = new Int8Array(grid.V * 6);
	this.polarity = new Int8Array(grid.V * 6);
	this.trenchDist = new Int8Array(grid.V);
	this.ext = new Float64Array(grid.V);
	this.plumeT = new Float64Array(grid.V);
	this.waveDir0 = new Float64Array(StateParams.nWave * 3);
	this.waveAxis = new Float64Array(StateParams.nWave * 3);
	this.waveDir = new Float64Array(StateParams.nWave * 3);
	this.wavePeriod = new Float64Array(StateParams.nWave);
	this.waveFreq = new Float64Array(StateParams.nWave);
	this.wavePhase = new Float64Array(StateParams.nWave);
	this.waveAmp = new Float64Array(StateParams.nWave);
	this.plumePos = new Float64Array(6 * 3);
	this.plumeBirth = new Float64Array(6);
	this.plumeLife = new Float64Array(6);
	this.plumeStr = new Float64Array(6);
	this.scratch = new Float64Array(32);
	this.climbHistogram = new Uint32Array(32);
	this.histT = new Float64Array(StateParams.histCap);
	this.histMeanV = new Float64Array(StateParams.histCap);
	this.histMaxV = new Float64Array(StateParams.histCap);
	this.histGaps = new Uint32Array(StateParams.histCap);
	this.histPlates = new Uint16Array(StateParams.histCap);
	this.histChanges = new Uint32Array(StateParams.histCap);
	this.histCols = new Uint32Array(StateParams.histCap);
	this.ckptCap = StateParams.ckptCap;
	this.ckpt = new Array(this.ckptCap);
	this.ckptT = new Float64Array(this.ckptCap);
	this.reset(seed === undefined ? grid.seed : seed);
}
State.prototype.reset = function (seed) {
	this.seed = seed >>> 0;
	this.t = 0; this.frame = 0; this.n = this.grid.V;
	this.plateCount = Math.min(StateParams.plateCount, this.n);
	this.gaps = 0; this.maxClimb = 0; this.fixedOmega = 0; this.prescribedOmega = 0; this.finite = 1;
	this.meanSpeed = 0; this.maxSpeed = 0; this.typeChanges = 0;
	this.rigidError = 0; this.quatError = 0; this.histI = 0; this.histN = 0;
	// Tm0 is the cooling baseline: the exponential always decays from the world's own start
	// temperature, so a hot start cools through the same curve a map start sits on today.
	this.Tm0 = this.hotStart ? StateParams.TmHot : StateParams.Tm0;
	this.Tm = this.Tm0; this.mantleScale = 1; this.plumeCount = 0; this.rng = 0;
	// lastEvent starts at 0, not -Infinity: plateCells is only meaningful after the first K5
	// pass, and the event cadence would otherwise retire every plate on the opening frame.
	this.spawns = 0; this.deaths = 0; this.overlaps = 0; this.splits = 0; this.merges = 0;
	this.lastEvent = 0; this.ckptI = 0; this.ckptN = 0; this.ckpt.fill(null); this.ckptT.fill(0);
	this.ckptDue = StateParams.ckptEvery;
	this.producedFel = 0; this.producedMaf = 0; this.erodedFel = 0; this.erodedMaf = 0;
	this.subductedMaf = 0; this.subductedSed = 0;
	this.subductedArea = 0; this.massFel = 0; this.massMaf = 0; this.massSed = 0;
	this.massFel0 = 0; this.massMaf0 = 0; this.massSed0 = 0;
	this.body.fill(0); this.world.fill(0); this.area.fill(0);
	this.hFel.fill(0); this.hMaf.fill(0); this.hSed.fill(0); this.age.fill(0);
	this.fert.fill(0); this.oVms.fill(0); this.oMaf.fill(0);
	this.oArc.fill(0); this.oOro.fill(0); this.oBas.fill(0); this.oPla.fill(0);
	this.damage.fill(0); this.zDyn.fill(0); this.zDynNext.fill(0); this.collapseDelta.fill(0); this.alive.fill(0);
	this.plate.fill(0); this.cell.fill(-1); this.consumedBy.fill(-1);
	this.loserList.fill(-1); this.loserStart.fill(0); this.loserCursor.fill(0);
	this.q.fill(0); this.omega.fill(0); this.omegaTarget.fill(0);
	this.M.fill(0); this.rhs.fill(0); this.seeds.fill(0); this.plateCells.fill(0);
	this.plateBirth.fill(0); this.plateParent.fill(-1); this.plateDead.fill(0); this.plateRemap.fill(0);
	this.sutureTime.fill(0); this.pairLen.fill(0); this.pairVel.fill(0); this.pairOk.fill(1);
	this.pairScratch.fill(0); this.corridor.fill(0); this.compLabel.fill(-1); this.queue.fill(0);
	this.compSize.fill(0); this.compPlate.fill(-1);
	this.fitM.fill(0); this.fitRhs.fill(0); this.fitOmega.fill(0);
	this.openSum.fill(0); this.openLen.fill(0); this.openFitted.fill(0);
	this.subRate.fill(0); this.subCount.fill(0);
	this.arcFeed.fill(0); this.arcFeedN.fill(0);
	this.belt.fill(0); this.oreSum.fill(0);
	this.plateSpawned.fill(0); this.plateLost.fill(0);
	this.count.fill(0); this.offset.fill(0); this.cursor.fill(0); this.entries.fill(0);
	this.owner.fill(-1); this.distance.fill(Infinity); this.z.fill(NaN); this.wet.fill(0);
	this.gradZ.fill(0); this.slope.fill(0); this.low.fill(-1); this.climbHistogram.fill(0);
	this.cellPlate.fill(65535); this.gapFrames.fill(0); this.gapTime.fill(0); this.spawnSlot.fill(-1);
	this.gapPlate.fill(0); this.gapDonor.fill(-1); this.gapDonorN.fill(0); this.riftZone.fill(0); this.gapScan.fill(0);
	this.mobile.fill(0); this.mobileFel.fill(0); this.mobilePla.fill(0);
	this.outflow.fill(0); this.outflowFel.fill(0); this.outflowPla.fill(0);
	this.eroSed.fill(0); this.eroFel.fill(0); this.eroPla.fill(0);
	this.stay.fill(0); this.stayFel.fill(0); this.stayPla.fill(0);
	this.uMantle.fill(0); this.vel.fill(0); this.wEq.fill(0);
	this.relN.fill(0); this.relT.fill(0); this.edgeType.fill(0); this.polarity.fill(0);
	this.trenchDist.fill(3); this.ext.fill(0); this.plumeT.fill(0);
	this.waveDir0.fill(0); this.waveAxis.fill(0); this.waveDir.fill(0);
	this.wavePeriod.fill(0); this.waveFreq.fill(0); this.wavePhase.fill(0); this.waveAmp.fill(0);
	this.plumePos.fill(0); this.plumeBirth.fill(0); this.plumeLife.fill(0); this.plumeStr.fill(0);
	this.scratch.fill(0); this.histT.fill(0); this.histMeanV.fill(0); this.histMaxV.fill(0);
	this.histGaps.fill(0); this.histPlates.fill(0); this.histChanges.fill(0); this.histCols.fill(0);
	var random = StateGrid.mulberry32(this.seed), g = this.grid, hot = this.hotStart;
	var mafNew = StateMantle.hMafNew(this.Tm0);
	for (var p = 0; p < this.plateCount; p++) {
		this.q[p * 4 + 3] = 1;
		var y = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
		this.seeds[p * 3] = r * Math.cos(a); this.seeds[p * 3 + 1] = y; this.seeds[p * 3 + 2] = r * Math.sin(a);
	}
	for (var i = 0; i < this.n; i++) {
		var b = i * 3, best = -Infinity, winner = 0;
		for (var p = 0; p < this.plateCount; p++) {
			var s = p * 3, dot = g.pos[b] * this.seeds[s] + g.pos[b + 1] * this.seeds[s + 1] + g.pos[b + 2] * this.seeds[s + 2];
			if (dot <= best) continue;
			best = dot; winner = p;
		}
		this.plate[i] = winner; this.cell[i] = i; this.area[i] = g.A0[i]; this.alive[i] = 1;
		this.fert[i] = StateParams.fertLo + (1 - StateParams.fertLo) * random();
		if (hot) {
			// Hot start (design §9): no continents at all. Felsic crust can only come from arcs,
			// so the continents in a long run are a result, not an input.
			this.hFel[i] = 0; this.hMaf[i] = mafNew; this.age[i] = random() * 20;
			continue;
		}
		this.hFel[i] = g.land[i] > 0.5 ? 35000 : 0;
		this.hMaf[i] = this.hFel[i] ? 0 : 7000;
		this.age[i] = this.hFel[i] ? 500 : random() * 120;
	}
	this.body.set(g.pos); this.world.set(g.pos);
	StateMantle.init(this);
	this.rebase();
};
// Re-anchor the source/sink ledgers on the current columns and zero the accumulators, so the
// balance identity holds from here on. reset() ends with it; tests that hand-edit columns or
// that want to exclude a settling phase call it before measuring.
State.prototype.rebase = function () {
	StateDiag.mass(this);
	this.massFel0 = this.massFel; this.massMaf0 = this.massMaf; this.massSed0 = this.massSed;
	this.producedFel = 0; this.producedMaf = 0; this.erodedFel = 0; this.erodedMaf = 0;
	this.subductedMaf = 0; this.subductedSed = 0;
};
if (typeof module !== 'undefined' && module.exports) module.exports = State;

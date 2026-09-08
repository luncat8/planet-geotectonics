var Params = Object.freeze({
	level: 5, seed: 7, dt: 0.1, radius: 6371000, plateCap: 128, plateCount: 16,
	rGap: 0.75, rSpawn: 0.85, rContact: 0.6, donors: 3, gapPersist: 2, fillDelay: 20, sedScrape: 0.5, riftDamage: 0.6,
	hRiftBreakup: 15000, hOceanic: 8000, hCollapse: 50000,
	epsHi: 2000, epsLo: 1000, vRef: 50000, vMax: 200000, vSuture: 3000, tauOmega: 1,
	U0: 50000, beta: 0.5, Ea: 3, vSlab: 1e6, kRidge: 5e6, vColl: 2e5, ageSlab: 70,
	kArc: 65, arcMafShare: 0.3, zTrench: 3000, tauDyn: 10, kFlex: 0.05, kCollapse: 0.02,
	kEro: 0.05, slopeRef: 0.01, deltaZ: 20, kPlacer: 0.2,
	kDam: 0.05, kDamT: 0.02, kHeal: 0.005, extRef: 0.01, splitDamage: 0.8, minPlateCells: 40,
	Tm0: 1, TmHot: 1.6, tauCool: 2500, Tfloor: 0.35, kPlume: 0.01, plumeRad: 500000,
	kV: 0.3, kM: 0.2, kM2: 0.15, kA: 0.02, kRec: 3, kO: 0.02, kB: 2e-4, kB2: 0.002, kDecay: 0.002,
	nWave: 8, nPhi: 4, nPlume: 4, histCap: 256, hotStart: 0, eventCadence: 1
});
if (typeof module !== 'undefined' && module.exports) module.exports = Params;

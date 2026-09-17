// Sealed rather than frozen so experiments/sweep.js can tune existing keys without allowing
// misspelled parameters to enter the runtime configuration.
var Params = Object.seal({
	level: 5, seed: 7, dt: 0.1, radius: 6371000, plateCap: 128, plateCount: 16,
	rGap: 0.75, rSpawn: 0.85, rContact: 0.6, donors: 3, gapPersist: 2, fillDelay: 20, sedScrape: 0.5, riftDamage: 0.6,
	hRiftBreakup: 15000, hOceanic: 8000, hCollapse: 50000, collThickness: 1,
	epsHi: 2000, epsLo: 1000, vRef: 50000, vMax: 200000, vSuture: 3000, tauOmega: 0.5,
	// Calibration baseline (seed 7, L5, hot start, 1500 Myr at dt 0.1), re-committed with the
	// 0.3.3 erosion knee: 9.01 cm/yr in the middle epoch, 19.3% continental area and 10.1%
	// cratons at the 1500 Myr acceptance epoch, 12 plates. The linear law had 9.05 / 19.1% /
	// 9.6% on the same history; experiments/erosion-knee.js measures any candidate on it.
	// The Adjust sliders (0.3.3) write four of these live, mid-run: friction scales Ea,
	// eroScale scales kEro, zRange is the relief ramp, and state.cooling/Tm0 the temperature.
	U0: 50000, beta: 0.5, Ea: 3, friction: 1, vSlab: 1e6, kRidge: 5e6, vColl: 2e5, ageSlab: 70,
	kArc: 65, arcMafShare: 0.3, zTrench: 3000, tauDyn: 10, kFlex: 0.05, kCollapse: 0.02,
	zPlume: 1000, tauPlume: 50, kLip: 30,
	// The knee is the height at which the q² intake meets the linear law, so it is what sets the
	// law's whole scale: at the colour ramp's 6.5 km it ate the thickened crust and the release
	// history fell out of acceptance 3 (14.1% continents), at 9 km it lands back on baseline.
	kEro: 0.05, eroScale: 1, slopeRef: 0.01, zKnee: 9000, deltaZ: 20, kPlacer: 0.2,
	// Relief ramp: |z| = zRange metres saturates land and the deep-water floor of the
	// elevation palette symmetrically (render.js, render-gpu.js). Renderer-only.
	zRange: 6500,
	// Display-only sea level (0.3.5); physics continues to use wet = z < 0. seaVolScale is
	// the volume slider's value; the active control is the page's UI state, not a Params key.
	sea: 0, seaVolScale: 1,
	kDam: 5e-4, kDamT: 1e-3, kHeal: 0.005, extRef: 0.01, splitDamage: 0.6, minPlateCells: 100,
	mergeTime: 20, vRift: 10000, splitAge: 40,
	Tm0: 1, TmHot: 1.6, tauCool: 2500, Tfloor: 0.35, kPlume: 0.01, plumeRad: 500000,
	kV: 0.3, kM: 0.2, kM2: 0.15, kA: 0.02, kRec: 3, kO: 0.02, kB: 2e-4, kB2: 0.002, kDecay: 0.002,
	fertLo: 0.5, hOro: 45000, hBas: 2000, zBasin: 300,
	nWave: 8, nPhi: 4, nPlume: 4, histCap: 256, hotStart: 0, eventCadence: 1,
	// ckptCap is the ring length at L5; ckptBytes caps the ring by bytes so a full-mirror
	// checkpoint blob (L7 is ~41 MB) cannot quietly turn the ring into hundreds of MB.
	// Checkpoint.push sizes the ring to the smaller of the two and reports it in ckptSlots.
	ckptCap: 16, ckptBytes: 96 * 1024 * 1024, ckptEvery: 20
});
if (typeof module !== 'undefined' && module.exports) module.exports = Params;

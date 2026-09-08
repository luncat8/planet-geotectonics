# findings, pitfalls, skills

## transport of crust on the icosphere grid (measured, experiments/advection-bench.js)

	at 10k-100k yr frames plates move 0.001-0.2 cell per frame.
	nearest-cell semi-Lagrangian copy: below ~1 cell of accumulated motion most cells map to
	themselves (plate freezes); at 0.7 cell the map is not a bijection on the irregular
	Voronoi grid and the plate erodes to nothing; at 1.0 cell it moves but distorts (IoU 0.11
	after 2 laps).
	first-order upwind flux: exact mass, but the edge smears as sqrt(dx*L): 11-26 cells per
	ocean crossing, independent of dt.
	Lagrangian columns with body-frame position + per-plate quaternion, re-rasterised every
	frame by nearest column within cell+ring: IoU 0.97 after 2 laps, zero interior holes,
	exact mass, 3 ms/frame at L5 in node.

## raster threshold

	for 1 column per cell moving rigidly, the nearest-column distance from a cell centre is
	p99.9 = 0.61 and max = 0.65 of the local neighbour distance (same at L5 and L6).
	cell+ring search covers a disc of ~0.85-1.0 neighbour distances.
	gap threshold 0.75 separates "covered" from "genuine divergent gap" with margin on both sides.

## mantle driver

	sum of A_m (a_m x r) terms is ONE rigid rotation (equals (sum A_m a_m) x r to 5e-16):
	zero divergence, zero shear, no differential plate forcing. use a scalar potential
	(poloidal grad Phi + toroidal r x grad Psi) from drifting low-degree noise instead.

## grid facts (js/geodesics.js)

	nbrB rotA/rotB is an exact 2D rotation (|rot| = 1), so tangent vectors can be transported
	between neighbour bases without trig.
	the W x H = 256 x ceil(V/256) packing is NOT spatial: texel neighbours are not cell
	neighbours; never bilinear-sample these textures.
	cell areas vary 0.68..1.21 of the mean; neighbour distances vary +-10 %.
	hill-climb from a cached cell is exact for locating a point in a Voronoi cell and needs
	<= 3 steps for sub-cell motion.

## foundation tests and precision

	the original cap bench uses an artificial priority override for the moving cap over the
	stationary background. nearest-distance raster ownership does not have that behavior.
	test transport with cap columns alone, then test competing plates in contact scenarios.
	L5 real kernels: IoU 0.9699 at 1000 Myr / dt 0.1, 0.9661 at 100 Myr / dt 0.01.
	keep unit positions in Float64 from mesh construction, not round-tripped via cellA f32.
	GC-delimited heap deltas measure retained memory, not transient allocations. Warm up
	first and track arrayBuffers separately; inspect hot-path code/profiles as well.
	ArrayBuffer delta can go negative if the second GC collects warmup leftovers; bound
	growth, do not require a zero delta.

## mantle field

	Tm(t) = Tfloor + (Tm0 − Tfloor) exp(−t/τ_cool). Map start Tm0 = 1, hot start 1.6.
	Scale ∇ₛΦ+β r×∇ₛΨ so the mean cell speed equals U0 Tm^2.5 at t=0; RMS-vs-mean
	would leave a ~8 % unit mismatch in the acceptance band.
	A lookup image of cell-quantized u always has grid-scale Fourier energy. Banding
	checks must sample the analytic field on spherical directions.

## discrete divergence on the dual

	Σ_j n_ij L_ij is not zero (tens of km of leftover). Midpoint flux
	0.5 (u_i+u_j)·n L therefore reports a large fake divergence for a rigid Ω×r field.
	Use 0.5 (u_j−u_i)·n L / A; it annihilates rigid motion to ~1e-5 /Myr at L5.

## prescribed omega

	K10 overwrites ω. Transport tests (Phase A raster bench) set state.fixedOmega so
	the frame loop keeps integrate + move/bin/raster only.

## crust flux accounting (Phase C conveyor rig)

	two counter-rotating hemispheres about ±x̂ with |ω| = W share the equator as their
	boundary; relN = 2WR sin φ, so each half carries ∫|relN| dl = 4WR² of area flux.
	do not use "speed × trench length": a rigid rotation is transform almost everywhere and
	its normal speed vanishes at two points.
	the sim's own measured divergent flux under-counts the analytic 4WR² by ~33 % (395 529 vs
	637 100 km²/Myr at L4) because a jagged ridge leaves many of its edges classified
	TRANSFORM or INTERIOR. Assert the analytic value on a prescribed-ω rig; the convergent
	side measures fine (578 166 measured vs 642 771 consumed).
	cumulative consumed/flux is not assertable from t = 0: the 0.6 d contact threshold against
	d initial spacing takes one extra bite of ≈ 0.4 d L (4.5e12 m² at L4), 70 % of a 10 Myr
	total. Warm up, then rebase, then measure.

## spawn threshold (why rSpawn sits above rGap)

	at the raster's 0.75 d gap threshold both cells of an opening pair gap in the same frame
	and each spawns, so the ridge makes 37 % more crust than divergence pays for and the
	column count grows without bound. L4, 160 Myr, analytic flux 4WR²:
	  rSpawn 0.75: consumed 1.129 spawned 1.371 cols 1.0484 | 0.85: 1.002 / 0.943 / 0.9883
	  rSpawn 1.00: consumed 1.002 spawned 0.764 cols 0.9524
	L5 sweep of the same rig (current code, with the fillDelay fallback):
	  0.80 1.023 1.211 1.0379 | 0.83 1.006 1.095 1.0181 | 0.85 1.004 1.029 1.0053
	  0.87 1.003 0.979 0.9953 | 0.90 1.003 0.926 0.9849   (consumed / spawned / cols÷V)
	the 2-ring donor search is NOT the limiter: replacing the cell∪ring scan with a flat
	two-hop list left the sweep bit-identical. Kept because a fresh gap needs a donor one
	cell outside its own ring.
	census at rSpawn = 1.0 (L4): 26 552 gap cell-frames, 25 819 still below threshold, 147
	eligible, 147 spawned, reject rate 0.000. The deficit is geometric — one spawn inhibits
	its neighbours within rSpawn·d — not donor starvation.
	rSpawn leaves packing holes: a cell 0.77–0.83 d from every neighbour, ring all one plate.
	fillDelay = 20 Myr fills them, and a rift cell crosses 0.75 → 0.85 d in 4.5 Myr at
	1 cm/yr (0.9 Myr at 5 cm/yr), so the fallback never fires at a live ridge.

## mass ledger leaks (found with per-stage identity checks)

	check Σ h + produced − subducted − const after each stage; the stage that breaks it is the
	leak. Three were real:
	  spawn thinned the donors before choosing the branch, and the oceanic branch discarded
	  newFel — crust vanished at every ridge.
	  C–C collision dropped the loser's hMaf. It is delamination: book it as subductedMaf.
	  subduction dropped the loser's hFel. Felsic crust is too buoyant to subduct, so accrete
	  it onto the overriding column; Σ hFel then has arc production as its only source. Watch
	  that accretion can push an oceanic overrider past hFel = 8 km and flip its polarity.
	state.rebase() must zero producedFel / producedMaf / subductedMaf / subductedSed as well
	as re-anchor the mass baselines. Otherwise a warm-up's accumulators reappear as a 0.032
	"maf residual" in the measured window that looks like drift but is not.

## arc growth calibration

	design §11's kArc = 8000 grows arc cells past 100 km of crust in 100 Myr. Calibrating
	Earth's 2.3 km³/yr against the rate-weighted arc area (L5: 1027 arc cells, 7.04 % of the
	surface, 3.593e13 m²) gives 64; params use 65, arc max 41 km after 160 Myr.

## units on the unit sphere

	column and cell geometry is unit-sphere, thresholds are metres: chord = 2 sin(d/2R).
	comparing chord² against a metre threshold silently accepts everything — 0.6 d at L5 is
	chord² 2.8e-8 against 3.7e11 m².

## spherical gradient (gradInv)

	least-squares tangent gradient, grad z = gradInv · Σ (z_j − z_i) r_j, tangent-projected
	after the solve. Constant field → exactly zero, so there is no additive bias.
	latitude field (|y| < 0.9): worst |mag − 1| 1.14e-2 at L3 and 6.57e-3 at L5, worst
	direction error 5.43e-4 / 3.45e-5, mean magnitude 1.0011 / 1.00006.
	a degree-1 harmonic reconstructs to 3.7e-2 — fine for ridge push and routing, not for
	anything that needs an exact ∇.

## performance counter

	L5, node, 300 steps at dt 0.1: 12.9 ms/step = 77.5 frames/s. Kernel split (ms/step):
	mantle 5.34, edges 2.88, raster 1.24, contact 1.05, forces 0.60, diag 0.55, apply 0.45,
	move 0.42, reduce 0.21, bin 0.11, column 0.03, events 0.01.
	the mantle harmonic evaluation dominates the CPU budget; it is the first WebGPU candidate.
	smooth with an EMA on the frame gap (τ 500 ms) and on the step time (τ 250 ms), and
	rebuild the HUD text at 2 Hz: per-frame string concatenation is not free, and at 2 Hz the
	text rebuild touches 1.7 % of the frames.

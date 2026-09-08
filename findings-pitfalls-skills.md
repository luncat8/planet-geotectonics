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

## contact-to-force ordering

	CONTACT/APPLY can delete a column after EDGES has classified the frame. Any force pass that uses
	those edge records must re-check the current neighbour owner before reading its crust fields;
	otherwise a stale C-C polarity reads `hFel[-1]` and sends NaN into the plate solve. The contact
	search should choose the nearest closing foreign column, not simply the nearest foreign column:
	a separating transform can sit inside a closing subduction pair.

	Collision resistance should be a normal barrier, not global basal friction: scale it with closing
	speed and a bounded continental-thickness factor, and use a shorter angular relaxation (0.5 Myr)
	so the barrier does not make all plate motion look viscous. The prescribed C-C load test catches
	both the monotonic thickness response and stale-contact finiteness.

## surface coupling

	Keep isostasy in one authoritative K9 kernel. A pre-raster preview duplicated in the ownership
	kernel quickly becomes inconsistent once sediment, flexure or trench loads change a column. Compute
	elevation and gradient before routing, gather all one-hop outflow before deposition, and count mobile
	sediment in the mass ledger even when a gap has no owner. Recompute scalar z after deposition for
	rendering; the graph gradient can wait until the next frame because a single-frame erosion transfer
	is small.

## performance after surface coupling

	L5 with surface coupling remains above the 40 frames/s node floor (about 45-52 frames/s in
	repeated smoke runs); mantle harmonic evaluation and the graph gradient are the dominant kernels.
	Keep the per-frame HUD text at 2 Hz and use typed-array scratch buffers instead of per-cell arrays.

## damage calibration (why kDam is 100x design)

	design §11's kDam 0.05 / kDamT 0.02 saturate: at L4 the 0.8 threshold covers 70-95 % of
	every plate's own cells, so the corridor is the plate and every plate fragments every
	cycle. Calibrate against the corridor *fraction* instead of absolute damage
	(experiments/corridor-scan.js): kDam 5e-4, kDamT 1e-3, kHeal 5e-3 with a 0.6 threshold hold
	the corridor at 15-60 % of a plate, and healing can actually close one. 0.6 is the best of
	0.4-0.8; below it the corridor splits plates that are merely sheared, above it nothing
	splits. Two further gates are load-bearing: corridor damage resets to 0.5*splitDamage
	(otherwise the same plate re-rifts next cycle) and splitAge 40 Myr bars a newborn plate.
	minPlateCells 40 (design §11) at L5 multiplies fragments to the 128-plate cap (plate counts
	64 and 89 in a 500 Myr L4 sweep); 100 holds at 16 -> 30 map-start and 20 -> 33 hot-start.
	Components under minCells must be re-absorbed, never dropped: a dropped component's columns
	keep no owner, are never advected again, and both ledgers leak.

## rigid-body opening geometry (split and merge rigs)

	the signed mean opening across a cut is identically zero for two rigid pieces on a sphere:
	for a symmetric polar cap the two centroids and the relative omega are mutually orthogonal,
	so R*((w1-w2) x r) . t cancels exactly even at 3.5 cm/yr of real spreading. Measured on the
	split rig: +43000 and -43000 m/Myr on the two halves of the same cut. A rift criterion must
	use the positive length-weighted part (openSum/openLen >= vRift), never the signed mean.
	The same fact kills a naive merge rig: two counter-rotating hemispheres have one half in
	ridge and the other in trench, so the closing normal speed averages to zero and they never
	suture. Drive a merge rig with a dead transform instead.
	a part that inherits the parent's omega does not open either way. Fit omega per part from
	uMantle (Plates.dragFit, area-weighted rigid least squares reusing the K10 solve); against
	a prescribed rigid field at W = 25000/R the fit returns the exact omega (M 3.40e14,
	rhs 2.09e5, |omega| 6.16e-10). Cache fits per label per cycle: two dragFit passes plus a
	mask clear per candidate pair made a 500 Myr L4 run ~25x slower.
	s.uMantle is a physical velocity R*(omega x r), not omega itself. Prescribing an omega in a
	test means writing u = R*(Omega x r).

## plate census and the 65535 compaction hazard

	plateCells is only filled by K5 (Edges.velocities). A rig that prescribes omega skips K5,
	plateCells[0] stays 0, retire() removes a plate that owns cells, compactPlates() writes
	remap[0] = -1 into every live s.plate[i] -- a Uint16Array turns -1 into 65535 -- and K3
	then reads world[65535] out of bounds. NaN positions follow, and Columns.climb's for(;;)
	never converges because every NaN comparison is false, so the frame hangs instead of
	failing. Judge plates from cellPlate, which K4 rewrites every frame, and make retire()
	return early when the census is empty. A test rig that appears to hang is not always a
	test bug.

## checkpoint format

	store primitives only and recompute the derived buffers: rebuild() after a load recovers
	world from b and q, and Sim.raster recovers z/vel/owner. world on a dead column is scratch
	in both directions -- rebuild zeroes it, an uninterrupted run keeps stale values -- so a
	round-trip comparison must restrict itself to alive columns or it fails on data that was
	never meant to survive. Share one SCALARS/ARRAYS table between save and load, so a field
	cannot be saved but not restored. Validate magic, version, header arithmetic, level, V,
	capacities, every declared length and the exact data length before touching live state, or
	a truncated file half-restores and the next frame reads garbage.
	snapshot times come from s.t, which accumulates in float (20.000000000000014), so a ring
	that "should" hold four snapshots of a 80 Myr run holds three. Assert structure, not counts.

## performance after events

	L5, node, 300 steps at dt 0.1, same session and machine: base 16.93 ms/step (59.1 frames/s),
	with Phase E 17.24 ms/step (58.0 frames/s). The events kernel costs 0.116 ms/step at a
	1 Myr cadence and diag 0.09 ms more (it now checks damage and plate ids). Always compare
	against the base commit measured at the same moment: a 64.2 -> 58.0 frames/s "regression"
	was a loaded machine, and three orphaned test processes from a timed-out run were the
	whole 2x slowdown -- every kernel including untouched ones read 2x slower.

## ore geography is a production rule, not an end state (acceptance 5)

	design §10 acceptance 5 asks for > 60 % of oArc mass within 2 cells of a subduction edge.
	Measured on the final world of an 800 Myr L4 hot start it is 48 %, and it keeps falling:
	a deposit is a fossil record and the plate carries it away from the trench that made it
	(at 5 cm/yr, 100 Myr is 5000 km, far more than 2 cells). The same is true of oVms, which
	is created only on oceanic crust and then stays put while arcs bury that crust in felsic
	crust (63 % still oceanic at 800 Myr).
	So test the factories, not the map: call the owning kernel once, diff the potential, and
	assert every increment landed where the rule says. Measured shares are then exactly 1.000
	with zero violations (oArc at trenchDist <= 2 on an overriding plate, oVms on oceanic
	crust, oOro on continental, oBas on thick sediment). Report the end-state share as the
	drift number it is.
	Two traps in that diff. Events.compact renumbers the column table, so a diff across a frame
	with deaths compares different columns -- skip such frames or call the kernel directly.
	And a column can own several cells, so s.cell[i] is not necessarily the cell the kernel
	acted on; reduce trenchDist to the minimum over the cells the column owns.

## statistical geography tests need a control

	"placer is downslope of an orogenic maximum" is invisible in a full world: after 800 Myr
	almost every continental column is orogenic, so the top-100 sources and an arbitrary
	control differ by only 1.1x in the placer found downhill of them. The mechanism is still
	exactly right -- build a rig instead. One 80 km felsic summit in a 60 km plateau, only the
	summit orogenic, 100 frames of Surface.step: placer appears (0.052), only in cells
	reachable downhill from the summit, only where z < 300 m, and exactly zero when the summit
	is not orogenic. Size the rig to the erosion rate: 400 frames grinds an 8 km cone down to
	sea level and the test then proves nothing.

## cost of the ore pass

	L5 node, same session: 58.0 frames/s before Phase F, 56.1 after (17.81 ms/step). Two things
	made it cheap. Diag.ores summed six classes with s[fields[k]] inside the column loop -- a
	megamorphic property load that cost 2.07 ms/step until the six arrays were hoisted into
	locals (0.28 ms). And the belt dilation belongs in the edge pass that finds the belt, not
	in a per-column ring scan: belt edges are few, continental columns are many.

## bounded vector lengths in hot JS kernels

	Math.hypot is deliberately robust against overflow and underflow; V8 pays for that scaling
	even when every vector is a bounded unit direction, velocity or slope. In the L5 frame,
	replacing the three high-count hypot calls with sqrt(x*x+y*y+z*z) moved 17.7 -> 14.8
	ms/step in the same session: mantle 5.40 -> 3.36, edges 2.80 -> 2.36, surface 2.83 ->
	2.23 ms. Keep hypot for setup and quaternion normalization, where it is called only per
	plate. The hot replacements are safe because their operands are physically capped and
	cannot approach floating-point overflow or underflow.

	The same pass removed work that is constant for the life of a grid: K4's squared gap chord,
	K6's squared contact chord, edge tangent r x n, finite-volume n*L/(2A), and symmetric
	collapse weights. Compute those once in Grid/State. Combining mass, ore and rigid checks in
	one diagnostic column traversal, and comparing squared rigid error until the final sqrt,
	cut K11 from about 1.2 to 0.6-0.9 ms/step. L5's strict node proxy then measures 65-68
	steps/s; keep a 40 steps/s development floor because shared CI load is not a calibration.

## calibration resolution and duration

	A low-resolution sweep is useful for checking plumbing, not choosing release defaults.
	At L3/300 Myr the scaled fragment floor is only six cells: the dt 0.02 baseline reaches 55
	plates and 43% continents while the established L5/1500 Myr baseline has 30 plates and 19%
	continents. Event frames also dominate a sampled boundary-flicker ratio on the coarse mesh.
	Use experiments/sweep.js --quick only as a smoke test; make parameter decisions from L5,
	1500 Myr rows at both dt values. Sweep U0, vSlab, kArc and kCollapse one factor at a time
	before trying a Cartesian neighbourhood: one full L5 fine-dt trajectory is already tens
	of thousands of coupled frames, and low-resolution ranking does not transfer.

## CPU release history

	The L5 seed-7 release profile reaches 4500 Myr at dt 0.1 with finite state, exact ledgers,
	21 plates, 13.5% continental columns, 4.9% cratons and 1.27 cm/yr mean speed at Tm 0.56.
	At the 1500 Myr acceptance epoch it has 18.8% continents; the 500-1000 Myr mean is 6.06
	cm/yr. The dt 0.01 history at 500 Myr remains statistical rather than pointwise: 30 vs 32
	plates, 19.9 vs 20.1% continents, and 7.15 vs 5.87 cm/yr. Exact trajectories diverge from
	minute floating-order changes, so release gates must stay on invariants and declared
	statistics, never column identity after thousands of frames.

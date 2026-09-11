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

## WebGPU parity: precision floors, not bugs

	Measured on SwiftShader (Chromium 137, forceFallbackAdapter): builtin cos is only
	accurate to 1.9e-4 at |x| ~ 3 and 2.6e-5 even near zero - the WGSL spec allows 2^-11,
	so this is legal. exp is fine (1.1e-6 worst on [-6,2]). The GPU kernels that must track
	the f64 CPU reference therefore use a private cosx: Cody-Waite reduction with a two-word
	2*pi (callers stay under |x| <= 16) plus an even Taylor series in y = t*t, all fma, good
	to 5.5e-7. integrate uses a small-argument sinx series for the quaternion increment.
	The plume term computes 1 - dot(pp, v) through the chord |pp - v|^2 / 2: the direct
	subtraction cancels near the plume axis and invSig (~160) amplifies the residue into
	plumeT; the chord form is exact by Sterbenz and matches to 1e-7.

	Velocity-family fields (uMantle, vel, relN, relT) carry f32 noise relative to the
	FIELD scale, not to each near-cancellation value, so their parity tolerance is the
	plan's "normalized units": (1e-6 + 1e-5 |x|) * vRef. With that, boot parity is exact
	on every integer field and every float is inside tolerance.

## WebGPU parity: the K10 solve and the ledger scale

	The normal equations are ~A0*N ~ 1e13, so a cofactor solve in f32 overflows (det
	products ~1e40 -> inf-inf -> NaN). Divide every entry by A0[0] before solving; the
	solution is unchanged and eps becomes exactly 1e-4. Chunk partials and the final
	64-partial sum use Kahan compensation, and the solve takes one fma-residual refinement
	step; without those, omega drifts ~1.5e-5 relative, which is exactly the vel parity
	budget.

	Mass ledgers run 1e14-1e15, so fixed point at 1e6 overflows even i64, and a single
	erosion event (3.5e14) overflows the i32 atomic delta slot outright. The GPU ledger
	instead accumulates per-column f32 deltas in a scratch region (one writer per column
	per kernel), Kahan-reduces them per chunk in fixed column order, and folds the frame
	total into a running hi/lo f32 pair with twoSum - f64-like precision forever, and
	bit-identical across repeat runs.

## WebGPU parity: dispatch shapes and small constants

	Kernels that map workgroup_id -> chunk and local_id -> item must be dispatched with
	runGroups(nChunks, WG); run(threads, WG) computes groups = ceil(threads/WG) and
	silently ran reduceA/subRateA on ONE workgroup (1/64th of the cells) - the symptom was
	a plausible-looking but wrong omega, not a crash. zeroFrame's first branch must end at
	exactly the slot count it zeroes (a t < 6 guard over an off-by-one u = t - 5 skipped
	plate 0's cells counter; 1392 = 2 x 696 was the tell). WGSL forbids swizzle assignment
	(r.xyz = ...) - build the vector in one constructor. The default storage-buffer limit
	is 8 per stage and spawn/columnStep need 9: request the adapter's ceiling (10 here),
	and validate against device.limits, not a hardcoded 8.

## WebGPU parity: threshold-triggered divergence is the expected end state

	From identical checkpoints the runs agree exactly (integers) and within f32-tolerance
	(floats) for 7 frames at L5/seed 7; the first structural divergence is a consume event
	in frame 8. Every early divergence is a legitimate threshold crossing under
	within-tolerance noise: flat abyssal floors tie z to ~1e-15 and the CPU breaks the tie
	by exact f64 value while f32 sees equality and breaks by index (gpu picks the lower
	index 759/759 times); relN sits within ~750 of epsHi/epsLo at a few percent of
	boundary edges and flips edgeType/polarity, which moves trench marks, which moves arc
	deposition, which changes hFel/z and the erosion routing. The cascade is real physics
	being re-decided, not error growth: ledgers, plate counts and speeds stay within
	bounds. Gate long GPU runs on statistics (plate count, speed and area-age
	distributions), never on column identity - the same rule the CPU dt-comparison tests
	already use. Same-device repeat runs are bit-identical over 25 frames including two
	event cycles (tests/gpu-parity.js --determinism).

## WebGPU parity: four kernel bugs the frame-1 gate could not see

	Frame-1 parity passes on a freshly zeroed world, so every bug that only fires on a
	STATE TRANSITION survives it. Four such bugs shipped together and each needed its own
	detector:

	1. Tint/SwiftShader fold `x != x` to false under a no-NaN assumption (measured: both
	   n != n and n == n are false on a quiet NaN). Every WGSL NaN guard must go through
	   the bit pattern: isNanF(x) = exponent all ones and mantissa nonzero. The symptom
	   was elevationG computing gradients from gap-cell NaN z and poisoning gradZ, slope,
	   then omega and velocities - and the GPU's own finiteness check (n != n) reporting
	   finite=1 throughout.
	2. setEdgeType packed the type into byte 0 of the edge word but its mask kept byte 0
	   and cleared byte 1: the new type was OR-ed onto the old. 1|2 = 3, so an edge that
	   ever became TRANSFORM could never leave it, and CONVERGENT<->DIVERGENT flips
	   became 3. Frame-2 "threshold cascade" (147 edgeType, 68 polarity mismatches, then
	   omega +3%/frame compounding to a 40% mean-speed drift by t=44) was entirely this
	   bug. Packed setters must clear exactly their own byte.
	3. scanCRank read scanOut(c) - the block-local exclusive prefix from scanA - without
	   adding the scanB block offset, so spawn ranks restarted at 0 every 1024 cells.
	   Duplicate slots made the spawn kernel a last-writer-wins race: same-device
	   determinism passed 8-22 frames and failed ~1 run in 2 at 25 (the failure needs
	   spawn flags in 2+ blocks and a loser to overwrite). The scan scratch buffers are
	   not part of the mirror compare; only dumping the raw SCAN buffer exposed it.
	4. overlaps broke exact squared-distance ties by atomic bin order; now a total order
	   (d, lower column index) matching the CPU's index-ordered bin fill.

	Locating 2-4 took three probe designs worth reusing: (a) run the same upload twice
	with per-frame mirror compare to bracket the first bad frame, then replay that frame
	kernel-by-kernel; (b) a single-frame bias test - clone the GPU state into the CPU
	mirror, evolve one frame on each side, diff per-plate M/rhs/omegaTarget - which
	turned a vague 40% statistical drift into "rhs is 25% off from identical state";
	(c) CPU chaos probes to size the envelope: injecting one cell's hSed, or even the
	GPU's whole frame-2 integer decision set, washes out to <1% drift, and cloning the
	GPU's full frame-2 state gives ~12% - so a 40% drift was provably bias, not chaos.

	Also: the harness called state.reset({seed, level}) but State.reset takes a raw
	number - the object coerced to 0 and every "seed 7" run was seed 0. All comparisons
	stayed apples-to-apples, but three "different seeds" were one. Reset signatures are
	part of the test surface; assert the boot actually differs between seeds.

	After the fixes: frame 2 is clean except 745 sub-f32 low ties; integers hold ~20-50
	frames (first consume/spawn threshold crossings after that); the 1000-frame,
	3-seed ensemble ends within plates +-1, columns 1.4%, mean speed 14%, continental
	share 1.5pp at t=100 Myr, and same-device determinism is bit-exact past 60 frames
	including two event cycles.

## WebGPU memory and the app integration

	Buffer schema measured, not estimated (H5): the device holds 9.1 MB at L5, 35 MB at
	L6 and 138.9 MB at L7 - dominated by gridF (83 words/cell), colF, cellF and edges;
	the fattest single buffer (gridF, 51.9 MB at L7) is well under the 128 MB storage
	binding ceiling. The JS mirror on top is another ~60 MB of f64 arrays at L7, so the
	real cost of the port is about 200 MB at L7 including the mirror - fine for a
	desktop tab, worth remembering on mobile.

	SwiftShader is a correctness floor, never a perf number: L5 161 ms/frame,
	L6 629 ms, L7 2.5 s on this container's CPU (no timestamp-query support either, so
	per-kernel timing needs real hardware). The 60 fps at L7 acceptance therefore
	cannot be closed headlessly - it needs a hardware run through the same harness.

	The app integration runs the GPU backend beside the CPU one: same renderer, column
	inspector, checkpoints and deposits JSON, all reading the downloaded mirror at
	render cadence (one download per animation frame, events still on the CPU mirror).
	The remaining H4 step is the no-readback renderer (render pipelines reading cellF/
	cellI directly); the mirror download is ~8 ms at L5 and is the thing to remove
	before L7-in-the-app is more than a demo.
## WebGPU parity: collapse ties on the CPU too (fround), don't just document them

	The 745 sub-f32 low ties above are not irreducible. Make the CPU pick the drainage
	neighbour on Math.fround(z) instead of the f64 value: sub-ulp differences collapse
	into the same f32 on both engines, both then break the tie by the smaller cell
	index, and frame-1 low flips drop 745 -> 28 (~0.3% of cells). The residual is the
	mirror image of the old failure: the GPU's own z differs from fround(cpu z) by
	1-4 ulp (different arithmetic paths through the elevation formula), so where the
	CPU now sees a tie the GPU still sees a real difference. Only a full f32 reference
	sim (all crust state rounded every frame) would close that; the ensemble bounds
	remain the gate for long runs. Rule: every discrete decision shared with the GPU
	(low, wet, fraction thresholds) should be taken on f32-quantized inputs on the CPU.

## The no-readback renderer (H4) and where the mirror is allowed back

	render-gpu.js is the render.js twin as a fragment shader: one fullscreen triangle,
	the layer id in a four-byte uniform, the static lookup raster in its own read-only
	buffer, and the sim buffers bound read-only - a frame costs one draw and zero
	readbacks. Headless validation without a presented canvas: render into an
	offscreen RENDER_ATTACHMENT texture, copyTextureToBuffer, compare against
	render.js's expected colors per cell. Nine layers come out pixel-exact; plate,
	type and z differ by at most 1 per channel (f32 cos/ramps vs f64 rounded to u8).

	The CPU mirror is now allowed back only at: the event cadence inside GpuSim.step
	(events run on the CPU, one cycle late), a probe click, save, and the deposits
	extract. The frame loop never downloads: the old per-render download was ~8 ms at
	L5 on hardware (~113 ms on this container's SwiftShader) versus ~0.2 ms to submit
	a frame's dispatches - it alone explained the ~50 fps GPU mode ceiling.

## Headless WebGPU rig: what works in sparticuz chromium and what silently dies

	Recipe: npm i @sparticuz/chromium puppeteer-core; extract to /tmp (chromium,
	al2023/lib with libnss, swiftshader); LD_LIBRARY_PATH=/tmp/al2023/lib; launch
	headless=new with --enable-unsafe-webgpu --enable-unsafe-swiftshader
	--in-process-gpu --no-sandbox. The page must come from http://127.0.0.1 or
	file:// - about:blank via puppeteer is not a secure context and navigator.gpu is
	undefined there.

	Two hard bugs in that build (152.0.7977): queue.writeBuffer rejects any nonzero
	dataOffset ("Number of bytes to write is too large") even when it fits - pass a
	subarray instead; and presenting a webgpu canvas kills the instance at the next
	mapAsync ("A valid external Instance reference no longer exists", sometimes a
	target crash) - sim dispatch + mapAsync without presents runs forever, presents
	without mapAsync run forever, only the combination dies. So: validate renderers
	via offscreen texture readback headlessly, and leave the presented-canvas path to
	real hardware. tests/gpu-parity.js takes PGT_CHROME / PGT_PUPPETEER / PGT_LIBS so
	the rig is not tied to /tmp paths.

## plate fragmentation was stranded orphan components, not split/merge balance

	Symptom at 1 Gyr (L5 map start): 27 plates, median 348 cells, 58% of all cells on a
	plate boundary (~51% subduction + ~46% ridge), plates shredded into interleaved
	fingers (isoperimetric quotient ~0.01), and 40% of covered cells sitting OFF their
	plate's main connected component. The obvious suspects were wrong: with splits
	disabled (Params.splitDamage=2) components still went 16 -> 155 in 300 Myr, and the
	release longrun log shows splits ~= merges - the seeder, not events, makes the
	mess.

	Root cause: contact.overlaps consumed columns only at strongly convergent contacts
	(gate R.closing > -epsHi), while gaps() spawns crust on whichever flank owns the
	nearest column - hash tie-break. A sliver stranded on the wrong side of a
	divergent/tangential contact is never consumed, never absorbed (it is only a
	fragment of a LARGE plate, and absorb only looks at whole plates below the floor),
	and rides with its plate forever, accreting a moat of wrong-side newborn crust
	(all 218 orphans measured < 250 cells; embedded slivers showed age 0.4 Myr plate
	labels already flipped). Probes: experiments/plate-{fragmentation,islands,shape,
	size-sweep}.js.

	Fix (js/events.js Events.orphans, terrane accretion, runs after split each cycle):
	per plate, plain-connectivity components (threshold infinity, so a damage corridor
	does not disconnect); largest = main; every other component below minCells is
	rebased into the plate owning most of its adjacent cells, crust keeping its world
	position exactly like a merge. Numbers, L5 map 1 Gyr seed 7: plates 27 -> 14,
	components 229 -> 18, island cells 40% -> 3.4%, boundary share 58% -> 19%, median
	plate ~810 cells; ASCII plate map coherent. Transform boundary share stays ~2-3%
	- a genuine property of the velocity field, not a defect.

	What did NOT fix it (do not retry): raising minPlateCells to 250 (12-14 plates but
	boundary still 46-60% - size floors do not remove interleaving); ridge-spawn
	hysteresis locking the spawn plate to the last owner within 25% distance margin
	(WORSE, 45.9% islands - locking the axis to one flank widens the misassigned
	bands); the epsHi gate fix alone (39.9% islands - kept only because design 4.1
	says every overlap removes one column). Secondary change that stays: the absorb
	floor is Events.minCells itself (was 0.5x) - plan E1's stated intent, and with
	terranes accreting there is no reason for half-size plates to linger. minPlateCells
	stays at the author's 100.

## terrane accretion shifts ore fossils, legitimately

	tests/ores.js arcOnOverrider was brittle at 0.9 (baseline 0.911): terrane accretion
	moves arc-fossil crust across plate labels, so a trench-side override can carry
	arc potential from its accreted terrane - baseline moved to 0.896. Threshold now
	0.85 with a comment. Rule: statistical geography tests that depend on plate
	IDENTITY need margin for relabelling; tests that depend on crust POSITION do not.

## structural WGSL checks without a GPU (tests/wgsl-struct.js)

	The failed-gpu branch shipped ten kernel modules that never compiled (undefined
	constants, reserved keywords); nothing caught it because compilation only happens
	in the browser. tests/wgsl-struct.js rebuilds every kernel's full source in node
	(CommonWGSL prelude for its groups + body, plus the renderer shader with its const
	patch) and asserts: brace/paren balance, an entry point, every SCREAMING_CASE
	token defined (const/fn/let/struct/var<...> declarations), and every called name
	either declared or a WGSL builtin/statement from an allowlist. Probe-validated:
	renaming a constant, adding a stray brace, dropping a group from a spec (kills
	prelude helpers) and typo-ing a helper all fail with a pointed message.

	Subtleties that each cost a probe iteration: strip comments FIRST (words and
	braces in comments are neither definitions nor references); `var<storage,
	read_write> NAME` needs the address-space attribute in the declaration regex;
	multi-letter constants (CELL_EPS) do not match a two-letter-prefix token regex;
	scan uses scanA/scanB/scanC entries, the renderer fs, everything else main - so
	"entry point" means @compute/@fragment present, not literally fn main.

## never `git checkout -- <file>` while it carries uncommitted fixes

	Probing the new test with an injected bug, restoring with `git checkout -- file`
	silently reverted that file's real uncommitted fix (the wgsl-contact gate) - the
	probe had hit the wrong file, so nothing looked wrong until the CPU/GPU gates were
	diffed. The ensemble that had started before the revert was still valid only
	because node had already required the module into memory. Rules: restore probe
	mutations with `cp backup file`, never git checkout, in a tree with uncommitted
	work; and remember a long-running node process executes the code it loaded at
	startup, not the file on disk.

## 0.3 Phase I rig: headless WebGPU is environment-dependent (2026-09)

	SwiftShader WebGPU did not come up in the current sandbox image: navigator.gpu
	exists, but requestAdapter({}) and { forceFallbackAdapter: true } return null
	under sparticuz chromium 126 and 119 with the documented flags (plus
	--enable-features=Vulkan and ANGLE-SwiftShader variants). tests/gpu-parity.js
	fails identically, so GPU numbers are owner-rig numbers until the image
	regains a working SwiftShader path (the 0.2-H log predates the image change).
	New sparticuz layout recipe: npm i @sparticuz/chromium@126.0.0
	puppeteer-core@23; require(...).executablePath() extracts the binary +
	swiftshader libs to /tmp; al2023.tar.br is brotli (zlib.brotliDecompressSync)
	then tar -> /tmp/al2023/lib (libnss3 set); LD_LIBRARY_PATH=/tmp/al2023/lib:/tmp.
	The classic getLddir/inflate API is gone in 119+.
	The bench infrastructure is environment-independent: bench.html (standalone
	GUI, the climate-repo pattern - dark panel, controls, results table with 60
	fps highlight, time-boxed medians, auto-run, ?fast=1/?noauto=1, ?level/&steps/
	&dt pre-fill) runs the two modes (iso: kernel graph only,
	onSubmittedWorkDone per n frames; smooth: full play path under rAF with gap
	distribution) and prints BENCH lines + window.__benchDone;
	index.html?bench=1 redirects to bench.html so there is one implementation;
	experiments/gpu-bench.js drives bench.html headless (--out log, PGT_QUERY
	pre-fills the inputs). Machines without an adapter get a clean "BENCH skip"
	line, so the driver never hangs.
	/tmp is NOT persistent across turns in this sandbox (the sparticuz rig,
	binary and libs vanish) - rebuild with the recipe above at the start of the
	turn that needs it. Note: @sparticuz/chromium 119 extracts its al2023 lib
	drop to /tmp/lib (not /tmp/al2023/lib as 126 did); LD_LIBRARY_PATH=/tmp/lib:/tmp.

## 0.3 Phase I design: timestamp ring, not per-pass readback

	Per-kernel GPU ms comes from one timestamp query set (2 queries per dispatch,
	start/end inside the compute pass) resolved per frame into a 4-buffer ring;
	collect reads the slot two submits back (its work and resolve are done; a
	completed buffer maps in ms, and the 4-deep ring gives two free slots of
	slack before reuse). The collect is 2 Hz (HUD) or per-step (node), never on
	the frame path, and any map/resolve failure self-disables ts (tsOn=false)
	rather than risking a device error. Query set creation is feature-gated
	(requiredFeatures only when adapter.features.has('timestamp-query')), so
	SwiftShader builds without it run the exact same frame with zero overhead.
	Timestamp period is assumed 1 ns (ANGLE/Swiftshader convention) - the HUD
	line is relative ms, which is all the comparison needs.

	Pitfall caught by the node overhead harness: TypedArray.sort() has NO range
	overload - the first argument is the compare function, so
	`buf.sort(0, n)` throws in node and would have thrown in the browser's 2 Hz
	strip too. The bug was latent because the bench page skips the normal frame
	loop and no container test drives Perf.update. Rules: sort the whole scratch
	buffer (pad the unused tail with Infinity first so the first n entries stay
	the n real values), and any page-only code path (Perf.update, GpuSim.ts*)
	must have at least one node-executable exercise, not just a load test.

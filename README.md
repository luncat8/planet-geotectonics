# Planet Geotectonics

planetary tectonics simulator in development. no-build, offline.

![Geodesic Planet screenshot](screenshot.avif)

## Run

Open `index.html` directly in a browser.

## Current implementation: Phase G CPU release

- Icosahedral grid with flat adjacency/geometry tables and deterministic land mask.
- Fixed-capacity column and plate arrays; seeded Voronoi plates, `q = identity`, `b = r`.
- Precessing poloidal–toroidal mantle flow (mean speed `U0·Tm^2.5`) plus short-lived plumes.
- 3×3 plate solve `M ω = rhs` driven by basal drag, slab pull, ridge push and thickness-aware
  collision resistance, with responsive relaxation and a `vMax` cap.
- Boundary classification with hysteresis, subduction polarity and 2-ring `trenchDist`.
- Crust cycle: divergent gaps spawn columns (mantle-derived oceanic crust, or crust rifted
  and thinned from the flanks); convergent overlaps consume the loser, scrape its sediment
  into an accretionary prism and grow arc crust two cells behind the trench; continents
  merge instead of subducting.
- Airy isostasy with thermal oceanic subsidence, dynamic trench/plume loads, flexure and
  symmetric gravitational collapse of thick continental crust.
- Deterministic one-hop erosion and sediment routing with mobile buffers and exact crust-plus-
  sediment mass accounting.
- Damage accumulation from strain and plume heating; at a 1 Myr cadence plates split along a
  rift corridor into components with their own least-squares-fitted rotation, small fragments
  are re-absorbed, slow or continent-colliding boundaries suture, and plates merge by rebasing
  the loser's columns into the winner's frame. Divergent boundaries that strand a sliver of one
  plate inside another are cleaned up by terrane accretion: components disconnected from their
  plate's main body are rebased into the plate that owns most of their surroundings, so plates
  stay coherent instead of shredding into interleaved fingers.
- Planetary cooling `Tm(t)` scaling the mantle speed, crust production and damage healing;
  hot-start and map-start initial states.
- Checkpoints: a ring of full states every 20 Myr, plus save/load to one validated binary
  blob, so a run can be resumed from a file.
- Metallogeny: six saturating potentials per column (VMS, mafic, arc, orogenic, basin, placer)
  scaled by a fertility drawn at birth, accumulated where each geologic factory runs and
  fading on a 500 Myr decay. Arc potential is enriched by whatever that plate is subducting;
  placer is liberated by erosion and rides the sediment load downhill.
- Deposit catalogue on demand (0.6.1): a one-cell blur of each potential and its ranked local
  maxima become records with numbers. A flat class table of thirteen Earth-anchored rows
  (porphyry, epithermal, VMS, Ni-Cu-PGE, cratonic diamond, orogenic vein, Carlin-style Au,
  sandstone uranium, coal, potash, placer Au, Superior- and Algoma-type iron) turns a quantized
  potential into a tonnage off a percentile ladder, log-uniform grades with the published negative
  grade-tonnage correlation, 1-8 ore bodies whose shape follows one aspect ratio and reproduces
  the tonnage exactly, a depth that knows whether the class is hosted in the basement or inside
  the sediment pile, contained metal, and the industry's own grade / size / depth viability screen
  with the failing leg named. Every number is a function of integer buckets and of a hash of
  (seed, class, quantized body direction), so it does not move when the sim drifts under a bucket
  or the clock advances. `Deposits.at` answers one cell for a click; `Deposits.build` is an
  explicit O(V) catalogue (21 ms at L5, 74 ms at L7) that only an export or a regional request may
  start, and `Deposits.json` dumps it as `pgt-deposits` v2.
- Single-cell prospecting (0.6.0): choose any combination of field observation, stream geochemistry,
  gravity/magnetics, ground radar, shallow/deep drilling and lab assay, then click one cell. The
  report is pinned independently from the cheap pointer-follow column probe; hover never surveys
  or adds ledger entries. Reach, cover, drainage footprint and deterministic detection noise gate
  each tool, while independent readings, drilling and lab work build inferred/indicated/measured
  confidence in a page-local ledger. Candidates have stable column-frame identities and depth
  buckets, and each found line now carries the 0.6.1 economics - variant, commodity, tonnage, size
  class, grades, body count, depth interval and the viability verdict. A survey performs no
  world scan at all: core logs, map-wide campaigns and markers are later increments, so this
  workflow does not scan or claim the whole planet.
- Canvas map with plate, boundary-type, elevation, coverage, sediment, damage and six ore
  views, plus a column probe and a plate-lineage/split/merge readout. Drag the map to rotate
  the surface; the trackball view has no latitude/longitude clamp and slows horizontal motion
  naturally near a pole. The sim never pauses for the pointer as such: a frame defers its step
  only while the view is moving, and for `VIEW_HOLD_FRAMES` after it stops, on both engines — the CPU
  frame that re-samples the view is ~18 ms heavier, and a GPU batch carrying the event round
  trip holds the device queue and then the main thread long enough to stutter the drag. A
  held-still pointer keeps the sim running; a resting pointer resumes it without waiting for the
  release, and a batch the drag catches mid-flight stops at its next frame boundary.
- Performance counter: smoothed fps, physics step time and per-kernel milliseconds, text
  rebuilt twice a second. Static geometric coefficients and bounded-vector length kernels keep
  the strict L5 Node proxy above 60 steps/s on the calibration host.
- Live adjustment (the Adjust group, 0.3.3): a Cooling switch and a Mantle Tm slider on the
  world's temperature, `Friction ×` on the asthenosphere damping exponent, `Erosion ×` on the
  sediment intake and a `Relief range` for the elevation ramp. Temperature and its switch are
  JS-side bookkeeping the frame block already carries, friction and erosion each promote one
  slot into that block, and the ramp is renderer-only, so all four apply mid-play on both
  engines with no restart and no measurable cost. The Tm slider re-anchors the cooling curve and
  follows the sim at 2 Hz while nothing is holding it, and a capture's header records every
  non-default value, so `?tm=1.4&cool=0&fric=1.5&ero=0.5&relief=9` re-runs what a log describes.
  The erosion intake itself is quadratic in elevation around `zKnee`, a calibrated release const
  (see `0.1.5-final-design.md` §7.3).
- CPU release tooling: a reproducible one-factor calibration sweep at both calibration frame steps,
  an optional 4.5 Gyr release test, and a browser run-to-time control (4500 Myr by default).
- 3D planet view (0.5.0/0.5.5): the elevation-and-water look on a displaced mesh - terrain
  deforms the silhouette - with a translucent sea shell at the display level, an orbit/zoom
  camera and a Displacement x slider, drawn from the same segment-final heights as the 2D map
  on both engines (a render-only WebGPU device when the sim is on the CPU). One height texture
  per frame from a gather pass; no frame rebuilds the mesh. Two meshes, either live: the
  icosphere (k6-k9, the 12-seed facets) and the 0.5.5 equirectangular lattice (512x256 to
  2048x1024, the height texture's own topology), with surface normals from screen-space
  derivatives or per-vertex analytic from the height field. The mesh, the detail and the
  normals are Adjust selects that swap buffers or pipelines on the running session. Off by
  default; `?v3d=1&disp=12&k3d=8` or `?v3d=1&mesh=grid&norm=analytic` prefills it.
- WebGPU engine (Phase H): the same kernel graph runs on the device (engine select in the
  controls). The map renders straight from the GPU buffers in a fragment shader, so playing
  never reads the state back; the CPU mirror is only pulled in for plate events (one cycle
  late), the column probe, saving and the deposit extract. The event cadence travels light:
  it ships only what the event cycle reads and writes (columns, plate table, frame
  counters), because the frame kernels recompute every cell and edge array themselves. Same-device repeat runs are
bit-identical, and 1000-frame CPU-vs-GPU ensembles stay within predeclared statistical
bounds (`node tests/gpu-parity.js 1000 --ensemble`; boot/parity/determinism modes in the
same driver, browser paths overridable via `PGT_CHROME`/`PGT_PUPPETEER`/`PGT_LIBS`).
- Earth start (0.4.0/0.4.5/0.4.6): the Startup fieldset can boot the real Earth instead of the
  procedural land mask. `?start=earth` is present-day Earth, baked from the PALEOMAP 0 Ma map
  plus the NNR-MORVEL56 plate model (true sea level, 70.8 % wet, real 25 plates, 1° and 0.5°
  packs); `?start=pangaea`, `?start=gondwana`, `?start=jurassic`, `?start=cretaceous`,
  `?start=kpg`, `?start=eocene` and `?start=miocene` boot the 250, 200, 150, 100, 65, 40 and
  20 Ma reconstructions
  (Scotese & Wright 2018), whose re-baked packs carry the PALEOMAP rotation model's own plate
  ids per cell. An Earth start shows a Preset select: `realistic` pins the thermal budget and
  prescribes the rotations — constant NNR Euler poles (`prescribedOmega`) on the modern start,
  ω(t) steered per step from the rotation model with the topology frozen on an epoch pack
  (Mode S) — while `game` hands the rotations to the procedural mantle. The sea controls ride
  the true hypsometry. The Reconstruct slider (Mode K) scrubs an Earth start to any past
  epoch through the committed rotation model: exact rigid rotations, reversible, display-only,
  and the release restores the live pose. `experiments/reconstruct-score.js` gates the
  kinematics over the whole ladder (IoU 0.3954 at 250 Ma rising to 0.7437 at 20 Ma against
  measured ceilings of 0.4537/0.4657 at the two oldest); `experiments/paleo-score.js` steps a
  checkpoint forward to the present: the steered runs converge (Pangaea ends at IoU 0.319 vs
  the procedural plateau of 0.252, Gondwana at 0.352, both rising at the end; 0.416 / 0.503 /
  0.660 / 0.679 / 0.742 at 150 / 100 / 65 / 40 / 20 Ma), and the gate is corrected to that
  measurement —
  a forward run cannot reach the rigid ceiling because any prescribed-ω world erodes its land
  over hundreds of Myr (the modern pack falls to IoU 0.20 against its own mask in 250 Myr;
  see the 0.4.6 plan §10.3). Every epoch on the `0.4.0-Earth-map-plan.md` §8.5 roadmap is now
  baked and staged (see `0.4.6-review.md` and that plan's §8).

See `0.2-plan.md`, `0.1.5-final-design.md`, `0.4.0-Earth-map-plan.md` and the prospecting
stages in `0.6.x-plan-deposit-prospector.md`; the reviews are in `0.6.0-review.md` and
`0.6.1-review.md`, and the catalogue's measured calibration is §10 of
`0.6.1-plan-deposit-catalogue.md` (`node experiments/deposit-calibration.js`).

## Test

```
node tests/run-all.js            short profile: 35 tests except the four histories (~2 min)
node tests/run-all.js --full     the gate: adds kinematics, ores, alloc and longrun (~15 min)
node tests/run-all.js --release  --full plus the 4.5 Gyr profile and the strict 60 fps proxy
```

Uses only Node built-ins. The short profile is the iterating set; `--full` adds the tests whose
runtime scales with simulated time (`longrun` alone is ~10 min on two cores, 12 of the gate's
18 min on the owner's rig), so it belongs on a real machine - run `run_full_test.py` there
(double-click on Windows, `python3 run_full_test.py` elsewhere) and get
`experiments/logs/full-test-<2026-09-15-01-34>.log`; `run_gpu_parity.py` does the same for the
headless CPU/GPU ensemble (`tests/gpu-parity.js`, needs the Chromium/puppeteer rig).
A capture's first line is its environment, kept short: date to the minute, browser, OS/CPU type,
and the GPU as a type plus one vendor word (`2026-09-15 01:34 · chrome 151 · linux x86_64 ·
gpu hardware nvidia`, built by `js/env.js`).
The runner launches the retained-memory test with `--expose-gc`.
The JS side of the GPU engine - the mirror transfer and the play path's scheduling - runs
headless against a stub device (`tests/gpu-play.js` on `tests/gpu-stub.js`), and
`node experiments/roundtrip-cost.js` times the round trip.
The GPU path itself is verified in a real browser: double-click `webgpu-smoke.html`
(`run-smoke.bat` / `run-smoke.command`), which boots the engine, runs a CPU/GPU parity
stretch, exercises the timestamp ring and every map layer, and offers the full report
as `webgpu-smoke-<2026-09-15-01-34>.log`.
The release profile extends the stability histories to 4500 Myr at dt 0.1 and 500 Myr
at dt 0.01, and makes the 60 steps/s performance proxy strict - it is what
`node tests/run-all.js --release` (and `run_full_test.py --release`) runs.

A full calibration sweep is separate from the test suite because it runs 18 long histories:

```
node experiments/sweep.js --level=5 --myr=1500 --out=sweep.json
```
Phase A: grid geometry, analytic rigid rotation, bitwise determinism, L5 cap transport at
both dt endpoints, crowded bins. Phase B: mantle mean speed / poloidal divergence / spectrum,
`ω = Ω` identity, least-squares drag fit, two-plate edge classification and flicker, thickness-aware collision
loading, a natural contact-deletion finiteness run, and 16-plate 500 Myr (dt 0.1) and 50 Myr
(dt 0.01) kinematics. Phase C: a prescribed-ω conveyor belt whose
consumed and spawned area both match the analytic `4WR²` flux, with exact `hMaf`/`hFel`
ledgers and a stable column count; a rifted continent whose margins thin 35 → 13 km within
three cells and then form oceanic crust. Phase D: calibrated isostasy, a cone-to-basin erosion
ledger, routing stability and 10,000-frame thick-plateau collapse. Phase E: a prescribed
damage corridor splitting into exactly two plates with column world positions preserved to
1e-9, direct merge and retire rigs, a checkpoint round trip with malformed-blob rejection, and
a hot-start 1500 Myr run (plus 300 Myr at both dt endpoints) asserting finite state, 1 %
invariants, 6-40 plates and per-epoch speed statistics; plus L5 throughput with the per-kernel
breakdown and a retained-memory smoke test. Phase F: each potential's production site asserted
exactly by diffing one kernel call, a placer rig that erodes a single orogenic summit, bounded
potentials over an 800 Myr hot start, ranked deterministic deposit extraction and a checkpoint
round trip. Phase G adds the strict throughput proxy, reproducible one-factor sweep, and the
optional 4.5 Gyr release profile. Phase H adds a GPU-free structural check of every WGSL kernel
source (brace/paren balance, entry point, and every referenced constant or called helper defined
in its prelude+body), catching the undefined-constant class of error that only surfaces at page
load (`node tests/wgsl-struct.js`).

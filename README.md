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
- Deposit extraction on demand: a one-cell blur of each potential, its ranked local maxima,
  and a context tag per deposit, dumped as JSON.
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
- 3D planet view (0.5.0): the elevation-and-water look on a displaced icosphere - terrain
  deforms the silhouette - with a translucent sea shell at the display level, an orbit/zoom
  camera and a Displacement x slider, drawn from the same segment-final heights as the 2D map
  on both engines (a render-only WebGPU device when the sim is on the CPU). One height texture
  per frame from a gather pass; the mesh never rebuilds. Off by default;
  `?v3d=1&disp=12&k3d=8` prefills it.
- WebGPU engine (Phase H): the same kernel graph runs on the device (engine select in the
  controls). The map renders straight from the GPU buffers in a fragment shader, so playing
  never reads the state back; the CPU mirror is only pulled in for plate events (one cycle
  late), the column probe, saving and the deposit extract. The event cadence travels light:
  it ships only what the event cycle reads and writes (columns, plate table, frame
  counters), because the frame kernels recompute every cell and edge array themselves. Same-device repeat runs are
bit-identical, and 1000-frame CPU-vs-GPU ensembles stay within predeclared statistical
bounds (`node tests/gpu-parity.js 1000 --ensemble`; boot/parity/determinism modes in the
same driver, browser paths overridable via `PGT_CHROME`/`PGT_PUPPETEER`/`PGT_LIBS`).
- Earth start (0.4.0/0.4.5): the Startup fieldset can boot the real Earth instead of the
  procedural land mask. `?start=earth` is present-day Earth, baked from the PALEOMAP 0 Ma map
  plus the NNR-MORVEL56 plate model (true sea level, 70.8 % wet, real 25 plates, 1° and 0.5°
  packs); `?start=pangaea` and `?start=gondwana` boot the 250 Ma and 200 Ma reconstructions
  (Scotese & Wright 2018) as pole-less packs. An Earth start shows a Preset select:
  `realistic` pins the thermal budget and, for the modern start, the NNR Euler poles
  (`prescribedOmega`), while `game` hands the rotations to the procedural mantle — on a
  pole-less historical pack, `realistic` is a frozen-pole game run. The sea controls ride the
  true hypsometry. `experiments/paleo-score.js` steps a checkpoint forward to the present and
  scores its land mask against the modern one: both full-epoch runs are stable (~42 s for the
  250 Myr Pangaea run at L5), but the IoU plateaus around 0.25–0.32 — the procedural mantle does
  not yet reproduce Phanerozoic kinematics, so that reconstruction fidelity is the next
  milestone, and older checkpoints (150 → 20 Ma) are gated on it (see
  `0.4.0-Earth-map-plan.md` §8).

See `0.2-plan.md`, `0.1.5-final-design.md` and `0.4.0-Earth-map-plan.md`.

## Test

```
node tests/run-all.js            short profile: every test except the four histories (~1 min)
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

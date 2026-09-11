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
  views, plus a column probe and a plate-lineage/split/merge readout.
- Performance counter: smoothed fps, physics step time and per-kernel milliseconds, text
  rebuilt twice a second. Static geometric coefficients and bounded-vector length kernels keep
  the strict L5 Node proxy above 60 steps/s on the calibration host.
- CPU release tooling: a reproducible one-factor calibration sweep at both calibration frame steps,
  an optional 4.5 Gyr release test, and a browser run-to-time control (4500 Myr by default).
- WebGPU engine (Phase H): the same kernel graph runs on the device (engine select in the
  controls). The map renders straight from the GPU buffers in a fragment shader, so playing
  never reads the state back; the CPU mirror is only pulled in for plate events (one cycle
  late), the column probe, saving and the deposit extract. Same-device repeat runs are
  bit-identical, and 1000-frame CPU-vs-GPU ensembles stay within predeclared statistical
  bounds (`node tests/gpu-parity.js 1000 --ensemble`; boot/parity/determinism modes in the
  same driver, browser paths overridable via `PGT_CHROME`/`PGT_PUPPETEER`/`PGT_LIBS`).

See `0.2-plan.md` and `0.1.5-final-design.md`.

## Test

```
node tests/run-all.js
```

Uses only Node built-ins. The runner launches the retained-memory test with `--expose-gc`.
The GPU path itself is verified in a real browser: double-click `webgpu-smoke.html`
(`run-smoke.bat` / `run-smoke.command`), which boots the engine, runs a CPU/GPU parity
stretch, exercises the timestamp ring and every map layer, and offers the full report
as a downloadable log.
The slower release profile extends the stability histories to 4500 Myr at dt 0.1 and 500 Myr
at dt 0.01, and makes the 60 steps/s performance proxy strict:

```
node tests/run-all.js --release
```

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

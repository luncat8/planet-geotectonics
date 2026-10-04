# AGENTS.md


## style

- use a single tab indentation. LF end

- avoid deep nesting of braces { } and long if-else.
- flatten with early returns, helper functions, or flat data tables.

- avoid duplication of code.

- avoid allocations in the hot path (per-frame loop, sim, render).
- no new {}, [], object literals, closures, or string concat
- inside the frame loop.
- reuse preallocated buffers / typed arrays / scratch objects.
- allocate once at setup, mutate in place per frame.
- these are not strict rules, use best.

- plan*.md is NOT the implementation log. if need - update/improve plan, but keep final plan as artifact for possible fork or reimplementation without referring of what was and what done, without referring chat, etc.

- only essential concise comments in code that really helpful i.e. explain why and decision. prefer descriptive naming.

- no legacy support, no old versions, no outdated browsers, no leftovers and no over protecting from unreal edge cases. we need clean architecture.

## runtime

file:// friendly, classic <script> tags, no modules, no build.
guard module.exports so files also run under node.
no internet links: vendor any lib as a local js file.
simulation: CPU JS first (L5), then WebGPU compute (L6-L7) with the same kernel structure.
frame step 10k..100k years; kernels must be dt-insensitive within that range.

## concepts

crust lives on Lagrangian columns moved by exact rigid plate rotations;
the grid is only the frame for neighbours, boundaries, topography, erosion, render.
never advect crust fields on the grid (measured: freezes or smears at sub-cell steps).
see 0.1.5-final-design.md.

## tests

node tests/run-all.js		short profile (default): 37 kernel, rig and GUI tests, ~2.5 min here
node tests/run-all.js --full	adds the four histories: kinematics, ores, alloc, longrun
node tests/run-all.js --release	--full plus the 4.5 Gyr profile and the strict 60 fps proxy

do not run the full profile in the sandbox. It is ~15 min against ~1 min for short:
longrun alone is ~10 min on these two cores (12 of 18 min on the owner rig) and the other
three histories ~3.5 min; anything that reaches a GPU here runs on SwiftShader, a CPU
rasterizer, so device numbers are slower and relative-only. full is the owner-rig gate:
run short while iterating, run_full_test.py (double-click on Windows) on a real machine - it writes
experiments/logs/full-test-<stamp>.log. run_gpu_parity.py does the same for
tests/gpu-parity.js (headless CPU/GPU ensemble; needs the Chromium rig).


## files

0.0-*.txt - original brief.
0.1-diz-*.md - three LLM designs (inputs, kept for reference).
0.1.5-final-design.md - normative design.
0.3.3-draft-adj.md - draft: live-adjustable global settings (temperature, erosion, relief ramp).
0.3.3-plan.md - the live adjustment plan built on the draft (temperature, friction, erosion, relief).
0.3.5-plan-water-level.md - the water level plan: display eustasy, level and volume modes (draft inlined).
0.4.0-Earth-map-plan.md - the Earth start plan: packs, bake pipeline, staged historical checkpoints.
0.4.6-plan-plate-history.md - plate positions through time: prescribed kinematics, exact backtracking,
the reverse-time answer, and what is not possible. 0.4.6a is in: data/earth/PALEOMAP_PlateModel.rot,
tools/earth/rot_ingest.js, js/data/rot-paleomap.js, js/rotations.js, tests/rotations.js.
0.4.8-plan-earth-data.md - modern sediment/provenance improvement and holdout bake gates.
0.6.x-plan-deposit-prospector.md - the deposit prospector umbrella: vocabulary, the stability
contract, thresholds, module map and staging. the increments:
0.6.0-review.md - implementation review, short-profile results and follow-up scope.
0.6.0-plan-instruments.md - local click-to-explore survey, seven instruments and the session ledger;
	no map-wide scan.
0.6.1-plan-deposit-catalogue.md - the deposit record, quantization, the Earth-anchored class table,
	viability; §10 holds the measured calibration (experiments/deposit-calibration.js).
0.6.1-review.md - implementation review of the catalogue: what the first measurement changed.
0.6.2-plan-core-and-viability-map.md - the stratigraphic core, optional regional campaign and the opt-in viable map.
0.6.3-merge-comparison.md - two sessions implemented the prospector independently; this is the
	comparison, what was taken from which, what was deleted, and the measured calibration of the
	monetary screen (experiments/economics-calibration.js).
0.6.4-review.md - review of the discovery-ledger commit: four defects, their reproductions and
	the tests that hold them.
0.7-proposed.md - roadmap; 0.6.x is deposits, live resolution targets 0.7.0.
0.5.0-draft-3d-render.md - draft: 3D planet render.
0.5.0-plan-3d-render.md - the 3D render plan built on the draft (displaced icosphere, translucent
water); s13's alternate heightmap-lattice mesh and its analytic normals are in (0.5.5):
Render3D.gridMesh, the Mesh/Normals selects, the mode-aware detail list; §14 is the 0.5.6
height-mode plan (hex plateaus vs continuous vertex-interpolated heightmap). 0.5.6 slices 1-3 are
in: js/heightfield.js (the setup-time barycentric lookup, its resumable row-band build and the CPU
reference sampler), the vertex gather variant in js/render3d.js (both pipelines cached at setup,
a live allocation-free mode swap, attachRecords for a lookup that lands later), the Height select
in index.html/js/ui.js (?hmod=hex|vertex, probe, capture header) driving that build across frames,
and tests/heightfield.js, tests/render3d.js, tests/gui.js, tests/wgsl-struct.js,
experiments/heightfield-calibration.js; 0.5.6-review.md reviews them. Slice 4 - the device gates
and the default switch - needs the owner rig.
archive/0.2-plan.md, archive/0.3-plan.md, archive/0.3.2-tweak-ui.md - implemented plans, kept as
artifacts for a fork or reimplementation; archive/ also holds per-session reports, logs and prompts.
experiments/ - measurement scripts (node), not loaded by the page.
experiments/logs/ - keep useful; run_full_test.py / run_gpu_parity.py write their logs here

run_bench.py, run_full_test.py, run_gpu_parity.py - double-clickable runners (page bench, the
full node profile, the headless GPU parity ensemble)

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

## sandbox

git push returns "Invalid username or token" is ok, no need to investigate or report - i will apply manually

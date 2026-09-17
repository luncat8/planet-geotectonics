# AGENTS.md


## style

use a single tab indentation. LF end

avoid deep nesting of braces { } and long if-else.
flatten with early returns, helper functions, or flat data tables.

avoid duplication of code.

avoid allocations in the hot path (per-frame loop, sim, render).
	no new {}, [], object literals, closures, or string concat
	inside the frame loop.
	reuse preallocated buffers / typed arrays / scratch objects.
	allocate once at setup, mutate in place per frame.
	these are not strict rules, use best.

plan*.md is NOT the implementation log. if need - update/improve plan, but keep final plan as artifact for possible fork or reimplementation without referring of what was and what done, without referring chat, etc.

only essential concise comments in code that really helpful i.e. explain why and decision. prefer descriptive naming.

no legacy support, no old versions, no outdated browsers, no leftovers and no over protecting from unreal edge cases. we need clean architecture.

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

node tests/run-all.js		short profile (default): 26 kernel, rig and GUI tests, ~1.5 min here
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
0.5.0-draft-3d-render.md - draft: 3D planet render.
0.5.0-plan-3d-render.md - the 3D render plan built on the draft (displaced icosphere, translucent water).
archive/0.2-plan.md, archive/0.3-plan.md, archive/0.3.2-tweak-ui.md - implemented plans, kept as
artifacts for a fork or reimplementation; archive/ also holds per-session reports, logs and prompts.
experiments/ - measurement scripts (node), not loaded by the page.
experiments/logs/ - keep useful; run_full_test.py / run_gpu_parity.py write their logs here

run_bench.py, run_full_test.py, run_gpu_parity.py - double-clickable runners (page bench, the
full node profile, the headless GPU parity ensemble)

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

## sandbox

git push returns "Invalid username or token" is ok, no need to investigate or report - i will apply manually

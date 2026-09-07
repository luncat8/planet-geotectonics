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

## files

0.0-*.txt - original brief.
0.1-diz-*.md - three LLM designs (inputs, kept for reference).
0.1.5-compare.md - comparison and verdicts with measurements.
0.1.5-final-design.md - normative design.
0.2-plan.md - development plan built on the design.
experiments/ - measurement scripts (node), not loaded by the page.

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

archive/ - for implemented plans

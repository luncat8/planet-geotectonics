# Planet Geotectonics

A no-build, offline-friendly planetary tectonics simulator in development.

## Run

Open `index.html` directly in a browser. No dependencies, network requests or server are
needed. Alternatively, serve this directory with `python3 -m http.server 8000 --bind 0.0.0.0`.

## Current implementation: Phase A transport foundation

- Icosahedral grid with flat adjacency/geometry tables and deterministic land mask.
- Fixed-capacity column and plate arrays; seeded Voronoi plate initialization and reset.
- Normalized quaternion integration, exact body-to-world column rotation, cached hill climb,
  deterministic count/scan/scatter bins and nearest-distance raster ownership.
- Canvas map with plate/elevation/coverage views, controls and column inspector.

Plate velocities are **prescribed**, not force-driven. Elevation is a static isostatic preview.
Gaps are deliberately left empty; contact, crust production/destruction, mantle forces,
surface evolution, events, ores, checkpoints and WebGPU are **not implemented** yet.
See `0.2-plan.md` for the complete roadmap and `0.1.5-final-design.md` for the physical design.

## Test

```
node tests/run-all.js
```

Uses only Node built-ins. The runner launches the retained-memory test with `--expose-gc`.
Tests cover grid geometry, analytic rigid rotation, seeded bitwise determinism/reset,
L5 cap transport over 10,000 frames at both dt endpoints, crowded bins and ownership ties.
The memory smoke test checks retained growth, not absence of transient allocations.

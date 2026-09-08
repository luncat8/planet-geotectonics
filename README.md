# Planet Geotectonics

A no-build, offline-friendly planetary tectonics simulator in development.

## Run

Open `index.html` directly in a browser. No dependencies, network requests or server are
needed. Alternatively, serve this directory with `python3 -m http.server 8000 --bind 0.0.0.0`.

## Current implementation: Phase B kinematics

- Icosahedral grid with flat adjacency/geometry tables and deterministic land mask.
- Fixed-capacity column and plate arrays; seeded Voronoi plates, `q = identity`, `b = r`.
- Precessing poloidal–toroidal mantle flow (mean speed `U0·Tm^2.5`) plus short-lived plumes.
- Drag-only 3×3 plate solve: `M ω = rhs`, relaxation `τ_ω`, `vMax` cap.
- Boundary classification with hysteresis, subduction polarity and 2-ring `trenchDist`.
- Canvas map with plate, boundary-type, elevation and coverage views.

Contact (gap spawn / overlap consume), slab pull, ridge push, surface evolution, events,
ores, checkpoints and WebGPU are **not implemented** yet. See `0.2-plan.md` and
`0.1.5-final-design.md`.

## Test

```
node tests/run-all.js
```

Uses only Node built-ins. The runner launches the retained-memory test with `--expose-gc`.
Phase A: grid geometry, analytic rigid rotation, bitwise determinism, L5 cap transport at
both dt endpoints, crowded bins. Phase B: mantle mean speed / poloidal divergence / spectrum,
`ω = Ω` identity, least-squares drag fit, two-plate edge classification and flicker, 16-plate
500 Myr (dt 0.1) and 50 Myr (dt 0.01) kinematics.

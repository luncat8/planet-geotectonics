# Planet Geotectonics

A no-build, offline-friendly planetary tectonics simulator in development.

## Run

Open `index.html` directly in a browser. No dependencies, network requests or server are
needed. Alternatively, serve this directory with `python3 -m http.server 8000 --bind 0.0.0.0`.

## Current implementation: Phase C crust cycle

- Icosahedral grid with flat adjacency/geometry tables and deterministic land mask.
- Fixed-capacity column and plate arrays; seeded Voronoi plates, `q = identity`, `b = r`.
- Precessing poloidal–toroidal mantle flow (mean speed `U0·Tm^2.5`) plus short-lived plumes.
- 3×3 plate solve `M ω = rhs` driven by basal drag, slab pull, ridge push and collision
  resistance, with relaxation `τ_ω` and a `vMax` cap.
- Boundary classification with hysteresis, subduction polarity and 2-ring `trenchDist`.
- Crust cycle: divergent gaps spawn columns (mantle-derived oceanic crust, or crust rifted
  and thinned from the flanks); convergent overlaps consume the loser, scrape its sediment
  into an accretionary prism and grow arc crust two cells behind the trench; continents
  merge instead of subducting.
- Canvas map with plate, boundary-type, elevation and coverage views, plus a column probe.
- Performance counter: smoothed fps, physics step time and per-kernel milliseconds, text
  rebuilt twice a second.

Surface isostasy and erosion, plate split/merge, planetary cooling, ores, checkpoints and
WebGPU are **not implemented** yet. See `0.2-plan.md` and `0.1.5-final-design.md`.

## Test

```
node tests/run-all.js
```

Uses only Node built-ins. The runner launches the retained-memory test with `--expose-gc`.
Phase A: grid geometry, analytic rigid rotation, bitwise determinism, L5 cap transport at
both dt endpoints, crowded bins. Phase B: mantle mean speed / poloidal divergence / spectrum,
`ω = Ω` identity, least-squares drag fit, two-plate edge classification and flicker, 16-plate
500 Myr (dt 0.1) and 50 Myr (dt 0.01) kinematics. Phase C: a prescribed-ω conveyor belt whose
consumed and spawned area both match the analytic `4WR²` flux, with exact `hMaf`/`hFel`
ledgers and a stable column count; a rifted continent whose margins thin 35 → 13 km within
three cells and then form oceanic crust; and L5 throughput with the per-kernel breakdown.

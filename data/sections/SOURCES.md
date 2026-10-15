# Generated section examples: sources and provenance

Two reviewed `pgt-slice-pack` v2 examples live here. Both are **generated**, not hand-written, and
both are reproduced byte-for-byte by `tests/slice-bake.js` from the arguments each pack itself
records — so a change in the Earth loader, the cell-run walker or the writer turns that test red
instead of leaving a stale example behind.

Regenerate with `tools/earth/bake_section.js` (0.8.2). The generator is the globe's own page
path: the data packs register exactly as `index.html`'s script tags do, `Earth.pick` resolves the
start, `Grid` + `State` + `Earth.apply` build a fresh `tMyr = 0` world, the circle is built from
the shared codec's geodesic step, and `Slice.pack` — the same writer the map cutter uses — emits
the pack, which is validated and encoded through `port/slice-format.js` before a byte is written.

## What each file is

| file | start | level | seed | preset | circle (lat, lon, azimuth) | runs | bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `earth-l5-gc0.json` | `earth` (modern pack) | 5 | 7 | realistic | 0, 0, 90 (the equator) | 193 | 17 058 |
| `earth-100Ma-l5-gc0.json` | `cretaceous` (100 Ma pack) | 5 | 7 | realistic | 0, 0, 90 (the equator) | 193 | 15 941 |

The equator was chosen because it is the plan's first corpus item in one line: it crosses ocean,
continent, every plate boundary kind present at `t = 0` and the antimeridian seam, over a full
40 030.2 km great circle at the L5 cell budget of 223.162 km.

## Exact commands

Both were generated at globe revision `0b10d68538488d6989939d4bf31a391775cf7581` with
`--built 2026-10-15T04:52:47.000Z`:

```text
node tools/earth/bake_section.js --start earth --level 5 --seed 7 --preset realistic \
	--circle 0 0 90 --out data/sections/earth-l5-gc0.json \
	--built 2026-10-15T04:52:47.000Z --commit 0b10d68538488d6989939d4bf31a391775cf7581

node tools/earth/bake_section.js --start cretaceous --level 5 --seed 7 --preset realistic \
	--circle 0 0 90 --out data/sections/earth-100Ma-l5-gc0.json \
	--built 2026-10-15T04:52:47.000Z --commit 0b10d68538488d6989939d4bf31a391775cf7581
```

## Identities

| file | path checksum | full checksum |
| --- | --- | --- |
| `earth-l5-gc0.json` | `e0147ee8ff63d4d1` | `63825f6abdfde871` |
| `earth-100Ma-l5-gc0.json` | `e0147ee8ff63d4d1` | `a9a17ca6721a9597` |

The path checksum is geographic only, so the same circle from two starts shares it; the full
checksum covers everything else, including `source.commit` and `source.built`.

## Honest field semantics (what these packs do and do not say)

- `source.tMyr` is `0` and `source.epochMa` is the pack's own input epoch (`0` for the modern
  pack, `100` for the cretaceous one). Those are two different clocks and neither contradicts
  the other.
- `source.rotModel` is `PALEOMAP` under the realistic preset (the pack's held NNR-MORVEL56
  poles, or the steered rotation model for an epoch pack) and `procedural` under `game`.
- Crust thickness, age, fertility, plate assignment, surface elevation and water come from
  `Earth.apply`'s real raster pass; boundary classification and surface velocity are the
  initialized globe state at `t = 0`.
- **All six ore potentials and all damage are zero.** That is the state the start initializer
  supplies at `t = 0`, not a surveyed absence and not modelled deposits. The modern deposit
  catalogue is local, dynamically evaluated and newer than the old slice-port model; nothing in
  a pack speaks for it.
- Section beds, section-local deposits and any reconstructed stratigraphy are absent by design.
  They are constructed by the section application after import and must be labelled as its own
  reconstruction, never as additional fields from the Earth pack.
- `sea` is level mode at the physics datum (`levelM 0`), the same effective water the page
  exports. Volume mode belongs to an interactive capture where the water slider is on screen.

## Licence

Each pack's `license` string carries the attribution of the pack it was baked from — for these
two, `Earth start <pack> · PALEOMAP-0Ma (Scotese & Wright 2018) + NNR-MORVEL56 + CRUST1.0
sediment (not GlobSed)` and `Earth start earth-100Ma · PALEOMAP-PaleoDEM 100Ma (Scotese & Wright
2018)`. The underlying data terms are in `data/earth/SOURCES.md`; the rotation model behind the
realistic preset is in `data/earth/SOURCES.md` §7.

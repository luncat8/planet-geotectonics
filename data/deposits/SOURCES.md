# Deposit catalogue priors: sources

The generator priors live in the class table at the top of `js/deposits.js` — `CLASSES`,
thirteen rows over seven deposit kinds — with the monetary scenario beside them in
`js/data/deposit-economics.js`. **Every number in both is a game parameter.** They are
order-of-magnitude choices guided by the sources below; no distribution has been fitted to
published deposit tables and nothing here is a measurement. A fit replaces a row's numbers,
bumps the generator `version`, and records its input files here with SHA-256.

Each row also carries its own `source` string, so the provenance travels with the row that
uses it rather than living only in this file.

## What the thirteen rows follow

| Row | Source |
| --- | --- |
| `vms/sulfide` | 904-deposit VMS compilation; Manitoba VMS short course |
| `mafic/sulfide` | USGS SIR 2010-5070-i |
| `mafic/diamond` | cratonic kimberlite literature |
| `arc/porphyry` | USGS OFR 2007-1214 §5 table 5.1-1; USGS OFR 95-0831 model 17 |
| `arc/epithermal` | low-sulfidation Au vein models |
| `orogenic/vein` | USGS OFR 94-250 (Archean Au-quartz veins) |
| `orogenic/sedhost` | USGS OFR 2014-1074 (sediment-hosted Au) |
| `basin/uranium` | IAEA classification; New Mexico Grants district |
| `basin/coal` | game assumption — no published grade–tonnage model |
| `basin/potash` | USGS 2014 potash overview; Russell deposit |
| `placer/gold` | USGS Bulletin 1693 model 39b (g/m³ at 2.0 t/m³) |
| `iron/bif` | Hamersley / Superior-type BIF literature |
| `iron/algoma` | Algoma-type BIF in greenstone belts |

Two rows are honest about having no model behind them: `basin/coal` says so in its own
`source` string, and `mafic/diamond` cites "literature" rather than a numbered table.

Published correlations the rows reproduce: porphyry Au grade vs tonnage r = −0.49 (n = 81)
and kuroko Cu grade vs tonnage r = −0.17. The class table carries these not as a stored
correlation but as the `0.75·draw + 0.25·(1 − w)` term in `buildRecord`, which reproduces a
negative grade–tonnage slope of roughly −0.35…−0.49 without a distribution object. The
porphyry Cu-Au record Fengshandong (105 Mt, 0.38 % Cu, 0.37 g/t Au, GMRAP 466) lies inside
the `arc/porphyry` row's central range.

Two ladder corrections came from checking the rows against these same sources during
0.6.1, and are recorded in `0.6.1-review.md` §2.4 rather than re-derived here:
`basin/uranium` was re-centred on the published average roll front of 9,500 t U₃O₈ with a
500 t economic floor, and `basin/coal`'s aspect band was widened to `0.0002–0.003` so it
produces 2–20 m seams instead of 40 m ones.

## The monetary scenario's numbers

`js/data/deposit-economics.js` is a separate versioned object with its own prices,
recoveries, method costs and capital. Its prices are anchored to 2026 market levels and
each one carries its derivation in a comment, so the arithmetic can be checked rather than
trusted. Its costs are method-based because one flat rate is wrong by an order of magnitude
in both directions. Neither is a quote, neither is fitted, and neither can change a record
or its identity: the scenario reads a finished record and never writes one.

## Digital deposit tables to fit against

- Singer, Mosier & Menzie 1993, *Digital grade and tonnage data for 50 types of mineral
  deposits*, USGS OFR 93-280 (3310 deposits).
- Singer, Berger & Moring 2008, *Porphyry copper deposits of the world*, OFR 2008-1155,
  `data/PorCuTX2008.txt` (422 deposits).
- Bulletin 1693's percentile figures are images; the deposit tables above are the machine
  readable route.

When fitting: keep the grade–tonnage correlation the source reports, state the truncation
and the deposit population, and hold some districts out of the fit. A fit is per row, not
per kind — `mafic/sulfide` and `mafic/diamond` are different deposit populations and must
not be fitted together.

## Measurement, not assertion

`experiments/deposit-calibration.js` measures the class table's output against the published
bands and has a committed log; `experiments/economics-calibration.js` measures the split
between the geological and monetary screens and has one too. Both are measurements with a
committed log rather than tests with a tolerance chosen to make them pass.

## Not covered

Oil and gas, bauxite and REE need variables the simulation does not carry. Evaporite
minerals other than potash, and sediment-hosted base metals (SEDEX, MVT), have no row yet.

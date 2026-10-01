# Deposit catalogue priors: sources

`js/data/deposit-models.js` holds the generator priors. **All numbers there are game
parameters** (`status: 'game'`). They are order-of-magnitude choices guided by the USGS
mineral-deposit grade-tonnage models below; no distribution has been fitted to these data
and none is a measurement. A fit replaces a family's numbers, bumps the model `version`
and records its input files here with SHA-256.

## Models the three families follow

| Family | USGS model | Reference |
| --- | --- | --- |
| `vms` | Cyprus (24a) and kuroko (28a) massive sulphide | Singer & Mosier 1986, Bulletin 1693 |
| `arc` | Porphyry Cu, porphyry Cu-Au (20c) | Singer, Mosier & Cox 1986; Singer, Berger & Moring 2008, OFR 2008-1155 |
| `orogenic` | Low-sulphide Au-quartz vein | USGS Bulletin 1693 / OFR 93-280; model number and grade-tonnage authors to be confirmed when fitting |

Published values the priors use: porphyry Au grade vs tonnage r = -0.49 (n = 81) and kuroko
Cu grade vs tonnage r = -0.17. The porphyry Cu-Au record Fengshandong (105 Mt,
0.38 % Cu, 0.37 g/t Au, GMRAP 466) lies inside the `arc` prior's central range.

## Digital deposit tables to fit against

- Singer, Mosier & Menzie 1993, *Digital grade and tonnage data for 50 types of mineral
  deposits*, USGS OFR 93-280 (3310 deposits).
- Singer, Berger & Moring 2008, *Porphyry copper deposits of the world*, OFR 2008-1155,
  `data/PorCuTX2008.txt` (422 deposits).
- Bulletin 1693's percentile figures are images; the deposit tables above are the machine
  readable route.

When fitting: keep the grade-tonnage correlation the source reports, state truncation and
the deposit population, and hold some districts out of the fit.

## Not covered

Mafic intrusion sulphide, basin (sediment-hosted) and placer potentials have no catalogue
family yet. Oil and gas, coal, bauxite, REE and uranium need variables the simulation does
not carry.

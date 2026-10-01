# Earth Map Sources and Provenance Specification (0.4.0)

This registry records all authoritative datasets, primary download endpoints, mirror repositories,
file formats, resolutions, licencing terms, checksums, and mathematical fallback procedures for the
`planet-geotectonics` Earth map ingestion and bake pipeline.

Raw source rasters (multi-hundred megabytes to gigabytes) are **not** committed to Git to keep
repository clone weight small (in accordance with `AGENTS.md`). Pre-computed and verified compact
starting packs (`js/data/earth-*.js`), extracted reference data (`data/earth/*.json`), and the
small 1° source textures + extracted bins behind the historical checkpoints (`data/earth/paleo/`,
0.4.5) are committed.
The Python bake tool (`tools/earth/bake_earth.py`) verifies checksums against this file prior to
processing.

---

## 1. Bedrock Elevation and Bathymetry

Bedrock elevation (ice-removed) is required for both continental isostatic inversion ($h_{\text{Fel}}$)
and oceanic bathymetric inversion ($h_{\text{Maf}}$). Top-of-ice elevation (e.g. standard DEMs over
Antarctica or Greenland) would introduce up to 3–4 km of fictitious felsic rock.

### Primary: ETOPO 2022 Bedrock Global Relief Model (NOAA NCEI)
- **Version:** ETOPO 2022 v1 (Bedrock)
- **Publisher:** National Oceanic and Atmospheric Administration (NOAA) National Centers for Environmental Information (NCEI)
- **Citation:** NOAA National Centers for Environmental Information. 2022: ETOPO 2022 15 Arc-Second Global Relief Model. NOAA National Centers for Environmental Information.
- **DOI:** [`10.25921/fd45-gt74`](https://doi.org/10.25921/fd45-gt74)
- **Licence:** Public Domain (U.S. Government Work / Open Data)
- **Coordinate System:** WGS 84 (EPSG:4326), Ellipsoidal/Tidal Datum Mean Sea Level
- **Resolution:** Available at 15 arc-seconds (~450 m), 30 arc-seconds (~900 m), and 60 arc-seconds (~1.8 km / 1 arc-minute)
- **Direct HTTP Download (60 arc-second NetCDF):**
  `https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc`
- **File size (60s NetCDF):** 491,284,376 bytes (~468.5 MB)
- **OPeNDAP Subsetting Endpoint:**
  `https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc`
  Allows strided downsampling (e.g. `z[0:30:10799][0:30:21599]` for 0.5°, `z[0:60:10799][0:60:21599]` for 1.0°).

### Fallback 1: GEBCO 2024 Global Bathymetric Grid
- **Publisher:** General Bathymetric Chart of the Oceans (BODC / IHO / IOC)
- **Licence:** Creative Commons Attribution 4.0 International (CC-BY 4.0)
- **URL:** `https://www.gebco.net/data_and_products/gridded_bathymetry_data/`
- **Resolution:** 15 arc-seconds (NetCDF / GeoTIFF, ~11 GB uncompressed, 4 GB zip)

### Fallback 2: ETOPO1 Bedrock (1 Arc-Minute)
- **Publisher:** NOAA National Geophysical Data Center (Amante & Eakins, 2009)
- **DOI:** `10.7289/V5C8276M`
- **URL:** `https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1/data/bedrock/grid_registered/netcdf/ETOPO1_Bed_g_gmt4.grd.gz`
- **File size:** ~380 MB compressed

---

## 2. Ocean Crustal Age

Age of the oceanic crust governs thermal cooling and boundary-layer subsidence:
$\text{thermal} = 350 \cdot \sqrt{\min(\text{age}, 80)}$ metres.

### Primary: Müller et al. (2019) / Seton et al. (2020) EarthByte Agegrid
- **Version:** EarthByte Seafloor Age Grid v2.0 (2020 update)
- **Citation:** Seton, M., Müller, R. D., Zahirovic, S., Williams, S., Wright, N., Cannon, J., Whittaker, J., Matthews, K., McGirr, R. (2020). A global dataset of present-day oceanic crustal age and seafloor spreading parameters. *Geochemistry, Geophysics, Geosystems*, 21, e2020GC009214.
- **DOI:** [`10.1029/2020GC009214`](https://doi.org/10.1029/2020GC009214)
- **Licence:** Creative Commons Attribution 4.0 International (CC-BY 4.0)
- **Grid Resolution:** 2 arc-minutes (~3.7 km), 0.1° (~11 km), and 1.0°
- **Primary FTP/HTTP Endpoint:**
  `https://www.earthbyte.org/webdav/ftp/earthbyte/agegrid/2020/Grids/`
  `https://www.earthbyte.org/webdav/ftp/Data_Collections/Muller_etal_2019_Tectonics/Muller_etal_2019_Agegrids/Muller_etal_2019_Tectonics_v2.0_netCDF/Muller_etal_2019_Tectonics_v2.0_AgeGrid-0.nc`
- **File size:** ~18 MB (NetCDF)
- **GPlates Portal Viewer:** `https://portal.gplates.org/portal/present_day_agegrid/`

### Fallback 1: Müller et al. 2016 AREPS Seafloor Age Grid v1.17
- **DOI:** `10.1146/annurev-earth-060115-012211`
- **URL:** `https://www.earthbyte.org/webdav/ftp/Data_Collections/Muller_etal_2016_AREPS/Muller_etal_2016_AREPS_Agegrids/Muller_etal_2016_AREPS_Agegrids_v1.17/Muller_etal_2016_AREPS_v1.17_netCDF/`

### Fallback 2: Analytical Half-Space Cooling Inversion
When no observational age raster is available, oceanic crust age is inverted directly from
bedrock depth $z$ using the sim's calibrated oceanic subsidence curve:
$$\Delta z_{\text{thermal}} = \max\left(0, -z - 2600 + \frac{h_{\text{sed}} \cdot 900}{3300}\right)$$
$$\text{age}_{\text{synth}} = \min\left(180, \left(\frac{\Delta z_{\text{thermal}}}{350}\right)^2\right)$$
On continental crust (identified by CRUST1.0 or bathymetric shelf cutoffs), age is set to 500 Myr
(stable craton baseline in `Params`).

---

## 3. Global Sediment Thickness

Sediment thickness $h_{\text{sed}}$ is an independent layer that contributes to isostatic loading
($h_{\text{sed}} \cdot 900 / 3300$) and feeds erosion routing and metallogeny (basin potential $o_{\text{Bas}}$).

### Primary: GlobSed Version 3 (Straume et al. 2019, 2025 PANGAEA Archive)
- **Title:** Total sediment thickness of the world's oceans and marginal seas, version 3 (GlobSed)
- **Authors:** Eivind Olavson Straume, Carmen Gaina, S. Medvedev, Katharina Hochmuth, Karsten Gohl, Joanne Whittaker, R. Abdul Fattah, J. C. Doornenbal, J. R. Hopper
- **Citation:** Straume, E. O., et al. (2019), GlobSed: Updated Total Sediment Thickness in the World's Oceans, *Geochem. Geophys. Geosyst.*, 20(4), 1756-1772.
- **DOI (Article):** [`10.1029/2018GC008115`](https://doi.org/10.1029/2018GC008115)
- **DOI (PANGAEA Dataset):** [`10.1594/PANGAEA.982339`](https://doi.org/10.1594/PANGAEA.982339)
- **Licence:** Creative Commons Attribution 4.0 International (CC-BY 4.0)
- **Direct Download URL:** `https://download.pangaea.de/dataset/982339/files/GlobSed.zip`
- **File size:** 61.6 MB (zip), ~1.1 GB uncompressed
- **MD5 Checksum:** `4e3f112e0cdc820bd74d3b261414e2cd`
- **Contents:** `GlobSed-v3.nc` (NetCDF-4), `GlobSed-v3.xyz` (Lon, Lat, Value), `globsed-v3.asc` (ArcGIS ASCII)
- **Resolution:** 5 arc-minutes (~9.2 km)

### Fallback 1: CRUST1.0 Sedimentary Layers (1° x 1°)
- Sum of upper, middle, and lower sedimentary layers from `crust1.bnds` (Laske et al. 2013).
- Covers both continental basins and oceanic margins.
- Resolution: 1° global.

### Fallback 2: Geometric Distance-to-Coast & Basinal Accumulation Heuristic
$$h_{\text{sed,synth}} = h_{\text{margin}} \cdot \exp\left(-\frac{d_{\text{coast}}}{d_{\text{decay}}}\right) + h_{\text{pelagic}} \cdot \frac{\text{age}}{80}$$
where $h_{\text{margin}} = 4000\text{ m}$, $d_{\text{decay}} = 400\text{ km}$, $h_{\text{pelagic}} = 300\text{ m}$.

---

## 4. Continental Crustal Thickness and Moho Depth

Governs the continental isostatic support $h_{\text{Fel}} / 6$.

### Primary: CRUST1.0 Global Crustal Model (Laske et al. 2013)
- **Authors:** Gabi Laske, Guy Masters, Zhitu Ma, Michael Pasyanos (UC San Diego / LLNL)
- **Citation:** Laske, G., Masters., G., Ma, Z. and Pasyanos, M., Update on CRUST1.0 - A 1-degree Global Model of Earth's Crust, *Geophys. Res. Abstracts*, 15, Abstract EGU2013-2658, 2013.
- **Home URL:** `https://igppweb.ucsd.edu/~gabi/crust1.html`
- **GitHub Reference Mirror:** `https://github.com/jrleeman/Crust1.0/`
- **Grid Extent:** 180 latitudes (89.5°N to -89.5°S) × 360 longitudes (-179.5°W to 179.5°E) = 64,800 cells.
- **Key Files:**
  - `crust1.bnds`: Top and bottom boundary elevations for 8 layers (water, ice, 3 sediments, 3 crystalline crust, Moho).
  - `sedthk`: Sediment thickness (km).
  - `crsthk`: Crystalline crustal thickness without water (km).
- **File size:** ~3.2 MB plain text per table (~600 KB gzip).

### Fallback: Airy-Heiskanen Bedrock Inversion
$$h_{\text{Fel,Airy}} = \max\left(0, \left(z + 3342 + 2091 - \frac{h_{\text{sed}} \cdot 900}{3300}\right) \cdot 6\right)$$

---

## 5. Plate Boundaries and Closed Polygons

Assigns every surface cell to a tectonic plate ID.

### Primary: PB2002 Global Plate Model (Bird 2003)
- **Author:** Peter Bird (UCLA)
- **Citation:** Bird, P. (2003), An updated digital model of plate boundaries, *Geochem. Geophys. Geosyst.*, 4(3), 1027, doi:10.1029/2001GC000252.
- **DOI:** [`10.1029/2001GC000252`](https://doi.org/10.1029/2001GC000252)
- **Plates Count:** 52 plates
- **Primary Data Format:** `PB2002_plates.dig.txt` (closed spherical polygon curves, counterclockwise)
- **Open GitHub GeoJSON Mirror:** `https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json`
- **Raw Dig Text:** `https://raw.githubusercontent.com/fraxen/tectonicplates/master/original/PB2002_plates.dig.txt`

### Supplementary: NNR-MORVEL56 Plate Boundaries (Argus et al. 2011)
- **URL:** `https://sideshow.jpl.nasa.gov/pub/usrs/argus/supporting.info/nnr.morvel56/2011gc003751-ts01.txt`
- **Plates Count:** 56 plates (splits Africa into Nubia/Somalia/Lwandle; Australia into Australia/Capricorn/Macquarie; South America into South America/Sur).

---

## 6. Plate Motions and Euler Poles

Sets initial rigid plate rotational velocity $\vec{\omega}$ per plate column.

### Primary: NNR-MORVEL56 (Argus, Gordon, DeMets 2011)
- **Citation:** Argus, D. F., R. G. Gordon, and C. DeMets (2011), Geologically current motion of 56 plates relative to the no-net-rotation reference frame, *Geochem. Geophys. Geosyst.*, 12, Q11001, doi:10.1029/2011GC003751.
- **DOI:** [`10.1029/2011GC003751`](https://doi.org/10.1029/2011GC003751)
- **Reference Frame:** No-Net-Rotation (NNR) lithosphere frame
- **Authoritative Data Endpoint (JPL):**
  - Table S2 (Plate names & ties): `https://sideshow.jpl.nasa.gov/pub/usrs/argus/supporting.info/nnr.morvel56/2011gc003751-ts02.txt`
  - Table S3 (Rotation matrix Q & area): `https://sideshow.jpl.nasa.gov/pub/usrs/argus/supporting.info/nnr.morvel56/2011gc003751-ts03.txt`
  - Table S4 (56 Euler poles & covariance): `https://sideshow.jpl.nasa.gov/pub/usrs/argus/supporting.info/nnr.morvel56/2011gc003751-ts04.txt`
  - Table S6 (25 MORVEL Euler poles): `https://sideshow.jpl.nasa.gov/pub/usrs/argus/supporting.info/nnr.morvel56/2011gc003751-ts06.txt`
- **Committed Parsed Representation:** `data/earth/nnr-morvel56.json` (56 plates, exact Euler poles, Cartesian axes, rotation rates in rad/Myr, and spherical areas).

---

## 7. Historical PaleoDEMs and Reconstructions (Milestone 0.4.5)

For initializing past geological epochs (e.g., Pangaea at 250 Ma, Cretaceous at 100 Ma, K-Pg at 66 Ma).

### Primary: PALEOMAP PaleoDEMs (Scotese & Wright 2018)
- **Authors:** Christopher R. Scotese and Nicky M. Wright
- **Citation:** Scotese, C. R., and Wright, N. M., 2018. PALEOMAP Paleodigital Elevation Models (PaleoDEMS) for the Phanerozoic, PALEOMAP Project.
- **Zenodo DOI:** [`10.5281/zenodo.5460860`](https://doi.org/10.5281/zenodo.5460860)
- **Licence:** Creative Commons Attribution 4.0 International (CC-BY 4.0)
- **Files & Checksums on Zenodo:**
  - `Scotese_Wright_2018_Maps_1-88_1degX1deg_PaleoDEMS_nc.zip`
    - Size: 9.3 MB (NetCDF rasters from 0 to 540 Ma)
    - MD5: `77147998623ab039d86ff3e0b5e40344`
  - `PaleoDEMS_long_lat_elev_csv_v2.zip`
    - Size: 20.3 MB (CSV coordinate tables)
    - MD5: `17b8c13425c71b17f87a540178d45d9c`
  - `Scotese_PaleoAtlas_v3.zip` (GPlates plate rotation models `.rot` and plate geometries)
    - Size: 58.1 MB
    - MD5: `9a8d16ab2d7f070ae3e89da7835ce4d4`
  - Explanatory Report: `Scotese_Wright2018_PALEOMAP_PaleoDEMs.pdf`
    - MD5: `3147576853269cbf3bb4481124fc2f35`
- **EarthByte Mirror:**
  `https://www.earthbyte.org/webdav/ftp/Data_Collections/Scotese_Wright_2018_PaleoDEM/`

### Actually Ingested (0.4.5): the 1° texture route

The build sandbox could not reach the Zenodo/EarthByte NetCDF-CSV downloads (TLS egress
restricted), so the historical maps were ingested from the **CC-BY 4.0 1° equirectangular JPEG
textures** of the same Scotese & Wright (2018) maps, as carried by the PDMap fossil-globe project
(`github.com/andytradewave/pdmap`, `vendor/paleodem/`, 1024×512, 5 Ma steps, `000.jpg`…`540.jpg`).
The textures are pixel-identical to the Zenodo 1° rasters; the Zenodo record above remains the
**canonical citation**.

The committed source textures and the 1° bins extracted from them (via
`tools/earth/paleo_extract.js`, see `0.4.0-Earth-map-plan.md` §8.3) are:

| File | Role | MD5 |
|---|---|---|
| `data/earth/paleo/250Ma_source.jpg` | PDMap `250.jpg` (Permian-Triassic, Pangaea), 1024×512 | `bb7580e7a3ce2138093a71aec6428444` |
| `data/earth/paleo/200Ma_source.jpg` | PDMap `200.jpg` (Early Jurassic), 1024×512 | `e92afb780f00c40bed6661bd6b9b8eca` |
| `data/earth/paleo/000Ma_source.jpg` | PDMap `000.jpg` (present day), 1024×512 — the 0.4.0 modern re-bake source | `71a45fbb4c7b8e457d38212285f3dcc7` |
| `data/earth/paleo/250Ma_1deg.bin` | 1° z/age/kind raster extracted from `250Ma_source.jpg` | `461a5745bbd1e63b2e80006d7dab840f` |
| `data/earth/paleo/200Ma_1deg.bin` | 1° z/age/kind raster extracted from `200Ma_source.jpg` | `af101df51aa0cc8762af877daadb3d44` |
| `data/earth/paleo/000Ma_1deg.bin` | 1° z/age/kind raster, modern band values (`--z-deep 4200 --z-navy 5000`) | `40657630da47fc8aeb3b9531405be54f` |
| `data/earth/paleo/000Ma_0p5deg.bin` | 0.5° raster of the modern map (L7) | `87d237870a5fd5c00f7269cae5a3b73f` |
| `data/earth/paleo/plates-250Ma.bin` | per-cell plate ids + stage ω from `gpml_plates.js --epoch=250` (85 plates) | `724fd05731e075c987ee0cd78a533a71` |
| `data/earth/paleo/plates-200Ma.bin` | the same at `--epoch=200` (125 plates) | `e774d07ee2c4a9df62bf6ad5446e3a59` |


Baked packs: `js/data/earth-250Ma.js` (`pangaea`, epoch 250, 84 PALEOMAP model plates + 8 oceanic
Voronoi, datum `+0.00 m`) and `js/data/earth-200Ma.js` (`gondwana`, epoch 200, 103 + 8, datum
`+0.00 m`). The 0.4.5 bake gave them nine anonymous land components and zero poles; the 0.4.6c
re-bake gives them the rotation model's own plate ids (`plates.codes`) and its stage ω at the
pack epoch, with the z/age/sed/kind banks bit-identical to the 0.4.5 bake — only the plate
table changed. Commands:

```
python3 tools/earth/bake_earth.py --paleo data/earth/paleo/250Ma_1deg.bin --name earth-250Ma \
    --out js/data/earth-250Ma.js --report data/earth/report-250Ma.txt \
    --plate-ids data/earth/paleo/plates-250Ma.bin --ids-min-cells 1
python3 tools/earth/bake_earth.py --paleo data/earth/paleo/200Ma_1deg.bin --name earth-200Ma \
    --out js/data/earth-200Ma.js --report data/earth/report-200Ma.txt \
    --plate-ids data/earth/paleo/plates-200Ma.bin --ids-min-cells 10
```

`--ids-min-cells` absorbs model plates smaller than the threshold into the neighbour with the
most shared border (200 Ma: 125 → 103, headroom for plateCap 128 including the oceanic
plates); continental cells no polygon claims (56 % at 250 Ma — the polygons and the PaleoDEM
are not the same vintage) follow their majority model neighbour; the remaining ocean gets the
same k=8 farthest-point Voronoi as the 0.4.5 bake, with no code and no pole — dead ocean
floor, honest about not knowing its kinematics.

**0.4.6d — the rest of the §8.5 ladder (150 → 20 Ma).** Same source, same route, five more
epochs. PDMap steps in 5 Ma, so the K-Pg checkpoint is baked at **65 Ma**, the nearest step to
66 Ma; every other epoch is an exact step. Ages are zero-padded in the file names to match the
existing three.

| File | Role | MD5 |
|---|---|---|
| `data/earth/paleo/150Ma_source.jpg` | PDMap `150.jpg` (Late Jurassic), 1024×512 | `415acaa0b480e63110d6eedd6aa17f9c` |
| `data/earth/paleo/100Ma_source.jpg` | PDMap `100.jpg` (Mid-Cretaceous) | `3ed48301cd7ec92d43f8f51b2d6f7427` |
| `data/earth/paleo/065Ma_source.jpg` | PDMap `065.jpg` (K-Pg) | `73040c7a6d882a7d8c31766ecd605a20` |
| `data/earth/paleo/040Ma_source.jpg` | PDMap `040.jpg` (Middle Eocene) | `3648a630d7cc3eca6b2d8af1971cc8b3` |
| `data/earth/paleo/020Ma_source.jpg` | PDMap `020.jpg` (Early Miocene) | `d2f857ac16541a3c1d7faddcc7579b39` |
| `data/earth/paleo/150Ma_1deg.bin` | 1° z/age/kind raster from `150Ma_source.jpg` | `7e334ab10c59a96230242ed1c9a13557` |
| `data/earth/paleo/100Ma_1deg.bin` | the same at 100 Ma | `434336ac15d15bcd2099cf725e52ea27` |
| `data/earth/paleo/065Ma_1deg.bin` | the same at 65 Ma | `f52d6a55a924b53dd230550ba3396e1a` |
| `data/earth/paleo/040Ma_1deg.bin` | the same at 40 Ma | `cc7ca9107b613b37dda8bd20a2eff371` |
| `data/earth/paleo/020Ma_1deg.bin` | the same at 20 Ma | `fd5d286025344007010011298d42b337` |
| `data/earth/paleo/plates-150Ma.bin` | `gpml_plates.js --epoch=150` (125 rings → 125 plates) | `fceb3594b6e14fd7c4cebcb84726eb69` |
| `data/earth/paleo/plates-100Ma.bin` | `--epoch=100` (133 plates) | `a4c2941ace6efba5b42c24df61a96cbc` |
| `data/earth/paleo/plates-065Ma.bin` | `--epoch=65` (140 plates) | `582bb06410fefa45d1a8fdc0c8d0dfb1` |
| `data/earth/paleo/plates-040Ma.bin` | `--epoch=40` (145 plates) | `2845d618df9ce0bc9fefbc8760c7532a` |
| `data/earth/paleo/plates-020Ma.bin` | `--epoch=20` (145 plates) | `4bcaa3079cbf40f444c6ae2a3715823f` |

`tools/earth/paleo_extract.js` needs a JPEG decoder; the project vendors one
(`vendor/jpeg-js/`, jpeg-js 0.4.4 decoder, Apache-2.0) so the pipeline runs offline from a clean
checkout. It is a build-time dependency of that one tool — no page script loads it.

Baked packs, one epoch per line — `n=$(printf "%03d" "$e")` is the zero-padded name and
`$t` is that epoch's `--ids-min-cells` (see the rule below the table):

```
for pair in 150:10 100:20 65:20 40:20 20:25; do
    e=${pair%%:*}; t=${pair##*:}; n=$(printf "%03d" "$((10#$e))")
    node tools/earth/gpml_plates.js --epoch=$e --out=data/earth/paleo/plates-${n}Ma.bin
    python3 tools/earth/bake_earth.py --paleo data/earth/paleo/${n}Ma_1deg.bin \
        --name earth-${n}Ma --out js/data/earth-${n}Ma.js --report data/earth/report-${n}Ma.txt \
        --plate-ids data/earth/paleo/plates-${n}Ma.bin --ids-min-cells $t
done
```

| Pack | Start value | Epoch | Model plates + 8 oceanic | Wet | datum |
|---|---|---|---|---|---|
| `js/data/earth-150Ma.js` | `jurassic` | 150 | 103 + 8 | 64.02 % | `+0.00 m` |
| `js/data/earth-100Ma.js` | `cretaceous` | 100 | 100 + 8 | 68.71 % | `+0.00 m` |
| `js/data/earth-065Ma.js` | `kpg` | 65 | 102 + 8 | 66.56 % | `+0.00 m` |
| `js/data/earth-040Ma.js` | `eocene` | 40 | 104 + 8 | 64.21 % | `+0.00 m` |
| `js/data/earth-020Ma.js` | `miocene` | 20 | 102 + 8 | 65.55 % | `+0.00 m` |

`--ids-min-cells` is per epoch because the polygon set grows denser towards the present (125
rings at 150 Ma, 145 at 20 Ma) and the pack must stay under `plateCap` 128 including the eight
oceanic Voronoi plates. The rule: the smallest threshold that keeps the model table at 104 or
fewer, i.e. 112 plates with headroom — 10 / 20 / 20 / 20 / 25. The 200 Ma pack predates the
rule at 10 (103 + 8), and 250 Ma is at 1 (84 + 8).

### Ingested (0.4.6): the PaleoAtlas v3 rotation model

`data/earth/PALEOMAP_PlateModel.rot` — 79,521 bytes, MD5 `6cc0c0e73c4f516c6069ae1c08d4f3d6`,
CC-BY 4.0 (`data/earth/License.txt`), extracted by hand from `Scotese_PaleoAtlas_v3.zip`. Its own
header names the model `m15g60_v2d3` and the plate-polygon set it belongs to,
`ContOCeanPolyv10u_v2d3`, committed as the `.gpml` below: model plus polygons give real plate
identity, real plate speeds and a per-cell plate table, but past plate boundaries enter a pack
only as the bake-time rasterization, never as dynamic boundaries in the forward sim.

`data/earth/PALEOMAP_PlatePolygons.gpml` — 5,287,072 bytes, MD5
`d782fab51dd1a5496656f212914eb427`, CC-BY 4.0, from the same folder of the same archive and
matched to the rotation model ("for use with Plate Polygons ContOCeanPolyv10u_v2d3"). 471
features, 503 rings, 26,936 vertices, each ring tagged with the plate id it rides and a
`[DISAPPEARA, APPEARANCE]` window in Ma-ago. `tools/earth/gpml_plates.js` reconstructs the
rings with the rotations above and rasterizes them onto the bake lattice, which is how a pack
gets a real plate id per cell instead of a Voronoi guess. 223 plates today (94 % of cells),
85 at 250 Ma (24 % of cells), 125 at 200 Ma (29 %) — continental crust only at the epochs,
because the ocean floor of 250 Ma is subducted and is not in the file.
`tests/gpml-plates.js` pins the identity and the Pangaea sutures.

### Available, assessed, not ingested: PaleoCoastlines v7 (0.4.6)

`archive/paleocoastlines_v7_shapefiles.zip` — 17,481,632 bytes, from Zenodo record
`10.5281/zenodo.7994000`. Two layers, `CS` (coastlines) and `CM` (continental margins), each as
81 epochs from 0 to 535 Ma in shapefile + GPML form. `archive/paleomap_global_plate_model_v3.zip`
is the same two files already vendored above, byte-identical (MD5s match), kept as the canonical
provenance archive.

Assessed rather than assumed, because the first reading of it is misleading:

- **The geometries are already reconstructed per epoch** — the 0 Ma and 250 Ma masks differ on
  half the sphere — so no rotation model is needed and none is referenced.
- **They carry no plate identity.** `PLATEID1` is `0` on every record, so this dataset can
  supply a land mask but never a plate id; plate identity stays with the PALEOMAP polygons.
- **The 250 Ma `CM` layer is 10 polygons with no holes**, one of which is a single 489-vertex
  ring spanning the whole globe (lat −89.9…82.0, lon span 360°). Read as land it covers 63.1 %
  of a 1° sphere and agrees with the committed 250 Ma PaleoDEM continental mask at
  **IoU 0.442**, covering 20,097 of its 24,687 cells (81 %) and missing 4,590; read as ocean it
  scores 0.104, so the orientation is not in doubt. The remaining 9 rings are 66 cells of
  islands. For comparison the PALEOMAP plate polygons cover 44 % of the same cells at IoU
  0.372 — the coastline layer is the better land mask and the worse identity source, which is
  what each dataset is for.
- A naive parse that treats every `gml:posList` as an exterior ring silently produces plausible
  numbers here; the 63 % figure is only meaningful once the globe-spanning ring and the absent
  holes are understood. `CS` at some epochs also ships a near-empty GPML stub (250 Ma is 342
  bytes) with the real geometry in the `.shp`, and some of its `.dbf` attribute columns are
  asterisk-filled placeholders.

Not ingested: the packs keep the Scotese PaleoDEM as their land mask so that the map, the
rotation model and the checkpoints stay one vintage. The value of this dataset is as an
**independent** land mask at 81 epochs — the cross-check that would tell us how much of the
0.372 IoU above is vintage and how much is flooded continental crust.

GPlates `.rot` format, 1491 rotation lines, 258 plates, −250…1100 Ma. Columns are
`moving_plate time_Ma lat lon angle_deg anchor_plate`; every line is a **total reconstruction**
rotation relative to an anchor plate (identity at 0 Ma), not a stage pole, and a positive angle
runs present → past. `tools/earth/rot_ingest.js` resolves each plate's anchor chain to the model
root and emits absolute rotations for 0–540 Ma as `js/data/rot-paleomap.js`
(MD5 `80428bab20e66fee1f1f53080c5b9d6e`, 258 plates), which `js/rotations.js` serves. The ingest's
own gates, re-deriving the file's pair rotations from its absolutes, agree to 3.8e-6° over 919
lines; `tests/rotations.js` pins the composition order and the handedness against present-day
plate bearings and against NNR-MORVEL56 (§6). The model is discontinuous where a plate changes
anchor — 42 such instants inside 0–540 Ma, mean jump 11.5°, worst 53.4° at 315 @ 458 Ma — and the
ingest reports that rather than smoothing it.

---

## 8. Summary Table of Sources

| Layer | Primary Source | Identifier / DOI | Format | Native Resolution | Licence |
|---|---|---|---|---|---|
| **Bedrock Relief / Bathymetry** | NOAA ETOPO 2022 | `10.25921/fd45-gt74` | NetCDF-4 / GeoTIFF | 15″–60″ | Public Domain |
| **Ocean Crust Age** | Seton et al. 2020 / EarthByte | `10.1029/2020GC009214` | NetCDF-4 | 2′–0.1° | CC-BY 4.0 |
| **Sediment Thickness** | GlobSed v3 (Straume 2019/2025) | `10.1594/PANGAEA.982339` | NetCDF-4 / XYZ | 5′ | CC-BY 4.0 |
| **Crustal Thickness & Moho** | CRUST1.0 (Laske et al. 2013) | EGU2013-2658 | ASCII Table | 1.0° | Citation |
| **Plate Boundaries** | PB2002 (Bird 2003) | `10.1029/2001GC000252` | GeoJSON / Dig ASCII | Vector (52 plates) | Open Data |
| **Plate Kinematics (NNR)** | NNR-MORVEL56 (Argus 2011) | `10.1029/2011GC003751` | ASCII Table | 56 Euler poles | Public Domain |
| **PaleoDEMs (0.4.5)** | PALEOMAP (Scotese 2018) | `10.5281/zenodo.5460860` | NetCDF / CSV; ingested via 1° textures (PDMap, §7) | 1.0° (88 epochs) | CC-BY 4.0 |
| **Paleo Rotations (0.4.6)** | Scotese PaleoAtlas v3 `m15g60_v2d3` | `10.5281/zenodo.5460860` | GPlates `.rot` → `js/data/rot-paleomap.js` | 258 plates, 0–1100 Ma | CC-BY 4.0 |
| **Paleo Plate Polygons (0.4.6)** | Scotese PaleoAtlas v3 `ContOCeanPolyv10u_v2d3` | `10.5281/zenodo.5460860` | GPlates `.gpml` | 503 rings, 241 plate ids | CC-BY 4.0 |
| **PaleoCoastlines (assessed)** | PaleoCoastlines v7 | `10.5281/zenodo.7994000` | Shapefile + `.gpml` | 81 epochs, 0–535 Ma, no plate ids | CC-BY 4.0 |

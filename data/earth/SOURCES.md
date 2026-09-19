# Earth Map Sources and Provenance Specification (0.4.0)

This registry records all authoritative datasets, primary download endpoints, mirror repositories,
file formats, resolutions, licencing terms, checksums, and mathematical fallback procedures for the
`planet-geotectonics` Earth map ingestion and bake pipeline.

Raw source rasters (multi-hundred megabytes to gigabytes) are **not** committed to Git to keep
repository clone weight small (in accordance with `AGENTS.md`). Pre-computed and verified compact
starting packs (`js/data/earth-*.js`) and extracted reference data (`data/earth/*.json`) are committed.
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
| **PaleoDEMs (0.4.5)** | PALEOMAP (Scotese 2018) | `10.5281/zenodo.5460860` | NetCDF / CSV | 1.0° (88 epochs) | CC-BY 4.0 |
| **Paleo Rotations (0.4.5)** | Scotese PaleoAtlas v3 | `10.5281/zenodo.5460860` | GPlates `.rot` | 0–540 Ma model | CC-BY 4.0 |

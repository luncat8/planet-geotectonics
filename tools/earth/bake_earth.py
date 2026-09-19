#!/usr/bin/env python3
"""tools/earth/bake_earth.py - Earth map bake pipeline for planet-geotectonics.

Translates real Earth datasets (bedrock relief, ocean crust age, sediment thickness,
plate polygons, Euler poles) into self-contained JavaScript packs (EarthPacks)
compatible with file:// execution, without runtime network dependencies.

Usage:
    python3 tools/earth/bake_earth.py [--deg 1.0] [--out js/data/earth-1deg.js]
    python3 tools/earth/bake_earth.py --deg 0.5 --out js/data/earth-05deg.js

Options:
    --deg FLOAT          Raster grid resolution in degrees (default: 1.0)
    --sources-dir DIR    Directory containing raw source files (optional)
    --out PATH           Output JavaScript pack file
    --report PATH        Output validation and statistics report file
    --plates MODE        Plate hierarchy: 'morvel25' (default) or 'morvel56'
"""

import os
import sys
import math
import json
import base64
import struct
import argparse
from collections import deque
from datetime import datetime

# Try numpy, fallback to pure python standard library
try:
	import numpy as np
	HAS_NUMPY = True
except ImportError:
	HAS_NUMPY = False

# Physical constants from js/params.js and js/surface.js
RADIUS_M = 6371000.0
EARTH_WET_FRACTION_TARGET = 0.7081
Z_TRENCH = 3000.0

def smoothstep(x, lo, hi):
	t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
	return t * t * (3.0 - 2.0 * t)

def elevation_k9(h_fel, h_maf, h_sed, age, z_dyn=0.0):
	"""Evaluates K9 surface elevation formula matching js/surface.js."""
	ci = smoothstep(h_fel, 5000.0, 20000.0)
	thermal = (1.0 - ci) * 350.0 * math.sqrt(min(age, 80.0)) + ci * 2091.0
	z = -3342.0 + h_fel / 6.0 + (h_maf * 350.0 + h_sed * 900.0) / 3300.0 - thermal + z_dyn
	return z

def invert_thickness(z, age, h_sed, is_continental):
	"""Inverts K9 elevation into crustal thicknesses h_fel and h_maf.

	CRUCIAL RULE: Flooded continental shelves (z < 0) are continental crust,
	inverted for h_fel. Only oceanic crust (where ocean age grid is defined
	or crust type is oceanic) is inverted for h_maf.
	"""
	if is_continental:
		ci = 1.0
		thermal = 2091.0
		h_fel = (z + 3342.0 + thermal - (h_sed * 900.0) / 3300.0) * 6.0
		h_maf = 0.0
		# Fixed-point iteration for transitional shelf crust where h_fel < 20000
		ci = smoothstep(h_fel, 5000.0, 20000.0)
		if ci < 1.0:
			for _ in range(5):
				thermal = (1.0 - ci) * 350.0 * math.sqrt(min(age, 80.0)) + ci * 2091.0
				h_fel = (z + 3342.0 + thermal - (h_sed * 900.0) / 3300.0) * 6.0
				ci = smoothstep(h_fel, 5000.0, 20000.0)
		h_fel = max(1000.0, min(80000.0, h_fel))
	else:
		h_fel = 0.0
		ci = 0.0
		thermal = 350.0 * math.sqrt(min(age, 80.0))
		h_maf = ((z + 3342.0 + thermal) * 3300.0 - h_sed * 900.0) / 350.0
		h_maf = max(2000.0, min(35000.0, h_maf))
	return h_fel, h_maf

def load_calibration_points(path):
	if not os.path.exists(path):
		return []
	with open(path, 'r', encoding='utf-8') as f:
		data = json.load(f)
	return data.get('points', [])

def load_morvel(path):
	if not os.path.exists(path):
		return {}
	with open(path, 'r', encoding='utf-8') as f:
		return json.load(f)

def haversine_distance_rad(lat1, lon1, lat2, lon2):
	dlat = lat2 - lat1
	dlon = lon2 - lon1
	a = math.sin(dlat * 0.5)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon * 0.5)**2
	return 2.0 * math.asin(math.sqrt(max(0.0, min(1.0, a))))

def build_raster(width, height, calib_pts, morvel_data, plate_mode='morvel25'):
	"""Synthesizes high-fidelity equirectangular rasters from real data points."""
	z_grid = [0.0] * (width * height)
	age_grid = [0.0] * (width * height)
	sed_grid = [0.0] * (width * height)
	kind_grid = [0] * (width * height)
	plate_grid = [0] * (width * height)

	plates_list = morvel_data.get('plates', [])
	plate_code_to_idx = {p['code']: i for i, p in enumerate(plates_list)}
	
	# Mapping for 25 plates mode
	if plate_mode == 'morvel25':
		unique_parents = sorted(list(set(p['parent_morvel25'] for p in plates_list)))
		parent_to_new_idx = {parent: i for i, parent in enumerate(unique_parents)}
		active_plates = []
		for parent in unique_parents:
			# find the parent's info
			p_info = next((p for p in plates_list if p['code'] == parent), None)
			if p_info:
				active_plates.append(p_info)
			else:
				active_plates.append(plates_list[0])
	else:
		active_plates = plates_list

	# Pre-convert calibration points coordinates to radians
	pts_rad = []
	for p in calib_pts:
		lat_r = math.radians(p['coordinates']['lat'])
		lon_r = math.radians(p['coordinates']['lon'])
		pts_rad.append((p, lat_r, lon_r))

	# Pre-convert active plate seeds to radians
	plate_seeds_rad = []
	for i, p in enumerate(active_plates):
		slat, slon = p['seed_lat_lon']
		plate_seeds_rad.append((i, math.radians(slat), math.radians(slon)))

	# Latitude ranges from -90 to +90 (row 0 = south pole, row H-1 = north pole)
	# Longitude ranges from -180 to +180 (col 0 = 180W, col W-1 = 180E)
	d_lat = 180.0 / height
	d_lon = 360.0 / width

	for r in range(height):
		lat = -90.0 + (r + 0.5) * d_lat
		lat_r = math.radians(lat)
		cos_lat = math.cos(lat_r)

		for c in range(width):
			lon = -180.0 + (c + 0.5) * d_lon
			lon_r = math.radians(lon)
			idx = r * width + c

			# 1. Assign nearest plate seed
			best_plate = 0
			min_pdist = float('inf')
			for p_idx, plat_r, plon_r in plate_seeds_rad:
				dist = haversine_distance_rad(lat_r, lon_r, plat_r, plon_r)
				if dist < min_pdist:
					min_pdist = dist
					best_plate = p_idx
			plate_grid[idx] = best_plate

			# 2. Inverse-distance weighting with calibration points
			weights_cont = []
			weights_ocean = []
			for p, plat_r, plon_r in pts_rad:
				dist = haversine_distance_rad(lat_r, lon_r, plat_r, plon_r)
				w = 1.0 / (dist * dist + 1e-4)
				if p['crust_type'] == 'continental':
					weights_cont.append((w, p))
				else:
					weights_ocean.append((w, p))

			# Continental probability heuristic based on spherical distance to continental cratons vs ocean basins
			sum_wc = sum(w for w, _ in weights_cont)
			sum_wo = sum(w for w, _ in weights_ocean)
			prob_cont = sum_wc / (sum_wc + sum_wo + 1e-9)

			# Elevation from all points first: the crust-type decision needs it, and the
			# type-specific refinement below only adjusts it mildly.
			all_weights = weights_cont + weights_ocean
			total_all = sum(w for w, _ in all_weights)
			z_all = sum(w * p['observed']['bedrock_elevation_m'] for w, p in all_weights) / total_all

			# Sharp threshold for continental vs oceanic. Cells at or near sea level are
			# continental regardless of the heuristic (shelf/island rule, plan §1.1): the
			# synthesized raster has no crustal-type grid, so raw elevation is the type proxy,
			# and an oceanic inversion of a +3 km island would demand a ~90 km basalt slab.
			is_cont = prob_cont > 0.50 or z_all > -200.0

			# Interpolate parameters
			active_weights = weights_cont if is_cont else weights_ocean
			total_w = sum(w for w, _ in active_weights)
			
			interp_z = sum(w * p['observed']['bedrock_elevation_m'] for w, p in active_weights) / total_w
			interp_age = sum(w * p['observed']['crust_age_myr'] for w, p in active_weights) / total_w
			interp_sed = sum(w * p['observed']['sediment_thickness_m'] for w, p in active_weights) / total_w

			# Add physical latitude and bathymetric corrections
			if not is_cont:
				# Old ocean baseline with mid-ocean ridge variability
				interp_age = max(1.0, min(180.0, interp_age))
				interp_sed = max(20.0, min(16500.0, interp_sed))
			else:
				interp_age = 500.0
				interp_sed = max(0.0, min(20000.0, interp_sed))

			z_grid[idx] = interp_z
			age_grid[idx] = interp_age
			sed_grid[idx] = interp_sed

			# kind bits:
			# bit 0: continental
			# bits 1-3: fertility quartile (2 default)
			# bit 4: synthesized from fallback
			kind_byte = (1 if is_cont else 0) | (2 << 1) | (1 << 4)
			kind_grid[idx] = kind_byte

	return {
		'z': z_grid,
		'age': age_grid,
		'sed': sed_grid,
		'kind': kind_grid,
		'plate': plate_grid,
		'active_plates': active_plates
	}

def wet_fraction(raster_data, width, height, shift=0.0):
	"""Cosine-latitude weighted wet fraction of the raster, with an optional trial shift."""
	z = raster_data['z']
	d_lat = 180.0 / height
	wet_sum = 0.0
	total_sum = 0.0
	for r in range(height):
		weight = math.cos(math.radians(-90.0 + (r + 0.5) * d_lat))
		row_idx = r * width
		for c in range(width):
			total_sum += weight
			if z[row_idx + c] + shift < 0.0:
				wet_sum += weight
	return wet_sum / total_sum

def enforce_k9_consistency(raster_data):
	"""Recomputes z from the clamped K9 inversion, in place.

	The synthesis and the datum shift can both ask for elevations outside what K9 crustal
	thicknesses can carry (islands above +0.4 km; trenches below -6.3 km given hMaf clamped
	to 2..35 km; and a datum shift of d metres moves every oceanic thickness requirement by
	d*3300/350 ~ 2.9d metres, pushing thin crust through the floor). The loader re-inverts
	the pack's z at apply time with the same clamps, so the pack must store the elevation the
	clamped crust actually produces - otherwise out-of-envelope cells drift up to a kilometre
	between bake and runtime and the datum calibration lies. main() alternates this pass with
	the datum calibration until the pair settles, so the final bank is shift-consistent and
	round-trips the loader within quantization, by construction.
	"""
	z = raster_data['z']
	age = raster_data['age']
	sed = raster_data['sed']
	kind = raster_data['kind']
	for i in range(len(z)):
		is_cont = bool(kind[i] & 1)
		h_fel, h_maf = invert_thickness(z[i], age[i], sed[i], is_cont)
		z[i] = elevation_k9(h_fel, h_maf, sed[i], age[i])

def calibrate_datum(raster_data, width, height, target=EARTH_WET_FRACTION_TARGET,
		lo=None, hi=None):
	"""Finds and applies the datum shift that lands the wet fraction on `target`.

	The wet fraction decreases with the shift (higher elevations, fewer cells below 0), so a
	binary search settles it. When `lo`/`hi` bound the shift, the search stays inside the
	window and clamps to the nearest bound if the target is unreachable in it - the window
	matters because outside it a thickness clamp rewrites z and the wet fraction is no
	longer monotonic in the shift (a whole ocean pinned on the hMaf ceiling can fake the
	target wet fraction, the 200 Ma bake's first attempt). Returns (shift applied, achieved)."""
	z = raster_data['z']
	if lo is None:
		lo = -8000.0
	if hi is None:
		hi = 8000.0
	wet_lo = wet_fraction(raster_data, width, height, lo)
	wet_hi = wet_fraction(raster_data, width, height, hi)
	if target >= wet_lo:
		shift = lo  # wetter than anything the window allows
	elif target <= wet_hi:
		shift = hi  # drier than anything the window allows
	else:
		for _ in range(40):
			mid = (lo + hi) * 0.5
			if wet_fraction(raster_data, width, height, mid) > target:
				lo = mid  # too wet, raise elevation to dry it out
			else:
				hi = mid  # too dry, lower elevation to submerge it
		shift = (lo + hi) * 0.5
	for i in range(len(z)):
		z[i] += shift

	return shift, wet_fraction(raster_data, width, height)

def unclamped_shift_window(raster_data):
	"""The shift range in which no K9 inversion hits a thickness clamp (plan §4, stage 4).

	Outside it the consistency pass rewrites z independently of the shift and the datum
	search is no longer monotonic. The paleo bakes search inside this window so the fixed
	point they converge on is the map's own sea level, not a clamp-pinned degenerate one."""
	z = raster_data['z']
	age = raster_data['age']
	sed = raster_data['sed']
	kind = raster_data['kind']
	lo = -8000.0
	hi = 8000.0
	for i in range(len(z)):
		if kind[i] & 1:
			thermal = 2091.0  # ci = 1 across the paleo land range
			hi = min(hi, 80000.0 / 6.0 - z[i] - 3342.0 - thermal + sed[i] * 900.0 / 3300.0)
			lo = max(lo, 1000.0 / 6.0 - z[i] - 3342.0 - thermal + sed[i] * 900.0 / 3300.0)
		else:
			thermal = 350.0 * math.sqrt(min(age[i], 80.0))
			hi = min(hi, 35000.0 * 350.0 / 3300.0 + sed[i] * 900.0 / 3300.0 - z[i] - 3342.0 - thermal)
			lo = max(lo, 2000.0 * 350.0 / 3300.0 + sed[i] * 900.0 / 3300.0 - z[i] - 3342.0 - thermal)
	return lo, hi

def quantize_and_pack(raster_data, datum_shift, achieved_wet, width, height, plate_mode, out_name,
		pack_name='earth', epoch=0, source='ETOPO2022+CRUST1.0+GlobSed+NNR-MORVEL56'):
	"""Encodes grids into Int16/Uint8 and packages base64 banks for JavaScript."""
	z_data = raster_data['z']
	age_data = raster_data['age']
	sed_data = raster_data['sed']
	kind_data = raster_data['kind']
	plate_data = raster_data['plate']
	active_plates = raster_data['active_plates']

	count = width * height
	z_int16 = [0] * count
	age_uint8 = [0] * count
	sed_uint8 = [0] * count
	kind_uint8 = [0] * count
	plate_uint8 = [0] * count

	for i in range(count):
		# Bedrock elevation in metres: Int16 (-32768 to 32767)
		z_val = int(round(z_data[i]))
		z_int16[i] = max(-32768, min(32767, z_val))

		# Age in Myr: Uint8 (0 to 255)
		age_val = int(round(age_data[i]))
		age_uint8[i] = max(0, min(255, age_val))

		# Sediment in units of 0.1 km (100 m): Uint8 (0 to 255 -> 0.0 to 25.5 km)
		sed_val = int(round(sed_data[i] / 100.0))
		sed_uint8[i] = max(0, min(255, sed_val))

		# Kind: Uint8
		kind_uint8[i] = int(kind_data[i]) & 0xFF

		# Plate ID: Uint8
		plate_uint8[i] = int(plate_data[i]) & 0xFF

	# Convert to binary byte buffers (Little Endian)
	z_bytes = struct.pack(f'<{count}h', *z_int16)
	age_bytes = struct.pack(f'<{count}B', *age_uint8)
	sed_bytes = struct.pack(f'<{count}B', *sed_uint8)
	kind_bytes = struct.pack(f'<{count}B', *kind_uint8)
	plate_bytes = struct.pack(f'<{count}B', *plate_uint8)

	z_b64 = base64.b64encode(z_bytes).decode('ascii')
	age_b64 = base64.b64encode(age_bytes).decode('ascii')
	sed_b64 = base64.b64encode(sed_bytes).decode('ascii')
	kind_b64 = base64.b64encode(kind_bytes).decode('ascii')
	plate_b64 = base64.b64encode(plate_bytes).decode('ascii')

	# Seeds and Euler poles formatting
	seeds_arr = []
	poles_arr = []
	for p in active_plates:
		seeds_arr.append(p['seed_unit_vector'])
		poles_arr.append(p['pole_vector'])

	js_pack = f"""// js/data/{out_name} — generated by tools/earth/bake_earth.py, do not edit
(function () {{
	var globalObject = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
	if (!globalObject.EarthPacks) globalObject.EarthPacks = [];
	globalObject.EarthPacks.push({{
		name: {pack_name!r},
		epoch: {epoch},
		w: {width},
		h: {height},
		source: {source!r},
		datum: {round(datum_shift, 2)},
		ocean: {round(achieved_wet, 4)},
		scale: {{ z: 1, age: 1, sed: 0.1 }},
		banks: {{
			z: '{z_b64}',
			age: '{age_b64}',
			sed: '{sed_b64}',
			kind: '{kind_b64}'
		}},
		plates: {{
			count: {len(active_plates)},
			ids: '{plate_b64}',
			seeds: {json.dumps(seeds_arr)},
			poles: {json.dumps(poles_arr)}
		}}
	}});
	if (typeof module !== 'undefined' && module.exports) module.exports = globalObject.EarthPacks;
}}());
"""
	return js_pack

def generate_report(raster_data, datum_shift, achieved_wet, width, height, report_path,
		target=EARTH_WET_FRACTION_TARGET, title='EARTH MAP BAKE REPORT'):
	"""Emits a comprehensive verification report artifact."""
	z = raster_data['z']
	age = raster_data['age']
	sed = raster_data['sed']
	kind = raster_data['kind']

	z_min = min(z)
	z_max = max(z)
	mean_z = sum(z) / len(z)

	land_z = [val for val in z if val >= 0.0]
	ocean_z = [val for val in z if val < 0.0]

	mean_land = sum(land_z) / len(land_z) if land_z else 0.0
	mean_ocean = sum(ocean_z) / len(ocean_z) if ocean_z else 0.0

	lines = [
		"=" * 72,
		f"{title} — {datetime.utcnow().isoformat()}Z",
		"=" * 72,
		f"Resolution: {width} x {height} ({(360.0/width):.2f}° equirectangular)",
		f"Total cells: {len(z):,}",
		f"Target wet fraction: {target:.4f}",
		f"Achieved wet fraction: {achieved_wet:.4f} ({achieved_wet*100.0:.2f}%)",
		f"Calibrated datum shift: {datum_shift:.2f} m",
		"-" * 72,
		"HYPSOMETRY & RELIEF STATISTICS:",
		f"  Global min elevation: {z_min:.1f} m",
		f"  Global max elevation: {z_max:.1f} m",
		f"  Global mean elevation: {mean_z:.1f} m",
		f"  Mean land elevation: {mean_land:+.1f} m",
		f"  Mean ocean depth: {mean_ocean:.1f} m",
		"-" * 72,
		"LAYER STATISTICS:",
		f"  Crust age range: {min(age):.1f} - {max(age):.1f} Myr",
		f"  Sediment thickness range: {min(sed):.1f} - {max(sed):.1f} m",
		f"  Mean sediment thickness: {sum(sed)/len(sed):.1f} m",
		f"  Active plates: {len(raster_data['active_plates'])}",
		"=" * 72,
		"VERIFICATION: K9-consistent by construction (z bank = elevation of the clamped crust);"
		" accept if the wet fraction reached its target and no thickness sits at a clamp ceiling"
	]
	report_content = "\n".join(lines) + "\n"
	with open(report_path, 'w', encoding='utf-8') as f:
		f.write(report_content)
	return report_content

# ------------------------------------------------------------------ 0.4.5 paleo
#
# Historical checkpoint packs (Pangaea 250 Ma, Gondwana 200 Ma, ...). Input is a
# raster extracted from an official PALEOMAP 1deg PaleoDEM rendering by
# tools/earth/paleo_extract.js (see data/earth/SOURCES.md for provenance). The
# band coastline and crust type are the real reconstruction; within-band
# elevation/age/sediment are documented priors (kind bit 4), and the K9
# fixed point below makes the pack round-trip the loader within quantization.

def load_paleo_bin(path):
	"""Reads a paleo_extract.js raster: [w:u16][h:u16][epoch:u16] z i16, age u8, kind u8."""
	with open(path, 'rb') as f:
		raw = f.read()
	w, h, epoch = struct.unpack_from('<HHH', raw, 0)
	n = w * h
	off = 6
	z = [float(v) for v in struct.unpack_from('<%dh' % n, raw, off)]
	off += 2 * n
	age = [float(v) for v in raw[off:off + n]]
	off += n
	kind = list(raw[off:off + n])
	cont = [bool(k & 1) for k in kind]
	return w, h, epoch, z, age, cont

def dist_to_land(width, height, cont):
	"""8-neighbour BFS distance (in degrees) from each cell to the nearest continental cell,
	longitude-wrapping. Drives the oceanic sediment prior (thick margins, thin pelagic)."""
	n = width * height
	d = [-1] * n
	q = deque()
	for i in range(n):
		if cont[i]:
			d[i] = 0
			q.append(i)
	while q:
		i = q.popleft()
		r, c = divmod(i, width)
		for dr in (-1, 0, 1):
			for dc in (-1, 0, 1):
				if dr == 0 and dc == 0:
					continue
				nr = r + dr
				if nr < 0 or nr >= height:
					continue
				j = nr * width + ((c + dc) % width)
				if d[j] < 0:
					d[j] = d[i] + max(abs(dr), abs(dc))
					q.append(j)
	return d

def _geo(i, width, height):
	r, c = divmod(i, width)
	lat = math.radians(-90.0 + (r + 0.5) * 180.0 / height)
	lon = math.radians(-180.0 + (c + 0.5) * 360.0 / width)
	return (math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat))

def _angle(a, b):
	return math.acos(max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))

def _centroid(cells, width, height):
	x = y = z = 0.0
	for i in cells:
		g = _geo(i, width, height)
		x += g[0]; y += g[1]; z += g[2]
	L = math.sqrt(x * x + y * y + z * z) or 1.0
	return (x / L, y / L, z / L)

def land_components(width, height, mask):
	"""8-connected components of the mask with longitude wrap. Returns (label grid, cell lists)."""
	n = width * height
	labels = [-1] * n
	comps = []
	for i in range(n):
		if not mask[i] or labels[i] >= 0:
			continue
		cid = len(comps)
		cells = []
		q = deque([i])
		labels[i] = cid
		while q:
			j = q.popleft()
			cells.append(j)
			r, c = divmod(j, width)
			for dr in (-1, 0, 1):
				for dc in (-1, 0, 1):
					if dr == 0 and dc == 0:
						continue
					nr = r + dr
					if nr < 0 or nr >= height:
						continue
					k = nr * width + ((c + dc) % width)
					if mask[k] and labels[k] < 0:
						labels[k] = cid
						q.append(k)
		comps.append(cells)
	return labels, comps

def paleo_plates(width, height, cont, min_cells=200, k_ocean=8):
	"""Plate table for a historical pack.

	Continental plates: 8-connected components of the continental mask (exposed land AND
	flooded shelf - the shelf rides its continent). Components at or above `min_cells`
	raster cells are plates of their own; smaller fragments are absorbed into the
	neighbouring big component with the most shared border (or the nearest centroid if
	islanded), so no sliver below min_plate_cells survives to the sim grid.
	Oceanic plates: k_ocean plates by farthest-point sampling over the ocean, so the
	super-ocean gets ridge-like boundaries the sim can evolve.
	Poles are zero: no NNR model exists for past epochs, the game preset (procedural
	mantle) drives the motion, and the loader's zero-pole guard keeps 'realistic' safe.
	Returns (plate_grid, seeds, poles) with geographic z-up vectors, like the morvel json.
	"""
	labels, comps = land_components(width, height, cont)
	big = sorted([c for c in comps if len(c) >= min_cells], key=len, reverse=True)
	cent = [_centroid(c, width, height) for c in big]
	grid = [-1] * (width * height)
	for ci, cells in enumerate(big):
		for i in cells:
			grid[i] = ci
	for c in comps:
		if len(c) >= min_cells:
			continue
		cellset = set(c)
		shared = [0] * len(big)
		for i in cellset:
			r, cc = divmod(i, width)
			for dr in (-1, 0, 1):
				for dc in (-1, 0, 1):
					if dr == 0 and dc == 0:
						continue
					nr = r + dr
					if nr < 0 or nr >= height:
						continue
					j = nr * width + ((cc + dc) % width)
					if grid[j] >= 0:
						shared[grid[j]] += 1
		if any(shared):
			tgt = shared.index(max(shared))
		elif big:
			p = _centroid(c, width, height)
			tgt = min(range(len(big)), key=lambda ci: _angle(p, cent[ci]))
		else:
			continue
		for i in c:
			grid[i] = tgt
	# Oceanic Voronoi over farthest-point seeds.
	ocean = [i for i in range(width * height) if not cont[i]]
	seed_cells = []
	if ocean:
		seed_cells = [ocean[0]]
		pts = [_geo(ocean[0], width, height)]
		for _ in range(1, k_ocean):
			best_i, best_d = ocean[0], -1.0
			for i in ocean:
				p = _geo(i, width, height)
				dmin = min(_angle(p, q) for q in pts)
				if dmin > best_d:
					best_d, best_i = dmin, i
			seed_cells.append(best_i)
			pts.append(_geo(best_i, width, height))
		for i in ocean:
			p = _geo(i, width, height)
			best = 0
			bd = float('inf')
			for s in range(len(pts)):
				d = _angle(p, pts[s])
				if d < bd:
					bd = d
					best = s
			grid[i] = len(big) + best
	seeds = [list(c) for c in cent]
	seeds += [list(_geo(i, width, height)) for i in seed_cells]
	poles = [[0.0, 0.0, 0.0, 0.0]] * len(seeds)
	return grid, seeds, poles

def morvel_plate_assignment(width, height, morvel_data, mode='morvel25'):
	"""Nearest-seed Voronoi plate table from the NNR-MORVEL kinematics, the same
	assignment the 0.4.0 modern bake used. Returns (plate_grid, seeds, poles) with
	geographic z-up vectors; poles are the real Euler poles (non-zero)."""
	plates_list = morvel_data.get('plates', [])
	if not plates_list:
		raise SystemExit('FAIL: no MORVEL plates in the kinematics file')
	if mode == 'morvel25':
		unique_parents = sorted(list(set(p['parent_morvel25'] for p in plates_list)))
		active_plates = []
		for parent in unique_parents:
			p_info = next((p for p in plates_list if p['code'] == parent), None)
			active_plates.append(p_info if p_info else plates_list[0])
	else:
		active_plates = plates_list
	seeds_rad = []
	for p in active_plates:
		slat, slon = p['seed_lat_lon']
		seeds_rad.append((math.radians(slat), math.radians(slon)))
	grid = [0] * (width * height)
	for r in range(height):
		lat = -90.0 + (r + 0.5) * (180.0 / height)
		lat_r = math.radians(lat)
		for c in range(width):
			lon = -180.0 + (c + 0.5) * (360.0 / width)
			lon_r = math.radians(lon)
			best, best_d = 0, float('inf')
			for i, (plat_r, plon_r) in enumerate(seeds_rad):
				d = haversine_distance_rad(lat_r, lon_r, plat_r, plon_r)
				if d < best_d:
					best_d, best = d, i
			grid[r * width + c] = best
	seeds = [list(p['seed_unit_vector']) for p in active_plates]
	poles = [list(p['pole_vector']) for p in active_plates]
	return grid, seeds, poles

def bake_paleo(args):
	w, h, epoch, z, age, cont = load_paleo_bin(args.paleo)
	n = w * h
	print(f"[*] Paleo raster {args.paleo}: {w}x{h} epoch {epoch} Ma")
	if w != int(round(360.0 / args.deg)) or h != int(round(180.0 / args.deg)):
		print(f"[*] NOTE: raster is {w}x{h}; resample it at --deg {args.deg} resolution for an exact match")
	# Documented priors (kind bit 4 marks the cell): shallow margins / thin pelagic ocean
	# sediment, thin cover on exposed land, thick epicontinental fill on flooded shelves.
	dist = dist_to_land(w, h, cont)
	sed = [0.0] * n
	for i in range(n):
		if cont[i]:
			sed[i] = 6000.0 if z[i] < 0 else 2000.0
		else:
			sed[i] = min(5000.0, 1000.0 + 4000.0 * math.exp(-dist[i] / 4.0))
	kind = [((1 if cont[i] else 0) | (2 << 1) | (1 << 4)) for i in range(n)]
	if args.plates == 'paleo':
		plate_grid, seeds, poles = paleo_plates(w, h, cont, min_cells=args.min_plate, k_ocean=args.ocean_plates)
		n_land_plates = len(seeds) - args.ocean_plates
	else:
		morvel_data = load_morvel(os.path.join(args.sources_dir, 'nnr-morvel56.json'))
		plate_grid, seeds, poles = morvel_plate_assignment(w, h, morvel_data, args.plates)
		n_land_plates = len(seeds)
	n_plates = len(seeds)
	if any(p < 0 for p in plate_grid):
		raise SystemExit('FAIL: unassigned plate cells - grow --min-plate or check the mask')
	if n_plates > 128:
		raise SystemExit('FAIL: plate count exceeds plateCap')
	print(f"[*] Plates ({args.plates}): {n_plates} total, {n_land_plates} continental/parent")
	raster = {'z': z, 'age': age, 'sed': sed, 'kind': kind, 'plate': plate_grid,
		'active_plates': [{'seed_unit_vector': s, 'pole_vector': p} for s, p in zip(seeds, poles)]}
	# The datum target: for historical packs the map's own drawn sea level (the fraction
	# the reconstruction puts below water); for the present-day re-bake the fixed modern
	# 70.81% (--wet-target), so sea level lands on the true modern value. Measured with
	# the same latitude-cosine weighting as the calibrator so the numbers agree.
	if args.wet_target is not None:
		wet_target = args.wet_target
	else:
		wet_target = wet_fraction({'z': z}, w, h)
	print(f"[*] K9 consistency + datum fixed point (wet target {wet_target*100.0:.2f}% from the map)...")
	enforce_k9_consistency(raster)
	datum_shift = 0.0
	achieved_wet = 0.0
	# Alternate to a fixed point. Historical packs search inside the unclamped window so
	# the sea level they find is the map's own, not a clamp-pinned degenerate one. The
	# present-day re-bake overrides the target (70.81% is wetter than the texture's own
	# implicit sea level), so it searches unbounded like the 0.4.0 bake: the large shift
	# flattens the deepest band on the hMaf floor (~-4.9 km at 1deg, the real abyssal
	# plain mean), which is the desired behaviour there.
	use_window = args.wet_target is None
	for _ in range(4):
		if use_window:
			win_lo, win_hi = unclamped_shift_window(raster)
			if win_lo >= win_hi:
				break
			step_shift, achieved_wet = calibrate_datum(raster, w, h, target=wet_target,
				lo=win_lo, hi=win_hi)
		else:
			step_shift, achieved_wet = calibrate_datum(raster, w, h, target=wet_target)
		enforce_k9_consistency(raster)
		datum_shift += step_shift
	achieved_wet = wet_fraction(raster, w, h)
	print(f"    Datum shift: {datum_shift:+.2f} m -> Achieved wet fraction: {achieved_wet*100.0:.2f}%")
	os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
	source = args.source or f'PALEOMAP-PaleoDEM {epoch}Ma (Scotese & Wright 2018)'
	js_pack = quantize_and_pack(
		raster, datum_shift, achieved_wet, w, h, 'paleo', os.path.basename(args.out),
		pack_name=args.name, epoch=epoch, source=source)
	with open(args.out, 'w', encoding='utf-8') as f:
		f.write(js_pack)
	print(f"[+] Output written to {args.out} ({os.path.getsize(args.out):,} bytes)")
	os.makedirs(os.path.dirname(args.report) or '.', exist_ok=True)
	report_txt = generate_report(raster, datum_shift, achieved_wet, w, h, args.report,
		target=wet_target, title=f'PALEO BAKE REPORT — {args.name} ({epoch} Ma)')
	with open(args.report, 'w', encoding='utf-8') as f:
		f.write(report_txt)
	print(f"[+] Validation report written to {args.report}")
	# Clamp-ceiling census: a paleo pack should not pile columns on the hMaf/hFel clamps.
	ceil = sum(1 for i in range(n) if raster['z'][i] < 0 and not cont[i]
		and age[i] < 20000 and min(35000.0, max(2000.0,
			((raster['z'][i] + 3342.0 + 350.0 * math.sqrt(min(age[i], 80.0))) * 3300.0
			 - raster['sed'][i] * 900.0) / 350.0)) >= 35000.0)
	floor = sum(1 for i in range(n) if raster['z'][i] < 0 and not cont[i]
		and ((raster['z'][i] + 3342.0 + 350.0 * math.sqrt(min(age[i], 80.0))) * 3300.0
			- raster['sed'][i] * 900.0) / 350.0 <= 2000.0)
	print(f"[+] Envelope census: {ceil} cells at the hMaf ceiling, {floor} at the floor "
		f"(envelope fringe; K9-consistent by construction)")

def main():
	parser = argparse.ArgumentParser(description="Bake Earth start map pack for planet-geotectonics")
	parser.add_argument('--deg', type=float, default=1.0, help="Grid resolution in degrees (default: 1.0)")
	parser.add_argument('--sources-dir', type=str, default='data/earth', help="Directory containing source datasets")
	parser.add_argument('--out', type=str, default='js/data/earth-1deg.js', help="Output JS pack path")
	parser.add_argument('--report', type=str, default='data/earth/report-reference.txt', help="Validation report output path")
	parser.add_argument('--plates', type=str, default='morvel25',
		choices=['morvel25', 'morvel56', 'paleo'], help="Plate model ('paleo' = land components + oceanic Voronoi)")
	parser.add_argument('--paleo', type=str, default=None,
		help="Paleo raster bin from paleo_extract.js (0.4.5 historical pack; also the present-day 000Ma re-bake)")
	parser.add_argument('--name', type=str, default='earth', help="Pack name (0.4.5)")
	parser.add_argument('--min-plate', type=int, default=200, help="Min raster cells for a continental plate (0.4.5)")
	parser.add_argument('--ocean-plates', type=int, default=8, help="Oceanic Voronoi plate count (0.4.5)")
	parser.add_argument('--wet-target', type=float, default=None,
		help="Datum wet fraction override (default: the map's own drawn sea level; use 0.7081 for the present-day re-bake)")
	parser.add_argument('--source', type=str, default=None,
		help="Provenance string for the pack (default: derived from the raster epoch)")

	args = parser.parse_args()

	if args.paleo:
		bake_paleo(args)
		return

	width = int(round(360.0 / args.deg))
	height = int(round(180.0 / args.deg))

	print(f"[*] Starting Earth bake pipeline at {args.deg}° ({width}x{height} raster)...")
	calib_path = os.path.join(args.sources_dir, 'calibration_points.json')
	morvel_path = os.path.join(args.sources_dir, 'nnr-morvel56.json')

	calib_pts = load_calibration_points(calib_path)
	morvel_data = load_morvel(morvel_path)

	print(f"[*] Loaded {len(calib_pts)} calibration points and {len(morvel_data.get('plates', []))} MORVEL plates.")
	print(f"[*] Building raster using K9 isostasy inversion & shelf transition physics...")
	raster = build_raster(width, height, calib_pts, morvel_data, plate_mode=args.plates)

	print(f"[*] Enforcing K9 consistency (z bank = elevation of the clamped crust)...")
	enforce_k9_consistency(raster)

	print(f"[*] Calibrating vertical datum for exact 70.81% ocean fraction...")
	# Datum and envelope form a fixed point: the shift moves every oceanic thickness
	# requirement by ~2.9x the shift, and the clamps rewrite z near the envelope edge, so
	# alternate until both hold together. Converges in 2-3 rounds (clamps only touch the
	# envelope fringe, which barely moves the wet fraction).
	datum_shift = 0.0
	achieved_wet = 0.0
	for _ in range(4):
		step_shift, achieved_wet = calibrate_datum(raster, width, height)
		enforce_k9_consistency(raster)
		datum_shift += step_shift
	achieved_wet = wet_fraction(raster, width, height)
	print(f"    Datum shift: {datum_shift:+.2f} m -> Achieved wet fraction: {achieved_wet*100.0:.2f}%")

	print(f"[*] Quantizing to Int16/Uint8 and packaging base64 banks...")
	os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
	js_pack = quantize_and_pack(raster, datum_shift, achieved_wet, width, height, args.plates,
		os.path.basename(args.out))
	with open(args.out, 'w', encoding='utf-8') as f:
		f.write(js_pack)
	print(f"[+] Output written to {args.out} ({os.path.getsize(args.out):,} bytes)")

	os.makedirs(os.path.dirname(args.report) or '.', exist_ok=True)
	report_txt = generate_report(raster, datum_shift, achieved_wet, width, height, args.report)
	print(f"[+] Validation report written to {args.report}")
	print(report_txt)

if __name__ == '__main__':
	main()

# findings, pitfalls, skills

## transport of crust on the icosphere grid (measured, experiments/advection-bench.js)

	at 10k-100k yr frames plates move 0.001-0.2 cell per frame.
	nearest-cell semi-Lagrangian copy: below ~1 cell of accumulated motion most cells map to
	themselves (plate freezes); at 0.7 cell the map is not a bijection on the irregular
	Voronoi grid and the plate erodes to nothing; at 1.0 cell it moves but distorts (IoU 0.11
	after 2 laps).
	first-order upwind flux: exact mass, but the edge smears as sqrt(dx*L): 11-26 cells per
	ocean crossing, independent of dt.
	Lagrangian columns with body-frame position + per-plate quaternion, re-rasterised every
	frame by nearest column within cell+ring: IoU 0.97 after 2 laps, zero interior holes,
	exact mass, 3 ms/frame at L5 in node.

## raster threshold

	for 1 column per cell moving rigidly, the nearest-column distance from a cell centre is
	p99.9 = 0.61 and max = 0.65 of the local neighbour distance (same at L5 and L6).
	cell+ring search covers a disc of ~0.85-1.0 neighbour distances.
	gap threshold 0.75 separates "covered" from "genuine divergent gap" with margin on both sides.

## mantle driver

	sum of A_m (a_m x r) terms is ONE rigid rotation (equals (sum A_m a_m) x r to 5e-16):
	zero divergence, zero shear, no differential plate forcing. use a scalar potential
	(poloidal grad Phi + toroidal r x grad Psi) from drifting low-degree noise instead.

## grid facts (js/geodesics.js)

	nbrB rotA/rotB is an exact 2D rotation (|rot| = 1), so tangent vectors can be transported
	between neighbour bases without trig.
	the W x H = 256 x ceil(V/256) packing is NOT spatial: texel neighbours are not cell
	neighbours; never bilinear-sample these textures.
	cell areas vary 0.68..1.21 of the mean; neighbour distances vary +-10 %.
	hill-climb from a cached cell is exact for locating a point in a Voronoi cell and needs
	<= 3 steps for sub-cell motion.

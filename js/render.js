var RenderParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// View math is kept beside the CPU renderer so the classic page and the pointer handler
// share the same world-to-screen convention. q maps a world direction into the displayed
// equirectangular map; a drag rotates the displayed surface without clamping its angle.
var MapView = {
	TAU: Math.PI * 2,
	direction: function (out, x, y, width, height) {
		var lon = (x / width - 0.5) * MapView.TAU;
		var lat = (0.5 - y / height) * Math.PI, c = Math.cos(lat);
		out[0] = c * Math.cos(lon); out[1] = Math.sin(lat); out[2] = c * Math.sin(lon);
	},
	// Apply the shortest screen-space rotation that takes a surface point from a to b.
	// Incremental composition, rather than Euler clamps, means repeated drags can pass any
	// number of latitude or longitude turns. Longitude motion naturally scales with cos(lat).
	drag: function (q, ax, ay, az, bx, by, bz) {
		var dot = ax * bx + ay * by + az * bz;
		if (dot > 0.999999999) return false;
		var rx = ay * bz - az * by, ry = az * bx - ax * bz, rz = ax * by - ay * bx, rw = 1 + dot;
		if (rw < 1e-7) {
			// A single event can jump across the antipode. Pick a stable perpendicular axis;
			// ordinary pointer moves use the cheaper cross-product branch above.
			if (Math.abs(ax) < 0.9) { rx = 0; ry = az; rz = -ay; }
			else { rx = -az; ry = 0; rz = ax; }
			rw = 0;
		}
		var inv = 1 / Math.hypot(rx, ry, rz, rw);
		rx *= inv; ry *= inv; rz *= inv; rw *= inv;
		var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
		var nx = rw * qx + rx * qw + ry * qz - rz * qy;
		var ny = rw * qy - rx * qz + ry * qw + rz * qx;
		var nz = rw * qz + rx * qy - ry * qx + rz * qw;
		var nw = rw * qw - rx * qx - ry * qy - rz * qz;
		var qInv = 1 / Math.hypot(nx, ny, nz, nw);
		q[0] = nx * qInv; q[1] = ny * qInv; q[2] = nz * qInv; q[3] = nw * qInv;
		return true;
	}
};

// atan2 to 1.7e-6 rad (measured over [0,1] and random quadrants): a degree-11 odd minimax
// polynomial on |t| <= 1 with the octant folded out. Math.atan2 is exact, but the view
// re-sample calls it a half-million times per moved frame and the swap took the L5 re-sample
// from ~45 ms to ~10 ms. The error is three orders of magnitude below the half-pixel margin
// of a lookup cell (~3e-3 rad), so it never changes which pixel a direction lands in except
// within 1.7e-6 rad of a boundary.
function atanUnit(t) {
	var t2 = t * t;
	return t * (0.99997726 + t2 * (-0.33262347 + t2 * (0.19354346 + t2 * (-0.11643287
		+ t2 * (0.05265332 + t2 * -0.01172120)))));
}
function atan2Fast(y, x) {
	var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, r;
	if (ay <= ax) r = ax > 0 ? atanUnit(ay / ax) : 0;
	else r = Math.PI / 2 - atanUnit(ax / ay);
	if (x < 0) r = Math.PI - r;
	return y < 0 ? -r : r;
}

function Renderer(canvas, state) {
	this.canvas = canvas;
	this.context = canvas.getContext('2d');
	this.state = state;
	canvas.width = state.grid.lookupW; canvas.height = state.grid.lookupH;
	this.image = this.context.createImageData(canvas.width, canvas.height);
	this.viewLookup = new Uint32Array(state.grid.lookup.length);
	this.viewLookup.set(state.grid.lookup);
	this.viewQ = new Float64Array([0, 0, 0, 1]);
	this.viewDirty = false;
	// Screen-angle tables: every column's and row's pixel-centre lon/lat, so the re-sample
	// spends its per-pixel work on the projection only. Built once - the canvas is the
	// lookup raster's size at every level.
	this.lonCos = new Float64Array(canvas.width); this.lonSin = new Float64Array(canvas.width);
	this.latCos = new Float64Array(canvas.height); this.latSin = new Float64Array(canvas.height);
	for (var x = 0; x < canvas.width; x++) {
		var lon = ((x + 0.5) / canvas.width - 0.5) * MapView.TAU;
		this.lonCos[x] = Math.cos(lon); this.lonSin[x] = Math.sin(lon);
	}
	for (var y = 0; y < canvas.height; y++) {
		var lat = (0.5 - (y + 0.5) / canvas.height) * Math.PI;
		this.latCos[y] = Math.cos(lat); this.latSin[y] = Math.sin(lat);
	}
	this.palette = new Uint8Array(state.plateCap * 3);
	this.colors = new Uint8Array(state.grid.V * 3);
	for (var p = 0; p < state.plateCap; p++) {
		var a = p * 2.3999632297;
		this.palette[p * 3] = 135 + 90 * Math.cos(a);
		this.palette[p * 3 + 1] = 145 + 80 * Math.cos(a + 2.1);
		this.palette[p * 3 + 2] = 155 + 80 * Math.cos(a + 4.2);
	}
}
// Hue helper for the plate-motion view: HSL hue->RGB channel, no allocation.
function hue2rgb(p, q, t) {
	if (t < 0) t += 1; if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}
// Plate-motion hue: compass angle of (east, north) velocity -> hue, exactly one wheel wrap
// so each hue names exactly one direction. Anchors E 120 green, N 240 blue, W 0 red,
// S 60 yellow; the unwrapped hue rises +360 over the turn (120->240->360->420->480), so
// opposite directions are complementary (green/red, blue/yellow). The rejected wish list
// (W yellow, S red = 120,240,60,0) winds 0 - see findings-pitfalls-skills.md.
function dirHue(ve, vn) {
	var t = Math.atan2(vn, ve) * 0.15915494309189535;
	t -= Math.floor(t);
	if (t < 0.5) return (120 + 480 * t) % 360;
	return (240 + 240 * t) % 360;
}
Renderer.dirHue = dirHue;
Renderer.MapView = MapView;
Renderer.atan2Fast = atan2Fast;
// Plate velocity (m/Myr, 1e4 per cm/yr) scaled so length~6 saturates, matching the 'speed'
// view's 80000 (= 8 cm/yr) ramp.
var DIR_SPEED_UNIT = 80000.0 / 6.0;

// Layer names for the six metallogenic potentials (design §8), read straight off the state.
Renderer.ORE = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];
Renderer.prototype.setView = function (qx, qy, qz, qw) {
	var q = arguments.length === 1 ? qx : null;
	if (q) { qy = q[1]; qz = q[2]; qw = q[3]; qx = q[0]; }
	var v = this.viewQ;
	if (v[0] === qx && v[1] === qy && v[2] === qz && v[3] === qw) return;
	v[0] = qx; v[1] = qy; v[2] = qz; v[3] = qw;
	this.viewDirty = true;
};
Renderer.prototype.resetView = function () {
	this.setView(0, 0, 0, 1);
};
Renderer.prototype.updateViewLookup = function () {
	if (!this.viewDirty) return;
	var g = this.state.grid, W = g.lookupW, H = g.lookupH, q = this.viewQ;
	var qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3], out = this.viewLookup;
	var lonC = this.lonCos, lonS = this.lonSin, latC = this.latCos, latS = this.latSin;
	for (var y = 0; y < H; y++) {
		var cl = latC[y], sy = latS[y], a = -2 * qz * sy, b = 2 * qx * sy;
		for (var x = 0; x < W; x++) {
			var sx = cl * lonC[x], sz = cl * lonS[x];
			var tx = 2 * qy * sz + a, ty = 2 * (qz * sx - qx * sz), tz = b - 2 * qy * sx;
			var wx = sx + qw * tx + qy * tz - qz * ty;
			var wy = sy + qw * ty + qz * tx - qx * tz;
			var wz = sz + qw * tz + qx * ty - qy * tx;
			// atan2 for the latitude too (y over the horizontal length): the same angle as
			// asin, one fewer special case, and it takes the fast polynomial as well.
			var sourceLon = atan2Fast(wz, wx);
			var sourceLat = atan2Fast(wy, Math.sqrt(wx * wx + wz * wz));
			var sourceX = Math.floor((sourceLon / MapView.TAU + 0.5) * W);
			if (sourceX < 0) sourceX += W;
			if (sourceX >= W) sourceX -= W;
			var sourceY = Math.floor((sourceLat / Math.PI + 0.5) * H);
			if (sourceY < 0) sourceY = 0;
			if (sourceY >= H) sourceY = H - 1;
			out[(H - 1 - y) * W + x] = g.lookup[sourceY * W + sourceX];
		}
	}
	this.viewDirty = false;
};
Renderer.prototype.draw = function (layer) {
	var s = this.state, g = s.grid, colors = this.colors;
	for (var c = 0; c < g.V; c++) {
		var b = c * 3, owner = s.owner[c];
		colors[b] = 20; colors[b + 1] = 26; colors[b + 2] = 39;
		if (owner < 0) continue;
		if (layer === 'owner') { colors[b] = 78; colors[b + 1] = 197; colors[b + 2] = 167; continue; }
		var ore = Renderer.ORE.indexOf(layer);
		if (ore >= 0) {
			// Potentials share one ramp; the class is named by the probe and the HUD, not by hue.
			var v = Math.min(1, s[Renderer.ORE[ore]][owner]);
			colors[b] = 24 + 231 * v;
			colors[b + 1] = 30 + 190 * v * v;
			colors[b + 2] = 44 + 40 * v;
			continue;
		}
		if (layer === 'damage') {
			// The rift corridor: cells whose column has weakened past the split threshold glow.
			var d = s.damage[owner], hot = d > RenderParams.splitDamage;
			colors[b] = 30 + 225 * Math.min(1, d);
			colors[b + 1] = 30 + (hot ? 90 : 40) * Math.min(1, d);
			colors[b + 2] = 46;
			continue;
		}
		if (layer === 'type') {
			var kind = 0;
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, t = s.edgeType[e];
				if (t === 1 && s.polarity[e] === 2) { kind = 4; break; }
				if (t === 1 && kind < 3) kind = 3;
				else if (t === 2 && kind < 2) kind = 2;
				else if (t === 3 && kind < 1) kind = 1;
			}
			if (kind === 4) { colors[b] = 186; colors[b + 1] = 92; colors[b + 2] = 214; continue; }
			if (kind === 3) { colors[b] = 214; colors[b + 1] = 72; colors[b + 2] = 64; continue; }
			if (kind === 2) { colors[b] = 232; colors[b + 1] = 196; colors[b + 2] = 74; continue; }
			if (kind === 1) { colors[b] = 214; colors[b + 1] = 214; colors[b + 2] = 220; continue; }
			var p = s.plate[owner] * 3;
			colors[b] = this.palette[p] * 0.45; colors[b + 1] = this.palette[p + 1] * 0.45; colors[b + 2] = this.palette[p + 2] * 0.45;
			continue;
		}
		if (layer === 'plate') {
			var p = s.plate[owner] * 3;
			colors[b] = this.palette[p]; colors[b + 1] = this.palette[p + 1]; colors[b + 2] = this.palette[p + 2];
			continue;
		}
		if (layer === 'sediment') {
			var sediment = Math.min(1, s.hSed[owner] / 5000);
			colors[b] = 52 + 170 * sediment; colors[b + 1] = 42 + 110 * sediment; colors[b + 2] = 30 + 55 * sediment;
			continue;
		}
		if (layer === 'speed') {
			// Rigid plate velocity |omega x r| of the cell, cm/yr on a 0-8 ramp.
			var sp = Math.min(1, Math.hypot(s.vel[b], s.vel[b + 1], s.vel[b + 2]) / 80000);
			colors[b] = 12 + 236 * sp; colors[b + 1] = 16 + 234 * sp; colors[b + 2] = 28 + 227 * sp;
			continue;
		}
		if (layer === 'age') {
			// Crust age of the owning column, Myr on a 0-1000 ramp: young hot, old blue.
			var ag = Math.min(1, s.age[owner] / 1000);
			colors[b] = 234 - 202 * ag; colors[b + 1] = 112 - 66 * ag; colors[b + 2] = 48 + 52 * ag;
			continue;
		}
		if (layer === 'force') {
			// |wEq| (design 6.3): every boundary force except drag expressed as an
			// equivalent basal velocity; sqrt ramp saturating at 50 cm/yr.
			var fo = Math.sqrt(Math.min(1, Math.hypot(s.wEq[b], s.wEq[b + 1], s.wEq[b + 2]) / 500000));
			colors[b] = 16 + 239 * fo; colors[b + 1] = 16 + 204 * fo * fo; colors[b + 2] = 30 + 26 * fo;
			continue;
		}
		if (layer === 'dir' || layer === 'forceDir') {
			// Motion/force: direction is hue, speed is lightness. Project the rigid
			// Ω×r velocity onto the local (east, north) tangent so the hue reads as
			// compass direction on the equirectangular map (E green, N blue, W red, S yellow).
			var vector = layer === 'forceDir' ? s.wEq : s.vel;
			var vx = vector[b], vy = vector[b + 1], vz = vector[b + 2];
			var px = g.pos[b], py = g.pos[b + 1], pz = g.pos[b + 2];
			var invR = 1 / Math.sqrt(px * px + py * py + pz * pz);
			var nx = px * invR, ny = py * invR, nz = pz * invR;
			var horiz = Math.sqrt(px * px + pz * pz);
			var ex, ey, ez;
			if (horiz > 1e-9) { ex = -pz / horiz; ey = 0; ez = px / horiz; }
			else { ex = 1; ey = 0; ez = 0; }
			var nrx = -ny * nx, nry = 1 - ny * ny, nrz = -ny * nz;
			var nrLen = Math.sqrt(nrx * nrx + nry * nry + nrz * nrz);
			if (nrLen > 1e-9) { nrx /= nrLen; nry /= nrLen; nrz /= nrLen; }
			var ve = (vx * ex + vz * ez) / DIR_SPEED_UNIT;
			var vn = (vx * nrx + vy * nry + vz * nrz) / DIR_SPEED_UNIT;
			// speedToHsl (0.3 plan): atan2(north, east) -> hue, |v| -> lightness.
			var hue = dirHue(ve, vn);
			var sp = Math.sqrt(ve * ve + vn * vn);
			var nl = Math.min(sp * 0.166666667, 1.0);
			var L = 0.05 + 0.65 * Math.pow(nl, 0.6);
			var h = hue / 360;
			var q = L < 0.5 ? L * 1.9 : L + 0.9 - L * 0.9;
			var pp = 2 * L - q;
			colors[b] = hue2rgb(pp, q, h + 1 / 3) * 255;
			colors[b + 1] = hue2rgb(pp, q, h) * 255;
			colors[b + 2] = hue2rgb(pp, q, h - 1 / 3) * 255;
			continue;
		}
		// Relief range (0.3.3): |z| = RenderParams.zRange saturates land and the deep-water floor
		// symmetrically, so the ramp's cap and its floor move together.
		var z = s.z[c];
		if (z < 0) {
			var shallow = Math.max(0, 1 + z / RenderParams.zRange);
			colors[b] = 15 + 23 * shallow; colors[b + 1] = 40 + 95 * shallow; colors[b + 2] = 69 + 100 * shallow;
			continue;
		}
		var high = Math.min(1, z / RenderParams.zRange);
		colors[b] = 100 + 145 * high; colors[b + 1] = 156 + 79 * high; colors[b + 2] = 112 + 113 * high;
	}
	this.paint();
};
// The current view's screen table through the last draw's colours, onto the canvas. On its
// own it is the redraw for a view move: the colours are still those of the last draw(), so
// a drag repaints without recolouring, and a drag while playing adds only the re-sample to
// the frame's own draw. The frame loop's initial dirty guarantees a draw has run first.
Renderer.prototype.paint = function () {
	this.updateViewLookup();
	var g = this.state.grid, data = this.image.data, colors = this.colors, screen = this.viewLookup;
	for (var y = 0, row = (g.lookupH - 1) * g.lookupW, pixel = 0; y < g.lookupH; y++, row -= g.lookupW) {
		for (var x = 0; x < g.lookupW; x++, pixel += 4) {
			var b = screen[row + x] * 3;
			data[pixel] = colors[b]; data[pixel + 1] = colors[b + 1]; data[pixel + 2] = colors[b + 2]; data[pixel + 3] = 255;
		}
	}
	this.context.putImageData(this.image, 0, 0);
};
if (typeof module !== 'undefined' && module.exports) module.exports = Renderer;

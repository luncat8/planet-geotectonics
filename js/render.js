function Renderer(canvas, state) {
	this.canvas = canvas;
	this.context = canvas.getContext('2d');
	this.state = state;
	canvas.width = state.grid.lookupW; canvas.height = state.grid.lookupH;
	this.image = this.context.createImageData(canvas.width, canvas.height);
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
// Plate velocity (m/Myr, 1e4 per cm/yr) scaled so length~6 saturates, matching the 'speed'
// view's 80000 (= 8 cm/yr) ramp.
var DIR_SPEED_UNIT = 80000.0 / 6.0;

// Layer names for the six metallogenic potentials (design §8), read straight off the state.
Renderer.ORE = ['oVms', 'oMaf', 'oArc', 'oOro', 'oBas', 'oPla'];
Renderer.prototype.draw = function (layer) {
	var s = this.state, g = s.grid, data = this.image.data, colors = this.colors;
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
			var d = s.damage[owner], hot = d > Params.splitDamage;
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
		if (layer === 'dir') {
			// Plate motion: direction is hue, speed is lightness. Project the rigid
			// Ω×r velocity onto the local (east, north) tangent so the hue reads as
			// compass direction on the equirectangular map (E green, N blue, W red, S yellow).
			var vx = s.vel[b], vy = s.vel[b + 1], vz = s.vel[b + 2];
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
		var z = s.z[c];
		if (z < 0) {
			var shallow = Math.max(0, 1 + z / 6500);
			colors[b] = 15 + 23 * shallow; colors[b + 1] = 40 + 95 * shallow; colors[b + 2] = 69 + 100 * shallow;
			continue;
		}
		var high = Math.min(1, z / 6500);
		colors[b] = 100 + 145 * high; colors[b + 1] = 156 + 79 * high; colors[b + 2] = 112 + 113 * high;
	}
	for (var y = 0; y < g.lookupH; y++) {
		for (var x = 0; x < g.lookupW; x++) {
			var c = g.lookup[(g.lookupH - 1 - y) * g.lookupW + x], b = c * 3, pixel = (y * g.lookupW + x) * 4;
			data[pixel] = colors[b]; data[pixel + 1] = colors[b + 1]; data[pixel + 2] = colors[b + 2]; data[pixel + 3] = 255;
		}
	}
	this.context.putImageData(this.image, 0, 0);
};
if (typeof module !== 'undefined' && module.exports) module.exports = Renderer;

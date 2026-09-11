// Plate motion view ('dir'): the hue wheel must wrap exactly once - one hue per direction,
// no repeated arcs - and the CPU renderer's tangent projection, speed ramp and HSL->RGB
// wiring must reproduce that wheel pixel for pixel.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Renderer = require('../js/render.js');

// Cardinal anchors: east green, north blue, west red, south yellow.
assert.equal(Renderer.dirHue(1, 0), 120);
assert.equal(Renderer.dirHue(0, 1), 240);
assert.equal(Renderer.dirHue(-1, 0), 0);
assert.equal(Renderer.dirHue(0, -1), 60);

// One wrap: the lifted hue is strictly increasing over a full turn of the direction
// angle and ends exactly one wheel higher. A winding number of 0 (the first cut at this
// view) means every hue names two directions - the r-y-g-b-both-ways artifact.
const N = 4096;
let prev = -Infinity;
for (let i = 0; i < N; i++) {
	const a = (i / N) * 2 * Math.PI;
	let h = Renderer.dirHue(Math.cos(a), Math.sin(a));
	if (i >= N * 0.5) h += 360;
	assert.ok(h > prev, 'hue must strictly increase with direction, i=' + i);
	prev = h;
}
assert.ok(prev < 480.000001, 'exactly one wrap, ended at ' + prev);
// Segment joints and the seam are continuous.
for (const t of [0.25, 0.5, 0.75, 1 - 1e-9]) {
	const a = t * 2 * Math.PI, e = 1e-6;
	const lo = Renderer.dirHue(Math.cos(a - e), Math.sin(a - e));
	const hi = Renderer.dirHue(Math.cos(a + e), Math.sin(a + e));
	const d = Math.min(Math.abs(lo - hi), 360 - Math.abs(lo - hi));
	assert.ok(d < 0.01, 'hue continuous at t=' + t + ', jump ' + d);
}

// The renderer end to end: an independent basis + HSL->RGB must match the drawn pixels.
function hslToRgb(h, s, l) {
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
	const ch = t => {
		if (t < 0) t += 1; if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}
const g = new Grid(5, 7).build();
const s = new State(g, 7);
s.reset(7);
Sim.raster(s);
Sim.advance(s, 0.1, 60);
const canvas = { getContext: () => ({ createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) };
const r = new Renderer(canvas, s);
for (const layer of ['dir', 'speed', 'age', 'force']) {
	r.draw(layer);
	for (const v of r.image.data) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, layer + ' byte out of range');
}
r.draw('dir');
const pixelOf = new Int32Array(g.V).fill(-1);
for (let y = 0; y < g.lookupH; y++)
	for (let x = 0; x < g.lookupW; x++)
		pixelOf[g.lookup[(g.lookupH - 1 - y) * g.lookupW + x]] = (y * g.lookupW + x) * 4;
let checked = 0;
for (let c = 0; c < g.V && checked < 300; c += 3) {
	const b = c * 3, speed = Math.hypot(s.vel[b], s.vel[b + 1], s.vel[b + 2]);
	if (s.owner[c] < 0 || speed < 20000 || pixelOf[c] < 0) continue;
	const px = g.pos[b], py = g.pos[b + 1], pz = g.pos[b + 2];
	const horiz = Math.hypot(px, pz);
	if (horiz < 1e-6) continue;
	const ex = -pz / horiz, ez = px / horiz;
	const nl = Math.sqrt(1 - py * py);
	const nx = -px * py / nl, ny = nl, nz = -pz * py / nl;
	const ve = (s.vel[b] * ex + s.vel[b + 2] * ez) / (80000 / 6);
	const vn = (s.vel[b] * nx + s.vel[b + 1] * ny + s.vel[b + 2] * nz) / (80000 / 6);
	const hue = Renderer.dirHue(ve, vn);
	const lit = 0.05 + 0.65 * Math.pow(Math.min(Math.hypot(ve, vn) / 6, 1), 0.6);
	const want = hslToRgb(hue / 360, 0.9, lit);
	const got = [r.image.data[pixelOf[c]], r.image.data[pixelOf[c] + 1], r.image.data[pixelOf[c] + 2]];
	for (let k = 0; k < 3; k++)
		assert.ok(Math.abs(want[k] - got[k]) <= 2, 'cell ' + c + ' ch' + k + ' want ' + want[k] + ' got ' + got[k]);
	checked++;
}
assert.ok(checked >= 100, 'expected a live multi-plate world, checked ' + checked);
console.log('PASS view-dir: wheel wraps once, anchors E/N/W/S, renderer pixels match, ' + checked + ' cells');

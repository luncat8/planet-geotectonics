// experiments/view-shots.js - renders the plate-motion ('dir') view to PNGs without a
// browser: (1) a rotation-pole pinwheel of the old winding-0 hue map next to the shipped
// one-wrap wheel, (2) the CPU renderer's dir and speed layers of a live world, stacked.
// node experiments/view-shots.js  ->  experiments/logs/0.3-view-dirhue-wheel.png
//                                     experiments/logs/0.3-view-CPU-dir+speed-fixed.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Grid = require('../js/geodesics.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');
const Renderer = require('../js/render.js');

// ---- minimal PNG writer ----
const CRC_T = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
function png(file, w, h, rgb) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	fs.writeFileSync(file, Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
	console.log('wrote ' + file);
}

// ---- HSL -> RGB, same constants as the renderers ----
function hue2rgb(p, q, t) {
	if (t < 0) t += 1; if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}
function hsl(h, s, l) {
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
	return [hue2rgb(p, q, h / 360 + 1 / 3), hue2rgb(p, q, h / 360), hue2rgb(p, q, h / 360 - 1 / 3)];
}
// The first-cut map from the plan: winding number 0, every hue twice.
function oldHue(t) {
	let hue = 120 + 480 * t;
	if (t >= 0.25) hue += 300 - 1200 * t;
	if (t >= 0.5) hue += -240 + 480 * t;
	if (t >= 0.75) hue += -540 + 720 * t;
	return ((hue % 360) + 360) % 360;
}

// ---- 1. pinwheel: rigid rotation about the panel centre, like a plate rotation pole ----
const PW = 512, PH = 512, out = Buffer.alloc(PW * 2 * PH * 3);
for (let y = 0; y < PH; y++) {
	for (let x = 0; x < PW * 2; x++) {
		const cx = (x % PW) - PW / 2, cy = y - PH / 2;
		const rad = Math.hypot(cx, cy);
		let rgb;
		if (rad < 2) rgb = [0, 0, 0];
		else {
			// rigid spin about the panel centre: travel direction is the position angle + 90 deg
			const t = (Math.atan2(-cy, cx) / (2 * Math.PI) + 1.25) % 1;
			rgb = hsl(x < PW ? oldHue(t) : Renderer.dirHue(Math.cos(t * 2 * Math.PI), Math.sin(t * 2 * Math.PI)), 0.9, 0.42);
		}
		const o = (y * PW * 2 + x) * 3;
		out[o] = rgb[0] * 255; out[o + 1] = rgb[1] * 255; out[o + 2] = rgb[2] * 255;
	}
}
// seam label strip: direction rose along the bottom (0..360 deg of travel direction)
for (let x = 0; x < PW * 2; x++) {
	const a = (x % PW) / PW * 2 * Math.PI;
	const rgb = hsl(x < PW ? oldHue((a / (2 * Math.PI)) % 1) : Renderer.dirHue(Math.cos(a), Math.sin(a)), 0.9, 0.4);
	for (let y = PH - 24; y < PH; y++) {
		const o = (y * PW * 2 + x) * 3;
		out[o] = rgb[0] * 255; out[o + 1] = rgb[1] * 255; out[o + 2] = rgb[2] * 255;
	}
}
png(path.join(__dirname, 'logs/0.3-view-dirhue-wheel.png'), PW * 2, PH, out);

// ---- 2. live world, CPU renderer, dir over speed ----
const g = new Grid(5, 7).build();
const s = new State(g, 7);
s.reset(7);
Sim.raster(s);
Sim.advance(s, 0.1, 150);
const canvas = { getContext: () => ({ createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) };
const r = new Renderer(canvas, s);
r.draw('dir');
const dir = Buffer.from(r.image.data.buffer.slice(0));
r.draw('speed');
const spd = Buffer.from(r.image.data.buffer.slice(0));
const W = g.lookupW, H = g.lookupH;
const stack = Buffer.alloc(W * H * 2 * 3);
for (let y = 0; y < H * 2; y++) {
	const src = y < H ? dir : spd, sy = y % H;
	for (let x = 0; x < W; x++) {
		const q = (sy * W + x) * 4, o = (y * W + x) * 3;
		stack[o] = src[q]; stack[o + 1] = src[q + 1]; stack[o + 2] = src[q + 2];
	}
}
png(path.join(__dirname, 'logs/0.3-view-CPU-dir+speed-fixed.png'), W, H * 2, stack);
console.log('t=' + s.t.toFixed(1) + ' Myr, plates ' + s.plateCount + ', meanSpeed ' + (s.meanSpeed / 10000).toFixed(2) + ' cm/yr');

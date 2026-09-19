/* tools/earth/paleo_extract.js - extract equirectangular rasters from PALEOMAP
 * PaleoDEM textures for the 0.4.5 historical checkpoint bake (plan §8).
 *
 * Input: one of the official 1x1-degree Scotese & Wright (2018) Phanerozoic
 * PaleoDEM renderings (1024x512 equirectangular JPEG, CC-BY 4.0, Zenodo
 * 10.5281/zenodo.5460860 - see data/earth/SOURCES.md for provenance). Those
 * textures use the classic PALEOMAP discrete elevation-band palette:
 *
 *   water (b >= g):
 *     pale blue  (~156,204,224)            shelves & epicontinental seas -
 *                                          CONTINENTAL crust, z = -120 m
 *     dark navy  (~8,32,68 / 8,44,88)      deepest basins,  z = -5500 m, old
 *     mid blue   (~28,92,152)              ridge flanks,    z = -3000 m, young
 *     deep blue  (~16,64,120)              abyssal plain,   z = -4500 m, old
 *
 * Band elevations are CLI-overridable (--z-deep/--z-navy/--z-flank/--z-shelf).
 * The 0 Ma re-bake overrides them to -5000/-4200: the texture's implicit sea
 * level is ~3pp drier than the true 70.81% ocean fraction, so imposing the
 * true modern datum on the generic bands would drag the 1deg mean ocean to
 * -4.7 km (true: -3.68 km); the anchored bands land it at ~-4.4 km. Historical
 * packs keep the generic table (no modern ground truth exists to anchor them).
 *   land:
 *     green      (~96,144,80 .. 144,168,96) lowlands, brightness ramp +400..+1400 m
 *     olive      (r ~= g, r >= 140)        uplands                  z = +1800 m
 *     tan/brown  (r > g + 5)               highland                 z = +2600 m
 *     white      (all > 200)               peaks                    z = +3500 m
 *
 * The band assignment is the real data (official reconstruction); the within-band
 * elevation and age values are documented priors (kind bit 4 marks the cell),
 * because the discrete palette cannot be inverted to a raw DEM. The bake's K9
 * consistency pass and datum calibration then make the pack self-consistent:
 * sea level lands exactly where the map draws water.
 *
 * Usage (needs jpeg-js: `npm install jpeg-js` in a scratch dir, or NODE_PATH):
 *   node tools/earth/paleo_extract.js <in.jpg> <out.bin> --deg 1 [--epoch 250]
 *
 * Output bin (little endian):
 *   [w:u16][h:u16][epoch:u16] then [z: i16 x w*h] [age: u8 x w*h] [kind: u8 x w*h]
 *   raster is cell-centred equirectangular (row 0 = south pole, col 0 = 180W),
 *   the same convention as the modern packs. kind bit 0 = continental crust
 *   (exposed land OR submerged pale-blue band, the shelf rule of plan §1.1),
 *   bit 4 = 1 (within-band elevation/age are priors). Age is 255 on continental
 *   cells (the loader pins the 500 Myr baseline via kind bit 0 anyway).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const jpeg = (() => {
	try { return require('jpeg-js'); } catch (e) {
		try { return require(path.join(__dirname, '..', 'node_modules', 'jpeg-js')); }
		catch (e2) {
			console.error('jpeg-js not found - run `npm install jpeg-js` (see header)');
			process.exit(1);
		}
	}
})();

const flag = (name, value) => {
	const eq = process.argv.find(a => a.startsWith('--' + name + '='));
	if (eq !== undefined) return eq.slice(name.length + 3);
	const i = process.argv.indexOf('--' + name);
	if (i !== -1) return process.argv[i + 1];
	return value;
};
const inPath = process.argv[2], outPath = process.argv[3];
if (!inPath || !outPath) { console.error('usage: paleo_extract.js <in.jpg> <out.bin> --deg 1 [--epoch N]'); process.exit(1); }
const DEG = +flag('deg', 1), EPOCH = +flag('epoch', 0);
// Age priors (Myr) for the three oceanic bands: old abyssal floor, deep basins,
// young ridge flanks. Continental age is pinned by kind bit 0 at decode time.
const AGE = { deep: +flag('age-deep', 120), navy: +flag('age-navy', 180), flank: +flag('age-flank', 15) };
// Band elevations (m), generic table by default. The 0 Ma re-bake passes
// --z-deep 4200 --z-navy 5000 to anchor the modern mean ocean (see header).
const Z = { deep: +flag('z-deep', 4500), navy: +flag('z-navy', 5500), flank: +flag('z-flank', 3000), shelf: +flag('z-shelf', 120) };

const img = jpeg.decode(fs.readFileSync(inPath), { useTArray: true });
const W = img.width, H = img.height;
console.log('[*] ' + path.basename(inPath) + ' ' + W + 'x' + H);

// One classification per source pixel: cls 0 = oceanic, 1 = shelf (flooded
// continental), 2 = exposed continental.
const clsPix = new Uint8Array(W * H);
const zPix = new Int32Array(W * H), agePix = new Uint8Array(W * H);
const census = { deep: 0, navy: 0, flank: 0, shelf: 0, land: 0, olive: 0, high: 0, peak: 0, unclass: 0 };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
	const i = (y * W + x) * 4;
	const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
	let cls, z, age;
	if (b >= g) { // water
		if (g >= 150 && b > r + 30) { cls = 1; z = -Z.shelf; age = 255; census.shelf++; }
		else if (r <= 12 && g <= 50) { cls = 0; z = -Z.navy; age = AGE.navy; census.navy++; }
		else if (g > 80) { cls = 0; z = -Z.flank; age = AGE.flank; census.flank++; }
		else { cls = 0; z = -Z.deep; age = AGE.deep; census.deep++; }
	} else if (r > 200 && g > 200 && b > 200) { cls = 2; z = 3500; age = 255; census.peak++; }
	else if (r > g + 5) { cls = 2; z = 2600; age = 255; census.high++; }
	else if (Math.abs(r - g) <= 5 && r >= 140) { cls = 2; z = 1800; age = 255; census.olive++; }
	else if (g > b + 5) { // green lowland ramp, brightness ~ (r+g)
		const t = Math.max(0, Math.min(1, (r + g - 240) / 72));
		cls = 2; z = Math.round(400 + t * 1000); age = 255; census.land++;
	} else { cls = 0; z = -Z.deep; age = AGE.deep; census.unclass++; }
	const p = y * W + x;
	clsPix[p] = cls; zPix[p] = z; agePix[p] = age;
}
const nSrc = W * H;
const pct = k => (100 * census[k] / nSrc).toFixed(2) + '%';
console.log('[*] census: deep ' + pct('deep') + ' navy ' + pct('navy') + ' flank ' + pct('flank')
	+ ' shelf ' + pct('shelf') + ' land ' + pct('land') + ' olive ' + pct('olive')
	+ ' high ' + pct('high') + ' peak ' + pct('peak') + ' unclass ' + pct('unclass'));
if (census.unclass / nSrc > 0.02) {
	console.error('FAIL: >2% of pixels fell out of the palette - unknown render style');
	process.exit(1);
}

// Area-average onto the target equirectangular grid (cell centres, longitude wraps).
const TW = Math.round(360 / DEG), TH = Math.round(180 / DEG);
const zT = new Int32Array(TW * TH), ageT = new Uint8Array(TW * TH), contT = new Uint8Array(TW * TH);
let landCells = 0;
for (let ty = 0; ty < TH; ty++) {
	const latLo = -90 + ty * DEG, latHi = latLo + DEG;
	for (let tx = 0; tx < TW; tx++) {
		const lonLo = -180 + tx * DEG, lonHi = lonLo + DEG;
		const xLo = Math.max(0, Math.floor((lonLo + 180) / (360 / W) - 0.5));
		const xHi = Math.min(W - 1, Math.ceil((lonHi + 180) / (360 / W) - 0.5));
		const yLo = Math.max(0, Math.floor((90 - latHi) / (180 / H) + 0.5));
		const yHi = Math.min(H - 1, Math.ceil((90 - latLo) / (180 / H) - 0.5));
		let nO = 0, nS = 0, nL = 0, sO = 0, sL = 0, aO = 0, aL = 0, nE = 0;
		for (let y = yLo; y <= yHi; y++) for (let x = xLo; x <= xHi; x++) {
			const p = y * W + x;
			nE++;
			if (clsPix[p] === 2) { nL++; sL += zPix[p]; aL += agePix[p]; }
			else if (clsPix[p] === 1) { nS++; sL += zPix[p]; aL += 255; }
			else { nO++; sO += zPix[p]; aO += agePix[p]; }
		}
		const i = ty * TW + tx;
		if (nL + nS >= nE / 2) { // continental crust (exposed or flooded)
			contT[i] = 1;
			if (nL > 0) landCells++;
			zT[i] = Math.round(sL / (nL + nS));
			ageT[i] = 255; // continental: loader pins the 500 Myr baseline
		} else {
			zT[i] = Math.round(sO / Math.max(1, nO));
			ageT[i] = Math.max(0, Math.min(255, Math.round(aO / Math.max(1, nO))));
		}
	}
}
// The datum target: the fraction of the grid the map itself draws as water.
// (Exposed-land cells are dry; everything else - oceanic and shelf cells - is wet.)
const wetTarget = 1 - landCells / (TW * TH);
console.log('[*] ' + TW + 'x' + TH + ' raster: exposed-land fraction '
	+ (100 * (1 - wetTarget)).toFixed(2) + '% -> datum wet target ' + (100 * wetTarget).toFixed(2) + '%');

const buf = Buffer.alloc(6 + TW * TH * 2 + TW * TH + TW * TH);
let o = 0;
buf.writeUInt16LE(TW, o); o += 2;
buf.writeUInt16LE(TH, o); o += 2;
buf.writeUInt16LE(EPOCH, o); o += 2;
for (let i = 0; i < TW * TH; i++) buf.writeInt16LE(zT[i], o + i * 2);
o += TW * TH * 2;
for (let i = 0; i < TW * TH; i++) buf.writeUInt8(ageT[i], o + i); o += TW * TH;
for (let i = 0; i < TW * TH; i++) buf.writeUInt8(contT[i] | 0x10, o + i); // bit 4: prior flag
fs.mkdirSync(path.dirname(outPath) || '.', { recursive: true });
fs.writeFileSync(outPath, buf);
console.log('[+] ' + outPath + ' (' + buf.length + ' bytes)');

// Plate shape at a time point: ASCII plate map + per-plate isoperimetric quotient.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const level = +(process.argv[2] || 5), hot = process.argv[3] === 'hot';
const myr = +(process.argv[4] || 1000);
const g = new Grid(level, 7).build(), s = new State(g, 7, hot);
s.ckptCap = 0;
Sim.raster(s);
Sim.advance(s, 0.1, Math.round(myr / 0.1));
// per-plate area and perimeter
const area = new Map(), perim = new Map();
for (let c = 0; c < g.V; c++) {
	const p = s.cellPlate[c];
	if (p === 65535) continue;
	area.set(p, (area.get(p) || 0) + 1);
	let pe = 0;
	for (let k = 0; k < g.ringN[c]; k++) {
		const j = g.ring[c * 6 + k];
		if (j >= 0 && s.cellPlate[j] !== p) pe++;
	}
	perim.set(p, (perim.get(p) || 0) + pe);
}
const rows = [];
const plates = [...area.keys()];
for (const p of plates) {
	const A = area.get(p), P = perim.get(p);
	rows.push({ p, A, P, iq: +(4 * Math.PI * A / (P * P)).toFixed(2) });
}
rows.sort((a, b) => b.A - a.A);
console.log(`t=${s.t.toFixed(0)} plates=${rows.length} (plate cells area perimeter IQ=1 disc)`);
for (const r of rows) console.log(`  plate ${String(r.p).padStart(3)}: area ${String(r.A).padStart(5)} perim ${String(r.P).padStart(5)} IQ ${r.iq}`);
// ASCII map: sample the lookup at ~72x22
const W = 72, H = 22, chars = 'ABCDEFGHIJKLMNOPQRSTUVWX';
let out = '';
for (let y = 0; y < H; y++) {
	for (let x = 0; x < W; x++) {
		const lx = Math.floor((x + 0.5) * g.lookupW / W), ly = Math.floor((y + 0.5) * g.lookupH / H);
		const c = g.lookup[ly * g.lookupW + lx];
		const p = s.cellPlate[c];
		out += p === 65535 ? '.' : chars[rows.findIndex(r => r.p === p) % chars.length];
	}
	out += '\n';
}
console.log(out);

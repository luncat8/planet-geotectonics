// Plate-count balance: splits vs sutures over 500 Myr, for the map and the hot start.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js'), Sim = require('../js/sim.js');
const Params = require('../js/params.js');
const level = +(process.argv[2] || 4), hot = process.argv[3] === 'hot';
const g = new Grid(level, 7).build(), s = new State(g, 7, hot);
s.ckptCap = 0;
Sim.raster(s);
const out = [];
for (let e = 0; e < 10; e++) {
	Sim.advance(s, 0.1, 500);
	out.push(s.plateCount);
}
const felAbs = Math.abs(s.massFel0 + s.producedFel - s.massFel);
console.log(`kDam ${Params.kDam} splitDamage ${Params.splitDamage} splitAge ${Params.splitAge} minPlateCells ${Params.minPlateCells}`
	+ ` | ${hot ? 'hot' : 'map'} plates/50Myr ${out.join(',')} | splits ${s.splits} merges ${s.merges}`
	+ ` | cols ${s.n} gaps ${s.gaps} finite ${s.finite} felAbs ${felAbs.toExponential(1)}/${s.massFel.toExponential(1)}`);

const { assert, Grid, State } = require('./helpers.js');
const Surface = require('../js/surface.js');
const g = new Grid(2, 7).build();
const s = new State(g, 7);
s.owner.fill(-1); s.alive.fill(0); s.owner[0] = 0; s.alive[0] = 1; s.cell[0] = 0;
function elevation(fel, maf, age, sed) {
	s.hFel[0] = fel; s.hMaf[0] = maf; s.hSed[0] = sed || 0; s.age[0] = age; s.zDyn[0] = 0;
	Surface.elevation(s);
	return s.z[0];
}
const refs = [
	['young ocean', elevation(0, 7000, 0), -2600],
	['old ocean', elevation(0, 7000, 80), -5730],
	['continent', elevation(35000, 0, 500), 400],
	['collision plateau', elevation(70000, 0, 500), 6200],
	['rifted margin', elevation(15000, 7000, 0), -1650]
];
for (const [name, actual, expected] of refs) {
	console.log(name, { actual: Math.round(actual), expected });
	assert.ok(Math.abs(actual - expected) <= 50, name + ': ' + actual);
}
assert.equal(s.wet[0], 1);
s.hFel[0] = 35000; s.hMaf[0] = 0; s.age[0] = 500; s.zDyn[0] = 1000; Surface.elevation(s); assert.equal(s.wet[0], 0);
console.log('PASS isostasy: calibrated ocean, continent, collision and rift elevations');

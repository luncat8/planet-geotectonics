const assert = require('node:assert/strict');
const Grid = require('../js/geodesics.js');
const State = require('../js/state.js');
const Sim = require('../js/sim.js');
function equal(a, b) {
	for (const key of Object.keys(a)) {
		if (ArrayBuffer.isView(a[key])) {
			assert.equal(Buffer.compare(Buffer.from(a[key].buffer), Buffer.from(b[key].buffer)), 0, key);
			continue;
		}
		if (typeof a[key] === 'number') assert.equal(a[key], b[key], key);
	}
}
module.exports = { assert, Grid, State, Sim, equal };

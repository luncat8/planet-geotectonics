const { assert, Grid, State, Sim, equal } = require('./helpers.js');
const grid = new Grid(3, 7).build();
const a = new State(grid, 42), b = new State(grid, 42);
equal(a, b);
for (const dt of [0.01, 0.1]) {
	Sim.advance(a, dt, 500); Sim.advance(b, dt, 500); equal(a, b);
}
a.reset(42); equal(a, new State(grid, 42));
a.reset(43); assert.notDeepEqual(a.omega, b.omega);
assert.throws(() => Sim.step(a, NaN), RangeError);
assert.throws(() => Sim.step(a, 1), RangeError);
console.log('PASS determinism: bit-identical state, reset and dt validation');

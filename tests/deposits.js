const { assert, Grid, State, Sim } = require('./helpers.js');
const Deposits = require('../js/deposits.js');
const Params = require('../js/params.js');

const grid = new Grid(2, 19).build();
const state = new State(grid, 19);
state.ckptCap = 0;
Sim.raster(state);
const cell = 0, owner = 0, body = cell * 3;
state.owner.fill(-1);
state.alive.fill(0);
state.alive[owner] = 1;
state.owner[cell] = owner;
state.cell[owner] = cell;
state.body[body] = grid.pos[cell * 3];
state.body[body + 1] = grid.pos[cell * 3 + 1];
state.body[body + 2] = grid.pos[cell * 3 + 2];
state.world.set(state.body.subarray(0, 3), 0);
state.plate[owner] = 0;
state.hFel[owner] = 35000;
state.hMaf[owner] = 5000;
state.hSed[owner] = 137;
state.age[owner] = 312.4;
state.z[cell] = 480;
state.oArc[owner] = 0.8001;

const anchor = Deposits.anchorKey(state, cell);
assert.deepEqual(anchor, Array.from(state.body.subarray(0, 3), (v) => Math.round(v * 32768)),
	'the physical anchor is quantized in the column frame');
assert.equal(Deposits.idFor(state.seed, 'arc', anchor), Deposits.idFor(state.seed, 'arc', anchor), 'stable id');
assert.notEqual(Deposits.idFor(state.seed, 'arc', anchor), Deposits.idFor(state.seed, 'vms', anchor),
	'class is part of a prospect identity');
assert.equal(Deposits.potential(0.8001), Deposits.potential(0.8005), 'sub-bucket potential drift is suppressed');
assert.equal(Deposits.potential(-1), 0, 'potential clamps below zero');
assert.equal(Deposits.potential(2), 1, 'potential clamps above one');

const first = Deposits.at(state, 'arc', cell);
assert.ok(first, 'a strong local maximum makes one candidate');
assert.equal(first.potential, Deposits.potential(0.8001));
assert.equal(first.host, 'continental');
assert.equal(first.ageMyr, 312);
assert.equal(first.cover % 50, 0, 'cover is quantized to 50 m');
assert.equal(first.top % 50, 0, 'emplacement depth is quantized to 50 m');
assert.equal(first.id, Deposits.at(state, 'arc', cell).id, 'a repeated local query has the same id');

// The stable id is independent of the raster cell and the simulation clock. A rigid plate
// move updates world coordinates, not the body-frame key, so a survey does not reroll.
const neighbor = grid.ring[cell * 6];
state.owner[cell] = -1;
state.owner[neighbor] = owner;
state.cell[owner] = neighbor;
state.world[0] = grid.pos[neighbor * 3];
state.world[1] = grid.pos[neighbor * 3 + 1];
state.world[2] = grid.pos[neighbor * 3 + 2];
state.z[neighbor] = 470;
state.t = 10.2;
state.frame = 102;
const moved = Deposits.at(state, 'arc', neighbor);
assert.ok(moved, 'the prospect follows its owning column');
assert.equal(moved.id, first.id, 'cell and frame do not enter the id');
assert.equal(moved.top, first.top, 'depth is stable while cover is unchanged within a bucket');
assert.equal(moved.epochMyr, 10.2, 'the report carries the current snapshot epoch');
assert.ok(moved.lat !== first.lat || moved.lon !== first.lon, 'the display position follows the moved column');

state.oArc[owner] = 0.2;
assert.equal(Deposits.at(state, 'arc', neighbor), null, 'background is not promoted to a named prospect');
assert.ok(Deposits.blurAt(state, 'arc', neighbor) >= Deposits.TRACE_MIN,
	'a sub-deposit anomaly can still be read without becoming a record');

console.log('PASS deposits: quantized potential, physical anchor identity, stable depth and thresholded local peaks');

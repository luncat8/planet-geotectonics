const { assert, Grid, State, Sim } = require('./helpers.js');
assert.equal(typeof global.gc, 'function', 'Run node --expose-gc tests/alloc.js');
const s = new State(new Grid(5, 7).build(), 7);
// The checkpoint ring is a deliberate retained allocation, not a leak; this test measures leaks.
s.ckptCap = 0;
Sim.advance(s, 0.1, 1000);
global.gc();
const before = process.memoryUsage();
Sim.advance(s, 0.1, 1000);
global.gc();
const after = process.memoryUsage();
const heap = after.heapUsed - before.heapUsed, buffers = after.arrayBuffers - before.arrayBuffers;
assert.ok(heap < 256 * 1024, 'retained heap growth exceeds 256 KiB');
assert.ok(buffers < 64 * 1024, 'retained ArrayBuffer growth exceeds 64 KiB');
console.log('PASS retained-memory smoke test:', { heap, buffers });

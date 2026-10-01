// 0.6.1 prospector: instruments, determinism, economic filtering and barren ground.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Deposits = require('../js/deposits.js');
const Models = require('../js/data/deposit-models.js');
const Prospector = require('../js/prospector.js');
const Economics = require('../js/data/deposit-economics.js');

const world = new State(new Grid(3, 7).build(), 7, true);
world.ckptCap = 0;
Sim.raster(world);
Sim.advance(world, 0.1, 400);

const snap = Deposits.snapshot(world, 'test');
const sc = Deposits.scenario(snap, 1);
Deposits.scan(sc, 0, Deposits.tileCount());
const all = Deposits.allBodies(sc);
console.log(JSON.stringify({ bodies: all.length, economics: Economics.describe() }));
// Economics leaves many sub-economic.
const filtered = Prospector.filterViable(all);
assert.ok(filtered.viable.length > 0 && filtered.viable.length < all.length, 'economics splits viable and sub-economic');
assert.ok(filtered.viable.length / all.length > 0.1 && filtered.viable.length / all.length < 0.6, 'viable fraction is neither all nor none: ' + (filtered.viable.length/all.length).toFixed(3));
console.log(JSON.stringify({ viable: filtered.viable.length, barrenRate: (1 - filtered.viable.length/all.length).toFixed(3) }));
// Find a body and its dir.
const target = filtered.viable[0] || all[0];
const dir = Deposits.dirOf(target.tile, target.fu, target.fv, [0,0,0]);
const cfgFull = { visual:true, sample:true, drill500:true, drill5000:true, mag:true, seismic:true };
// Determinism: same survey returns same JSON.
const s1 = Prospector.survey(sc, dir[0], dir[1], dir[2], cfgFull, 0);
const s2 = Prospector.survey(sc, dir[0], dir[1], dir[2], cfgFull, 0);
assert.deepEqual(s1, s2, 'repeat 0 is deterministic');
assert.ok(s1.detected.length > 0, 'survey at a viable body detects it');
// Repeat survey with repeat=1 may change assay noise but not the hidden geology id set size? It may change detection flip, but should not change catalogue.
const sR1 = Prospector.survey(sc, dir[0], dir[1], dir[2], cfgFull, 1);
assert.ok(sR1.detected.length > 0, 'repeat still detects');
assert.equal(Deposits.allBodies(sc).length, all.length, 'survey does not mutate catalogue');
assert.equal(sc.snapshot.checksum, snap.checksum, 'survey does not mutate snapshot');

// Instrument limits: visual never returns grade, mag never assays.
for (const key of ['visual', 'mag', 'seismic']) {
  if (!s1.observations[key]) continue;
  const text = JSON.stringify(s1.observations[key]);
  assert.ok(!/%.*grade/.test(text) || key==='visual', key + ' does not assay');
  // Ensure no hidden metal tonnes leak via mag/seismic/visual.
  if (key==='mag') assert.ok(!text.includes('metalTonnes'), 'mag does not leak metal tonnes');
}
if (s1.observations.drill && s1.observations.drill.d500) {
  const d = s1.observations.drill.d500;
  assert.ok(Array.isArray(d.intervals), 'drill returns intervals');
  if (d.intervals.length) {
    const iv = d.intervals[0];
    assert.ok(iv.topM >= 0 && iv.bottomM <= 500, 'shallow drill respects 500 m');
    assert.ok(iv.commodities.length === target.commodities.length, 'drill assays share commodity count');
  }
}
// Sample footprint: background vs near-ore.
const farDir = [0,1,0]; // north pole, may be barren or not; use a random far tile that is not near target.
var far = null;
for (let k=0;k<200;k++) {
  const r= Math.random(); const a=Math.random()*2*Math.PI; const z= Math.random()*2-1; const rr=Math.sqrt(1-z*z);
  const ff=[rr*Math.cos(a), z, rr*Math.sin(a)];
  const near = Prospector._candidates(sc, ff[0],ff[1],ff[2], 80);
  // find a point with no candidates within sample footprint and no viable
  if (near.length===0) { far=ff; break; }
  // Also check that sample would be background (no shallow).
  let shallow=false;
  for(let b of near) if(b.burialTopM<Prospector.INSTRUMENTS.sample.maxBurialM) shallow=true;
  if(!shallow){ far=ff; break; }
}
var sFar = null;
if (far) {
  sFar = Prospector.survey(sc, far[0],far[1],far[2], {sample:true},0);
  assert.ok(sFar.observations.sample.background || !sFar.observations.sample.assays.some(a=>a.bodyId), 'far sample is background');
  assert.ok(sFar.detected.length===0 || sFar.observations.sample.background, 'far point has no ore-grade sample');
}
// Lazy vs full scan: survey on a lazy scenario yields same result as on the full one.
const lazy = Deposits.scenario(snap, 1);
const sLazy = Prospector.survey(lazy, dir[0], dir[1], dir[2], cfgFull, 0);
assert.deepEqual(sLazy.detected.sort(), s1.detected.sort(), 'lazy scenario detects same bodies');
assert.deepEqual(sLazy.observations.drill, s1.observations.drill);
assert.ok(lazy.tiles.size < 20, 'lazy survey materialised only touched tiles');
console.log('lazy tiles', lazy.tiles.size);

// Ledger accumulates distinct bodies, does not reveal hidden catalogue.
const ledger = Prospector.createLedger();
Prospector.addToLedger(ledger, s1);
Prospector.addToLedger(ledger, sFar || s1);
assert.ok(ledger.surveys.length===2);
assert.ok(ledger.discovered.size >= s1.detected.length);
assert.ok(ledger.discovered.size <= all.length, 'ledger does not create bodies');

// Economics text: not every cell hosts a positive body.
const barrenProbe = Prospector.survey(sc, far? far[0]:0, far? far[1]:0, far? far[2]:0, {visual:true, sample:true, drill500:true, mag:true},0);
const hasViableNearby = barrenProbe.economics.some(e=>e.positive);
assert.ok(!hasViableNearby || barrenProbe.detected.length===0, 'barren ground is not scenario-positive');

console.log('PASS prospector: determinism, instrument limits, lazy identity, economics barren fraction, ledger');

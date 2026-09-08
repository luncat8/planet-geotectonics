// Phase E events. A prescribed damage corridor splits a plate along the line the mantle is
// pulling apart, and only there: the same corridor with no differential traction does nothing.
// Merging is the mirror image: a slow continental boundary sutures, a fast one does not, and a
// plate too small to be a plate is absorbed by its largest neighbour.
const { assert, Grid, State, Sim } = require('./helpers.js');
const Events = require('../js/events.js');
const Params = require('../js/params.js');
const g = new Grid(4, 7).build();
const R = Params.radius;
const Y = Math.SQRT1_2;      // the corridor sits at 45 N

function world() {
	const s = setup();
	const before = Float64Array.from(s.world);
	return { s, before };
}
function setup() {
	const s = new State(g, 7);
	s.ckptCap = 0;
	s.plateCount = 2;
	s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
	for (let i = 0; i < s.n; i++) {
		s.plate[i] = g.pos[i * 3 + 1] >= 0 ? 0 : 1;
		s.hFel[i] = 35000; s.hMaf[i] = 0; s.age[i] = 500;
		s.damage[i] = 0;
	}
	Sim.raster(s);
	// Damage the columns sitting on the 45 N band: a corridor across the northern plate.
	for (let c = 0; c < g.V; c++) {
		const o = s.owner[c];
		if (o >= 0 && Math.abs(g.pos[c * 3 + 1] - Y) < 0.15) s.damage[o] = 1;
	}
	s.t = 100;                 // past the post-rift cooldown
	return s;
}
// Flow that pushes everything north of the corridor north and everything south of it south:
// each half then fits a different rigid rotation and the corridor opens at 2 W R cos(lat).
function pullApart(s, W) {
	for (let c = 0; c < g.V; c++) {
		const b = c * 3, y = g.pos[b + 1], z = g.pos[b + 2], sign = y > Y ? W : -W;
		s.uMantle[b] = 0; s.uMantle[b + 1] = -sign * z; s.uMantle[b + 2] = sign * y;
	}
}
function maxWorldDrift(s, before) {
	let drift = 0;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i]) continue;
		const b = i * 3;
		drift = Math.max(drift, Math.hypot(s.world[b] - before[b], s.world[b + 1] - before[b + 1], s.world[b + 2] - before[b + 2]));
	}
	return drift;
}

// --- split: the corridor opens -------------------------------------------------------------
{
	const { s, before } = world();
	const north = s.plateCells[0];
	pullApart(s, 25000);           // 2.5 cm/yr per half
	Events.split(s);
	assert.equal(s.plateCount, 3, 'the corridor must cut the plate in two');
	const fresh = 2, q = s.q;
	assert.equal(q[fresh * 4], q[0], 'the child inherits the parent orientation');
	assert.equal(q[fresh * 4 + 1], q[1]);
	assert.equal(q[fresh * 4 + 2], q[2]);
	assert.equal(q[fresh * 4 + 3], q[3]);
	assert.equal(s.omega[fresh * 3], s.omega[0], 'and its angular velocity');
	let cap = 0, lowest = Infinity, corridorDamage = Infinity;
	for (let i = 0; i < s.n; i++) {
		if (!s.alive[i] || s.plate[i] !== fresh) continue;
		cap++;
		lowest = Math.min(lowest, g.pos[s.cell[i] * 3 + 1]);
		if (Math.abs(g.pos[s.cell[i] * 3 + 1] - Y) < 0.15) corridorDamage = Math.min(corridorDamage, s.damage[i]);
	}
	const min = Events.minCells(s);
	assert.ok(cap >= min, 'the polar cap must be a plate of its own: ' + cap + ' < ' + min);
	assert.ok(cap < north, 'the cap is the smaller piece, so it becomes the new plate');
	assert.ok(lowest > Y - 0.3, 'the new plate stays north of the corridor, lowest ' + lowest.toFixed(3));
	assert.ok(corridorDamage <= Params.splitDamage * 0.5 + 1e-12, 'corridor damage stays a weak line');
	assert.ok(maxWorldDrift(s, before) < 1e-9, 'a split must not move any crust');
	console.log('PASS split: corridor opens', { capCells: cap, plateCells: north, minCells: min });
}

// --- no traction, no split -----------------------------------------------------------------
{
	const { s } = world();
	s.uMantle.fill(0);
	s.plumeCount = 0;
	Events.split(s);
	assert.equal(s.plateCount, 2, 'a fossil weak zone the flow is not pulling must not split');
	console.log('PASS split: an unforced corridor stays put');
}

// --- a dead boundary sutures ---------------------------------------------------------------
// Two rigid pieces cannot converge all the way round a closed boundary: the relative rotation
// opens one side as fast as it closes the other. The suturing case is therefore a boundary that
// has stopped moving — every edge transform, and slower than vSuture along all of it.
function convergence(W) {
	const s = new State(g, 7);
	s.ckptCap = 0;
	s.prescribedOmega = 1;
	s.plateCount = 2;
	s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
	for (let i = 0; i < s.n; i++) {
		s.plate[i] = g.pos[i * 3 + 1] >= 0 ? 0 : 1;
		s.hFel[i] = 35000; s.hMaf[i] = 0; s.age[i] = 500;
	}
	s.omega.fill(0);
	s.omega[0] = W; s.omega[3] = -W;   // the equator is their whole shared boundary
	s.uMantle.fill(0); s.plumeCount = 0;
	Sim.raster(s);
	return s;
}
{
	const s = convergence(1500 / (2 * R));    // 1.5 mm/yr: below epsHi, so a dead transform
	Sim.advance(s, 0.1, 300);                 // 30 Myr, past mergeTime
	assert.equal(s.plateCount, 1, 'a dead boundary must suture');
	assert.equal(s.splits, 0);
	assert.ok(s.merges >= 1);
	assert.ok(s.rigidError < 1e-9, 'rigid ' + s.rigidError);
	assert.equal(s.finite, 1);
	console.log('PASS merge: 30 Myr of a dead boundary sutures two plates into one');
}
{
	const s = convergence(40000 / (2 * R));   // 4 cm/yr: ridge on one side, trench on the other
	Sim.advance(s, 0.1, 300);
	assert.equal(s.plateCount, 2, 'an active boundary must stay two plates');
	assert.equal(s.merges, 0);
	console.log('PASS merge: an active boundary keeps both plates');
}

// --- rebasing on merge keeps the crust exactly where it was --------------------------------
{
	const s = new State(g, 7);
	s.ckptCap = 0;
	s.plateCount = 2;
	s.q.fill(0); s.q[3] = 1;
	const half = Math.PI / 12;                // plate 1 is turned 30 degrees about z
	s.q[6] = Math.sin(half); s.q[7] = Math.cos(half);
	for (let i = 0; i < s.n; i++) {
		s.plate[i] = g.pos[i * 3 + 1] >= 0 ? 0 : 1;
		s.hFel[i] = 35000; s.hMaf[i] = 0; s.age[i] = 500;
	}
	Sim.raster(s);
	const before = Float64Array.from(s.world), bodyBefore = Float64Array.from(s.body);
	const was = Uint8Array.from(s.plate);
	assert.equal(Events.merge(s, 1, 0), 1);
	assert.equal(s.plateCount, 2, 'the slot is reclaimed by the next event cycle');
	assert.ok(s.plateDead[1], 'the loser is marked dead');
	assert.ok(maxWorldDrift(s, before) < 1e-9, 'b\' = q_winner^-1 q_loser b must not move crust');
	let moved = 0, kept = 0;
	for (let i = 0; i < s.n; i++) {
		assert.equal(s.plate[i], 0);
		const b = i * 3;
		const shift = Math.hypot(s.body[b] - bodyBefore[b], s.body[b + 1] - bodyBefore[b + 1], s.body[b + 2] - bodyBefore[b + 2]);
		if (shift > 1e-6) moved++; else kept++;
		assert.equal(shift > 1e-6, was[i] === 1, 'only the loser\'s columns change frame');
	}
	assert.ok(moved > 0 && kept > 0, { moved, kept });
	Events.compactPlates(s);
	assert.equal(s.plateCount, 1);
	assert.equal(s.finite, 1);
	console.log('PASS merge: rebasing moves the frame, not the crust', { moved, kept });
}

// --- a plate too small to be a plate is absorbed --------------------------------------------
{
	const s = new State(g, 7);
	s.ckptCap = 0;
	s.prescribedOmega = 1;
	s.plateCount = 2;
	s.q.fill(0); s.q[3] = 1; s.q[7] = 1;
	for (let i = 0; i < s.n; i++) { s.plate[i] = 0; s.hFel[i] = 35000; s.age[i] = 500; }
	for (let i = 0; i < 5; i++) s.plate[i] = 1;      // five columns of a second plate
	const before = Float64Array.from(s.world);
	Sim.raster(s);
	Events.cycle(s);
	assert.equal(s.plateCount, 1, 'the sliver must be absorbed');
	for (let i = 0; i < 5; i++) assert.equal(s.plate[i], 0, 'its columns join the neighbour');
	assert.ok(maxWorldDrift(s, before) < 1e-9, 'absorption must not move crust');
	assert.equal(s.finite, 1);
	console.log('PASS merge: a sliver plate is absorbed by the neighbour it touches most');
}

// --- events are deterministic and leave the ledger alone ------------------------------------
{
	const runs = [];
	for (let pass = 0; pass < 2; pass++) {
		const s = new State(g, 7);
		s.ckptCap = 0;
		Sim.raster(s);
		s.rebase();
		Sim.advance(s, 0.1, 1500);          // 150 Myr with live splits and merges
		runs.push({ s, fel: s.massFel0 + s.producedFel - s.massFel, maf: s.massMaf0 + s.producedMaf - s.subductedMaf - s.massMaf });
	}
	assert.equal(runs[0].s.plateCount, runs[1].s.plateCount);
	assert.equal(runs[0].s.splits, runs[1].s.splits);
	assert.equal(runs[0].s.merges, runs[1].s.merges);
	assert.ok(runs[0].s.splits > 0 && runs[0].s.merges > 0, 'the natural run must split and merge');
	for (const run of runs) {
		assert.equal(run.s.finite, 1);
		assert.ok(Math.abs(run.fel) / run.s.massFel < 1e-9, 'hFel ledger ' + run.fel);
		assert.ok(Math.abs(run.maf) / run.s.massMaf < 1e-9, 'hMaf ledger ' + run.maf);
	}
	console.log('PASS events: deterministic, ledgers exact,',
		{ plates: runs[0].s.plateCount, splits: runs[0].s.splits, merges: runs[0].s.merges });
}

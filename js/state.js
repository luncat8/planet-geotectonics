var StateParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var StateGrid = typeof module !== 'undefined' && module.exports ? require('./geodesics.js') : Grid;
function State(grid, seed) {
	this.grid = grid;
	this.colCap = Math.ceil(grid.V * 1.5);
	this.plateCap = StateParams.plateCap;
	this.body = new Float64Array(this.colCap * 3);
	this.world = new Float64Array(this.colCap * 3);
	this.area = new Float64Array(this.colCap);
	this.hFel = new Float64Array(this.colCap);
	this.hMaf = new Float64Array(this.colCap);
	this.age = new Float64Array(this.colCap);
	this.plate = new Uint16Array(this.colCap);
	this.cell = new Int32Array(this.colCap);
	this.q = new Float64Array(this.plateCap * 4);
	this.omega = new Float64Array(this.plateCap * 3);
	this.seeds = new Float64Array(this.plateCap * 3);
	this.count = new Uint32Array(grid.V);
	this.offset = new Uint32Array(grid.V + 1);
	this.cursor = new Uint32Array(grid.V);
	this.entries = new Uint32Array(this.colCap);
	this.owner = new Int32Array(grid.V);
	this.distance = new Float64Array(grid.V);
	this.z = new Float64Array(grid.V);
	this.climbHistogram = new Uint32Array(32);
	this.reset(seed === undefined ? grid.seed : seed);
}
State.prototype.reset = function (seed) {
	this.seed = seed >>> 0;
	this.t = 0; this.frame = 0; this.n = this.grid.V;
	this.plateCount = Math.min(StateParams.plateCount, this.n);
	this.gaps = 0; this.maxClimb = 0;
	this.body.fill(0); this.world.fill(0); this.area.fill(0);
	this.hFel.fill(0); this.hMaf.fill(0); this.age.fill(0);
	this.plate.fill(0); this.cell.fill(-1); this.q.fill(0); this.omega.fill(0); this.seeds.fill(0);
	this.count.fill(0); this.offset.fill(0); this.cursor.fill(0); this.entries.fill(0);
	this.owner.fill(-1); this.distance.fill(Infinity); this.z.fill(NaN); this.climbHistogram.fill(0);
	var random = StateGrid.mulberry32(this.seed), g = this.grid;
	for (var p = 0; p < this.plateCount; p++) {
		this.q[p * 4 + 3] = 1;
		var y = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
		this.seeds[p * 3] = r * Math.cos(a); this.seeds[p * 3 + 1] = y; this.seeds[p * 3 + 2] = r * Math.sin(a);
		var wy = random() * 2 - 1, wa = random() * Math.PI * 2, wr = Math.sqrt(1 - wy * wy);
		var speed = StateParams.speed / StateParams.radius;
		this.omega[p * 3] = speed * wr * Math.cos(wa);
		this.omega[p * 3 + 1] = speed * wy; this.omega[p * 3 + 2] = speed * wr * Math.sin(wa);
	}
	for (var i = 0; i < this.n; i++) {
		var b = i * 3, best = -Infinity, winner = 0;
		for (var p = 0; p < this.plateCount; p++) {
			var s = p * 3, dot = g.pos[b] * this.seeds[s] + g.pos[b + 1] * this.seeds[s + 1] + g.pos[b + 2] * this.seeds[s + 2];
			if (dot <= best) continue;
			best = dot; winner = p;
		}
		this.plate[i] = winner; this.cell[i] = i; this.area[i] = g.A0[i];
		this.hFel[i] = g.land[i] > 0.5 ? 35000 : 0;
		this.hMaf[i] = this.hFel[i] ? 0 : 7000;
		this.age[i] = this.hFel[i] ? 500 : random() * 120;
	}
	this.body.set(g.pos); this.world.set(g.pos);
};
if (typeof module !== 'undefined' && module.exports) module.exports = State;

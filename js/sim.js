var SimColumns = typeof module !== 'undefined' && module.exports ? require('./columns.js') : Columns;
var SimMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var SimPlates = typeof module !== 'undefined' && module.exports ? require('./plates.js') : Plates;
var SimEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var SimDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var SimParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var Sim = {
	evaluate: function (s, dt, solveFirst) {
		if (!s.fixedOmega) SimMantle.update(s);
		SimColumns.move(s); SimColumns.bin(s); SimColumns.raster(s);
		if (s.fixedOmega) return;
		if (solveFirst) SimPlates.reduce(s, dt);
		SimEdges.classify(s);
		if (!solveFirst) SimPlates.reduce(s, dt);
		SimDiag.check(s);
	},
	raster: function (s) {
		Sim.evaluate(s, SimParams.tauOmega, 1);
	},
	step: function (s, dt) {
		if (!Number.isFinite(dt) || dt < 0.01 || dt > 0.1) throw new RangeError('dt must be 0.01–0.1 Myr');
		SimPlates.integrate(s, dt);
		Sim.evaluate(s, dt, 0);
		s.frame++; s.t += dt;
	},
	advance: function (s, dt, frames) {
		for (var i = 0; i < frames; i++) Sim.step(s, dt);
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sim;

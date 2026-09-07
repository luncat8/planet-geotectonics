var SimQuat = typeof module !== 'undefined' && module.exports ? require('./quat.js') : Quat;
var SimColumns = typeof module !== 'undefined' && module.exports ? require('./columns.js') : Columns;
var Sim = {
	raster: function (s) {
		SimColumns.move(s); SimColumns.bin(s); SimColumns.raster(s);
	},
	step: function (s, dt) {
		if (!Number.isFinite(dt) || dt < 0.01 || dt > 0.1) throw new RangeError('dt must be 0.01–0.1 Myr');
		for (var p = 0; p < s.plateCount; p++) SimQuat.integrate(s.q, p * 4, s.omega, p * 3, dt);
		Sim.raster(s);
		s.frame++; s.t += dt;
	},
	advance: function (s, dt, frames) {
		for (var i = 0; i < frames; i++) Sim.step(s, dt);
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sim;

var SimColumns = typeof module !== 'undefined' && module.exports ? require('./columns.js') : Columns;
var SimMantle = typeof module !== 'undefined' && module.exports ? require('./mantle.js') : Mantle;
var SimPlates = typeof module !== 'undefined' && module.exports ? require('./plates.js') : Plates;
var SimEdges = typeof module !== 'undefined' && module.exports ? require('./edges.js') : Edges;
var SimContact = typeof module !== 'undefined' && module.exports ? require('./contact.js') : Contact;
var SimColumnUpdate = typeof module !== 'undefined' && module.exports ? require('./column-update.js') : ColumnUpdate;
var SimSurface = typeof module !== 'undefined' && module.exports ? require('./surface.js') : Surface;
var SimEvents = typeof module !== 'undefined' && module.exports ? require('./events.js') : Events;
var SimDiag = typeof module !== 'undefined' && module.exports ? require('./diag.js') : Diag;
var SimParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var SimPerf = typeof module !== 'undefined' && module.exports ? require('./perf.js') : Perf;
var Sim = {
	// K0 mantle state, K5 boundaries, K6/K7 contact, K8 columns, K10 force solve, K11 diag.
	// prescribedOmega keeps the caller's ω (tests drive plates analytically) and skips K10.
	physics: function (s, dt, at) {
		var K = SimPerf.K;
		SimMantle.update(s);
		at = SimPerf.lap(K.MANTLE, at);
		SimEdges.classify(s);
		at = SimPerf.lap(K.EDGES, at);
		SimContact.scan(s, dt);
		at = SimPerf.lap(K.CONTACT, at);
		SimContact.apply(s, dt);
		at = SimPerf.lap(K.APPLY, at);
		SimColumnUpdate.step(s, dt);
		at = SimPerf.lap(K.COLUMN, at);
		SimSurface.step(s, dt);
		at = SimPerf.lap(K.SURFACE, at);
		if (!s.prescribedOmega) {
			SimPlates.forces(s);
			at = SimPerf.lap(K.FORCES, at);
			SimPlates.reduce(s, dt);
			at = SimPerf.lap(K.REDUCE, at);
		}
		SimDiag.check(s);
		return SimPerf.lap(K.DIAG, at);
	},
	step: function (s, dt) {
		if (!Number.isFinite(dt) || dt < 0.01 || dt > 0.1) throw new RangeError('dt must be 0.01–0.1 Myr');
		var K = SimPerf.K, start = SimPerf.clock(), at = start;
		// Events run before MOVE/BIN so nothing downstream holds a pre-compaction column index.
		if (s.t - s.lastEvent >= SimParams.eventCadence) {
			SimEvents.cycle(s);
			s.lastEvent = s.t;
			at = SimPerf.lap(K.EVENTS, at);
		}
		SimPlates.integrate(s, dt);
		at = SimPerf.lap(K.INTEGRATE, at);
		SimColumns.move(s);
		at = SimPerf.lap(K.MOVE, at);
		SimColumns.bin(s);
		at = SimPerf.lap(K.BIN, at);
		SimColumns.raster(s);
		at = SimPerf.lap(K.RASTER, at);
		if (!s.fixedOmega) Sim.physics(s, dt, at);
		s.frame++; s.t += dt;
		SimPerf.step(SimPerf.clock() - start);
	},
	// Boot: solve K10 once with dt = τ_ω so the first painted frame already has velocities and
	// boundary types. sim.step then classifies with the integrated ω and reduces for the next one.
	raster: function (s) {
		SimMantle.update(s);
		SimColumns.move(s); SimColumns.bin(s); SimColumns.raster(s);
		SimSurface.elevation(s);
		if (s.fixedOmega) return;
		SimEdges.velocities(s);
		if (!s.prescribedOmega) {
			SimPlates.forces(s);
			SimPlates.reduce(s, SimParams.tauOmega);
		}
		SimEdges.classify(s);
		SimDiag.check(s);
	},
	advance: function (s, dt, frames) {
		for (var i = 0; i < frames; i++) Sim.step(s, dt);
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sim;

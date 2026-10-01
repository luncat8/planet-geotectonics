// Versioned priors of the synthetic deposit catalogue (js/deposits.js, plan 0.6.x).
//
// Every number is a GAME parameter (`status: 'game'`): the orders of magnitude follow the USGS
// grade-tonnage models listed in data/deposits/SOURCES.md, but no distribution has been fitted
// to the published deposit tables yet. Only two correlations are published values: porphyry
// Au grade vs tonnage r = -0.49 (Singer, Mosier & Cox 1986) and kuroko Cu grade vs tonnage
// r = -0.17 (Singer & Mosier 1986). Replacing a family's numbers with a fit changes the
// catalogue, so it bumps `version`. The mafic, basin and placer potentials have no family
// here until their priors and tests exist.
//
// Grades are lognormal about `median` (log-sd `sigmaLn`); tonnage is the ore envelope's total
// mass in tonnes; `tonnageGradeCorr` correlates a grade's normal score with the tonnage's.
// `rockDensity` is t/m3 of the host ore rock, `oreFraction` the share of the ellipsoidal
// envelope that is ore. `axisRatio` = [b/a, c/a] with a along strike, b down dip and c across.
// Burial is the depth of the body's top below the solid surface.
var DepositModels = {
	version: 1,
	tileN: 64,        // cube-sphere tiles per face edge: 24576 tiles of ~145 km, level-independent
	slots: 2,         // candidate bodies per tile and family; acceptance thins them
	maxExtentM: 10000,
	truncationSigma: 2.5,
	potentialFloor: 0.05,
	families: [
		{
			key: 'vms', name: 'volcanic-hosted massive sulphide', potential: 'oVms',
			hosts: ['oceanic', 'continental'],
			maxAccept: 0.25, acceptGamma: 2,
			tonnage: { median: 2e6, sigmaLn: 2, favourGain: 1 },
			commodities: [
				{ id: 'Cu', unit: '%', median: 1.5, sigmaLn: 0.5, tonnageGradeCorr: -0.17 },
				{ id: 'Zn', unit: '%', median: 2, sigmaLn: 0.8, tonnageGradeCorr: 0 }
			],
			rockDensity: 3.8, oreFraction: 0.8, axisRatio: [0.9, 0.1], axisRatioSigmaLn: 0.25,
			burial: { median: 60, sigmaLn: 1 }, dipDeg: [0, 45],
			ageMa: { min: 5, max: 400 }, status: 'game'
		},
		{
			key: 'arc', name: 'porphyry system', potential: 'oArc',
			hosts: ['continental', 'thick continental', 'oceanic'],
			maxAccept: 0.2, acceptGamma: 2,
			tonnage: { median: 1e8, sigmaLn: 1.6, favourGain: 1.5 },
			commodities: [
				{ id: 'Cu', unit: '%', median: 0.45, sigmaLn: 0.35, tonnageGradeCorr: -0.1 },
				{ id: 'Au', unit: 'g/t', median: 0.3, sigmaLn: 0.8, tonnageGradeCorr: -0.49 }
			],
			rockDensity: 2.7, oreFraction: 0.25, axisRatio: [0.9, 1.5], axisRatioSigmaLn: 0.25,
			burial: { median: 400, sigmaLn: 0.8 }, dipDeg: [60, 90],
			ageMa: { min: 2, max: 300 }, status: 'game'
		},
		{
			key: 'orogenic', name: 'orogenic lode system', potential: 'oOro',
			hosts: ['continental', 'thick continental'],
			maxAccept: 0.25, acceptGamma: 2,
			tonnage: { median: 1.5e6, sigmaLn: 1.9, favourGain: 1 },
			commodities: [
				{ id: 'Au', unit: 'g/t', median: 6, sigmaLn: 0.6, tonnageGradeCorr: -0.3 }
			],
			rockDensity: 2.75, oreFraction: 0.3, axisRatio: [0.8, 0.06], axisRatioSigmaLn: 0.3,
			burial: { median: 120, sigmaLn: 1 }, dipDeg: [40, 85],
			ageMa: { min: 20, max: 800 }, status: 'game'
		}
	]
};
if (typeof module !== 'undefined' && module.exports) module.exports = DepositModels;

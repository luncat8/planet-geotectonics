// Monetary scenario for the deposit catalogue (0.6.3; carried over from the alternate
// 0.6.1 branch, re-targeted at the 0.6.1 record of js/deposits.js).
//
// The catalogue's own `viable` flag is a GEOLOGICAL screen: grade against the class
// cutoff, size against the row floor, top against the row's maximum mining depth. That
// screen never mentions a price. This module asks the second, independent question - what
// the record would be worth if it were mined - and it is kept separate so that neither
// screen can hide behind the other. A record can be geologically viable and monetarily
// marginal, and saying so is more useful than collapsing the two.
//
// Every number here is a GAME parameter, not a feasibility study. The prices are orders of
// magnitude anchored to 2026 market levels; they are not a quote and they are not fitted.
// Changing price, recovery, cost or cutoff changes this filter only: it never touches the
// catalogue, a record's identity, or the generator version, because a record is a function
// of (seed, class, anchor) alone. Bumping `version` re-labels the scenario, nothing else.
//
// Cost is method-based, and that is not decoration. A single flat $/t would be wrong by an
// order of magnitude in both directions: a gold dredge moves a tonne of gravel for a few
// dollars while a selective underground stope costs ten times that, so one rate either
// makes every placer uneconomic or every vein free. Each method therefore carries its own
// mining and processing rate, its own depth and water escalation, its own capital and its
// own scale floor.
//
// Call the result scenario-positive, never NPV.
var DepositEconomics = {
	version: 2,
	currency: 'USD',
	year: 2026,

	// USD per tonne of contained metal or commodity. Derivations, so a reviewer can check
	// the arithmetic rather than take it on trust:
	//   Au  $2,000/oz x 32,150.7 oz/t = 64.3 Mt   Ag  $22/oz      = 0.707 Mt
	//   PGE $950/oz (Pt-Pd blend)     = 30.5 Mt   Diamond $150/ct = 0.75 Mt (1 ct = 0.2 g)
	//   Mo  $18/lb x 2,204.6 lb/t     = 39.7 kt   U3O8 $40/lb     = 88.2 kt
	//   K2O $300/t KCl, KCl is 63 % K2O           = 476 t
	//
	// A price is only meaningful against the unit the catalogue counted the commodity in,
	// and `contained` is not uniformly tonnes: `containedOf` folds a `%` grade by 0.01 and a
	// `g/t` grade by 1e-6, both of which land in tonnes, but a `ct/t` grade by 1, which lands
	// in CARATS. Diamond is the one such row. Pricing it per tonne produced a $13 trillion
	// kimberlite, so `pricePer` names the unit each price is quoted in and `screen` refuses
	// a record whose own `gradeUnit` disagrees, rather than printing a number four orders of
	// magnitude out.
	prices: {
		Cu: 9500, Zn: 2800, Pb: 2000, Ni: 16000, Mo: 40000,
		Au: 64300000, Ag: 707000, PGE: 30500000, Diamond: 150,
		U3O8: 88200, K2O: 476, Coal: 90, Fe: 100
	},
	// The unit each price above is quoted in. Everything is per tonne of contained metal
	// except diamond, which the catalogue reports in carats and the market prices per carat.
	pricePer: {
		Cu: 't', Zn: 't', Pb: 't', Ni: 't', Mo: 't', Au: 't', Ag: 't', PGE: 't',
		Diamond: 'ct', U3O8: 't', K2O: 't', Coal: 't', Fe: 't'
	},
	// What a catalogue grade unit implies for the unit of `contained`.
	gradeUnitTo: { '%': 't', 'g/t': 't', 'ct/t': 'ct' },
	// Fraction of contained metal the plant recovers, then the fraction of that which is
	// payable after treatment charges and penalty elements.
	recovery: {
		Cu: 0.88, Zn: 0.82, Pb: 0.80, Ni: 0.85, Mo: 0.88,
		Au: 0.90, Ag: 0.85, PGE: 0.82, Diamond: 0.95,
		U3O8: 0.80, K2O: 0.70, Coal: 0.85, Fe: 0.90
	},
	payability: {
		Cu: 0.96, Zn: 0.95, Pb: 0.95, Ni: 0.94, Mo: 0.96,
		Au: 0.99, Ag: 0.97, PGE: 0.96, Diamond: 0.98,
		U3O8: 0.95, K2O: 0.98, Coal: 0.99, Fe: 0.97
	},
	defaultRecovery: 0.85,
	defaultPayability: 0.95,

	// Costs are USD per tonne of ore envelope rock, so they scale with what has to be moved
	// and milled rather than with the metal in it. `depth` and `water` are per-metre
	// escalations on top: hauling rock out of a deep hole and pumping a wet one are the two
	// things that turn a shallow marginal orebody into an uneconomic deep one. `minOreTonnes`
	// is the scale floor - below it the fixed capital cannot be carried whatever the grade.
	methods: {
		// Bulk open pit: the porphyry and epithermal case, and the default.
		openpit: { mining: 4, processing: 11, depth: 0.008, water: 0.010,
			capexFixed: 250e6, capexPerMt: 6e6, minOreTonnes: 1.5e6 },
		// Selective underground: narrow veins, kimberlite, massive sulfide at depth.
		underground: { mining: 45, processing: 15, depth: 0.020, water: 0.025,
			capexFixed: 300e6, capexPerMt: 8e6, minOreTonnes: 0.3e6 },
		// A dredge or gravel plant: the cheapest tonne there is, and the reason a placer
		// survives at 0.1 g/t at all.
		dredge: { mining: 2.5, processing: 2.5, depth: 0.002, water: 0.004,
			capexFixed: 60e6, capexPerMt: 0.5e6, minOreTonnes: 0.5e6 },
		// Open pit plus a washery.
		bulk: { mining: 12, processing: 6, depth: 0.004, water: 0.010,
			capexFixed: 150e6, capexPerMt: 1e6, minOreTonnes: 5e6 },
		// Open pit plus beneficiation: iron formation.
		beneficiation: { mining: 6, processing: 12, depth: 0.004, water: 0.008,
			capexFixed: 400e6, capexPerMt: 2e6, minOreTonnes: 10e6 },
		// In-situ leach: only the pregnant liquor is processed, so the ore tonne is cheap.
		inSitu: { mining: 6, processing: 8, depth: 0.006, water: 0.012,
			capexFixed: 200e6, capexPerMt: 0.8e6, minOreTonnes: 0.5e6 },
		// Solution or conventional potash.
		potash: { mining: 15, processing: 10, depth: 0.010, water: 0.015,
			capexFixed: 800e6, capexPerMt: 4e6, minOreTonnes: 5e6 }
	},
	defaultMethod: 'openpit',
	// Which method a class is mined by. Keyed `kind/variant`, exactly as the class table
	// names it, so a new row has to declare its own mining method rather than inherit one.
	methodOf: {
		'vms/sulfide': 'underground',
		'mafic/sulfide': 'openpit',
		'mafic/diamond': 'underground',
		'arc/porphyry': 'openpit',
		'arc/epithermal': 'underground',
		'orogenic/vein': 'underground',
		'orogenic/sedhost': 'underground',
		'basin/uranium': 'inSitu',
		'basin/coal': 'bulk',
		'basin/potash': 'potash',
		'placer/gold': 'dredge',
		'iron/bif': 'beneficiation',
		'iron/algoma': 'beneficiation'
	},
	// A commodity with no price is refused rather than silently valued at zero.
	noPrice: 'no priced commodity',
	// A commodity whose catalogue unit does not match the unit its price is quoted in is
	// refused rather than mispriced. This is the guard that would have caught the diamond.
	badUnit: 'price unit does not match the catalogue',

	// The method for a record, falling back to a bulk open pit for any class this table
	// does not know yet. An unknown method is a bug in the table, not in the record.
	method: function (record) {
		var econ = DepositEconomics;
		var name = econ.methodOf[record.kind + '/' + record.variant] || econ.defaultMethod;
		return econ.methods[name] || econ.methods[econ.defaultMethod];
	},
	// `contained` is already metal tonnes per metal, so valuation is a straight sum.
	value: function (record) {
		var econ = DepositEconomics, total = 0, priced = 0, mismatch = null;
		for (var metal in record.contained) {
			var price = econ.prices[metal];
			if (!price) continue;
			// Check the units before multiplying. A bulk commodity (coal) carries no
			// `gradeUnit` entry and is tonnes by construction; anything else declares its
			// own unit on the record and has to agree with the price's.
			var quoted = econ.pricePer[metal] || 't';
			var counted = record.gradeUnit && record.gradeUnit[metal]
				? econ.gradeUnitTo[record.gradeUnit[metal]] : 't';
			if (counted !== quoted) { mismatch = metal; continue; }
			var rec = record.contained[metal]
				* (econ.recovery[metal] || econ.defaultRecovery)
				* (econ.payability[metal] || econ.defaultPayability);
			total += rec * price;
			priced++;
		}
		return { total: total, priced: priced, mismatch: mismatch };
	},
	// The monetary screen. Reads only fields the 0.6.1 record already carries (kind,
	// variant, contained, sizeMt, top, water), so it can never disagree with the catalogue
	// about what the deposit is - only about what it is worth.
	screen: function (record) {
		var econ = DepositEconomics, m = econ.method(record);
		var oreTonnes = (record.sizeMt || 0) * 1e6;
		var capex = m.capexFixed + (oreTonnes / 1e6) * m.capexPerMt;
		if (!(oreTonnes >= m.minOreTonnes)) {
			return {
				value: 0, opex: 0, capex: capex, cost: capex, net: -Infinity,
				positive: false, reason: 'below scale cutoff'
			};
		}
		var valued = econ.value(record);
		if (valued.mismatch || !valued.priced) {
			return {
				value: 0, opex: 0, capex: capex, cost: capex, net: -Infinity,
				positive: false, reason: valued.mismatch ? econ.badUnit : econ.noPrice
			};
		}
		var depthCost = oreTonnes * (record.top || 0) * m.depth;
		var waterCost = oreTonnes * (record.water || 0) * m.water;
		var opex = oreTonnes * (m.mining + m.processing) + depthCost + waterCost;
		var net = valued.total - opex - capex;
		return {
			value: Math.round(valued.total),
			opex: Math.round(opex),
			capex: Math.round(capex),
			cost: Math.round(opex + capex),
			net: Math.round(net),
			positive: net > 0,
			reason: net > 0 ? 'scenario-positive' : 'cost exceeds value'
		};
	},
	// Short money line for a report. Printed in $k/$M/$G so a giant porphyry and a placer
	// read on the same line without a wall of digits.
	money: function (n) {
		var magnitude = Math.abs(n);
		if (magnitude >= 1e9) return (n / 1e9).toFixed(2) + ' G$';
		if (magnitude >= 1e6) return (n / 1e6).toFixed(1) + ' M$';
		if (magnitude >= 1e3) return (n / 1e3).toFixed(0) + ' k$';
		return Math.round(n) + ' $';
	},
	verdict: function (record) {
		var s = DepositEconomics.screen(record);
		return s.positive
			? 'money +' + DepositEconomics.money(s.net)
			: 'money ' + s.reason;
	},
	describe: function () {
		var e = DepositEconomics, m = e.methods[e.defaultMethod];
		return e.currency + ' ' + e.year + ' game prices (Cu $' + e.prices.Cu + '/t, Au $'
			+ (e.prices.Au / 1e6).toFixed(1) + 'M/t, Fe $' + e.prices.Fe + '/t)'
			+ ' · method-based opex (' + Object.keys(e.methods).length + ' methods, open pit $'
			+ (m.mining + m.processing) + '/t ore + $' + m.depth + '/t/m depth)'
			+ ' · capex $' + (m.capexFixed / 1e6).toFixed(0) + 'M + $' + m.capexPerMt + '/Mt'
			+ ' · floor ' + (m.minOreTonnes / 1e6).toFixed(1) + ' Mt ore';
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = DepositEconomics;

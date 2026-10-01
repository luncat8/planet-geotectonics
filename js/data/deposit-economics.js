// Versioned economic scenario for the synthetic deposit catalogue (plan 0.6.x §4).
// All numbers are GAME parameters: they define a plausible screening filter, not a
// feasibility study. Changing price, recovery, cost or cutoff changes the filter,
// never the catalogue or its geological ID. Bumping the scenario version changes
// only the screening, not the generator version.
//
// Prices are USD per tonne of metal (2026). Au price is ~$65M/t = $65k/kg = $2000/oz.
// Recovery and payability are fractions. Costs are USD per tonne of ore envelope rock.
// Depth penalty is USD per tonne per metre of burial below the solid surface; water adds
// a separate penalty per metre of water. Capex is a fixed proxy plus a scale term.
// A body is “scenario-positive” when net > 0 and ore tonnes exceeds the scale cutoff.
// Call it scenario-positive, not commercially proven; never NPV.
var DepositEconomics = {
	version: 1,
	currency: 'USD',
	year: 2026,
	prices: { Cu: 9500, Zn: 2800, Au: 65000000 },
	recovery: { Cu: 0.88, Zn: 0.82, Au: 0.90 },
	payability: { Cu: 0.96, Zn: 0.95, Au: 0.99 },
	miningCostPerTonneOre: 28,
	processingCostPerTonneOre: 16,
	depthCostPerMetrePerTonne: 0.035,
	waterCostPerMetrePerTonne: 0.04,
	capexFixed: 45e6,
	capexPerMtOre: 16e6,
	minOreTonnes: 1.5e6,
	// Depth penalty is applied to burialTopM, water penalty to waterDepthM.
	// Net = Σ(recoverable metal * payability * price) - oreTonnes*(mining+processing+depth*rate+water*rate) - capex
	screen: function (body) {
		var econ = DepositEconomics, ore = body.oreTonnes;
		if (!(ore >= econ.minOreTonnes)) return { value: 0, cost: Infinity, capex: econ.capexFixed, net: -Infinity, positive: false, reason: 'below scale cutoff' };
		var value = 0;
		for (var i = 0; i < body.commodities.length; i++) {
			var m = body.commodities[i], price = econ.prices[m.id];
			if (!price) continue;
			var rec = m.metalTonnes * (econ.recovery[m.id] || 0.85) * (econ.payability[m.id] || 0.96);
			value += rec * price;
		}
		var depthCost = ore * body.burialTopM * econ.depthCostPerMetrePerTonne;
		var waterCost = ore * body.waterDepthM * econ.waterCostPerMetrePerTonne;
		var opex = ore * (econ.miningCostPerTonneOre + econ.processingCostPerTonneOre) + depthCost + waterCost;
		var capex = econ.capexFixed + (ore / 1e6) * econ.capexPerMtOre;
		var net = value - opex - capex;
		return {
			value: Math.round(value),
			opex: Math.round(opex),
			capex: Math.round(capex),
			cost: Math.round(opex + capex),
			net: Math.round(net),
			positive: net > 0,
			reason: net > 0 ? 'scenario-positive' : 'cost exceeds value'
		};
	},
	describe: function () {
		var e = DepositEconomics;
		return e.currency + ' ' + e.year + ' prices Cu $' + e.prices.Cu + '/t Zn $' + e.prices.Zn + '/t Au $' + (e.prices.Au / 1e6).toFixed(1) + 'M/t'
			+ ' · opex $' + (e.miningCostPerTonneOre + e.processingCostPerTonneOre) + '/t ore + $' + e.depthCostPerMetrePerTonne + '/t/m depth'
			+ ' · capex $' + (e.capexFixed / 1e6).toFixed(0) + 'M + $' + (e.capexPerMtOre / 1e6).toFixed(0) + 'M/Mt · cutoff ' + (e.minOreTonnes / 1e6).toFixed(1) + ' Mt';
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = DepositEconomics;

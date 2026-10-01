var ProspectorDeposits = typeof module !== 'undefined' && module.exports ? require('./deposits.js') : Deposits;
var ProspectorModels = typeof module !== 'undefined' && module.exports ? require('./data/deposit-models.js') : DepositModels;
var ProspectorEconomics = typeof module !== 'undefined' && module.exports ? require('./data/deposit-economics.js') : DepositEconomics;
var ProspectorParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
// Prospector 0.6.1: instrument surveys on top of the frozen catalogue.
// A survey is a deterministic observation of the hidden bodies at one surface
// point; it never writes the simulation and never rerolls the catalogue.
// Instrument choice and repeat index are part of the survey key, so the same
// saved survey returns the same result. Repeats improve confidence at a cost
// but cannot be rerolled until a hidden body appears.
//
// Instruments are deliberately limited: visual needs exposure, sampling needs
// shallow ground, drilling needs an intersection, mag/seismic never assay.
var Prospector = {
	INSTRUMENTS: {
		visual: { label: 'Visual / outcrop', footprintM: 40, needsExposure: true },
		sample: { label: 'Surface sample + assay', footprintM: 80, maxBurialM: 60 },
		drill500: { label: 'Drill 500 m', maxM: 500 },
		drill5000: { label: 'Drill 5 km', maxM: 5000 },
		mag: { label: 'Magnetic / EM', footprintM: 50000 },
		seismic: { label: 'Seismic', footprintM: 70000 }
	},
	// Hash a survey draw in [0,1). Keyed by scenario seed+version+snap checksum, anchor
	// tile/fu/fv, instrument ordinal, repeat and draw index. Independent of catalogue RNG.
	_draw: function (sc, tile, fu, fv, instOrd, repeat, drawIdx) {
		var h = ProspectorDeposits.combine(ProspectorDeposits.combine(sc.seed, sc.version), tile);
		// Fu/fv as 24-bit ints so identical stored anchors hash identically to rounded survey anchors.
		var iu = Math.floor(fu * 16777216) & 0xffffff, iv = Math.floor(fv * 16777216) & 0xffffff;
		h = ProspectorDeposits.combine(ProspectorDeposits.combine(h, iu), iv);
		h = ProspectorDeposits.combine(ProspectorDeposits.combine(h, instOrd), repeat);
		// Add snapshot checksum lane so a re-snapshot world is a different survey domain.
		var cs = sc.meta && sc.meta.checksum ? sc.meta.checksum : 'none';
		for (var c = 0; c < 8; c++) h = ProspectorDeposits.combine(h, cs.charCodeAt(c % cs.length) + c * 131);
		return (ProspectorDeposits.combine(h, drawIdx + 1) + 0.5) / 4294967296;
	},
	_truncatedNormalFrom: function (u1, u2) {
		var z = Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
		var lim = ProspectorModels.truncationSigma;
		return Math.max(-lim, Math.min(lim, z));
	},
	// Local host at the survey point (cell nearest the direction).
	_hostAt: function (sc, x, y, z) {
		var cell = ProspectorDeposits.nearestCell(sc.snapshot.grid, x, y, z);
		return {
			cell: cell,
			host: ProspectorDeposits.HOSTS[sc.snapshot.host[cell]],
			alt: sc.snapshot.alt[cell],
			thick: sc.snapshot.thick[cell]
		};
	},
	// Bodies that could be sensed by an instrument at this point: near() with a
	// conservative reach (footprint + max semiaxis) and sorted by id.
	_candidates: function (sc, x, y, z, footprintM) {
		var r = footprintM + ProspectorModels.maxExtentM;
		if (r > ProspectorDeposits.MAX_QUERY_M) r = ProspectorDeposits.MAX_QUERY_M;
		return ProspectorDeposits.near(sc, x, y, z, r);
	},
	survey: function (sc, x, y, z, config, repeat) {
		if (!sc || !sc.snapshot) throw new Error('survey needs a snapshot scenario');
		repeat = repeat | 0;
		var len = Math.hypot(x, y, z); x /= len; y /= len; z /= len;
		var hostInfo = Prospector._hostAt(sc, x, y, z);
		var waterDepthM = Math.max(0, -hostInfo.alt), surfaceAltM = hostInfo.alt;
		var dir = [x, y, z], tile = ProspectorDeposits.tileOf(x, y, z);
		// fu/fv of the survey point within its tile, for hashing.
		var uv = ProspectorDeposits.scratchUv, fu, fv;
		ProspectorDeposits.faceCoords(ProspectorDeposits.faceOf(x, y, z), x, y, z, uv);
		var n = ProspectorModels.tileN, fi = tile % n, fj = Math.floor(tile / n) % n;
		// invert faceCoords to fu/fv: uv in [-1,1), fu = frac((uv+1)/2*n) etc. Recompute via nearest.
		// Simpler: compute fu/fv by sampling dirOf inverse: we have dir, tile, we can derive fu/fv
		// as the fractional tile coordinate of the point.
		// Use dirOf helper: search fu/fv by linearising; instead approximate via face local.
		// For determinism we store the ideal fu/fv as quantized 6dp fractions derived from tile.
		// Use tile centre as fallback when inversion is messy: hash with tile centre fu=0.5.
		// To keep per-point uniqueness, hash tile + a quantized lat/lon of the point.
		var latQ = Math.round(Math.asin(y) * 1e6), lonQ = Math.round(Math.atan2(z, x) * 1e6);
		// fu/fv for body-anchor comparison: we treat survey as point, so east/north offsets are via offsetFrom.
		// For hashing, combine quantized lat/lon.
		var tileForHash = tile ^ (latQ & 0xffff) ^ ((lonQ & 0xffff) << 7);
		var out = {
			anchor: { x: x, y: y, z: z, tile: tile, lat: +(Math.asin(y) * 180 / Math.PI).toFixed(4), lon: +(Math.atan2(z, x) * 180 / Math.PI).toFixed(4),
				cell: hostInfo.cell, host: hostInfo.host, waterDepthM: ProspectorDeposits.round(waterDepthM), surfaceAltM: ProspectorDeposits.round(surfaceAltM),
				crustThicknessM: ProspectorDeposits.round(hostInfo.thick) },
			repeat: repeat,
			config: Object.assign({}, config),
			waterCover: waterDepthM > 1,
			observations: {},
			detected: [],
			truth: null // filled only when reveal=true variant is asked; not part of normal observation
		};
		// Visual / outcrop -----------------------------------------------------
		if (config.visual) {
			var vis = { lithology: hostInfo.host, waterDepthM: out.anchor.waterDepthM, exposure: waterDepthM <= 1 ? 'exposed' : 'submerged', indicators: [] };
			if (waterDepthM <= 1) {
				var cands = Prospector._candidates(sc, x, y, z, Prospector.INSTRUMENTS.visual.footprintM);
				for (var i = 0; i < cands.length; i++) {
					var b = cands[i], off = [0, 0];
					ProspectorDeposits.offsetFrom(b, x, y, z, off);
					var horiz = Math.hypot(off[0], off[1]);
					if (b.burialTopM < 8 && horiz < 50) {
						// Deterministic gossan draw: not every shallow body shows colour.
						var show = Prospector._draw(sc, tileForHash, 0.5, 0.5, 0, repeat, i * 7) < 0.55;
						if (show) vis.indicators.push({ bodyId: b.id, family: b.family, note: 'iron staining / colour anomaly', confidence: 'low' });
					}
					if (b.burialTopM < 2 && horiz < 25) {
						vis.indicators.push({ bodyId: b.id, family: b.family, note: 'outcropping ore', confidence: 'high' });
					}
				}
				if (!vis.indicators.length) vis.indicators.push({ note: 'no visible mineral indicators at surface', confidence: 'observation' });
			} else {
				vis.indicators.push({ note: 'submerged: outcrop not visible', confidence: 'observation' });
				vis.lithology += ' (water cover ' + Math.round(waterDepthM) + ' m)';
			}
			out.observations.visual = vis;
		}
		// Surface sampling + assay --------------------------------------------
		if (config.sample) {
			var samp = { assays: [], background: true, note: '' };
			if (waterDepthM > 1) {
				samp.note = 'submerged: surface sampling not accessible; use drilling or marine survey';
			} else {
				var candsS = Prospector._candidates(sc, x, y, z, Prospector.INSTRUMENTS.sample.footprintM);
				var best = null, bestDist = Infinity;
				for (var s = 0; s < candsS.length; s++) {
					var sb = candsS[s];
					if (sb.burialTopM > Prospector.INSTRUMENTS.sample.maxBurialM) continue;
					var so = [0, 0]; ProspectorDeposits.offsetFrom(sb, x, y, z, so);
					var sd = Math.hypot(so[0], so[1]);
					if (sd < 80 && sd < bestDist) { best = sb; bestDist = sd; }
				}
				if (best) {
					samp.background = false;
					for (var ci = 0; ci < best.commodities.length; ci++) {
						var cm = best.commodities[ci];
						// Noisy assay: lognormal 18% sigma, keyed per commodity.
						var u1 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 1, repeat, ci * 2), u2 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 1, repeat, ci * 2 + 1);
						var zScore = Prospector._truncatedNormalFrom(u1, u2);
						var sigma = 0.18;
						var observed = cm.grade * Math.exp(sigma * zScore);
						// Heuristic uncertainty: ±35% at 95%
						var lo = observed * 0.65, hi = observed * 1.35;
						samp.assays.push({ id: cm.id, unit: cm.unit, grade: ProspectorDeposits.round(observed), lo: ProspectorDeposits.round(lo), hi: ProspectorDeposits.round(hi), bodyId: best.id, family: best.family });
					}
					samp.note = 'surface chip of weathered outcrop near ' + best.id + ' at ' + Math.round(bestDist) + ' m; local support, not whole-body tonnage';
					out.detected.push(best.id);
				} else {
					// Background: deterministic low grade based on potential, not deposit grade.
					var potIdx = ProspectorDeposits.HOSTS.indexOf(hostInfo.host); // not used; use potential mean
					var uBg = Prospector._draw(sc, tileForHash, 0.5, 0.5, 1, repeat, 99);
					// small background ppm/%: e.g., Cu 0.01-0.04%, Au 0.01-0.05 g/t
					var bgCu = 0.008 + uBg * 0.03, bgAu = 0.005 + Prospector._draw(sc, tileForHash, 0.5, 0.5, 1, repeat, 100) * 0.05;
					samp.assays.push({ id: 'Cu', unit: '%', grade: ProspectorDeposits.round(bgCu), lo: ProspectorDeposits.round(bgCu * 0.6), hi: ProspectorDeposits.round(bgCu * 1.4), note: 'background' });
					samp.assays.push({ id: 'Au', unit: 'g/t', grade: ProspectorDeposits.round(bgAu), lo: ProspectorDeposits.round(bgAu * 0.5), hi: ProspectorDeposits.round(bgAu * 1.5), note: 'background' });
					samp.note = 'no ore-grade surface anomaly; background lithogeochemistry';
				}
			}
			out.observations.sample = samp;
		}
		// Drills ----------------------------------------------------------------
		var drillOut = null;
		if (config.drill500 || config.drill5000) {
			drillOut = {};
			var maxFor = function (key) { return Prospector.INSTRUMENTS[key].maxM; };
			var doDrill = function (key, outKey) {
				var maxM = maxFor(key);
				var intervals = [], hitIds = [];
				var hostLog = [];
				// Host intervals: simplified - one sediment/felsic/mafic stack before basement? Use snapshot thick for total, but split crudely 10% sediment if host sediment, else felsic/mafic.
				// Keep honest: we don't have stratigraphy, so report simplified host with gap handling.
				var candsD = Prospector._candidates(sc, x, y, z, 30); // tight: drill needs direct hit
				// Add water column as first interval when submerged.
				if (waterDepthM > 1) hostLog.push({ topM: 0, bottomM: ProspectorDeposits.round(waterDepthM), lith: 'water', note: 'water column, not drilled rock' });
				var rockTop = waterDepthM;
				for (var di = 0; di < candsD.length; di++) {
					var db = candsD[di], offD = [0, 0];
					ProspectorDeposits.offsetFrom(db, x, y, z, offD);
					var iv = [0, 0];
					if (!ProspectorDeposits.verticalIntersection(db, offD[0], offD[1], iv)) continue;
					if (iv[0] >= maxM) continue; // entirely deeper than hole
					var top = Math.max(0, iv[0]), bottom = Math.min(maxM, iv[1]);
					if (bottom <= top + 0.5) continue;
					// Grade uncertainty: drill core assay is better than surface.
					var commodities = [];
					for (var cc = 0; cc < db.commodities.length; cc++) {
						var dcm = db.commodities[cc];
						var uu1 = Prospector._draw(sc, tileForHash, 0.5, 0.5, key === 'drill500' ? 2 : 3, repeat, di * 4 + cc * 2);
						var uu2 = Prospector._draw(sc, tileForHash, 0.5, 0.5, key === 'drill500' ? 2 : 3, repeat, di * 4 + cc * 2 + 1);
						var zz = Prospector._truncatedNormalFrom(uu1, uu2);
						var sig = 0.10;
						var obsGrade = dcm.grade * Math.exp(sig * zz);
						commodities.push({ id: dcm.id, unit: dcm.unit, grade: ProspectorDeposits.round(obsGrade), trueGrade: dcm.grade, bodyId: db.id });
					}
					intervals.push({ topM: ProspectorDeposits.round(top), bottomM: ProspectorDeposits.round(bottom), lengthM: ProspectorDeposits.round(bottom - top), bodyId: db.id, family: db.family, commodities: commodities });
					hitIds.push(db.id);
				}
				intervals.sort(function (a, b) { return a.topM - b.topM; });
				// Host rock intervals: fill gaps between ore intervals up to maxM.
				var cursor = 0;
				for (var ii = 0; ii < intervals.length; ii++) {
					var it = intervals[ii];
					if (it.topM > cursor + 0.5) hostLog.push({ topM: ProspectorDeposits.round(cursor), bottomM: ProspectorDeposits.round(it.topM), lith: hostInfo.host === 'sediment' ? 'sediment' : hostInfo.host === 'oceanic' ? 'basalt' : 'felsic/mafic', note: 'host rock' });
					hostLog.push({ topM: it.topM, bottomM: it.bottomM, lith: 'ore: ' + it.family, ore: true, bodyId: it.bodyId, commodities: it.commodities });
					cursor = it.bottomM;
				}
				if (cursor < maxM - 0.5) hostLog.push({ topM: ProspectorDeposits.round(cursor), bottomM: ProspectorDeposits.round(maxM), lith: hostInfo.host === 'sediment' ? 'sediment' : hostInfo.host === 'oceanic' ? 'basalt' : 'felsic/mafic', note: 'host rock to TD' });
				// Beyond host? Actually crustThicknessM is total crust; maxM may exceed it for deep drill: mark unknown.
				// Find where we exceed crust.
				var crust = hostInfo.thick;
				for (var hh = 0; hh < hostLog.length; hh++) {
					if (hostLog[hh].topM >= crust) hostLog[hh].note = (hostLog[hh].note || '') + ' · below crust (unknown)';
				}
				drillOut[outKey] = { maxM: maxM, intervals: intervals, hostLog: hostLog, hits: hitIds, note: intervals.length ? 'ore interval(s) cut by vertical hole through solid surface' : 'no ore intersection within drilled rock length' };
				for (var hi = 0; hi < hitIds.length; hi++) if (out.detected.indexOf(hitIds[hi]) < 0) out.detected.push(hitIds[hi]);
			};
			if (config.drill500) doDrill('drill500', 'd500');
			if (config.drill5000) doDrill('drill5000', 'd5000');
			out.observations.drill = drillOut;
		}
		// Magnetic / EM ---------------------------------------------------------
		if (config.mag) {
			var mag = { anomalies: [], note: '' };
			var candsM = Prospector._candidates(sc, x, y, z, Prospector.INSTRUMENTS.mag.footprintM);
			var considered = 0;
			for (var mi = 0; mi < candsM.length; mi++) {
				var mb = candsM[mi];
				var mo = [0, 0]; ProspectorDeposits.offsetFrom(mb, x, y, z, mo);
				var mdist = Math.hypot(mo[0], mo[1]);
				if (mdist > Prospector.INSTRUMENTS.mag.footprintM + Math.max(mb.axesM[0], mb.axesM[1])) continue;
				// Host-dependent sensitivity: mafic/VMS stronger, orogenic weaker.
				var hostFactor = (mb.host === 'oceanic' ? 0.9 : mb.host === 'continental' ? 0.7 : 0.6);
				var famFactor = mb.family === 'vms' ? 1.2 : mb.family === 'arc' ? 1.0 : 0.5;
				var vol = ProspectorDeposits.volumeOf(mb.axesM);
				var strength = Math.log10(vol + 1) * famFactor * hostFactor * Math.exp(-mb.burialTopM / 900) * Math.exp(-mdist / 50000);
				// Honest detection: shallow large bodies give strong anomalies; deep or distant
				// are weak. Threshold is deterministic with a little noise, but a body in the
				// footprint is usually seen (game needs discoverability). Weak bodies may be
				// missed; see the FP path below.
				var uDet = Prospector._draw(sc, tileForHash, 0.5, 0.5, 4, repeat, mi * 3);
				var pDetect = Math.min(0.92, strength / 3.2);
				var detected = strength > 1.1 || (strength > 0.6 && uDet < pDetect);
				if (detected) {
					var cls = strength > 3.2 ? 'strong' : strength > 1.6 ? 'moderate' : 'weak';
					var conf = cls === 'strong' ? 'high' : cls === 'moderate' ? 'medium' : 'low';
					mag.anomalies.push({ bodyId: mb.id, horizontalM: Math.round(mdist), burialM: Math.round(mb.burialTopM), strength: +strength.toFixed(2), class: cls, confidence: conf, note: 'magnetic/EM anomaly, host-dependent, non-unique' });
					if (out.detected.indexOf(mb.id) < 0) out.detected.push(mb.id);
					considered++;
				}
			}
			// Add occasional false positive when no body nearby, with small prob.
			if (!mag.anomalies.length) {
				var uFP = Prospector._draw(sc, tileForHash, 0.5, 0.5, 4, repeat, 997);
				if (uFP < 0.06) mag.anomalies.push({ class: 'weak', confidence: 'low', strength: +(0.8 + uFP * 2).toFixed(2), note: 'weak anomaly, likely non-ore source or cultural noise', falsePositive: true });
			}
			if (!mag.anomalies.length) mag.note = 'no magnetic/EM anomaly within footprint; not detected ≠ absent';
			else mag.note = mag.anomalies.length + ' anomaly(ies) within ' + Prospector.INSTRUMENTS.mag.footprintM + ' m footprint; does not directly measure elemental concentration';
			out.observations.mag = mag;
		}
		if (config.seismic) {
			var sei = { interfaces: [], note: '' };
			// Interpreted depth to basement / crust interfaces with uncertainty.
			var uS1 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 1), uS2 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 2);
			var zS = Prospector._truncatedNormalFrom(uS1, uS2);
			var crust = hostInfo.thick;
			var interpretedMoho = crust * (1 + 0.08 * zS);
			var unc = Math.round(crust * 0.12);
			sei.interfaces.push({ name: 'Moho / crust base', depthM: ProspectorDeposits.round(interpretedMoho), uncertaintyM: unc, note: 'interpreted from seismic velocities, not an assay' });
			// Sediment-basement when sediment host.
			if (hostInfo.host === 'sediment') {
				var uS3 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 3), uS4 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 4);
				var zzS = Prospector._truncatedNormalFrom(uS3, uS4);
				var sed = ProspectorDeposits.round(900 + 400 * zzS);
				if (sed < 100) sed = 100;
				sei.interfaces.push({ name: 'Sediment-basement', depthM: sed, uncertaintyM: Math.round(sed * 0.2), note: 'velocity contrast' });
			}
			// Deposit reflector: if a body is nearby, sometimes shows as bright reflector, but not guaranteed.
			var candsSei = Prospector._candidates(sc, x, y, z, Prospector.INSTRUMENTS.seismic.footprintM);
			for (var si = 0; si < candsSei.length; si++) {
				var sb2 = candsSei[si];
				var so2 = [0, 0]; ProspectorDeposits.offsetFrom(sb2, x, y, z, so2);
				if (Math.hypot(so2[0], so2[1]) > 400) continue;
				var uRefl = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 10 + si);
				if (uRefl < 0.35) {
					var uD1 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 20 + si * 2), uD2 = Prospector._draw(sc, tileForHash, 0.5, 0.5, 5, repeat, 20 + si * 2 + 1);
					var zD = Prospector._truncatedNormalFrom(uD1, uD2);
					var dep = sb2.burialTopM + ProspectorDeposits.verticalHalfExtent(sb2.axesM, ProspectorDeposits.axisUnits(sb2.strikeDeg, sb2.dipDeg, ProspectorDeposits.scratchUnits));
					var obsDepth = dep * (1 + 0.10 * zD);
					sei.interfaces.push({ name: 'bright reflector (possible ore lens)', depthM: ProspectorDeposits.round(obsDepth), uncertaintyM: Math.round(obsDepth * 0.15), bodyId: sb2.id, note: 'non-unique, host-dependent' });
				}
			}
			sei.note = 'seismic images structure, not composition; depth carries ±10-20% uncertainty';
			out.observations.seismic = sei;
		}
		// Economics for detected bodies (scenario-positive flag)
		out.economics = [];
		for (var di2 = 0; di2 < out.detected.length; di2++) {
			var id = out.detected[di2];
			// find body
			var allNear = Prospector._candidates(sc, x, y, z, 1000);
			for (var a = 0; a < allNear.length; a++) if (allNear[a].id === id) {
				var ev = ProspectorEconomics.screen(allNear[a]);
				out.economics.push({ id: id, family: allNear[a].family, oreTonnes: allNear[a].oreTonnes, positive: ev.positive, net: ev.net, value: ev.value, cost: ev.cost });
				break;
			}
		}
		return out;
	},
	// Whole-world filter for economically viable bodies (map export).
	filterViable: function (bodies) {
		var viable = [], barren = [];
		for (var i = 0; i < bodies.length; i++) {
			var ev = ProspectorEconomics.screen(bodies[i]);
			if (ev.positive) viable.push(bodies[i]); else barren.push(bodies[i]);
		}
		return { viable: viable, barren: barren, economics: ProspectorEconomics };
	},
	// Deterministic ledger: surveys accumulate discover knowledge; the ledger
	// itself does not reveal hidden fields.
	createLedger: function () {
		return { surveys: [], discovered: new Set(), byId: new Map() };
	},
	addToLedger: function (ledger, survey) {
		ledger.surveys.push(survey);
		for (var i = 0; i < survey.detected.length; i++) {
			var id = survey.detected[i];
			if (!ledger.discovered.has(id)) {
				ledger.discovered.add(id);
				// keep earliest detection reference
				ledger.byId.set(id, survey);
			}
		}
	},
	// Text summaries for UI -------------------------------------------------
	formatSample: function (samp) {
		if (!samp) return '';
		if (samp.note && samp.background) return samp.note + ' · ' + samp.assays.map(function (a) { return a.id + ' ' + a.grade + a.unit + ' (bg)'; }).join(', ');
		if (!samp.assays.length) return samp.note;
		return samp.assays.map(function (a) { return a.id + ' ' + a.grade + a.unit + ' [' + a.lo + '-' + a.hi + ']'; }).join(', ') + ' · ' + samp.note;
	},
	formatDrill: function (d) {
		if (!d) return 'no drilling';
		var lines = [];
		if (d.intervals.length) {
			for (var i = 0; i < d.intervals.length; i++) {
				var it = d.intervals[i];
				var g = it.commodities.map(function (c) { return c.id + ' ' + c.grade + c.unit; }).join(', ');
				lines.push('  ' + it.topM + '-' + it.bottomM + ' m (' + it.lengthM + ' m) ' + it.bodyId + ' ' + g);
			}
		} else lines.push('  ' + d.note);
		return lines.join('\n');
	},
	formatMag: function (m) {
		if (!m) return '';
		if (!m.anomalies.length) return m.note;
		return m.anomalies.map(function (a) { return (a.bodyId || 'FP') + ' ' + a.class + ' (' + a.confidence + ') str ' + a.strength + ' at ' + (a.horizontalM || '?') + ' m'; }).join(', ') + ' · ' + m.note;
	},
	formatSurvey: function (survey, reveal) {
		var lines = [];
		lines.push('Survey at ' + survey.anchor.lat + ', ' + survey.anchor.lon + ' (cell ' + survey.anchor.cell + ' ' + survey.anchor.host + ') water ' + Math.round(survey.anchor.waterDepthM) + ' m');
		if (survey.observations.visual) lines.push('Visual: ' + survey.anchor.host + ' · ' + survey.observations.visual.indicators.map(function (x) { return x.note; }).join('; '));
		if (survey.observations.sample) lines.push('Sample: ' + Prospector.formatSample(survey.observations.sample));
		if (survey.observations.drill) {
			if (survey.observations.drill.d500) lines.push('Drill 500 m:\n' + Prospector.formatDrill(survey.observations.drill.d500));
			if (survey.observations.drill.d5000) lines.push('Drill 5000 m:\n' + Prospector.formatDrill(survey.observations.drill.d5000));
		}
		if (survey.observations.mag) lines.push('Mag/EM: ' + Prospector.formatMag(survey.observations.mag));
		if (survey.observations.seismic) lines.push('Seismic: ' + survey.observations.seismic.interfaces.map(function (s) { return s.name + ' ' + s.depthM + '±' + s.uncertaintyM + ' m'; }).join('; ') + ' · ' + survey.observations.seismic.note);
		if (survey.detected.length) {
			lines.push('Detected bodies: ' + survey.detected.join(', '));
			if (survey.economics.length) {
				for (var i = 0; i < survey.economics.length; i++) {
					var e = survey.economics[i];
					lines.push('  ' + e.id + ' ' + (e.positive ? 'scenario-POSITIVE' : 'sub-economic') + ' net $' + (e.net / 1e6).toFixed(1) + 'M (value $' + (e.value / 1e6).toFixed(1) + 'M cost $' + (e.cost / 1e6).toFixed(1) + 'M) ' + (e.oreTonnes / 1e6).toFixed(2) + ' Mt');
				}
			}
		} else lines.push('Detected: none within instrument support (not detected ≠ absent)');
		if (reveal && survey.truth) lines.push('Ground truth (debug): ' + survey.truth.map(function (b) { return b.id + ' ' + b.family + ' ' + (b.oreTonnes / 1e6).toFixed(2) + 'Mt ' + b.commodities.map(function (c) { return c.id + ' ' + c.grade + c.unit; }).join(', ') + ' burial ' + Math.round(b.burialTopM) + 'm'; }).join(' | '));
		return lines.join('\n');
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Prospector;

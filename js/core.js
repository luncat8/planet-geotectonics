var CoreParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var CoreDeposits = typeof module !== 'undefined' && module.exports ? require('./deposits.js') : Deposits;
var Core = (function () {
	var DEPTH_BUCKET = 50, WATER_BUCKET = 10, MAX_BEDS = 12;
	var ORE_LABEL = {
		'arc/porphyry': 'PORPHYRY STOCKWORK',
		'arc/epithermal': 'QUARTZ LODE',
		'vms/sulfide': 'MASSIVE SULFIDE LENS',
		'mafic/sulfide': 'SILL, DISSEMINATED SULFIDE',
		'orogenic/vein': 'QUARTZ LODE',
		'orogenic/sedhost': 'SEDIMENT-HOSTED GOLD',
		'basin/uranium': 'U-BEARING SANDSTONE',
		'basin/coal': 'COAL SEAM',
		'basin/potash': 'POTASH EVAPORITE',
		'placer/gold': 'PLACER PAY STREAK',
		'iron/bif': 'BIF',
		'iron/algoma': 'IRON FORMATION'
	};

	function hash(seed, key, salt) {
		var mixed = (seed ^ Math.imul(salt + 1, 0x27d4eb2f)) >>> 0;
		return CoreDeposits.hash32(mixed, CoreDeposits.IRON, key);
	}
	function unit(seed, key, salt) {
		return hash(seed, key, salt) / 4294967296;
	}
	function bucket(value, size) {
		return Math.max(0, Math.round(value / size) * size);
	}
	function countText(value) {
		var digits = String(Math.round(value)), out = '';
		while (digits.length > 3) {
			out = ',' + digits.slice(-3) + out;
			digits = digits.slice(0, -3);
		}
		return digits + out;
	}
	function clamp(value, lo, hi) {
		return Math.max(lo, Math.min(hi, value));
	}
	function addLayer(out, top, bottom, lithology, detail) {
		if (bottom < top) return;
		out.push({
			top: top,
			bottom: bottom,
			thickness: bottom - top,
			lithology: lithology,
			detail: detail || '',
			ore: false
		});
	}
	function lithologyFor(seed, key, salt, wet, latitude) {
		var roll = unit(seed, key, salt);
		if (wet && Math.abs(latitude) < 40 * Math.PI / 180 && roll < 0.16) return ['evaporite', 'gypsum and halite'];
		if (roll < 0.25) return ['sandstone', 'quartz-rich, cross-bedded'];
		if (roll < 0.58) return ['siltstone', 'laminated silt, plant debris'];
		if (roll < 0.82) return ['shale', 'clay-rich, laminated'];
		return ['marl', 'carbonate and clay'];
	}
	function bedSizes(total, count, seed, key) {
		var sizes = [], used = 0;
		for (var i = 0; i < count - 1; i++) {
			var remainingBeds = count - i - 1;
			var remaining = total - used;
			var target = total / count * (0.7 + 0.6 * unit(seed, key, 10 + i));
			var size = clamp(Math.round(target), 1, remaining - remainingBeds);
			sizes.push(size);
			used += size;
		}
		sizes.push(total - used);
		return sizes;
	}
	function overlaps(features, top, bottom) {
		for (var i = 0; i < features.length; i++)
			if (top < features[i].bottom && bottom > features[i].top) return true;
		return false;
	}
	function placeFeature(features, sediment, thickness, preferred, seed, key, salt, nearBase) {
		thickness = Math.min(sediment, Math.max(1, thickness));
		var span = sediment - thickness, candidates = 12;
		for (var i = 0; i < candidates; i++) {
			var top;
			if (nearBase) {
				var band = Math.min(span, 100);
				top = span - hash(seed, key, salt + i) % (band + 1);
			} else if (i === 0) {
				top = preferred % (span + 1);
			} else {
				top = hash(seed, key, salt + i) % (span + 1);
			}
			if (top < 0) top = 0;
			if (!overlaps(features, top, top + thickness)) return { top: top, bottom: top + thickness };
		}
		return null;
	}
	function recordKind(records, kind, variant) {
		for (var i = 0; i < records.length; i++) {
			if (records[i].kind === kind && (!variant || records[i].variant === variant)) return records[i];
		}
		return null;
	}
	function localRecords(state, cell) {
		var records = [];
		for (var k = 0; k < CoreDeposits.KINDS.length; k++) {
			var record = CoreDeposits.at(state, k, cell);
			if (record) records.push(record);
		}
		return records;
	}
	function sedimentFeatures(state, cell, owner, seed, key, sediment, records, wet) {
		var features = [];
		if (!sediment) return features;
		var basin = recordKind(records, 'basin');
		var coal = basin && basin.variant === 'coal';
		var uranium = basin && basin.variant === 'uranium';
		var placer = recordKind(records, 'placer');
		var landCoal = !wet && state.oBas[owner] >= 0.4;
		var downhill = state.low[cell];
		var downhillPlacer = !placer && state.oPla[owner] >= 0.3 && downhill >= 0
			&& downhill < state.grid.V && !!CoreDeposits.at(state, 'placer', downhill);
		var feature, thickness;
		if (uranium) {
			thickness = 1 + hash(seed, key, 20) % 10;
			feature = placeFeature(features, sediment, thickness, hash(seed, key, 21), seed, key, 22, false);
			if (feature) features.push({ top: feature.top, bottom: feature.bottom,
				lithology: 'sandstone', detail: 'U-bearing, redox boundary' });
		}
		if (coal || landCoal) {
			thickness = 1 + hash(seed, key, 30) % 4;
			feature = placeFeature(features, sediment, thickness, hash(seed, key, 31), seed, key, 32, false);
			if (feature) features.push({ top: feature.top, bottom: feature.bottom,
				lithology: 'coal', detail: 'coal seam' });
		}
		if (placer || downhillPlacer) {
			thickness = 1 + hash(seed, key, 40) % 3;
			feature = placeFeature(features, sediment, thickness, hash(seed, key, 41), seed, key, 42, true);
			if (feature) features.push({ top: feature.top, bottom: feature.bottom,
				lithology: 'gravel', detail: 'gold pay streak' });
		}
		features.sort(function (a, b) { return a.top - b.top; });
		return features;
	}
	function sedimentLayers(state, cell, owner, seed, key, wet, latitude, water, sediment, records, out) {
		if (!sediment) return;
		var count = clamp(Math.round(sediment / 120), 1, MAX_BEDS);
		count = Math.min(count, sediment);
		var sizes = bedSizes(sediment, count, seed, key);
		var features = sedimentFeatures(state, cell, owner, seed, key, sediment, records, wet);
		var at = 0;
		for (var i = 0; i < count; i++) {
			var bedTop = at, bedBottom = at + sizes[i];
			var lithology = lithologyFor(seed, key, 60 + i, wet, latitude);
			var cuts = [bedTop, bedBottom];
			for (var f = 0; f < features.length; f++) {
				if (features[f].top > bedTop && features[f].top < bedBottom) cuts.push(features[f].top);
				if (features[f].bottom > bedTop && features[f].bottom < bedBottom) cuts.push(features[f].bottom);
			}
			cuts.sort(function (a, b) { return a - b; });
			for (var c = 0; c < cuts.length - 1; c++) {
				var pieceTop = cuts[c], pieceBottom = cuts[c + 1], mid = (pieceTop + pieceBottom) * 0.5;
				var pieceRock = lithology[0], detail = lithology[1];
				for (var j = 0; j < features.length; j++) {
					if (mid < features[j].top || mid >= features[j].bottom) continue;
					pieceRock = features[j].lithology; detail = features[j].detail; break;
				}
				addLayer(out, water + pieceTop, water + pieceBottom, pieceRock, detail);
			}
			at = bedBottom;
		}
	}
	function basementDetail(state, owner, seed, key, kind) {
		var detail = kind === 'felsic'
			? ['biotite granite', 'granodiorite', 'banded gneiss', 'greenstone'][hash(seed, key, 70) % 4]
			: ['gabbro', 'basalt', 'peridotite'][hash(seed, key, 71) % 3];
		if (kind === 'felsic' && state.oArc[owner] >= 0.3 && unit(seed, key, 72) < 0.65) detail += ', sericite-altered';
		if (state.oOro[owner] >= 0.3 && unit(seed, key, 73) < 0.65) detail += ', sheared';
		return detail;
	}
	function baseLayers(state, cell, owner, seed, key, water, sediment, felsic, mafic, wet, latitude, records) {
		var layers = [];
		if (wet) addLayer(layers, 0, water, 'seawater', 'water column');
		sedimentLayers(state, cell, owner, seed, key, wet, latitude, water, sediment, records, layers);
		var top = water + sediment;
		if (felsic) {
			addLayer(layers, top, top + felsic, 'felsic crust', basementDetail(state, owner, seed, key, 'felsic'));
			top += felsic;
		}
		if (mafic) addLayer(layers, top, top + mafic, 'mafic crust', basementDetail(state, owner, seed, key, 'mafic'));
		return layers;
	}
	function oreLabel(record) {
		return ORE_LABEL[record.kind + '/' + record.variant] || (record.kind + ' ore');
	}
	function gradeText(record) {
		var out = [];
		for (var metal in record.grade) out.push(metal + ' ' + record.grade[metal] + ' ' + record.gradeUnit[metal]);
		return out.join(' ');
	}
	var _span = [0, 0];
	function intersections(records, water, depth, eastM, northM, out) {
		for (var r = 0; r < records.length; r++) {
			var record = records[r];
			for (var b = 0; b < record.bodies.length; b++) {
				var body = record.bodies[b], top = water + body.top, bottom = water + body.bottom;
				var enterRock = body.top, exitRock = body.bottom;
				if (body.axesM && CoreDeposits.verticalIntersection) {
					if (!CoreDeposits.verticalIntersection(body, eastM, northM, _span)) continue;
					enterRock = Math.max(body.top, Math.min(body.bottom - 1, Math.round(_span[0])));
					exitRock = Math.min(body.bottom, Math.max(enterRock + 1, Math.round(_span[1])));
				} else if (eastM !== 0 || northM !== 0) {
					continue;
				}
				var from = Math.max(0, water + enterRock), to = Math.min(depth, water + exitRock);
				if (to <= from) continue;
				out.push({
					id: record.id,
					kind: record.kind,
					variant: record.variant,
					commodity: record.commodity,
					bodyIndex: b,
					bodyTop: top,
					bodyBottom: bottom,
					from: from,
					to: to,
					strikeDeg: body.strikeDeg !== undefined ? body.strikeDeg : 0,
					dipDeg: body.dipDeg !== undefined ? body.dipDeg : 0,
					eastM: body.eastM || 0,
					northM: body.northM || 0,
					grade: record.grade,
					gradeUnit: record.gradeUnit,
					label: oreLabel(record),
					gradeText: gradeText(record)
				});
			}
		}
	}
	function splitOreLayers(layers, hits) {
		var out = [];
		for (var i = 0; i < layers.length; i++) {
			var layer = layers[i], cuts = [layer.top, layer.bottom];
			for (var h = 0; h < hits.length; h++) {
				if (hits[h].from > layer.top && hits[h].from < layer.bottom) cuts.push(hits[h].from);
				if (hits[h].to > layer.top && hits[h].to < layer.bottom) cuts.push(hits[h].to);
			}
			cuts.sort(function (a, b) { return a - b; });
			for (var c = 0; c < cuts.length - 1; c++) {
				var top = cuts[c], bottom = cuts[c + 1];
				if (bottom <= top) continue;
				var piece = {
					top: top,
					bottom: bottom,
					thickness: bottom - top,
					lithology: layer.lithology,
					detail: layer.detail,
					ore: false
				};
				var ores = [];
				for (var j = 0; j < hits.length; j++) {
					if (top < hits[j].from || bottom > hits[j].to) continue;
					ores.push({
						id: hits[j].id, kind: hits[j].kind, variant: hits[j].variant,
						label: hits[j].label, grade: hits[j].grade, gradeUnit: hits[j].gradeUnit,
						bodyIndex: hits[j].bodyIndex, strikeDeg: hits[j].strikeDeg, dipDeg: hits[j].dipDeg
					});
				}
				if (ores.length) {
					var primary = ores[0];
					piece.ore = true; piece.oreRecords = ores;
					piece.id = primary.id; piece.kind = primary.kind; piece.variant = primary.variant;
					piece.label = primary.label; piece.grade = primary.grade;
					piece.gradeUnit = primary.gradeUnit; piece.bodyIndex = primary.bodyIndex;
				}
				out.push(piece);
			}
		}
		return out;
	}
	function section(state, cell, requestedDepth, seed, opts) {
		if (!Number.isInteger(cell) || cell < 0 || cell >= state.grid.V) throw new RangeError('core cell is outside the grid');
		var owner = state.owner[cell];
		if (owner < 0 || owner >= state.n || !state.alive[owner]) return null;
		if (seed && typeof seed === 'object') { opts = seed; seed = opts.seed; }
		var eastM = opts && Number.isFinite(opts.eastM) ? Math.round(opts.eastM) : 0;
		var northM = opts && Number.isFinite(opts.northM) ? Math.round(opts.northM) : 0;
		var isBasement = requestedDepth === 'basement' || requestedDepth === 'to basement';
		var depth = isBasement ? 0 : Number(requestedDepth);
		if (!isBasement && (!Number.isFinite(depth) || depth < 0)) throw new RangeError('core depth must be a nonnegative number or basement');
		var s = seed === undefined ? state.seed : seed >>> 0;
		var key = CoreDeposits.anchorKey(state, cell);
		if (!key) return null;
		var wet = state.z[cell] < CoreParams.sea;
		var water = wet ? Math.max(0, bucket(CoreParams.sea - state.z[cell], WATER_BUCKET)) : 0;
		var sediment = bucket(state.hSed[owner], DEPTH_BUCKET);
		var felsic = bucket(state.hFel[owner], DEPTH_BUCKET);
		var mafic = bucket(state.hMaf[owner], DEPTH_BUCKET);
		var crustBottom = water + sediment + felsic + mafic;
		if (isBasement) depth = crustBottom;
		else depth = Math.round(depth);
		var records = localRecords(state, cell);
		var direction = state.grid.pos, p = cell * 3;
		var latitude = Math.asin(clamp(direction[p + 1], -1, 1));
		var longitude = Math.atan2(direction[p + 2], direction[p]);
		var layers = baseLayers(state, cell, owner, s, key, water, sediment, felsic, mafic, wet, latitude, records);
		if (depth > crustBottom) addLayer(layers, crustBottom, depth, 'mantle', 'peridotite');
		var rawLayers = [];
		for (var l = 0; l < layers.length; l++) {
			var layer = layers[l];
			if (layer.top >= depth) continue;
			if (layer.bottom > depth) addLayer(rawLayers, layer.top, depth, layer.lithology, layer.detail);
			else rawLayers.push(layer);
		}
		if (wet && !rawLayers.length) addLayer(rawLayers, 0, 0, 'seawater', 'water column');
		var hits = [];
		intersections(records, water, depth, eastM, northM, hits);
		var finalLayers = splitOreLayers(rawLayers, hits);
		if (wet && (water === 0 || !finalLayers.length)) finalLayers.unshift({
			top: 0, bottom: 0, thickness: 0, lithology: 'seawater', detail: 'water column', ore: false
		});
		var wetDepth = wet ? Math.min(water, depth) : 0;
		return {
			cell: cell,
			level: state.grid.level,
			epochMyr: Math.round(state.t * 10) / 10,
			depth: depth,
			requestedDepth: isBasement ? 'basement' : Math.round(Number(requestedDepth)),
			eastM: eastM,
			northM: northM,
			datum: wet ? 'sea surface' : 'land surface',
			wet: wet,
			water: water,
			waterLogged: wetDepth,
			sediment: sediment,
			felsic: felsic,
			mafic: mafic,
			crustBottom: crustBottom,
			latitude: latitude,
			longitude: longitude,
			layers: finalLayers,
			intersections: hits
		};
	}
	function pad(value, width) {
		var text = countText(value);
		while (text.length < width) text = ' ' + text;
		return text;
	}
	function text(section) {
		if (!section) return 'No core: this cell has no assigned crust column.';
		var lat = section.latitude * 180 / Math.PI, lon = section.longitude * 180 / Math.PI;
		var head = 'hole ' + countText(section.cell) + ' · L' + section.level + ' · '
			+ Math.abs(lat).toFixed(1) + '°' + (lat < 0 ? 'S' : 'N') + ' '
			+ Math.abs(lon).toFixed(1) + '°' + (lon < 0 ? 'W' : 'E') + ' · ' + section.datum
			+ ' · water ' + section.waterLogged + ' m · sediment ' + section.sediment
			+ ' m · depth ' + countText(section.depth) + ' m';
		var lines = [head];
		for (var i = 0; i < section.layers.length; i++) {
			var layer = section.layers[i], line = pad(layer.top, 7) + ' - ' + pad(layer.bottom, 7) + ' m  '
				+ layer.lithology.padEnd(12) + ' ' + layer.detail;
			if (layer.ore) {
				var ores = layer.oreRecords || [layer];
				for (var o = 0; o < ores.length; o++) {
					line += '  ' + ores[o].label + '  #' + ores[o].id;
					var grades = [];
					for (var metal in ores[o].grade)
						grades.push(metal + ' ' + ores[o].grade[metal] + ores[o].gradeUnit[metal]);
					if (grades.length) line += '  ' + grades.join(' ');
				}
			}
			lines.push(line);
		}
		return lines.join('\n');
	}
	function json(section) {
		if (!section) throw new TypeError('cannot export an empty core');
		return JSON.stringify({
			format: 'pgt-core',
			version: 1,
			cell: section.cell,
			epoch: section.epochMyr,
			depth: section.depth,
			requestedDepth: section.requestedDepth,
			datum: section.datum,
			water: section.water,
			layers: section.layers,
			intersections: section.intersections
		}, null, 1);
	}
	return { section: section, text: text, json: json };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Core;

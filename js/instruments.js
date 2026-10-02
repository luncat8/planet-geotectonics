var InstrumentParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var InstrumentDeposits = typeof module !== 'undefined' && module.exports ? require('./deposits.js') : Deposits;
var Instruments = (function () {
	var KINDS = InstrumentDeposits.KINDS;
	var ALL = (1 << KINDS.length) - 1;
	var LIST = [
		{ id: 'obs', name: 'Field observation', reach: 50, coverMax: 5, footprint: 1, kinds: ALL, detect: 0.45 },
		{ id: 'geo', name: 'Stream-sediment geochemistry', reach: 0, coverMax: 200, footprint: -1, kinds: ALL, detect: 0.25 },
		{ id: 'mag', name: 'Gravity + magnetics', reach: 3000, coverMax: Infinity, footprint: 2,
			kinds: (1 << 0) | (1 << 1) | (1 << 2), detect: 0.30 },
		{ id: 'gpr', name: 'Shallow reflection / ground radar', reach: 1000, coverMax: Infinity, footprint: 0,
			kinds: (1 << 4) | (1 << 5), detect: 0.25 },
		{ id: 'd500', name: 'Shallow drill 500 m', reach: 500, coverMax: Infinity, footprint: 0, kinds: ALL, detect: 0.10 },
		{ id: 'd5k', name: 'Deep drill 5 km', reach: 5000, coverMax: Infinity, footprint: 0, kinds: ALL, detect: 0.10 },
		{ id: 'lab', name: 'Assay + isotopes', reach: 0, coverMax: Infinity, footprint: 0, kinds: ALL, detect: Infinity }
	];
	var KIND_GAIN = [
		[1, 1, 1, 1, 1, 1],
		[1, 1, 1, 1, 1, 1],
		[1, 1, 0.5, 0, 0, 0],
		[0, 0, 0, 0, 1, 1],
		[1, 1, 1, 1, 1, 1],
		[1, 1, 1, 1, 1, 1],
		[0, 0, 0, 0, 0, 0]
	];
	var CONFIDENCE = ['unknown', 'inferred', 'indicated', 'measured'];
	var EARTH_RADIUS = InstrumentParams.radius;
	var DEPTH_STEP = 50;

	function Ledger(size) {
		this.coverage = new Uint8Array(size);
		this.cells = new Uint32Array(size);
		this.cellsN = 0;
		this.found = [];
		this.byId = Object.create(null);
		this.calls = 0;
		this.sampleCells = new Int32Array(260);
		this.sampleDepth = new Uint8Array(260);
		this.sampleSeen = new Uint32Array(size);
		this.sampleToken = 0;
	}
	function instrumentIndex(id) {
		for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return i;
		return -1;
	}
	function selectedIndices(selection) {
		var want = Object.create(null), out = [];
		if (typeof selection === 'string') selection = selection.split(',');
		if (!selection || typeof selection.length !== 'number') return out;
		for (var j = 0; j < selection.length; j++) want[String(selection[j]).trim()] = 1;
		for (var i = 0; i < LIST.length; i++) if (want[LIST[i].id]) out.push(i);
		return out;
	}
	function popcount(value) {
		value -= (value >>> 1) & 0x55555555;
		value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
		return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
	}
	function markCoverage(ledger, cell, indices) {
		var mask = 0;
		for (var i = 0; i < indices.length; i++) mask |= 1 << indices[i];
		if (!ledger.coverage[cell]) ledger.cells[ledger.cellsN++] = cell;
		ledger.coverage[cell] |= mask;
		ledger.calls++;
	}
	function addSample(ledger, cell, depth, token, tail) {
		ledger.sampleSeen[cell] = token;
		ledger.sampleCells[tail] = cell;
		ledger.sampleDepth[tail] = depth;
		return tail + 1;
	}
	function collectSamples(s, center, inst, ledger) {
		var maxDepth = inst.footprint < 0 ? 3 : inst.footprint;
		var cells = ledger.sampleCells, depths = ledger.sampleDepth, seen = ledger.sampleSeen;
		var token = (ledger.sampleToken + 1) >>> 0;
		if (!token) { seen.fill(0); token = 1; }
		ledger.sampleToken = token;
		var head = 0, tail = addSample(ledger, center, 0, token, 0), g = s.grid;
		while (head < tail) {
			var at = head++, c = cells[at], depth = depths[at];
			if (depth >= maxDepth) continue;
			for (var k = 0; k < g.ringN[c]; k++) {
				var neighbor = g.ring[c * 6 + k];
				if (seen[neighbor] === token) continue;
				if (inst.footprint < 0 && s.low[neighbor] !== c) continue;
				tail = addSample(ledger, neighbor, depth + 1, token, tail);
			}
		}
		return tail;
	}
	function readable(s, instIndex, cell, owner) {
		var inst = LIST[instIndex], cover = s.hSed[owner];
		if (cover > inst.coverMax) return false;
		if (inst.id !== 'obs') return true;
		var wet = s.z[cell] < InstrumentParams.sea;
		return s.z[cell] > InstrumentParams.sea || (wet && cover <= inst.coverMax);
	}
	function canMeasure(instIndex, s, record) {
		var inst = LIST[instIndex], actualCover = s.hSed[record.owner];
		if (actualCover > inst.coverMax) return false;
		if (inst.id === 'obs') {
			var wet = record.surfaceZ < InstrumentParams.sea;
			return record.top <= inst.reach && (record.surfaceZ > InstrumentParams.sea || (wet && actualCover <= 5));
		}
		if (inst.id === 'geo') return true;
		if (inst.id === 'lab') return false;
		return record.top <= inst.reach;
	}
	function gain(instIndex, kindIndex) {
		return KIND_GAIN[instIndex][kindIndex];
	}
	function noise(seed, record, instIndex) {
		var mixSeed = (seed ^ Math.imul(instIndex + 1, 0x9e3779b1)) >>> 0;
		return InstrumentDeposits.hash32(mixSeed, record.kindIndex, record.anchorKey) / 4294967296;
	}
	function resultItem(result, entry, record, known, stale) {
		for (var i = 0; i < result.found.length; i++) {
			if (result.found[i].entry === entry) {
				result.found[i].record = record || result.found[i].record;
				result.found[i].stale = result.found[i].stale && stale;
				result.found[i].known = result.found[i].known || known;
				return result.found[i];
			}
		}
		var item = { entry: entry, record: record || entry.record, known: known, stale: stale, instruments: [], refinedFrom: 0 };
		result.found.push(item);
		return item;
	}
	function reanchorTolerance(state, cell) {
		var distance = state.grid.nbrDist[cell] * 1.5 / EARTH_RADIUS;
		return Math.cos(Math.min(Math.PI, distance));
	}
	function findEntry(ledger, state, record) {
		var exact = ledger.byId[record.id];
		if (exact) return exact;
		var cosLimit = reanchorTolerance(state, record.cell);
		for (var i = 0; i < ledger.found.length; i++) {
			var entry = ledger.found[i];
			if (entry.kind !== record.kind || entry.id === record.id) continue;
			var direction = entry.direction, next = record.direction;
			var dot = direction[0] * next[0] + direction[1] * next[1] + direction[2] * next[2];
			if (dot < cosLimit) continue;
			delete ledger.byId[entry.id];
			entry.id = record.id;
			entry.cell = record.cell;
			entry.anchorKey = record.anchorKey.slice(0);
			entry.direction = record.direction.slice(0);
			entry.record = record;
			ledger.byId[entry.id] = entry;
			return entry;
		}
		var created = {
			id: record.id, kind: record.kind, kindIndex: record.kindIndex, cell: record.cell,
			anchorKey: record.anchorKey.slice(0), direction: record.direction.slice(0),
			confidence: 0, evidence: 0, epochMyr: record.epochMyr, firstSeen: record.epochMyr,
			lastSeen: record.epochMyr, surveyCell: -1, record: record
		};
		ledger.found.push(created);
		ledger.byId[created.id] = created;
		return created;
	}
	function removeEntry(ledger, at) {
		var entry = ledger.found[at];
		delete ledger.byId[entry.id];
		ledger.found.splice(at, 1);
	}
	function collectCandidates(s, cell, instIndex, ledger, result, foundNow) {
		var inst = LIST[instIndex], nCells = collectSamples(s, cell, inst, ledger),
			cells = ledger.sampleCells, values = [0, 0, 0, 0, 0, 0], candidates = [], loadTotal = 0,
			sums = [0, 0, 0, 0, 0, 0], contributing = 0;
		var isGeo = inst.id === 'geo';
		for (var ci = 0; ci < nCells; ci++) {
			var c = cells[ci], owner = s.owner[c];
			if (owner < 0 || owner >= s.n || !s.alive[owner]) continue;
			if (!readable(s, instIndex, c, owner)) continue;
			var weight = 1;
			if (isGeo) {
				weight = Math.max(0, s.mobile[c]);
				if (!(weight > 0)) continue;
				loadTotal += weight;
				contributing++;
			}
			for (var k = 0; k < KINDS.length; k++) {
				if (!(inst.kinds & (1 << k))) continue;
				var value = InstrumentDeposits.blurAt(s, k, c);
				if (inst.id === 'd500' || inst.id === 'd5k') {
					var intersected = InstrumentDeposits.at(s, k, c);
					if (!intersected || !canMeasure(instIndex, s, intersected)) continue;
					value = intersected.potential;
				}
				if (isGeo) sums[k] += value * weight;
				else if (value > values[k]) values[k] = value;
			}
		}
		if (isGeo && loadTotal > 0) {
			for (var g = 0; g < KINDS.length; g++) values[g] = sums[g] / loadTotal;
		}
		for (var sample = 0; sample < nCells; sample++) {
			var sourceCell = cells[sample], sourceOwner = s.owner[sourceCell];
			if (sourceOwner < 0 || sourceOwner >= s.n || !s.alive[sourceOwner]) continue;
			for (var kind = 0; kind < KINDS.length; kind++) {
				if (!(inst.kinds & (1 << kind)) || gain(instIndex, kind) === 0) continue;
				var record = InstrumentDeposits.at(s, kind, sourceCell);
				if (!record || !canMeasure(instIndex, s, record)) continue;
				candidates.push(record);
				var signal = isGeo ? values[kind] : record.potential;
				var limit = inst.detect * (0.7 + 0.6 * noise(s.seed, record, instIndex));
				if (signal < limit * gain(instIndex, kind)) continue;
				var reading = result.readings[result.readings.length - 1];
				if (inst.id === 'mag') {
					var sourceDepth = Math.round(record.top / 250) * 250;
					if (reading.depthToSource < 0 || sourceDepth < reading.depthToSource)
						reading.depthToSource = sourceDepth;
				}
				var wasKnown = !!ledger.byId[record.id], entry = findEntry(ledger, s, record);
				entry.surveyCell = cell;
				entry.lastSeen = record.epochMyr;
				entry.record = record;
				if (instIndex <= 3) {
					entry.evidence |= 1 << instIndex;
					entry.confidence = Math.max(entry.confidence, popcount(entry.evidence) > 1 ? 2 : 1);
				} else if (instIndex === 4 || instIndex === 5) {
					entry.confidence = 3;
				}
				var item = resultItem(result, entry, record, wasKnown, false);
				if (item.instruments.indexOf(inst.id) < 0) item.instruments.push(inst.id);
				foundNow[entry.id] = 1;
				var hitId = '#' + record.id;
				if (result.readings[result.readings.length - 1].hits.indexOf(hitId) < 0)
					result.readings[result.readings.length - 1].hits.push(hitId);
			}
		}
		var reading = result.readings[result.readings.length - 1];
		reading.values = values;
		if (inst.id === 'mag') reading.magneticIndex = Math.max(values[0], values[1], values[2]);
		reading.contributors = contributing;
		reading.sampleCount = nCells;
		reading.holeHits = reading.hits.slice(0);
		reading.metrics = cellMetrics(s, cell);
		reading.candidates = candidates;
	}
	function cellMetrics(s, cell) {
		var owner = s.owner[cell], wet = s.z[cell] < InstrumentParams.sea;
		return {
			owner: owner,
			wet: wet,
			exposed: owner >= 0 && s.hSed[owner] <= 5 && (s.z[cell] > InstrumentParams.sea || s.z[cell] < InstrumentParams.sea),
			water: wet ? Math.max(0, InstrumentParams.sea - s.z[cell]) : 0,
			sediment: owner >= 0 ? Math.round(s.hSed[owner] / DEPTH_STEP) * DEPTH_STEP : 0,
			mafic: owner >= 0 ? s.hMaf[owner] : 0,
			damage: owner >= 0 ? s.damage[owner] : 0,
			belt: s.belt[cell],
			placer: s.mobilePla[cell],
			elevation: Number.isFinite(s.z[cell]) ? Math.round(s.z[cell] / 10) * 10 : 0
		};
	}
	function reconcile(s, cell, ledger, result, foundNow) {
		for (var i = ledger.found.length - 1; i >= 0; i--) {
			var entry = ledger.found[i];
			if (entry.surveyCell !== cell || foundNow[entry.id]) continue;
			var value = InstrumentDeposits.blurAt(s, entry.kindIndex, entry.cell);
			if (value < InstrumentParams.depositMin * InstrumentParams.depositHysteresis) {
				removeEntry(ledger, i);
				continue;
			}
			resultItem(result, entry, entry.record, true, true);
		}
	}
	function applyLab(s, cell, ledger, result, foundNow) {
		var reading = result.readings[result.readings.length - 1], changed = 0;
		for (var i = 0; i < ledger.found.length; i++) {
			var entry = ledger.found[i];
			if (entry.cell !== cell || entry.confidence < 1) continue;
			var before = entry.confidence;
			if (before < 2) { entry.confidence++; changed++; }
			entry.lastSeen = Math.round(s.t * 10) / 10;
			var item = resultItem(result, entry, entry.record, true, false);
			if (entry.confidence !== before) item.refinedFrom = before;
			if (item.instruments.indexOf('lab') < 0) item.instruments.push('lab');
			reading.hits.push('#' + entry.id);
			foundNow[entry.id] = 1;
		}
		reading.refined = changed;
		reading.metrics = cellMetrics(s, cell);
	}
	function survey(s, cell, selection, ledger) {
		if (!Number.isInteger(cell) || cell < 0 || cell >= s.grid.V) throw new RangeError('survey cell is outside the grid');
		var indices = selectedIndices(selection);
		if (!indices.length) return { ok: false, reason: 'no instruments selected', cell: cell };
		if (!ledger) ledger = new Ledger(s.grid.V);
		if (ledger.coverage.length !== s.grid.V) throw new RangeError('survey ledger belongs to a different grid');
		markCoverage(ledger, cell, indices);
		var latLon = s.grid.pos, b = cell * 3, lat = Math.asin(Math.max(-1, Math.min(1, latLon[b + 1]))),
			lon = Math.atan2(latLon[b + 2], latLon[b]);
		var result = {
			ok: true, cell: cell, epochMyr: Math.round(s.t * 10) / 10,
			lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
			host: requireHost(s, cell), readings: [], found: [],
			ledger: ledger, surveyMask: ledger.coverage[cell]
		};
		var foundNow = Object.create(null);
		for (var n = 0; n < indices.length; n++) {
			var index = indices[n], inst = LIST[index];
			result.readings.push({ id: inst.id, name: inst.name, values: [0, 0, 0, 0, 0, 0],
				hits: [], contributors: 0, sampleCount: 0, metrics: cellMetrics(s, cell), refined: 0 });
			result.readings[result.readings.length - 1].depthToSource = -1;
			if (inst.id === 'lab') applyLab(s, cell, ledger, result, foundNow);
			else collectCandidates(s, cell, index, ledger, result, foundNow);
		}
		reconcile(s, cell, ledger, result, foundNow);
		result.found.sort(function (a, b) {
			var ak = a.record.kindIndex, bk = b.record.kindIndex;
			return ak !== bk ? ak - bk : a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
		});
		return result;
	}
	function requireHost(s, cell) {
		var owner = s.owner[cell];
		if (owner < 0) return 'none';
		if (s.hSed[owner] > 2000 && s.hSed[owner] > s.hFel[owner] && s.hSed[owner] > s.hMaf[owner]) return 'sediment';
		if (s.hFel[owner] >= InstrumentParams.hOceanic) return s.hFel[owner] > InstrumentParams.hOro ? 'thick continental' : 'continental';
		return 'oceanic';
	}
	function countText(value) {
		var digits = String(Math.floor(value)), out = '';
		while (digits.length > 3) {
			out = ',' + digits.slice(-3) + out;
			digits = digits.slice(0, -3);
		}
		return digits + out;
	}
	function kindValues(reading) {
		var out = [];
		for (var i = 0; i < KINDS.length; i++) {
			if (reading.values[i] < InstrumentDeposits.TRACE_MIN) continue;
			out.push(KINDS[i] + ' ' + reading.values[i].toFixed(2));
		}
		return out.length ? out.join(' · ') : 'no reading above background';
	}
	function readingText(reading) {
		var m = reading.metrics, line = reading.id + '  ';
		if (reading.id === 'obs') {
			var exposure = m.exposed ? 'clicked column exposed' : 'clicked column covered';
			line += exposure + ' · structure ' + (m.belt ? 'belt' : 'none') + ' · drainage pans ' + m.placer.toFixed(2)
				+ ' · ' + kindValues(reading);
			return line;
		}
		if (reading.id === 'geo') {
			line += 'upstream basin ' + reading.contributors + ' loaded cells · anomaly index · ' + kindValues(reading);
			if (!reading.contributors) line += ' · no stream load';
			return line;
		}
		if (reading.id === 'mag') {
			line += 'hMaf ' + (m.mafic / 1000).toFixed(1) + ' km · damage ' + m.damage.toFixed(2)
				+ ' · magnetic index ' + reading.magneticIndex.toFixed(2) + ' · ' + kindValues(reading)
				+ ' · depth to source '
				+ (reading.depthToSource < 0 ? 'unresolved' : reading.depthToSource + ' m');
			return line;
		}
		if (reading.id === 'gpr') {
			line += 'sediment ' + m.sediment + ' m · depth to basement ' + m.sediment + ' m · reflectors '
				+ reading.candidates.length + ' · ' + kindValues(reading);
			return line;
		}
		if (reading.id === 'd500' || reading.id === 'd5k') {
			line += 'hole ' + LIST[instrumentIndex(reading.id)].reach + ' m · cover ' + m.sediment + ' m · assay pending';
			line += reading.holeHits.length ? ' · intersections ' + reading.holeHits.join(', ') : ' · no intersections';
			return line;
		}
		if (reading.id === 'lab') {
			line += !reading.hits.length ? 'no previously found sample'
				: reading.refined ? 'refined ' + reading.hits.join(', ') + ' · confidence improved'
				: 'known sample ' + reading.hits.join(', ') + ' · no further confidence gain';
			return line;
		}
		return line + 'no reading above background';
	}
	function report(result) {
		if (!result || !result.ok) return 'Select at least one instrument, then click a map cell.';
		var lat = result.lat * 180 / Math.PI, lon = result.lon * 180 / Math.PI, cell = result.cell;
		var m = result.readings[0].metrics;
		var text = 'cell ' + countText(cell) + ' · ' + Math.abs(lat).toFixed(1) + '°' + (lat < 0 ? 'S' : 'N')
			+ ' ' + Math.abs(lon).toFixed(1) + '°' + (lon < 0 ? 'W' : 'E') + ' · ' + result.host
			+ ' · z ' + m.elevation + ' m · sediment ' + m.sediment + ' m · t ' + result.epochMyr.toFixed(1) + ' Myr';
		text += '\nreadings';
		for (var i = 0; i < result.readings.length; i++) text += '\n  ' + readingText(result.readings[i]);
		text += '\nfound deposits (' + result.found.length + ')';
		if (!result.found.length) text += '\n  no deposits detected';
		for (var f = 0; f < result.found.length; f++) {
			var item = result.found[f], rec = item.record;
			text += '\n  #' + rec.id + '  ' + rec.kind + '  ' + CONFIDENCE[item.entry.confidence]
				+ '  top ' + rec.top + ' m  ' + rec.host;
			if (item.stale) text += '  · retained in session';
			if (item.refinedFrom) text += '  · lab ' + CONFIDENCE[item.refinedFrom] + ' → ' + CONFIDENCE[item.entry.confidence];
			if (item.instruments.length) text += '  · ' + item.instruments.join('+');
			text += '  · size / grade pending';
		}
		text += '\nsession ' + countText(result.ledger.cellsN) + ' cells surveyed · '
			+ countText(result.ledger.found.length) + ' records found';
		return text;
	}

	return {
		LIST: LIST,
		Ledger: Ledger,
		selectedIndices: selectedIndices,
		noise: noise,
		survey: survey,
		report: report,
		confidence: CONFIDENCE
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Instruments;

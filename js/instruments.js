var InstrumentParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var InstrumentDeposits = typeof module !== 'undefined' && module.exports ? require('./deposits.js') : Deposits;
var Instruments = (function () {
	var KINDS = InstrumentDeposits.KINDS;
	var ALL = (1 << KINDS.length) - 1;
	var LIST = [
		{ id: 'obs', name: 'Field observation', reach: 50, coverMax: 5, footprint: 1, kinds: ALL, detect: 0.45 },
		{ id: 'geo', name: 'Stream-sediment geochemistry', reach: 0, coverMax: 200, footprint: -1, kinds: ALL, detect: 0.25 },
		{ id: 'mag', name: 'Gravity + magnetics', reach: 3000, coverMax: Infinity, footprint: 2,
			kinds: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6), detect: 0.30 },
		{ id: 'gpr', name: 'Shallow reflection / ground radar', reach: 1000, coverMax: Infinity, footprint: 0,
			kinds: (1 << 4) | (1 << 5), detect: 0.25 },
		{ id: 'd500', name: 'Shallow drill 500 m', reach: 500, coverMax: Infinity, footprint: 0, kinds: ALL, detect: 0.10 },
		{ id: 'd5k', name: 'Deep drill 5 km', reach: 5000, coverMax: Infinity, footprint: 0, kinds: ALL, detect: 0.10 },
		{ id: 'lab', name: 'Assay + isotopes', reach: 0, coverMax: Infinity, footprint: 0, kinds: ALL, detect: Infinity }
	];
	// Rows are instruments, columns the seven deposit kinds. Magnetite-rich iron formation is
	// the classic magnetic target; ground radar only reaches the shallow basin and placer hosts.
	var KIND_GAIN = [
		[1, 1, 1, 1, 1, 1, 1],
		[1, 1, 1, 1, 1, 1, 1],
		[1, 1, 0.5, 0, 0, 0, 1],
		[0, 0, 0, 0, 1, 1, 0],
		[1, 1, 1, 1, 1, 1, 1],
		[1, 1, 1, 1, 1, 1, 1],
		[0, 0, 0, 0, 0, 0, 0]
	];
	var CONFIDENCE = ['unknown', 'inferred', 'indicated', 'measured'];
	var reanchorBest = { entry: null, dot: -1 };
	function zeroReadings() {
		var out = [];
		for (var i = 0; i < KINDS.length; i++) out.push(0);
		return out;
	}
	var EARTH_RADIUS = InstrumentParams.radius;
	var DEPTH_STEP = 50;

	function Ledger(size) {
		this.coverage = new Uint8Array(size);
		this.cells = new Uint32Array(size);
		this.cellsN = 0;
		this.found = [];
		this.byId = Object.create(null);
		this.byRecordCell = Object.create(null);
		this.bySurveyCell = Object.create(null);
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
	function addCellEntry(index, cell, entry) {
		var key = String(cell), list = index[key];
		if (!list) index[key] = list = [];
		list.push(entry);
	}
	function removeCellEntry(index, cell, entry) {
		if (cell < 0) return;
		var key = String(cell), list = index[key];
		if (!list) return;
		var at = list.indexOf(entry);
		if (at >= 0) list.splice(at, 1);
		if (!list.length) delete index[key];
	}
	function moveRecordCell(ledger, entry, cell) {
		if (entry.cell === cell) return;
		removeCellEntry(ledger.byRecordCell, entry.cell, entry);
		entry.cell = cell;
		addCellEntry(ledger.byRecordCell, cell, entry);
	}
	function moveSurveyCell(ledger, entry, cell) {
		if (entry.surveyCell === cell) return;
		removeCellEntry(ledger.bySurveyCell, entry.surveyCell, entry);
		entry.surveyCell = cell;
		addCellEntry(ledger.bySurveyCell, cell, entry);
	}
	function setAnchor(entry, record) {
		for (var i = 0; i < 3; i++) entry.anchorKey[i] = record.anchorKey[i];
		for (var j = 0; j < 3; j++) entry.direction[j] = record.direction[j];
	}
	function clearObject(object) {
		for (var key in object) delete object[key];
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
	function considerReanchor(ledger, record, cell, cosLimit) {
		var list = ledger.byRecordCell[String(cell)];
		if (!list) return;
		for (var i = 0; i < list.length; i++) {
			var entry = list[i];
			if (entry.kind !== record.kind || entry.id === record.id) continue;
			var direction = entry.direction, next = record.direction;
			var dot = direction[0] * next[0] + direction[1] * next[1] + direction[2] * next[2];
			if (dot >= cosLimit && dot > reanchorBest.dot) {
				reanchorBest.entry = entry; reanchorBest.dot = dot;
			}
		}
	}
	function findEntry(ledger, state, record) {
		var exact = ledger.byId[record.id];
		if (exact) {
			moveRecordCell(ledger, exact, record.cell);
			setAnchor(exact, record);
			exact.record = record;
			return exact;
		}
		var cosLimit = reanchorTolerance(state, record.cell);
		reanchorBest.entry = null; reanchorBest.dot = cosLimit;
		if (ledger.found.length) {
			var g = state.grid, ring = g.ring, ringN = g.ringN, first = record.cell;
			considerReanchor(ledger, record, first, cosLimit);
			for (var n = 0; n < ringN[first]; n++) {
				var near = ring[first * 6 + n];
				considerReanchor(ledger, record, near, cosLimit);
				for (var m = 0; m < ringN[near]; m++)
					considerReanchor(ledger, record, ring[near * 6 + m], cosLimit);
			}
		}
		var best = reanchorBest.entry;
		if (best) {
			delete ledger.byId[best.id];
			moveRecordCell(ledger, best, record.cell);
			best.id = record.id;
			best.kindIndex = record.kindIndex;
			setAnchor(best, record);
			best.record = record;
			ledger.byId[best.id] = best;
			return best;
		}
		var created = {
			id: record.id, kind: record.kind, kindIndex: record.kindIndex, cell: record.cell,
			anchorKey: record.anchorKey.slice(0), direction: record.direction.slice(0),
			confidence: 0, evidence: 0, epochMyr: record.epochMyr, firstSeen: record.epochMyr,
			lastSeen: record.epochMyr, surveyCell: -1, record: record,
			ledgerIndex: ledger.found.length
		};
		ledger.found.push(created);
		ledger.byId[created.id] = created;
		addCellEntry(ledger.byRecordCell, created.cell, created);
		return created;
	}
	function removeEntry(ledger, at) {
		var entry = ledger.found[at], last = ledger.found.pop();
		delete ledger.byId[entry.id];
		removeCellEntry(ledger.byRecordCell, entry.cell, entry);
		removeCellEntry(ledger.bySurveyCell, entry.surveyCell, entry);
		if (at < ledger.found.length) {
			ledger.found[at] = last;
			last.ledgerIndex = at;
		}
	}
	function catalogueAt(s, catalogue, cell, kind) {
		if (!catalogue) return InstrumentDeposits.at(s, kind, cell);
		for (var at = catalogue.cellStart[cell]; at < catalogue.cellStart[cell + 1]; at++) {
			var record = catalogue.records[at];
			if (record.kindIndex === kind) return record;
		}
		return null;
	}
	var campaignValues = new Float64Array(KINDS.length), campaignSums = new Float64Array(KINDS.length);
	function collectCandidates(s, cell, instIndex, ledger, result, foundNow, catalogue) {
		var detailed = !!result, inst = LIST[instIndex], nCells = collectSamples(s, cell, inst, ledger),
			cells = ledger.sampleCells, values = detailed ? zeroReadings() : campaignValues,
			candidates = detailed ? [] : null, loadTotal = 0,
			sums = detailed ? zeroReadings() : campaignSums, contributing = 0;
		if (!detailed) { values.fill(0); sums.fill(0); }
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
					var intersected = catalogueAt(s, catalogue, c, k);
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
				var record = catalogueAt(s, catalogue, sourceCell, kind);
				if (!record || !canMeasure(instIndex, s, record)) continue;
				if (candidates) candidates.push(record);
				var signal = isGeo ? values[kind] : record.potential;
				var limit = inst.detect * (0.7 + 0.6 * noise(s.seed, record, instIndex));
				if (signal < limit * gain(instIndex, kind)) continue;
				var reading = detailed ? result.readings[result.readings.length - 1] : null;
				if (reading && inst.id === 'mag') {
					var sourceDepth = Math.round(record.top / 250) * 250;
					if (reading.depthToSource < 0 || sourceDepth < reading.depthToSource)
						reading.depthToSource = sourceDepth;
				}
				var wasKnown = !!ledger.byId[record.id], entry = findEntry(ledger, s, record);
				moveSurveyCell(ledger, entry, cell);
				entry.lastSeen = record.epochMyr;
				entry.record = record;
				if (instIndex <= 3) {
					entry.evidence |= 1 << instIndex;
					entry.confidence = Math.max(entry.confidence, popcount(entry.evidence) > 1 ? 2 : 1);
				} else if (instIndex === 4 || instIndex === 5) {
					entry.confidence = 3;
				}
				if (detailed) {
					var item = resultItem(result, entry, record, wasKnown, false);
					if (item.instruments.indexOf(inst.id) < 0) item.instruments.push(inst.id);
				}
				foundNow[entry.id] = 1;
				if (reading) {
					var hitId = '#' + record.id;
					if (reading.hits.indexOf(hitId) < 0) reading.hits.push(hitId);
				}
			}
		}
		if (!detailed) return;
		var lastReading = result.readings[result.readings.length - 1];
		lastReading.values = values;
		if (inst.id === 'mag') lastReading.magneticIndex = Math.max(values[0], values[1], values[2]);
		lastReading.contributors = contributing;
		lastReading.sampleCount = nCells;
		lastReading.holeHits = lastReading.hits.slice(0);
		lastReading.metrics = cellMetrics(s, cell);
		lastReading.candidates = candidates;
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
		var list = ledger.bySurveyCell[String(cell)];
		if (!list) return;
		for (var i = list.length - 1; i >= 0; i--) {
			var entry = list[i];
			if (foundNow[entry.id]) continue;
			var value = InstrumentDeposits.blurAt(s, entry.kindIndex, entry.cell);
			if (value < InstrumentParams.depositMin * InstrumentParams.depositHysteresis) {
				removeEntry(ledger, entry.ledgerIndex);
				continue;
			}
			if (result) resultItem(result, entry, entry.record, true, true);
		}
	}
	function applyLab(s, cell, ledger, result, foundNow) {
		var reading = result ? result.readings[result.readings.length - 1] : null;
		var list = ledger.byRecordCell[String(cell)], changed = 0;
		if (!list) return;
		for (var i = 0; i < list.length; i++) {
			var entry = list[i];
			if (entry.confidence < 1) continue;
			var before = entry.confidence;
			if (before < 2) { entry.confidence++; changed++; }
			entry.lastSeen = Math.round(s.t * 10) / 10;
			if (reading) {
				var item = resultItem(result, entry, entry.record, true, false);
				if (entry.confidence !== before) item.refinedFrom = before;
				if (item.instruments.indexOf('lab') < 0) item.instruments.push('lab');
				reading.hits.push('#' + entry.id);
			}
			foundNow[entry.id] = 1;
		}
		if (reading) {
			reading.refined = changed;
			reading.metrics = cellMetrics(s, cell);
		}
	}
	function surveyInternal(s, cell, indices, ledger, catalogue, detailed, foundNow) {
		if (!Number.isInteger(cell) || cell < 0 || cell >= s.grid.V) throw new RangeError('survey cell is outside the grid');
		if (!indices.length) return detailed ? { ok: false, reason: 'no instruments selected', cell: cell } : null;
		if (!ledger) ledger = new Ledger(s.grid.V);
		if (ledger.coverage.length !== s.grid.V) throw new RangeError('survey ledger belongs to a different grid');
		markCoverage(ledger, cell, indices);
		var result = null;
		if (detailed) {
			var latLon = s.grid.pos, b = cell * 3, lat = Math.asin(Math.max(-1, Math.min(1, latLon[b + 1]))),
				lon = Math.atan2(latLon[b + 2], latLon[b]);
			result = {
				ok: true, cell: cell, epochMyr: Math.round(s.t * 10) / 10,
				lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
				host: requireHost(s, cell), readings: [], found: [],
				ledger: ledger, surveyMask: ledger.coverage[cell]
			};
		}
		if (!foundNow) foundNow = Object.create(null);
		else clearObject(foundNow);
		for (var n = 0; n < indices.length; n++) {
			var index = indices[n], inst = LIST[index];
			if (detailed) {
				result.readings.push({ id: inst.id, name: inst.name, values: zeroReadings(),
					hits: [], contributors: 0, sampleCount: 0, metrics: cellMetrics(s, cell), refined: 0 });
				result.readings[result.readings.length - 1].depthToSource = -1;
			}
			if (inst.id === 'lab') applyLab(s, cell, ledger, result, foundNow);
			else collectCandidates(s, cell, index, ledger, result, foundNow, catalogue);
		}
		reconcile(s, cell, ledger, result, foundNow);
		if (!detailed) return null;
		result.found.sort(function (a, b) {
			var ak = a.record.kindIndex, bk = b.record.kindIndex;
			return ak !== bk ? ak - bk : a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
		});
		return result;
	}
	function survey(s, cell, selection, ledger) {
		return surveyInternal(s, cell, selectedIndices(selection), ledger, null, true, null);
	}
	function campaignStart(state, catalogue, selection, ledger) {
		var indices = selectedIndices(selection);
		if (!indices.length) return { ok: false, reason: 'no instruments selected' };
		if (!state || !state.grid || !catalogue || !catalogue.records || !catalogue.cellStart)
			return { ok: false, reason: 'campaign requires a state and built deposit catalogue' };
		if (catalogue.level !== state.grid.level || catalogue.cellStart.length !== state.grid.V + 1
			|| catalogue.signature !== state.frame || catalogue.time !== state.t
			|| catalogue.epochMyr !== Math.round(state.t * 10) / 10)
			return { ok: false, reason: 'catalogue does not match the campaign snapshot' };
		if (!ledger) ledger = new Ledger(state.grid.V);
		if (ledger.coverage.length !== state.grid.V)
			return { ok: false, reason: 'survey ledger belongs to a different grid' };
		var selected = [];
		for (var i = 0; i < indices.length; i++) selected.push(LIST[indices[i]].id);
		var job = {
			ok: true, state: state, catalogue: catalogue, ledger: ledger,
			frame: state.frame, time: state.t, epochMyr: catalogue.epochMyr,
			indices: indices, instruments: selected, cursor: 0, total: state.grid.V,
			found: 0, viable: 0, seen: Object.create(null), foundNow: Object.create(null),
			running: true, done: false, cancelled: false, invalidated: false, reason: ''
		};
		for (var r = 0; r < catalogue.records.length; r++) {
			var record = catalogue.records[r];
			if (!ledger.byId[record.id]) continue;
			job.seen[record.id] = 1;
			job.found++;
			if (record.viable) job.viable++;
		}
		return job;
	}
	function campaignStep(job, maxCells, maxMs) {
		if (!job || !job.ok) return job || { ok: false, reason: 'missing campaign job' };
		if (!job.running) return job;
		if (job.state.frame !== job.frame || job.state.t !== job.time) {
			job.running = false; job.invalidated = true; job.reason = 'world changed';
			return job;
		}
		var limit = Number.isFinite(maxCells) ? Math.floor(maxCells) : 256;
		limit = Math.max(1, Math.min(256, limit));
		var budget = Number.isFinite(maxMs) ? Math.max(0, maxMs) : Infinity;
		var started = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
		var processed = 0;
		while (job.cursor < job.total && processed < limit) {
			surveyInternal(job.state, job.cursor, job.indices, job.ledger, job.catalogue, false, job.foundNow);
			job.cursor++; processed++;
			for (var id in job.foundNow) {
				if (job.seen[id]) continue;
				var entry = job.ledger.byId[id];
				if (!entry) continue;
				job.seen[id] = 1; job.found++;
				if (entry.record && entry.record.viable) job.viable++;
			}
			if (processed % 8 === 0 && budget !== Infinity) {
				var now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
				if (now - started >= budget) break;
			}
		}
		if (job.cursor >= job.total) { job.running = false; job.done = true; }
		return job;
	}
	function cancelCampaign(job) {
		if (!job || !job.ok || !job.running) return job;
		job.running = false; job.cancelled = true; job.reason = 'cancelled';
		return job;
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
	// A size is printed in its own ladder unit: Mt of ore for most rows, tonnes of U3O8 for
	// sandstone uranium. Grades carry the unit the class table drew them in.
	function sizeText(record) {
		return (record.size >= 1 ? countText(record.size) : String(record.size)) + ' ' + record.unit;
	}
	function gradeText(record) {
		var out = [];
		for (var metal in record.grade) out.push(metal + ' ' + record.grade[metal] + record.gradeUnit[metal]);
		return out.join(', ');
	}
	function economicsText(record) {
		var line = '\n      ' + record.variant + ' · ' + record.commodity + ' · ' + sizeText(record)
			+ ' (' + record.sizeClass + ')';
		var grades = gradeText(record);
		if (grades) line += ' @ ' + grades;
		line += ' · ' + record.bodies.length + (record.bodies.length === 1 ? ' body' : ' bodies');
		return line + ' · ' + (record.viable ? 'viable' : 'sub-economic: ' + record.reason);
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
				+ '  ' + rec.top + '-' + rec.bottom + ' m  ' + rec.host;
			if (item.stale) text += '  · retained in session';
			if (item.refinedFrom) text += '  · lab ' + CONFIDENCE[item.refinedFrom] + ' → ' + CONFIDENCE[item.entry.confidence];
			if (item.instruments.length) text += '  · ' + item.instruments.join('+');
			text += economicsText(rec);
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
		startCampaign: campaignStart,
		campaignStep: campaignStep,
		cancelCampaign: cancelCampaign,
		report: report,
		confidence: CONFIDENCE
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = Instruments;

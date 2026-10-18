/* core-log.js — globe-side filing for section observations (0.8.4).
 * The shared port owns every wire byte and the stratigraphic law. This module only compares
 * the decoded identities and keeps accepted observations in a page-local side table; it
 * never writes to State, kernels, checkpoints, or GPU buffers.
 */
var GlobeCoreLogFormat = typeof module !== 'undefined' && module.exports
	? require('../port/core-log-format.js') : CoreLogFormat;
var GlobeCoreLogPack = typeof module !== 'undefined' && module.exports
	? require('../port/slice-format.js') : SlicePack;

var CoreLog = (function (CF, SP) {
	function cloneBeds(records) {
		return records.map(function (record) {
			return { sKm: record.sKm, div: record.div, hTotM: record.hTotM,
				beds: record.beds.map(function (bed) { return bed.slice(); }) };
		});
	}
	function freezeDeep(value) {
		if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
		Object.keys(value).forEach(function (key) { freezeDeep(value[key]); });
		return Object.freeze(value);
	}
	function createTable() { return { entries: Object.create(null), order: [] }; }
	function artifact(pack) {
		if (!pack || !pack.path) return null;
		return {
			pathChecksum: SP.pathChecksum(pack.path),
			packChecksum: pack.checksum,
			arcKm: pack.path.arcKm
		};
	}
	function importText(table, text, current, options) {
		if (!table || !table.entries || !Array.isArray(table.order))
			throw new TypeError('a core-log table is required');
		options = options || {};
		// Parse and validate completely before consulting or mutating the side table.
		var message = CF.parse(text);
		var match = CF.identity(message, current);
		if (match.status === 'foreign')
			return { status: 'foreign', reason: match.reason, committed: false };
		if (match.status === 'stale' && !options.confirmStale)
			return { status: 'confirmation-required', reason: match.reason, committed: false };
		var key = message.pathChecksum + ':' + message.packChecksum;
		var source = freezeDeep({ pathChecksum: message.pathChecksum, packChecksum: message.packChecksum,
			arcKm: message.arcKm, tMyr: message.tMyr, epochMa: message.epochMa,
			format: message.format, version: message.version, lithologySchema: message.lithologySchema,
			checksum: message.checksum });
		var entry = freezeDeep({ key: key, importedAt: options.importedAt === undefined ? Date.now() : options.importedAt,
			sourceMetadata: source, records: cloneBeds(message.records),
			validationReport: 'pgt-core-log v2 passed shared validation',
			status: match.status, staleReason: match.status === 'stale' ? match.reason : '' });
		if (!table.entries[key]) table.order.push(key);
		table.entries[key] = entry;
		return { status: match.status, reason: match.reason, committed: true, entry: entry };
	}
	function freshness(entry, current, contextStaleReason) {
		if (!entry) return { status: 'foreign', reason: 'no observation' };
		if (entry.staleReason) return { status: 'stale', reason: entry.staleReason };
		if (contextStaleReason) return { status: 'stale', reason: contextStaleReason };
		return CF.identity({ pathChecksum: entry.sourceMetadata.pathChecksum,
			packChecksum: entry.sourceMetadata.packChecksum, arcKm: entry.sourceMetadata.arcKm }, current);
	}
	function nearest(entry, sKm) {
		if (!entry || !entry.records.length || !Number.isFinite(sKm)) return null;
		var best = entry.records[0], distance = Math.abs(best.sKm - sKm);
		for (var i = 1; i < entry.records.length; i++) {
			var d = Math.abs(entry.records[i].sKm - sKm);
			if (d < distance) { best = entry.records[i]; distance = d; }
		}
		return { record: best, distanceKm: distance };
	}
	function display(entry, current, contextStaleReason) {
		if (!entry) return 'No imported section observations.';
		var fresh = freshness(entry, current, contextStaleReason);
		var text = 'Observed section log · ' + fresh.status
			+ (fresh.status === 'stale' ? ' · ' + (entry.staleReason || fresh.reason) : '')
			+ ' · source pack ' + entry.sourceMetadata.packChecksum.slice(0, 8)
			+ ' · ' + entry.records.length + ' records';
		for (var i = 0; i < entry.records.length; i++) {
			var r = entry.records[i];
			text += '\n' + r.sKm + ' km · hTot ' + r.hTotM + ' m · div ' + r.div;
			for (var k = 0; k < r.beds.length; k++) {
				var b = r.beds[k];
				text += '\n  ' + CF.LITH[b[0]] + ' · ' + b[1] + ' m · formed '
					+ b[2] + ' Myr · flags ' + CF.FLAGS.filter(function (_, bit) { return b[3] & (1 << bit); }).join(',');
			}
		}
		return text;
	}
	return {
		FORMAT: CF.FORMAT, VERSION: CF.VERSION, LAYER_CAP: CF.LAYER_CAP,
		LITH: CF.LITH, FLAGS: CF.FLAGS, FLAG: CF.FLAG,
		createTable: createTable, artifact: artifact, importText: importText,
		freshness: freshness, nearest: nearest, display: display
	};
}(GlobeCoreLogFormat, GlobeCoreLogPack));

if (typeof module !== 'undefined' && module.exports) module.exports = CoreLog;

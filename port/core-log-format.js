/* core-log-format.js — pgt-core-log v2: the section's observation wire format.
 * Shared-identical with planet-geotectonics through port/PORT.json (slice 0.4.4 §2 P2/P3,
 * globe 0.8.4 §2). Self-contained by contract: it reads no other port file and no engine
 * module. The hash is this file's own two-lane FNV over the domain string below, the
 * quantisation is its own six-significant-digit rule, and every key order is written here,
 * so both projects can read one log the same way without sharing an engine.
 *
 * A log is an observation, not a material: a receiver files it in a side table and never
 * feeds it to a kernel. `packChecksum` is mandatory — a log whose full-pack identity is not
 * the receiver's current export is stale, never current (globe 0.8.3 §2.1, adopted).
 *
 * Beds are positional `[lithology, thicknessM, formedMyr, flags]` under the named vocabulary
 * `section-lith-1`, not objects: the name carries the vocabulary, the array carries the bed.
 * The flags are four bits in the order below; a bed formed earlier than the one under it is
 * legal only where an adjacent `intr` flag says the contact is an injection, not deposition.
 */
'use strict';

var CoreLogFormat = (function () {
	var FORMAT = 'pgt-core-log', VERSION = 2;
	var LITHOLOGY_SCHEMA = 'section-lith-1';
	var LITH = ['sed', 'fel', 'maf', 'tephra', 'lava', 'sill'];
	var FLAGS = ['wet', 'ore', 'unconf', 'intr'];
	var FLAG = { wet: 1, ore: 2, unconf: 4, intr: 8 };
	// the protocol's own stack bound: a section build may hold fewer beds, never more
	var LAYER_CAP = 96;
	// every bed is quantised alone, so the rounded total and the sum of rounded beds part
	// by up to a bed count of half ulps at each bed's own scale — 1.5 m is the same law
	// js/core-log.js used as v1, kept as one number for both sides
	var TH_TOL = 1.5;
	var AGE_EPS = 1e-9;
	var HEX = /^[0-9a-f]{16}$/;
	var HASH_DOMAIN = 'pgt-core-log-v2';
	var BODY_KEYS = ['format', 'version', 'pathChecksum', 'packChecksum', 'arcKm', 'tMyr',
		'epochMa', 'lithologySchema', 'records', 'checksum'];
	var LOG_KEYS = BODY_KEYS.slice(0, 9);
	var RECORD_KEYS = ['sKm', 'div', 'hTotM', 'beds'];
	var own = Object.prototype.hasOwnProperty;

	function round(v) {
		if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
		var rounded = +v.toPrecision(6);
		return rounded === 0 ? 0 : rounded;
	}
	function finite(v) {
		return typeof v === 'number' && Number.isFinite(v);
	}
	function object(v) {
		return v !== null && typeof v === 'object' && !Array.isArray(v);
	}
	function keysOk(value, required, optional, label) {
		var keys = Object.keys(value), i;
		for (i = 0; i < required.length; i++)
			if (!own.call(value, required[i])) return label + ' is missing ' + required[i];
		for (i = 0; i < keys.length; i++)
			if (required.indexOf(keys[i]) < 0 && optional.indexOf(keys[i]) < 0)
				return label + ' has unknown field ' + keys[i];
		return '';
	}

	// UTF-8 bytes of the hashed text. Written here rather than borrowed: a shared module may
	// not depend on another project's private helper (globe 0.8.3 §2.1 named that reach).
	function utf8(text) {
		var out = [], i, code;
		for (i = 0; i < text.length; i++) {
			code = text.charCodeAt(i);
			if (code < 0x80) out.push(code);
			else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
			else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
				var low = text.charCodeAt(i + 1);
				if (low >= 0xdc00 && low <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
					i++;
					out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63),
						0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
					continue;
				}
				out.push(0xef, 0xbf, 0xbd);
			} else if (code >= 0xdc00 && code <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
			else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		}
		return out;
	}
	// two lanes so a 32-bit FNV collision has to happen twice, in the same text
	function fnvText(value) {
		var bytes = utf8(HASH_DOMAIN + '\n' + JSON.stringify(value));
		var a = 0x811c9dc5, b = 0x9747b28c;
		for (var i = 0; i < bytes.length; i++) {
			a = Math.imul(a ^ bytes[i], 16777619);
			b = Math.imul(b ^ bytes[i] ^ 0x5a, 0x01000195);
		}
		return ('0000000' + (a >>> 0).toString(16)).slice(-8)
			+ ('0000000' + (b >>> 0).toString(16)).slice(-8);
	}

	// The canonical body, in this key order: the checksum is over exactly this text, so a
	// log that survives a JSON round trip is the same log. `records` are ordered columns.
	function body(msg) {
		var out = {
			format: msg.format, version: msg.version,
			pathChecksum: msg.pathChecksum, packChecksum: msg.packChecksum,
			arcKm: msg.arcKm, tMyr: msg.tMyr, epochMa: msg.epochMa,
			lithologySchema: msg.lithologySchema,
			records: []
		};
		for (var i = 0; i < msg.records.length; i++) {
			var r = msg.records[i];
			out.records.push({ sKm: r.sKm, div: r.div, hTotM: r.hTotM, beds: r.beds });
		}
		return out;
	}
	function checksum(msg) {
		return fnvText(body(msg));
	}

	// Six significant digits, once, so a log has one spelling. A number that is not finite
	// stays non-finite here and fails to a refusal in validate, not to a second spelling.
	function quantize(msg) {
		msg.arcKm = round(msg.arcKm);
		msg.tMyr = round(msg.tMyr);
		msg.epochMa = round(msg.epochMa);
		var i, k, r, b;
		for (i = 0; i < msg.records.length; i++) {
			r = msg.records[i];
			r.sKm = round(r.sKm);
			r.div = round(r.div);
			r.hTotM = round(r.hTotM);
			for (k = 0; k < r.beds.length; k++) {
				b = r.beds[k];
				b[1] = round(b[1]);
				b[2] = round(b[2]);
			}
		}
		return msg;
	}
	// hTotM is the sum of the rounded beds, so a record always survives its own rule
	function sumBeds(msg) {
		var i, k, sum;
		for (i = 0; i < msg.records.length; i++) {
			sum = 0;
			for (k = 0; k < msg.records[i].beds.length; k++) sum += msg.records[i].beds[k][1];
			msg.records[i].hTotM = round(sum);
		}
		return msg;
	}

	// The object skeleton only: what seal may quantise before the law runs on numbers.
	function shape(msg) {
		if (!object(msg)) return 'a core log must be an object';
		var bad = keysOk(msg, LOG_KEYS, ['checksum'], 'log'), i, k;
		if (bad) return bad;
		if (!Array.isArray(msg.records)) return 'records must be an array';
		for (i = 0; i < msg.records.length; i++) {
			var r = msg.records[i];
			if (!object(r)) return 'record ' + i + ' is not an object';
			bad = keysOk(r, RECORD_KEYS, [], 'record ' + i);
			if (bad) return bad;
			if (!Array.isArray(r.beds)) return 'record ' + i + ' has no bed list';
			for (k = 0; k < r.beds.length; k++)
				if (!Array.isArray(r.beds[k]) || r.beds[k].length !== 4)
					return 'record ' + i + ' bed ' + k + ' is not [lith, thM, formedMyr, flags]';
		}
		return '';
	}

	// The stratigraphic law, on the wire exactly as on a live stack: formation times never
	// decrease upward across a depositional contact. The injection flag on either bed
	// exempts the contact — an intrusion cuts both of its faces.
	function validate(msg) {
		var bad = shape(msg);
		if (bad) return bad;
		if (msg.format !== FORMAT) return 'not a ' + FORMAT + ' (' + msg.format + ')';
		if (msg.version !== VERSION) return 'log version ' + msg.version + ', this build reads ' + VERSION;
		if (msg.lithologySchema !== LITHOLOGY_SCHEMA)
			return 'unknown lithology schema ' + msg.lithologySchema + ', this build reads ' + LITHOLOGY_SCHEMA;
		if (!HEX.test(msg.pathChecksum || '')) return 'pathChecksum must be 16 hex digits';
		if (!HEX.test(msg.packChecksum || '')) return 'packChecksum must be 16 hex digits';
		if (!(finite(msg.arcKm) && msg.arcKm > 0)) return 'arcKm is not positive';
		if (!(finite(msg.tMyr) && msg.tMyr >= 0)) return 'tMyr out of range: ' + msg.tMyr;
		if (!finite(msg.epochMa)) return 'epochMa is not finite';
		if (!msg.records.length) return 'a core log carries at least one record';
		var i, k, b, r, sum, prev = -1;
		for (i = 0; i < msg.records.length; i++) {
			r = msg.records[i];
			if (!(finite(r.sKm) && r.sKm >= 0 && r.sKm < msg.arcKm)) return 'record ' + i + ' is off the cut';
			if (!(r.sKm > prev)) return 'records are not in ascending arc order at ' + i;
			prev = r.sKm;
			if (!(finite(r.div) && r.div >= 0)) return 'record ' + i + ' diverged fraction is not a number';
			if (!(finite(r.hTotM) && r.hTotM > 0)) return 'record ' + i + ' carries no crust';
			if (!r.beds.length) return 'record ' + i + ' has no beds';
			if (r.beds.length > LAYER_CAP) return 'record ' + i + ' exceeds the layer cap';
			sum = 0;
			for (k = 0; k < r.beds.length; k++) {
				b = r.beds[k];
				if (!(b[0] === Math.floor(b[0]) && b[0] >= 0 && b[0] < LITH.length))
					return 'record ' + i + ' bed ' + k + ' is not a lithology';
				if (!(finite(b[1]) && b[1] > 0))
					return 'record ' + i + ' bed ' + k + ' is not thicker than zero (' + b[1] + ')';
				if (!finite(b[2])) return 'record ' + i + ' bed ' + k + ' has no formation time';
				if (!(b[3] === Math.floor(b[3]) && b[3] >= 0 && b[3] <= 15))
					return 'record ' + i + ' bed ' + k + ' flags are not four bits';
				sum += b[1];
			}
			if (Math.abs(sum - r.hTotM) > TH_TOL)
				return 'record ' + i + ' thicknesses do not sum: ' + sum + ' vs ' + r.hTotM;
			for (k = 1; k < r.beds.length; k++) {
				if ((r.beds[k][3] | r.beds[k - 1][3]) & FLAG.intr) continue;
				if (r.beds[k][2] < r.beds[k - 1][2] - AGE_EPS)
					return 'record ' + i + ' ages are not monotone at bed ' + k;
			}
		}
		if (msg.checksum !== undefined && msg.checksum !== '') {
			if (typeof msg.checksum !== 'string' || !HEX.test(msg.checksum))
				return 'checksum must be 16 hex digits';
			if (msg.checksum !== checksum(msg)) return 'checksum mismatch';
		}
		return '';
	}

	function verify(msg) {
		if (!msg || typeof msg.checksum !== 'string' || !HEX.test(msg.checksum))
			return 'the log carries no checksum';
		try { return msg.checksum === checksum(msg) ? '' : 'checksum mismatch: the log was edited or truncated'; }
		catch (e) { return 'the log cannot be serialised'; }
	}

	// The builder's seam: quantise, close the thickness sum, stamp, then run the same law the
	// receiver will run. A message this refuses never leaves the build.
	function seal(msg) {
		var bad = shape(msg);
		if (bad) throw new RangeError(bad);
		quantize(msg);
		sumBeds(msg);
		msg.checksum = checksum(msg);
		bad = validate(msg);
		if (bad) throw new RangeError('a core log this build made is invalid: ' + bad);
		return msg;
	}

	// One spelling on the wire: a valid, sealed message and nothing else.
	function encode(msg) {
		if (!msg || typeof msg.checksum !== 'string' || !HEX.test(msg.checksum))
			throw new RangeError('encode needs a sealed log: no checksum');
		var bad = validate(msg);
		if (bad) throw new RangeError(bad);
		var out = body(msg);
		out.checksum = msg.checksum;
		return JSON.stringify(out);
	}

	// A parsed log must say what it is: validate tolerates an absent checksum so a freshly
	// built one can be checked before it is stamped, but a text off the wire cannot omit it.
	// Quantise before judging, the v1 rule: the wire may carry more digits than the rule, the
	// record cannot — and the checksum is then verified over the numbers the receiver would keep.
	function parse(text) {
		if (typeof text !== 'string') throw new TypeError('core log input must be JSON text');
		var msg;
		try { msg = JSON.parse(text); }
		catch (error) { throw new SyntaxError('core log is not valid JSON: ' + error.message); }
		var bad = shape(msg);
		if (bad) throw new RangeError(bad);
		quantize(msg);
		if (typeof msg.checksum !== 'string' || !HEX.test(msg.checksum))
			throw new RangeError('a parsed log must carry its 16-hex checksum');
		bad = validate(msg);
		if (bad) throw new RangeError(bad);
		return msg;
	}

	// The import decision, identical on both sides (globe 0.8.3 §2.2/§2.3): a different path
	// is foreign and refused; the same path over a different full pack is stale and may only
	// be archived after confirmation; only an exact identity is current.
	function identity(msg, artifact) {
		if (!artifact) return { status: 'foreign', reason: 'no exported pack to compare against' };
		if (msg.pathChecksum !== artifact.pathChecksum)
			return { status: 'foreign', reason: 'pathChecksum ' + msg.pathChecksum + ' is not this cut' };
		if (!finite(artifact.arcKm) || round(msg.arcKm) !== round(artifact.arcKm))
			return { status: 'foreign', reason: 'arcKm ' + msg.arcKm + ' is not this cut (' + artifact.arcKm + ')' };
		if (msg.packChecksum !== artifact.packChecksum)
			return { status: 'stale', reason: 'source pack ' + msg.packChecksum + ' is not the current export ' + artifact.packChecksum };
		return { status: 'current', reason: '' };
	}

	return {
		FORMAT: FORMAT, VERSION: VERSION,
		LITHOLOGY_SCHEMA: LITHOLOGY_SCHEMA, LITH: LITH, FLAGS: FLAGS, FLAG: FLAG,
		LAYER_CAP: LAYER_CAP, TH_TOL: TH_TOL, AGE_EPS: AGE_EPS, HASH_DOMAIN: HASH_DOMAIN,
		round: round, body: body, checksum: checksum, quantize: quantize, sumBeds: sumBeds,
		seal: seal, validate: validate, verify: verify, encode: encode, parse: parse,
		identity: identity
	};
}());

if (typeof module !== 'undefined' && module.exports) module.exports = CoreLogFormat;

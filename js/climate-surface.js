// Globe -> climate surface exchange (0.9.1). This runs inside the climate iframe, where the
// two repositories' Grid globals cannot collide. Every target cell is mapped by direction
// through the source globe's own nearest-cell raster; cell indices are never assumed equal.
// The packet is also the held geometry saved with a joint session.
var ClimateSurface = (function () {
	'use strict';
	var FORMAT = 'pgt-climate-surface', VERSION = 1, TAU = Math.PI * 2;

	function cellsAt(level) { return 10 * Math.pow(4, level) + 2; }
	function integer(value) { return Number.isInteger(value); }
	function validLevel(value) { return integer(value) && value >= 0 && value <= 7; }

	function validate(surface) {
		if (!surface || surface.format !== FORMAT || surface.version !== VERSION)
			throw new RangeError('not a pgt-climate-surface v1 packet');
		if (!validLevel(surface.level) || surface.V !== cellsAt(surface.level))
			throw new RangeError('climate surface level/cell count mismatch');
		if (surface.targetLevel !== undefined && !validLevel(surface.targetLevel))
			throw new RangeError('climate surface target level');
		if (!integer(surface.lookupW) || !integer(surface.lookupH)
			|| surface.lookupW < 1 || surface.lookupH < 1)
			throw new RangeError('climate surface lookup dimensions');
		if (!(surface.lookup instanceof Float32Array) || !(surface.elevation instanceof Float64Array))
			throw new RangeError('climate surface array types');
		if (surface.lookup.length !== surface.lookupW * surface.lookupH)
			throw new RangeError('climate surface lookup length');
		if (surface.elevation.length !== surface.V)
			throw new RangeError('climate surface elevation length');
		if (!Number.isFinite(surface.seaLevel) || !Number.isFinite(surface.tMyr) || surface.tMyr < 0)
			throw new RangeError('climate surface clock/sea level');
		for (var i = 0; i < surface.V; i++) {
			// NaN is the globe's explicit uncovered-cell marker, not a missing number. Preserve
			// it in the held packet and map it to abyssal ocean only at application time.
			if (!Number.isFinite(surface.elevation[i]) && !Number.isNaN(surface.elevation[i]))
				throw new RangeError('climate surface elevation ' + i);
		}
		for (var j = 0; j < surface.lookup.length; j++) {
			var cell = surface.lookup[j];
			if (!integer(cell) || cell < 0 || cell >= surface.V) throw new RangeError('climate surface lookup id ' + j);
		}
		return surface;
	}

	function sourceCell(surface, x, y, z) {
		var length = Math.hypot(x, y, z);
		if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('climate target cell direction');
		y /= length;
		var lon = Math.atan2(z / length, x / length);
		var lat = Math.asin(Math.max(-1, Math.min(1, y)));
		var px = Math.floor((lon / TAU + 0.5) * surface.lookupW);
		var py = Math.floor((lat / Math.PI + 0.5) * surface.lookupH);
		px = Math.max(0, Math.min(surface.lookupW - 1, px));
		py = Math.max(0, Math.min(surface.lookupH - 1, py));
		return surface.lookup[py * surface.lookupW + px];
	}

	// Mutate only the climate engine's public static geometry tables and their textures. The
	// fluid state belongs to Planet and is not rewritten here. coastDist (cellC.w) is a build-
	// time input to the procedural bathymetry generator, not a runtime shader input; it is
	// zeroed rather than retaining a distance to the previous, unrelated coastline.
	function apply(planet, surface) {
		validate(surface);
		if (!planet || !planet.grid || !planet.params || typeof planet.writeTex !== 'function')
			throw new TypeError('a climate Planet is required');
		var grid = planet.grid, params = planet.params;
		if (!grid.cellA || !grid.cellB || !grid.cellC || !planet.texCellB || !planet.texCellC)
			throw new TypeError('climate Planet geometry is incomplete');
		var landCells = 0, gapCells = 0, oceanArea = 0, oceanVolume = 0;
		var minBed = Infinity, maxBed = -Infinity;
		for (var i = 0; i < grid.V; i++) {
			var a = i * 4;
			var source = sourceCell(surface, grid.cellA[a], grid.cellA[a + 1], grid.cellA[a + 2]);
			var elevation = surface.elevation[source], gap = Number.isNaN(elevation);
			// An uncovered globe cell has no authoritative bed height. It is an ocean gap for
			// this display-only coupling stage, using climate's own named abyssal depth.
			var bed = gap ? -(params.depthMax || 4000) : elevation - surface.seaLevel;
			var land = !gap && bed >= 0 ? 1 : 0;
			var depth = land ? Math.max(5, params.dShelf || 200) : Math.max(5, -bed);
			var href = Math.max(1, Math.min(params.hTop || 60, depth * 0.4));
			grid.cellB[a + 3] = land;
			grid.cellC[a] = depth;
			grid.cellC[a + 1] = href;
			grid.cellC[a + 2] = land ? bed : -depth;
			grid.cellC[a + 3] = 0;
			if (land) landCells++;
			else {
				oceanArea += grid.cellA[a + 3];
				oceanVolume += depth * grid.cellA[a + 3];
			}
			if (gap) gapCells++;
			else {
				minBed = Math.min(minBed, bed);
				maxBed = Math.max(maxBed, bed);
			}
		}
		planet.writeTex(planet.texCellB, grid.cellB);
		planet.writeTex(planet.texCellC, grid.cellC);
		grid.landFraction = landCells / grid.V;
		grid.oceanArea = oceanArea;
		grid.oceanVolume = oceanVolume;
		planet.globals = null;
		planet.lastGlobalsT = null;
		planet._bakeKey = null;
		planet.vflowInit = false;
		surface.targetLevel = grid.level;
		return {
			level: grid.level, cells: grid.V, landCells: landCells, gapCells: gapCells,
			landFraction: grid.landFraction, oceanArea: oceanArea, oceanVolume: oceanVolume,
			minElevation: minBed, maxElevation: maxBed,
			surfaceTMyr: surface.tMyr, seaLevel: surface.seaLevel
		};
	}

	function toBase64(array) {
		var bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		var binary = '', chunk = 0x8000;
		for (var i = 0; i < bytes.length; i += chunk)
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		return btoa(binary);
	}

	function fromBase64(text, Type, length, label) {
		if (typeof text !== 'string' || !text.length || text.length % 4
			|| !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new RangeError(label + ' base64');
		var binary = atob(text);
		if (binary.length !== length * Type.BYTES_PER_ELEMENT) throw new RangeError(label + ' byte length');
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new Type(bytes.buffer);
	}

	function encode(surface) {
		validate(surface);
		return {
			format: FORMAT, version: VERSION,
			level: surface.level, targetLevel: surface.targetLevel, V: surface.V,
			lookupW: surface.lookupW, lookupH: surface.lookupH,
			seaLevel: surface.seaLevel, tMyr: surface.tMyr,
			lookup: toBase64(surface.lookup), elevation: toBase64(surface.elevation)
		};
	}

	function decode(encoded) {
		if (!encoded || encoded.format !== FORMAT || encoded.version !== VERSION)
			throw new RangeError('not an encoded pgt-climate-surface v1 packet');
		if (!integer(encoded.lookupW) || !integer(encoded.lookupH) || encoded.lookupW < 1 || encoded.lookupH < 1
			|| !validLevel(encoded.level) || encoded.V !== cellsAt(encoded.level))
			throw new RangeError('encoded climate surface dimensions');
		var surface = {
			format: FORMAT, version: VERSION,
			level: encoded.level, targetLevel: encoded.targetLevel, V: encoded.V,
			lookupW: encoded.lookupW, lookupH: encoded.lookupH,
			seaLevel: encoded.seaLevel, tMyr: encoded.tMyr,
			lookup: fromBase64(encoded.lookup, Float32Array, encoded.lookupW * encoded.lookupH, 'climate lookup'),
			elevation: fromBase64(encoded.elevation, Float64Array, encoded.V, 'climate elevation')
		};
		return validate(surface);
	}

	return {
		FORMAT: FORMAT, VERSION: VERSION, cellsAt: cellsAt,
		validate: validate, sourceCell: sourceCell, apply: apply,
		encode: encode, decode: decode
	};
}());
if (typeof module !== 'undefined' && module.exports) module.exports = ClimateSurface;

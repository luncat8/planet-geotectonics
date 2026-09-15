/* env.js - the one-line environment header every capture carries.
   A log's first line has to say which machine produced the numbers, but a full UA string plus
   the adapter's description is ~200 characters of model names no comparison ever reads. What a
   reader diffs is the minute the run started (seconds are noise), the browser at its major
   version, the OS with the CPU architecture, and the GPU as a type plus one vendor word.
   Classic script for the pages; module.exports guarded so node can require it. */
var Env = {
	pad: function (n) { return n < 10 ? '0' + n : String(n); },
	// '2026-09-15 01:34'
	stamp: function (date) {
		date = date || new Date();
		return date.getFullYear() + '-' + Env.pad(date.getMonth() + 1) + '-' + Env.pad(date.getDate())
			+ ' ' + Env.pad(date.getHours()) + ':' + Env.pad(date.getMinutes());
	},
	// '2026-09-15-01-34' - the same stamp where a filename cannot take ':' or ' '
	fileStamp: function (date) {
		return Env.stamp(date).replace(' ', '-').replace(':', '-');
	},
	ua: function () { return (typeof navigator !== 'undefined' && navigator.userAgent) || ''; },
	// Order matters: Edge and Opera carry "Chrome/" too, and Safari carries neither "Chrome/"
	// nor "Firefox/" - its version is the "Version/<n>" token.
	BROWSERS: [[/Edg[A-Za-z]*\/(\d+)/, 'edge'], [/OPR\/(\d+)/, 'opera'], [/Firefox\/(\d+)/, 'firefox'],
		[/Chrome\/(\d+)/, 'chrome'], [/Version\/(\d+)[^)]*Safari/, 'safari']],
	browser: function (ua) {
		ua = ua || Env.ua();
		for (var i = 0; i < Env.BROWSERS.length; i++) {
			var hit = Env.BROWSERS[i][0].exec(ua);
			if (hit) return Env.BROWSERS[i][1] + ' ' + hit[1];
		}
		return 'unknown';
	},
	// OS and CPU architecture, never the model: 'linux x86_64', 'win x86_64', 'mac'. The Mac UA
	// reports "Intel" on an M-series machine too, so no architecture is claimed there (Chrome
	// exposes the real one only through an async high-entropy call, and a wrong claim is worse
	// than a missing field).
	platform: function (ua, nav) {
		nav = nav || (typeof navigator !== 'undefined' ? navigator : null);
		var text = (ua || (nav && nav.userAgent) || '') + ' ' + ((nav && nav.platform) || '');
		if (/Windows|Win32|Win64|ARM64/.test(text)) return 'win ' + (/ARM64|aarch64/i.test(text) ? 'arm64' : 'x86_64');
		if (/Android/.test(text)) return 'android ' + (/ARM64|aarch64|arm64/i.test(text) ? 'arm64' : 'x86_64');
		if (/Macintosh|Mac OS X|MacIntel/.test(text)) return 'mac';
		if (/Linux|X11|CrOS/.test(text)) return 'linux ' + (/aarch64|arm64/.test(text) ? 'arm64' : 'x86_64');
		return 'unknown';
	},
	// GPU type plus one vendor word: 'hardware nvidia', 'software swiftshader', 'none'. The
	// adapter's device/description/architecture strings (the model name) are dropped on purpose;
	// a software adapter is the thing a comparison has to be able to spot at a glance.
	gpu: function (adapter, fallback) {
		if (!adapter) return 'none';
		var info = adapter.info || {};
		var vendor = String(info.vendor || '').toLowerCase().split(/[^a-z0-9]+/)[0];
		var model = String(info.description || info.device || info.architecture || '').toLowerCase();
		if (fallback || vendor === 'google' || /swiftshader|llvmpipe|lavapipe|software/.test(model)) {
			return 'software ' + (vendor === 'google' || !vendor ? 'swiftshader' : vendor);
		}
		return 'hardware ' + (vendor || 'unknown');
	},
	// '2026-09-15 01:34 · chrome 151 · linux x86_64'
	line: function () {
		return Env.stamp() + ' · ' + Env.browser() + ' · ' + Env.platform();
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Env;

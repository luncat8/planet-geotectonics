/* clipboard.js - the "Copy" buttons on index.html and bench.html.
   Both pages are opened over file://, where navigator.clipboard exists but its write can
   still be rejected (no transient activation after an await, a locked-down profile), so the
   hidden-textarea path is kept as the fallback rather than as legacy support: it is the only
   one that works there. A capture the owner has to retype by hand is a capture that does not
   happen, which is why the pages carry this at all. */
var Clipboard = {
	writeText: function (text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(function () {
				return true;
			}, function () {
				return Clipboard.legacy(text);
			});
		}
		return Promise.resolve(Clipboard.legacy(text));
	},
	legacy: function (text) {
		var area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
		document.body.appendChild(area);
		area.select();
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
		document.body.removeChild(area);
		return ok;
	},
	// Wire a button to a text source and say whether it worked on the button itself.
	bind: function (button, getText) {
		if (!button) return null;
		var label = button.textContent;
		button.addEventListener('click', function () {
			Clipboard.writeText(getText()).then(function (ok) {
				button.textContent = ok ? 'Copied ✓' : 'Copy failed';
				setTimeout(function () { button.textContent = label; }, 1200);
			});
		});
		return button;
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Clipboard;

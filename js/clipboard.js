/* clipboard.js - the copy controls on index.html, bench.html and webgpu-smoke.html.
   These pages are opened over file://, where navigator.clipboard exists but its write can
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
	ACK_MS: 1200,
	// Buttons use their label for acknowledgement; content controls can supply another style.
	bind: function (element, getText, ack) {
		if (!element) return null;
		ack = ack || Clipboard.labelAck(element);
		element.addEventListener('click', function () {
			Clipboard.writeText(getText()).then(ack);
		});
		return element;
	},
	labelAck: function (button) {
		var label = button.textContent;
		return function (ok) {
			button.textContent = ok ? 'Copied ✓' : 'Copy failed';
			setTimeout(function () { button.textContent = label; }, Clipboard.ACK_MS);
		};
	},
	classAck: function (element) {
		var timer = 0;
		return function (ok) {
			var name = ok ? 'copied' : 'copy-failed';
			clearTimeout(timer);
			element.classList.remove('copied');
			element.classList.remove('copy-failed');
			element.classList.add(name);
			timer = setTimeout(function () { element.classList.remove(name); }, Clipboard.ACK_MS);
		};
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Clipboard;

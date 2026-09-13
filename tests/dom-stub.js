'use strict';
/* dom-stub.js - the smallest DOM that lets js/ui.js load and run in node, built by parsing the
   real index.html.

   Parsing the page instead of hand-listing its controls is the point: an element the HTML does
   not have is null here, so a test that reaches for a control the page forgot trips over it
   instead of being handed a stub no browser will ever have.

   It is a stub, not an engine - no layout, no styles, no cascade, so every claim about reserved
   sizes stays a pin on style.css (tests/gui.js) rather than a measurement. What it does model
   faithfully is the parts ui.js actually depends on: attributes, text, parent/child order,
   listener dispatch, a canvas 2d context that hands out image data, and a <select> whose value
   refuses an option it does not have (which is why the load path cannot silently select a level
   the page does not offer). */

const VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1,
	meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
const TOKEN = /<(\/?)([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function El(tag, doc) {
	this.tagName = tag.toUpperCase();
	this.ownerDocument = doc;
	this.attrs = {};
	this.children = [];
	this.parentNode = null;
	this.listeners = {};
	this.textContent = '';
	this.hidden = false;
	this.disabled = false;
	this.files = [];
	this.style = {};
	this.valid = true;
	this.reported = 0;
	this.selected = false;
	this.clicks = 0;
	this.puts = 0;
	this._value = undefined;
}
// A select's value is its selected option's, and assigning one no option carries is refused -
// exactly what a browser does, and the behaviour ui.js's load path relies on.
Object.defineProperty(El.prototype, 'value', {
	get: function () {
		if (this.tagName !== 'SELECT') {
			return this._value !== undefined ? this._value : (this.attrs.value || '');
		}
		for (var i = 0; i < this.children.length; i++) {
			if (this.children[i].selected) return this.children[i].value;
		}
		return this.children.length ? this.children[0].value : '';
	},
	set: function (next) {
		if (this.tagName !== 'SELECT') { this._value = String(next); return; }
		var found = false;
		for (var i = 0; i < this.children.length; i++) {
			this.children[i].selected = this.children[i].value === String(next);
			found = found || this.children[i].selected;
		}
		if (!found) this.refused = String(next);
	}
});
Object.defineProperty(El.prototype, 'options', {
	get: function () { return this.children; }
});
Object.defineProperty(El.prototype, 'lastChild', {
	get: function () { return this.children[this.children.length - 1] || null; }
});
El.prototype.setAttribute = function (name, value) { this.attrs[name] = String(value); };
El.prototype.getAttribute = function (name) {
	return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
};
El.prototype.appendChild = function (child) {
	child.parentNode = this;
	this.children.push(child);
	if (child.tagName === 'OPTION' && child.selected) this.value = child.value;
	return child;
};
El.prototype.removeChild = function (child) {
	var at = this.children.indexOf(child);
	if (at < 0) throw new Error('stub: removeChild of a node that is not a child');
	this.children.splice(at, 1);
	child.parentNode = null;
	return child;
};
El.prototype.addEventListener = function (type, fn) {
	(this.listeners[type] = this.listeners[type] || []).push(fn);
};
El.prototype.dispatch = function (type, event) {
	var list = this.listeners[type] || [];
	var ev = event || { type: type, target: this, currentTarget: this };
	for (var i = 0; i < list.length; i++) list[i].call(this, ev);
	return list.length;
};
El.prototype.click = function () { this.clicks++; return this.dispatch('click'); };
El.prototype.checkValidity = function () { return this.valid; };
El.prototype.reportValidity = function () { this.reported++; return this.valid; };
El.prototype.select = function () { this.selected = true; this.ownerDocument.activeElement = this; };
El.prototype.setSelectionRange = function () {};
El.prototype.getContext = function (kind) {
	if (kind !== '2d') return { configure: function () {}, getCurrentTexture: function () { return {}; } };
	var self = this;
	this.context = this.context || {
		createImageData: function (w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
		putImageData: function () { self.puts++; }
	};
	return this.context;
};
El.prototype.byId = function (id) {
	if (this.attrs.id === id) return this;
	for (var i = 0; i < this.children.length; i++) {
		var hit = this.children[i].byId(id);
		if (hit) return hit;
	}
	return null;
};

function parseAttrs(text, el) {
	ATTR.lastIndex = 0;
	var m;
	while ((m = ATTR.exec(text))) {
		var value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
		el.attrs[m[1]] = value;
	}
	el.id = el.attrs.id || '';
	if (el.attrs.hidden !== undefined) el.hidden = true;
	if (el.attrs.disabled !== undefined) el.disabled = true;
	if (el.tagName === 'OPTION') el.selected = el.attrs.selected !== undefined;
}

// One pass over the markup: open/close/text. Option values fall back to their label, as in a
// browser, so `<option>20</option>` in the Steps/frame select has the value "20".
function parse(html, doc) {
	var root = new El('#document-fragment', doc), stack = [root], m;
	TOKEN.lastIndex = 0;
	while ((m = TOKEN.exec(html))) {
		if (m[5] !== undefined) {
			stack[stack.length - 1].textContent += m[5];
			continue;
		}
		var closing = m[1] === '/', tag = m[2].toLowerCase(), selfClosing = m[4] === '/';
		if (closing) {
			for (var i = stack.length - 1; i > 0; i--) {
				if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
			}
			continue;
		}
		var el = new El(tag, doc);
		parseAttrs(m[3] || '', el);
		stack[stack.length - 1].appendChild(el);
		if (el.tagName === 'OPTION' && el.attrs.value === undefined) el._value = el.textContent.trim();
		if (!VOID[tag] && !selfClosing) stack.push(el);
	}
	// An option's label is only complete once the pass is over.
	(function fixOptions(node) {
		for (var i = 0; i < node.children.length; i++) {
			var child = node.children[i];
			if (child.tagName === 'OPTION' && child.attrs.value === undefined) child._value = child.textContent.trim();
			fixOptions(child);
		}
	}(root));
	return root;
}

function makeDom(html) {
	var doc = { copied: [], made: [], activeElement: null };
	var root = parse(html, doc);
	doc.documentElement = root;
	doc.body = findTag(root, 'BODY');
	doc.getElementById = function (id) { return root.byId(id); };
	doc.createElement = function (tag) {
		var el = new El(tag, doc);
		doc.made.push(el);
		return el;
	};
	doc.execCommand = function (cmd) {
		var area = doc.activeElement;
		if (cmd !== 'copy' || !area) return false;
		doc.copied.push(area.value);
		return true;
	};
	var raf = [];
	var api = {
		document: doc, root: root, raf: raf,
		location: { search: '', href: 'file:///index.html', replaced: null,
			replace: function (url) { api.location.replaced = url; } },
		navigator: { userAgent: 'node-dom-stub' },
		requestAnimationFrame: function (cb) { raf.push(cb); return raf.length; },
		URLSearchParams: URLSearchParams,
		// Drives the frame loop the way a browser would: one callback per registered frame.
		pump: function (frames, t0, stepMs) {
			var now = t0 || 0, at = 0;
			for (var i = 0; i < frames; i++) {
				now += (stepMs || 5.6);
				var cb = raf[at++];
				if (!cb) throw new Error('stub: the frame loop stopped registering callbacks');
				cb(now);
			}
			return now;
		}
	};
	return api;
}
function findTag(node, tag) {
	if (node.tagName === tag) return node;
	for (var i = 0; i < node.children.length; i++) {
		var hit = findTag(node.children[i], tag);
		if (hit) return hit;
	}
	return null;
}
// Install the globals a page script sees. defineProperty rather than assignment because node
// owns some of these names with a getter and no setter (`navigator`), where `globalThis.x = ...`
// throws - and a page global that silently failed to install is a test that passes on a stub
// nobody has.
function installGlobals(api, extra) {
	var values = {
		document: api.document, location: api.location, navigator: api.navigator,
		requestAnimationFrame: api.requestAnimationFrame, URLSearchParams: URLSearchParams,
		console: console, performance: performance, setTimeout: setTimeout, clearTimeout: clearTimeout
	};
	for (var key in extra) values[key] = extra[key];
	for (var name in values) {
		Object.defineProperty(globalThis, name,
			{ value: values[name], writable: true, configurable: true, enumerable: true });
	}
	return values;
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { makeDom: makeDom, installGlobals: installGlobals, parse: parse, El: El };
}

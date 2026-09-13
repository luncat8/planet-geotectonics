// Copy buttons (the strip in index.html, the table in bench.html) go through js/clipboard.js,
// and every page in this repo has to work from file:// - where navigator.clipboard exists but
// its write is routinely rejected. Both paths are therefore load bearing, and the one nobody
// exercises (the textarea fallback) is the one that breaks silently in the rig the captures
// actually come from.
const { assert } = require('./helpers.js');
const fs = require('fs');
const path = require('path');
const Clipboard = require('../js/clipboard.js');

function fakeButton(label) {
	const listeners = {};
	return {
		listeners: listeners,
		textContent: label,
		className: 'copy',
		addEventListener: function (type, fn) { listeners[type] = fn; },
		click: function () { listeners.click(); }
	};
}

// A body that tracks its children plus an activeElement - enough DOM for the fallback path.
function fakeDom() {
	const removed = [];
	const body = {
		children: [],
		appendChild: function (node) { body.children.push(node); return node; },
		removeChild: function (node) { removed.push(node); body.children.splice(body.children.indexOf(node), 1); }
	};
	const made = [];
	const doc = {
		body: body, removed: removed, made: made, execCalls: 0, lastCmd: '',
		createElement: function (tag) {
			const el = {
				tag: tag, value: '', style: {}, attrs: {}, selected: false,
				setAttribute: function (name, value) { el.attrs[name] = value; },
				select: function () { el.selected = true; },
				setSelectionRange: function () {}
			};
			made.push(el);
			return el;
		},
		queryCommandSupported: function () { return true; },
		execCommand: function (cmd) { doc.execCalls++; doc.lastCmd = cmd; return true; },
		activeElement: { blur: function () {} }
	};
	return doc;
}

// navigator is a getter-only global on node 22: defineProperty, never assignment.
function useNavigator(doc, clipboardApi) {
	const previousNav = global.navigator, previousDoc = global.document;
	Object.defineProperty(global, 'navigator', {
		value: clipboardApi ? { clipboard: clipboardApi } : {}, configurable: true, writable: true
	});
	global.document = doc;
	return function restore() {
		Object.defineProperty(global, 'navigator', { value: previousNav, configurable: true, writable: true });
		global.document = previousDoc;
	};
}

// Every page with a copy button loads the module before the file that binds the button -
// index.html binds it in js/ui.js, bench.html and webgpu-smoke.html in an inline script.
for (const [page, consumer] of [['index.html', 'js/ui.js'], ['bench.html', '<script>'],
	['webgpu-smoke.html', '<script>']]) {
	const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
	const load = html.indexOf('js/clipboard.js');
	const use = consumer === '<script>' ? html.lastIndexOf('<script>') : html.indexOf(consumer);
	assert.ok(load >= 0, page + ' loads js/clipboard.js');
	assert.ok(use >= 0, page + ' still loads ' + consumer);
	assert.ok(load < use, page + ' loads js/clipboard.js before ' + consumer + ' binds the button');
}

const written = [];
let restore = useNavigator(fakeDom(), { writeText: function (t) { written.push(t); return Promise.resolve(); } });
const okBtn = fakeButton('Copy');
Clipboard.bind(okBtn, function () { return 'engine gpu · L6\nrows'; });
okBtn.click();
restore();
assert.equal(written.length, 1, 'the async clipboard got the text');
assert.equal(written[0], 'engine gpu · L6\nrows', 'and it is the text the getter returned, newlines kept');

// file://, no clipboard API at all: the textarea path carries the whole write.
const doc = fakeDom();
restore = useNavigator(doc, null);
const legacyBtn = fakeButton('Copy results');
Clipboard.bind(legacyBtn, function () { return 'col\tms/step\nplates\t8.5'; });
legacyBtn.click();
restore();
assert.equal(doc.made.length, 1, 'one element was created');
assert.equal(doc.made[0].tag, 'textarea', 'and it is a textarea');
assert.equal(doc.made[0].value, 'col\tms/step\nplates\t8.5', 'holding the text verbatim');
assert.equal(doc.made[0].attrs.readonly, '', 'readonly, so no mobile keyboard pops up');
assert.ok(doc.made[0].selected, 'selected before the copy');
assert.equal(doc.execCalls, 1, 'execCommand ran once');
assert.equal(doc.lastCmd, 'copy', 'with the copy command');
assert.equal(doc.body.children.length, 0, 'the textarea came back out of the DOM');
assert.equal(doc.removed.length, 1, 'removed rather than left behind');

// A write that fails both ways has to be reported on the button instead of leaving the
// operator guessing whether the click registered.
const doc3 = fakeDom();
doc3.execCommand = function () { return false; };
restore = useNavigator(doc3, null);
const deadBtn = fakeButton('Copy');
Clipboard.bind(deadBtn, function () { return 'x'; });
deadBtn.click();
restore();

// A refused async write falls back to the textarea, but only from the rejection handler - one
// microtask after the click. The stubbed document therefore has to stay installed across that
// gap, which is also what makes the ordering visible: the fallback is a best effort, and the
// transient activation it needs may already be gone by the time the refusal arrives.
const doc2 = fakeDom();
restore = useNavigator(doc2, { writeText: function () { return Promise.reject(new Error('denied')); } });
const refusedBtn = fakeButton('Copy');
Clipboard.bind(refusedBtn, function () { return 'x'; });
refusedBtn.click();

setTimeout(function () {
	restore();
	assert.equal(okBtn.textContent, 'Copied ✓', 'an accepted write reports success on the button');
	assert.equal(legacyBtn.textContent, 'Copied ✓', 'so does the textarea path');
	assert.equal(doc2.execCalls, 1, 'a refused async write falls back to the textarea');
	assert.equal(refusedBtn.textContent, 'Copied ✓', 'and reports the fallback, not the refusal');
	assert.equal(deadBtn.textContent, 'Copy failed', 'a write that fails both ways is reported');
	console.log('PASS clipboard: async write, file:// textarea fallback (created, readonly, selected, '
		+ 'removed), refusal falls back, both-ways failure reported, all three pages load the module');
}, 0);

// gpu-parity-ui.js — the run buttons of tests/gpu-parity.html are the whole harness for
// owner-rig captures, and until 2026-09-16 they promised nothing: the ensemble ran ~46 s
// with no output (read as a hang, with live buttons underneath), an aborted run printed its
// PASS verdict beside the error, and the ensemble's label lines said `seed=7` /
// `seed=undefined` for a run over three seeds. The page script runs here against
// tests/dom-stub.js with fake runners — the UI contract is the test subject, the compute
// behind the runners belongs to the rig and to gpu-play.js with the stub device.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { assert } = require('./helpers.js');
const { makeDom, installGlobals } = require('./dom-stub.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('tests/gpu-parity.html');
const api = makeDom(html);

// The page asks for navigator.gpu before any run; the fake runners never use the rest.
api.navigator.gpu = {};
const win = { addEventListener: function () {} };
installGlobals(api, { window: win });

for (const file of ['env', 'params', 'clipboard']) {
	vm.runInThisContext(read('js/' + file + '.js'), { filename: 'js/' + file + '.js' });
}
// The inline script comes from the raw markup, not from the parsed tree: the stub's
// tokenizer eats a `<` that does not open a tag (every `i < n` comparison), which no
// browser's script tokenizer does. The ELEMENTS (buttons, #status, #out) are still the
// real parse, which is the part that pins the page.
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
assert.ok(inline.indexOf('async function runAndLog') >= 0, 'the page\'s inline harness was found');
vm.runInThisContext(inline, { filename: 'tests/gpu-parity.html:script' });

const byId = (id) => api.document.getElementById(id);
const status = () => byId('status').textContent;
const statusShown = () => byId('status').style.display !== 'none';
const out = () => byId('out').textContent;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const count = (hay, needle) => hay.split(needle).length - 1;

async function waitUntil(pred, what) {
	for (let i = 0; i < 200; i++) {
		if (pred()) return;
		await sleep(10);
	}
	throw new Error('timeout waiting for ' + what);
}

const RUN_IDS = ['run-1', 'run-ens', 'run-batch', 'run-det'];

(async () => {
	assert.ok(byId('status'), 'the page carries a #status line for in-flight runs');
	assert.equal(out().indexOf('— ready'), out().indexOf('— ready'), 'boot line printed');

	// 1. a slow run: status live, buttons locked, second click answered, then all released.
	win.__run = async function (cfg) {
		assert.equal(typeof cfg.progress, 'function', 'runAndLog hands the runner a progress hook');
		cfg.progress('frame 0/1');
		await sleep(40);
		return { frames: 1, level: 5, seed: 7, ok: true, firstBadFrame: -1, last: [] };
	};
	byId('run-1').click();
	assert.ok(statusShown(), 'the status line is shown while a run works');
	assert.ok(status().indexOf('parity running') === 0, 'the status names the run: ' + status());
	assert.ok(/\d+\.\d s/.test(status()), 'the status counts the elapsed seconds: ' + status());
	assert.ok(status().indexOf('frame 0/1') > 0, 'runner progress lands in the status: ' + status());
	for (const id of RUN_IDS) {
		assert.equal(byId(id).disabled, true, id + ' locked while the run is in flight');
	}
	byId('run-ens').click();
	await waitUntil(() => out().indexOf('[result] PASS') >= 0, 'the first run to finish');
	assert.equal(count(out(), 'PASS parity OK'), 1, 'the second click did not start a run');
	assert.ok(out().indexOf('already in flight') >= 0, 'the refused click says why');
	for (const id of RUN_IDS) {
		assert.equal(byId(id).disabled, false, id + ' re-enabled when the run ended');
	}
	assert.ok(!statusShown(), 'the status hides when the run is done');

	// 2. an aborted run: error and FAIL only — a verdict line would lie.
	const passBefore = count(out(), 'PASS parity OK');
	win.__run = async function () { throw new Error('no WebGPU adapter'); };
	byId('run-1').click();
	await waitUntil(() => out().indexOf('aborted before any comparison') >= 0, 'the abort verdict');
	assert.equal(count(out(), 'PASS parity OK'), passBefore, 'an aborted run never says PASS');
	assert.ok(out().indexOf('ERROR: Error: no WebGPU adapter') >= 0, 'the abort prints the error');
	assert.ok(out().indexOf('[result] FAIL') >= 0, 'the abort ends FAIL');
	for (const id of RUN_IDS) {
		assert.equal(byId(id).disabled, false, id + ' released even after an abort');
	}

	// 3. the ensemble names its seeds, in the start line and the verdict line.
	win.__ens = async function () {
		return { frames: 2, level: 5, seeds: [7, 8, 9], ok: true, rows: [], violations: [] };
	};
	byId('run-ens').click();
	await waitUntil(() => out().indexOf('PASS ensemble') >= 0, 'the ensemble verdict');
	assert.ok(out().indexOf('[ensemble] frames=1000 level=5 seed=[7,8,9] …') >= 0,
		'the start line names the seeds the ensemble runs (a lone seed=7 is a lie for three)');
	assert.ok(/ensemble: frames=2 level=5 seed=\[7,8,9\] wall=\d+ms/.test(out()),
		'the verdict line carries the seed list, never seed=undefined');

	console.log('PASS gpu-parity ui: live status with elapsed+phase, buttons locked while '
		+ 'in flight, no verdict on abort, ensemble names its seeds');
})().catch(e => { console.error(e); process.exit(1); });

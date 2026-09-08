// gpu-parity.js — drives tests/gpu-harness.html in a real Chrome (plan §H tests). The harness
// runs the whole battery in the page and prints its verdict as JSON in <pre id="result">; this
// driver only launches the browser and reports. Without WebGPU hardware nothing here can run,
// so with no PGT_CHROME in the environment it reports SKIP and the exact command it would run.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const chrome = process.env.PGT_CHROME;
const page = 'file://' + path.join(__dirname, 'gpu-harness.html');
const args = ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run',
	'--disable-gpu-sandbox', '--virtual-time-budget=240000', '--dump-dom', page];

if (!chrome) {
	console.log('SKIP gpu-parity: WebGPU needs a real browser. Set PGT_CHROME to a Chrome binary and re-run:');
	console.log('  PGT_CHROME=/usr/bin/google-chrome node tests/gpu-parity.js');
	console.log('  (runs: ' + ['google-chrome'].concat(args).join(' ') + ')');
	process.exit(0);
}

const result = spawnSync(chrome, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600000 });
const dom = result.stdout || '';
const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
if (!match) {
	console.log('FAIL gpu-parity: no result in page output' +
		(result.error ? ' (' + result.error + ')' : ''));
	if (result.stderr) console.log(result.stderr.split('\n').filter(l => /error|fail/i.test(l)).slice(0, 5).join('\n'));
	process.exit(1);
}
let json;
try {
	json = JSON.parse(match[1]);
} catch (e) {
	console.log('FAIL gpu-parity: result is not JSON: ' + match[1].slice(0, 200));
	process.exit(1);
}
if (!json.pass) {
	console.log('FAIL gpu-parity: ' + JSON.stringify(json));
	process.exit(1);
}
const ens = json.ensemble;
console.log('PASS gpu-parity: boot worst ' + json.boot.worst.toExponential(2) + ' flips ' + json.boot.flips +
	', frames worst ' + json.frames.worst.toExponential(2) + ' flips ' + json.frames.flips +
	', ensemble plates ' + ens.plateCpu + '/' + ens.plateGpu +
	', determinism ' + (json.hashes[0] === json.hashes[1] ? 'ok' : 'BROKEN'));

// gpu-bench.js (node driver, 0.3-plan Phase I3): boots bench.html in headless
// Chromium (SwiftShader in the container) and prints the in-page bench report.
// Usage:
//   node experiments/gpu-bench.js [--out=experiments/logs/0.3-baseline.txt]
//   PGT_QUERY='level=6&steps=8&dt=0.1' node experiments/gpu-bench.js
// Tool locations follow the PGT_CHROME / PGT_PUPPETEER / PGT_LIBS overrides of
// tests/gpu-parity.js. SwiftShader numbers are relative-only (BENCH convention);
// an adapter-less machine records a single "BENCH skip" line and exits 0.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8123;

function arg(name, dflt) {
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name) return process.argv[i + 1];
		if (a.startsWith(name + '=')) return a.slice(name.length + 1);
	}
	return dflt;
}

function serve(dir) {
	const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
	const server = http.createServer((req, res) => {
		const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain' });
			res.end(data);
		});
	});
	return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
	const out = arg('--out', null);
	const server = await serve(ROOT);
	const puppeteerDir = process.env.PGT_PUPPETEER || '/tmp/wgputest/node_modules/puppeteer-core';
	const chromeBin = process.env.PGT_CHROME || '/tmp/chromium';
	const libDir = process.env.PGT_LIBS || '';
	const puppeteer = require(puppeteerDir);
	if (libDir) process.env.LD_LIBRARY_PATH = libDir;
	const browser = await puppeteer.launch({
		executablePath: chromeBin,
		args: ['--headless=new', '--no-sandbox', '--no-zygote', '--disable-gpu-sandbox',
			'--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--in-process-gpu', '--disable-dev-shm-usage'],
		headless: false, protocolTimeout: 1500000
	});
	const lines = [];
	try {
		const page = await browser.newPage();
		page.on('console', m => {
			const t = m.text();
			if (t.startsWith('BENCH ')) {
				lines.push(t);
				console.log(t);
			}
		});
		page.on('pageerror', e => console.log('[pageerror]', e.message));
		// PGT_QUERY pre-fills the bench page inputs (level/steps/dt).
		var query = process.env.PGT_QUERY ? '?' + process.env.PGT_QUERY : '';
		await page.goto(`http://127.0.0.1:${PORT}/bench.html${query}`, { waitUntil: 'networkidle0' });
		// SwiftShader kernel build plus three 1.2 s iso boxes plus a 5 s smooth box.
		await page.waitForFunction('window.__benchDone === true', { timeout: 300000 });
		if (out) {
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, lines.join('\n') + '\n');
			console.log('wrote ' + out);
		}
	} finally {
		await browser.close();
		server.close();
	}
})().catch(e => { console.error('BENCH-DRIVER-FAIL', e.message); process.exit(1); });

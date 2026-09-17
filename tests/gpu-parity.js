// gpu-parity.js (node driver): boots the harness page in headless Chromium with
// SwiftShader, runs window.__run and prints the report. Usage:
//   node tests/gpu-parity.js [frames] [level] [--fields=a,b] [--seed=n] [--all]
// Tries system puppeteer first (npm install puppeteer / puppeteer-core), then
// PGT_PUPPETEER / PGT_CHROME env vars, then the temp rig dir (os.tmpdir()/rig) — see tests/headless-common.js.
// No puppeteer? Open tests/gpu-parity.html directly in Chrome 113+ (file:// works)
// and click “Run ensemble” — same harness, same copy/save, no headless rig needed
// (webgpu-smoke.html pattern). The page is served from the repo root; start it with
//   python3 -m http.server 8123 &
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8123;

// This side's half of the capture header: node and the host OS/CPU type, no model names.
function hostLine() {
	const os = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform] || process.platform;
	const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch] || process.arch;
	return 'node ' + process.version.replace(/^v/, '') + ' · ' + os + ' ' + arch;
}

function arg(name, dflt) {
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name) return process.argv[i + 1];
		if (a.startsWith(name + '=')) return a.slice(name.length + 1);
	}
	return dflt;
}

function serve(dir) {
	const types = { '.html': 'text/html', '.js': 'text/javascript' };
	const server = http.createServer((req, res) => {
		const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
		// Chrome asks for /favicon.ico on every http page; a 404 there lands in the capture
		// log as an unrelated "Failed to load resource" line. 204 is the empty favicon.
		if (file === path.join(dir, 'favicon.ico')) { res.writeHead(204); res.end(); return; }
		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain' });
			res.end(data);
		});
	});
	return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
	const pos = process.argv.slice(2).filter(a => !a.startsWith('--'));
	const frames = parseInt(arg('--frames', pos[0] !== undefined ? pos[0] : '1'), 10);
	const level = parseInt(arg('--level', pos[1] !== undefined ? pos[1] : '5'), 10);
	const seed = parseInt(arg('--seed', '7'), 10);
	const fields = arg('--fields', null);
	const ensemble = process.argv.includes('--ensemble');
	const seeds = arg('--seeds', null);
	const all = process.argv.includes('--all');
	const stop = process.argv.includes('--keep-going') ? false : true;
	const server = await serve(ROOT);
	// Resolve puppeteer + chrome flexibly: system install → env overrides → os.tmpdir()/rig → helpful error.
	const hc = require('./headless-common.js');
	let puppeteer = hc.resolvePuppeteer();
	if (!puppeteer) {
		console.error(hc.installHint(false));
		process.exit(2);
	}
	const chromeBin = hc.resolveChrome(puppeteer);
	if (!chromeBin) {
		console.error(hc.installHint(true));
		console.error('\nResolved puppeteer from: ' + (puppeteer.__resolvedFrom || hc.resolvePuppeteer._from || 'unknown'));
		process.exit(2);
	}
	const browser = await puppeteer.launch(hc.launchOptions(puppeteer, chromeBin));
	try {
		const page = await browser.newPage();
		page.on('console', m => { const t = m.text(); if (!t.startsWith('Download the React')) console.log('[page]', t); });
		page.on('pageerror', e => console.log('[pageerror]', e.message));
		await page.goto(`http://127.0.0.1:${PORT}/tests/gpu-parity.html`, { waitUntil: 'networkidle0' });
		await page.waitForFunction('window.__ready === true', { timeout: 30000 });
		const cfg = { frames, level, seed, stopOnFirst: !all && stop, fields: fields ? fields.split(',') : null };
		if (ensemble) cfg.seeds = seeds ? seeds.split(',').map(Number) : [7, 8, 9];
		const batch = process.argv.includes('--batch');
		const t0 = Date.now();
		const report = process.argv.includes('--determinism')
			? await page.evaluate(cfg => window.__det(cfg), cfg)
			: batch
				? await page.evaluate(cfg => window.__batch(cfg), cfg)
				: ensemble
					? await page.evaluate(cfg => window.__ens(cfg), cfg)
					: await page.evaluate(cfg => window.__run(cfg), cfg);
		const ms = Date.now() - t0;
		// The capture's first line: the page's environment (browser, OS/CPU, GPU type plus one
		// vendor word) and this side's (node, host type), then the numbers. Read defensively:
		// a missing header must not cost the report the run just produced.
		const env = await page.evaluate('window.__envLine ? window.__envLine() : ""').catch(() => '');
		if (env) console.log(env + ' · ' + hostLine());
		if (!batch) {
			// gpuBuild only exists where a single GpuSim.init built the world (__run; __ens
			// records its first seed's build). Printing it unconditionally made every
			// ensemble capture say gpuBuild=undefinedms.
			console.log(`frames=${report.frames} level=${report.level} seed=${report.seeds ? '[' + report.seeds + ']' : report.seed} wall=${ms}ms`
				+ (report.gpuBuildMs ? ` gpuBuild=${report.gpuBuildMs}ms` : ''));
		} else {
			console.log(`batch-identity level=${report.level} seed=${report.seed} wall=${ms}ms`);
		}
		if (report.error) {
			// An aborted run has nothing to verdict — print the error, not the per-kind
			// PASS/FAIL block below (and not a second copy of the error).
			console.log('ERROR: ' + report.error);
			console.log('aborted before any comparison');
			process.exitCode = 1;
			return;
		}
		if (ensemble) {
			console.log(`ensemble: ${report.frames} frames, seeds [${report.seeds}] (bounds: plates +-2, cols 2%, mean 20%, max 2x, cont 2pp)`);
			for (const r of report.rows) {
				console.log(`  seed ${r.seed}: worst plates ${r.plates.toFixed(0)}, cols ${(r.columns * 100).toFixed(2)}%, mean ${(r.meanCm * 100).toFixed(1)}%, max ${(r.maxCm * 100).toFixed(1)}%, cont ${(r.cont * 100).toFixed(2)}pp`);
				console.log(`    end cpu: t=${r.end.t.toFixed(0)} plates=${r.end.plates} cols=${r.end.columns} mean=${r.end.meanCm.toFixed(2)}cm/yr cont=${(r.end.cont * 100).toFixed(1)}%`);
				console.log(`    end gpu: t=${r.endGpu.t.toFixed(0)} plates=${r.endGpu.plates} cols=${r.endGpu.columns} mean=${r.endGpu.meanCm.toFixed(2)}cm/yr cont=${(r.endGpu.cont * 100).toFixed(1)}%`);
			}
			if (report.violations.length) {
				console.log('BOUND VIOLATIONS:');
				for (const v of report.violations.slice(0, 30)) console.log('  ' + v);
			} else {
				console.log('all seeds within predeclared statistical bounds');
			}
			process.exitCode = report.ok ? 0 : 1;
			return;
		}
		if (batch) {
			console.log(`batch-identity: ${report.runs.length} frame counts, seed ${report.seed}, level ${report.level} (zero tolerance)`);
			for (const r of report.runs) {
				console.log(`  ${r.frames} frames: t=${r.t.toPrecision(17)} frame=${r.frame} lastEvent=${r.lastEvent} ` +
					(r.bad.length ? 'MISMATCH ' + r.bad.map(f => f.name).slice(0, 8).join(',') : 'identical'));
			}
			if (report.ok) console.log('batch encoders are bit-identical to one-frame encoders');
			else {
				console.log(`BATCH DIVERGENCE at ${report.firstBadFrames} frames:`);
				for (const b2 of report.bad || []) {
					console.log(`  ${b2.name}: ${b2.mismatches} bad, first at [${b2.at}] single=${b2.cpu} batch=${b2.gpu}`);
				}
			}
			process.exitCode = report.ok ? 0 : 1;
			return;
		}
		if (process.argv.includes('--determinism')) {
			if (report.ok) {
				console.log(`determinism OK: two ${report.frames}-frame runs from the same upload are bit-identical`);
			} else {
				console.log('NON-DETERMINISTIC fields:');
				for (const b of report.bad || []) {
					console.log(`  ${b.name}: ${b.mismatches} bad, first at [${b.at}] a=${b.cpu} b=${b.gpu}`);
				}
			}
			process.exitCode = report.ok ? 0 : 1;
			return;
		}
		if (report.firstBadFrame >= 0) {
			console.log(`FIRST DIVERGENCE at frame ${report.firstBadFrame}:`);
			for (const b of report.bad) {
				console.log(`  ${b.name}: ${b.mismatches} bad, first at [${b.at}] cpu=${b.cpu} gpu=${b.gpu} worstRatio=${b.worstRatio.toFixed(2)}`);
			}
		} else {
			console.log('parity OK for all compared frames');
		}
		const interesting = report.last.filter(f => f.worstRatio > 0.01 || f.mismatches > 0);
		console.log('worst fields at last frame:');
		for (const f of interesting.slice(0, 20)) {
			console.log(`  ${f.name}: ratio=${f.worstRatio.toFixed(3)} mismatches=${f.mismatches}${f.mismatches ? ` at [${f.at}] cpu=${f.cpu} gpu=${b_gpu(f)}` : ''}`);
		}
		function b_gpu(f) { return f.gpu; }
		process.exitCode = report.ok ? 0 : 1;
	} finally {
		await browser.close();
		server.close();
	}
})().catch(e => { console.error(e); process.exit(2); });

// headless-common.js — shared puppeteer/chrome launcher for the three headless drivers.
// Tries system puppeteer first, then PGT_PUPPETEER, then /tmp/rig, then helpful error.
// Chrome binary: PGT_CHROME → puppeteer.executablePath() → @sparticuz/chromium → which(google-chrome|chromium) → /tmp/chromium.
// PGT_LIBS sets LD_LIBRARY_PATH for the @sparticuz/chromium al2023 libs (optional).
const fs = require('fs');
const path = require('path');
const child = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function tryRequire(id) {
	try { return require(id); } catch (_) { return null; }
}

function resolvePuppeteer() {
	const candidates = [];
	// 1. explicit env override (file or package name)
	if (process.env.PGT_PUPPETEER) candidates.push(process.env.PGT_PUPPETEER);
	// 2. PUPPETEER_EXECUTABLE_PATH's puppeteer sibling (standard var)
	if (process.env.PUPPETEER_EXECUTABLE_PATH) {
		// no puppeteer package inferred from this, keep candidate search
	}
	// 3. project-local installs
	candidates.push(path.join(ROOT, 'node_modules', 'puppeteer-core'));
	candidates.push(path.join(ROOT, 'node_modules', 'puppeteer'));
	// 4. bare package names (global / npm prefix on PATH, or NODE_PATH)
	candidates.push('puppeteer-core');
	candidates.push('puppeteer');
	// 5. legacy /tmp/rig default from 0.3-7 rig recipe
	candidates.push('/tmp/rig/node_modules/puppeteer-core');
	candidates.push('/tmp/rig/node_modules/puppeteer');
	// 6. alternative prefix the recipe also used
	candidates.push('/tmp/lib/node_modules/puppeteer-core');
	for (const id of candidates) {
		const mod = tryRequire(id);
		if (mod) {
			// puppeteer-core's exports may be frozen — store the provenance on the helper instead
			try {
				if (Object.isExtensible(mod)) mod.__resolvedFrom = id;
			} catch (_) {}
			resolvePuppeteer._from = id;
			resolvePuppeteer._mod = mod;
			return mod;
		}
	}
	return null;
}
resolvePuppeteer._from = null;

function which(bin) {
	try {
		const out = child.execSync('which ' + bin + ' 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
		if (out && fs.existsSync(out)) return out;
	} catch (_) {}
	return null;
}

function resolveChrome(puppeteer) {
	// 1. explicit env
	const envs = ['PGT_CHROME', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH', 'CHROME_BIN'];
	for (const k of envs) {
		const p = process.env[k];
		if (p && fs.existsSync(p)) return p;
	}
	// 2. puppeteer(‑core) managed browser — puppeteer.executablePath() may be sync or async
	// puppeteer-core without a downloaded browser throws/rejects; skip gracefully
	if (puppeteer && typeof puppeteer.executablePath === 'function') {
		try {
			const maybe = puppeteer.executablePath();
			if (maybe && typeof maybe.then === 'function') {
				// async — silence the rejection, fall through to other probes (python helper can await elsewhere)
				maybe.catch(function(){});
			} else if (typeof maybe === 'string' && maybe && fs.existsSync(maybe)) {
				return maybe;
			}
		} catch (_) {}
	}
	try {
		const ch = tryRequire('@sparticuz/chromium');
		if (ch) {
			const p = typeof ch.executablePath === 'function' ? ch.executablePath() : ch.path || null;
			const resolved = typeof p === 'string' ? p : (typeof p === 'function' ? p() : null);
			// @sparticuz/chromium may need to be invoked: await ch.executablePath() is async in newer API.
			// For sync path, fall back to which‑style check: the package extracts to /tmp/chromium on first use.
			if (resolved && fs.existsSync(resolved)) return resolved;
		}
	} catch (_) {}
	// 3. system chrome
	for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome']) {
		const p = which(bin);
		if (p) return p;
	}
	// 4. legacy defaults
	for (const p of ['/tmp/chromium', '/tmp/chrome']) if (fs.existsSync(p)) return p;
	// 5. puppeteer cache: ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome
	try {
		const home = process.env.HOME || process.env.USERPROFILE || '';
		const cache = path.join(home, '.cache', 'puppeteer', 'chrome');
		if (fs.existsSync(cache)) {
			const vers = fs.readdirSync(cache).sort().reverse();
			for (const v of vers) {
				const c = path.join(cache, v, 'chrome-linux64', 'chrome');
				if (fs.existsSync(c)) return c;
				const c2 = path.join(cache, v, 'chrome-linux', 'chrome');
				if (fs.existsSync(c2)) return c2;
			}
		}
	} catch (_) {}
	return null;
}

function launchOptions(puppeteer, chromeBin) {
	const libDir = process.env.PGT_LIBS || '/tmp/al2023/lib';
	// Only set LD_LIBRARY_PATH if the dir exists — an empty/non‑existent path is noise.
	if (libDir && fs.existsSync(libDir)) {
		process.env.LD_LIBRARY_PATH = libDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
	} else if (process.env.PGT_LIBS && !fs.existsSync(libDir)) {
		// PGT_LIBS explicitly set but missing — warn, don't silently ignore
		console.warn('[headless] PGT_LIBS=' + libDir + ' not found, continuing without it');
	}
	const args = ['--headless=new', '--no-sandbox', '--no-zygote', '--disable-gpu-sandbox',
		'--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--in-process-gpu', '--disable-dev-shm-usage'];
	const opts = { args, headless: false, protocolTimeout: 1500000 };
	if (chromeBin) opts.executablePath = chromeBin;
	return opts;
}

function installHint(missingChrome) {
	const lines = [];
	lines.push('Headless WebGPU rig not found.');
	lines.push('');
	lines.push('Options (any one):');
	lines.push('  1) Use your system puppeteer + chrome (preferred):');
	lines.push('       npm install puppeteer         # downloads a compatible chrome to ~/.cache/puppeteer');
	lines.push('       # or, if you already have chrome: PGT_CHROME=/usr/bin/google-chrome node tests/gpu-parity.js');
	lines.push('  2) Use the @sparticuz/chromium recipe (CI / containers):');
	lines.push('       npm install --prefix /tmp/rig puppeteer-core @sparticuz/chromium');
	lines.push('       node -e "require(\"/tmp/rig/node_modules/@sparticuz/chromium\").executablePath().then(p=>console.log(p))"');
	lines.push('  3) Point to an existing install:');
	lines.push('       PGT_PUPPETEER=/path/to/puppeteer-core  PGT_CHROME=/path/to/chrome  node tests/gpu-parity.js');
	lines.push('  4) Let the python helper install it:');
	lines.push('       python3 run_gpu_parity.py --install    # runs npm install --prefix /tmp/rig puppeteer-core');
	lines.push('');
	lines.push('No‑puppeteer alternative — same browser as in‑gui:');
	lines.push('  Open tests/gpu-parity.html directly in Chrome 113+ (file:// works, no server needed),');
	lines.push('  click “Run ensemble” and “Copy log” — identical harness, no headless rig (see gpu‑parity.html header).');
	lines.push('  Same for bench.html and experiments/heavy-overlap.html (open file://, click Run).');
	if (missingChrome) {
		lines.push('');
		lines.push('Chrome not found — puppeteer was found but no chrome binary. Install one of the above or set PGT_CHROME.');
	}
	return lines.join('\n');
}

module.exports = { resolvePuppeteer, resolveChrome, launchOptions, installHint, ROOT };

// headless-common.js — shared puppeteer/chrome launcher for the three headless drivers.
// Tries system puppeteer first, then PGT_PUPPETEER, then os.tmpdir()/rig (/tmp/rig on
// POSIX, %TEMP%\rig on Windows — run_gpu_parity.py --install puts it there), then helpful error.
// Chrome binary: PGT_CHROME → puppeteer.executablePath() → @sparticuz/chromium →
// which/where(google-chrome|chromium) → Program Files\Google\Chrome (win) → /tmp/chromium.
// PGT_LIBS sets LD_LIBRARY_PATH for the @sparticuz/chromium al2023 libs (POSIX only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RIG = path.join(os.tmpdir(), 'rig');

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
	// 5. the temp rig dir the 0.3-7 recipe and run_gpu_parity.py --install use
	candidates.push(path.join(RIG, 'node_modules', 'puppeteer-core'));
	candidates.push(path.join(RIG, 'node_modules', 'puppeteer'));
	// 6. alternative prefix the recipe also used
	candidates.push(path.join(os.tmpdir(), 'lib', 'node_modules', 'puppeteer-core'));
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
	// Windows has no `which` and its executables carry extensions: where.exe + '.exe'.
	const cmd = process.platform === 'win32'
		? 'where ' + bin + '.exe 2>nul'
		: 'which ' + bin + ' 2>/dev/null';
	try {
		const out = child.execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
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
	// 3. system chrome — PATH, then the standard install dirs on Windows
	for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome']) {
		const p = which(bin);
		if (p) return p;
	}
	if (process.platform === 'win32') {
		const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
			process.env.LOCALAPPDATA].filter(Boolean);
		for (const root of roots) {
			for (const rel of [path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
				path.join('Chromium', 'Application', 'chrome.exe')]) {
				const p = path.join(root, rel);
				if (fs.existsSync(p)) return p;
			}
		}
	}
	// 4. legacy defaults
	for (const p of ['/tmp/chromium', '/tmp/chrome']) if (fs.existsSync(p)) return p;
	// 5. puppeteer cache: ~/.cache/puppeteer/chrome/*/<platform dir> (the npm-install
	// puppeteer default on all three OSes; the dir name is what the download picks)
	try {
		const home = process.env.HOME || process.env.USERPROFILE || '';
		const cache = path.join(home, '.cache', 'puppeteer', 'chrome');
		if (fs.existsSync(cache)) {
			const vers = fs.readdirSync(cache).sort().reverse();
			const leafs = [['chrome-win64', 'chrome.exe'], ['chrome-win32', 'chrome.exe'],
				['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
			for (const v of vers) {
				for (const leaf of leafs) {
					const c = path.join(cache, v, leaf[0], leaf[1]);
					if (fs.existsSync(c)) return c;
				}
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
	lines.push('       npm install --prefix ' + RIG + ' puppeteer-core @sparticuz/chromium');
	lines.push('       node -e "require(\\"' + path.join(RIG, 'node_modules', '@sparticuz/chromium') + '\\").executablePath().then(p=>console.log(p))"');
	lines.push('  3) Point to an existing install:');
	lines.push('       PGT_PUPPETEER=/path/to/puppeteer-core  PGT_CHROME=/path/to/chrome  node tests/gpu-parity.js');
	lines.push('  4) Let the python helper install it:');
	lines.push('       python3 run_gpu_parity.py --install    # npm install --prefix ' + RIG + ' puppeteer-core, chrome via npx');
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

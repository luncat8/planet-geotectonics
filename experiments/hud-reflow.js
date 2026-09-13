// hud-reflow.js (node driver): measures what the perf strip does to the page around it, in a
// real browser - the owner's complaint was "this info has variable size that cause GUI elements
// move", which is a layout claim and wants a layout number, not a CSS reading.
//
// It samples the strip's height, the number of rows it shows, and the offsetTop of every
// element below it, across strip updates whose content varies the way the real ones do: the
// kernel table appearing and changing length, an event window opening and closing, a checkpoint
// line. Then it does the same across a resolution switch, which is the other thing that changes
// the page's shape. With --old=<tree> it measures a second tree the same way, so a fix is a
// before/after pair of numbers rather than an assertion.
//
//   node experiments/hud-reflow.js [--old=/tmp/pgt-old] [--shot=experiments/logs/0.3-hud.png]
//                                  [--width=1440] [--height=900] [--level=6,7]
//
// CPU engine only: no WebGPU adapter is needed to measure layout, so this runs in the sandbox
// (SwiftShader numbers would be relative-only anyway, per the BENCH convention). Chromium and
// its libs come from the @sparticuz/chromium drop in /tmp - see findings-pitfalls-skills.md,
// "Headless WebGPU rig".
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

function arg(name, dflt) {
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name) return process.argv[i + 1];
		if (a.startsWith(name + '=')) return a.slice(name.length + 1);
	}
	return dflt;
}

function serve(dir, port) {
	const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
	const server = http.createServer((req, res) => {
		const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { 'content-type': types[path.extname(file)] || 'text/plain' });
			res.end(data);
		});
	});
	return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// Everything the driver needs from the page, read in one go so a sample is one instant.
const LAYOUT = function () {
	const strip = document.getElementById('perf');
	const rows = document.getElementById('perf-rows');
	const box = (el) => {
		const r = el.getBoundingClientRect();
		return { top: +(r.top + window.scrollY).toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) };
	};
	const marks = {};
	for (const sel of ['.map-bottom', '.controls', '.notes', '#badge', '.clock']) {
		const el = document.querySelector(sel);
		if (el) marks[sel] = box(el);
	}
	return {
		strip: box(strip), rows: box(rows), marks: marks,
		rowN: rows.children.length,
		textN: Array.prototype.filter.call(rows.children, (s) => s.textContent).length,
		rowsText: Array.prototype.map.call(rows.children, (s) => s.textContent),
		docH: document.documentElement.scrollHeight,
		badge: document.getElementById('badge').textContent,
		gridInfo: document.getElementById('grid-info')
			? document.getElementById('grid-info').textContent : '(no #grid-info)',
		t: document.getElementById('time').textContent
	};
};

async function measure(page, label, opts) {
	const samples = [];
	const sample = async (why) => {
		const l = await page.evaluate(LAYOUT);
		l.why = why;
		samples.push(l);
		return l;
	};
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const settle = () => wait(700);
	// The HUD rewrites the strip at 2 Hz (Perf.TEXT_MS) and a text update consumes the event
	// and checkpoint counters, so "inject a line and wait 700 ms" can land on the window after
	// the one that showed it. Wait for the row itself instead: the sample then always catches
	// the strip in the state the injection asked for.
	// Which row a part lands in is exactly what differs between the two trees (the old one
	// drops empty parts, so every row below a missing one shifts up), so the waits scan all of
	// them instead of naming a slot.
	const rowsMatch = (src) => page.waitForFunction((src) => {
		const test = new Function('t', 'return ' + src);
		const rows = document.getElementById('perf-rows').children;
		for (let i = 0; i < rows.length; i++) if (test(rows[i].textContent)) return true;
		return false;
	}, { timeout: 8000, polling: 20 }, src);
	const rowsAbsent = (src) => page.waitForFunction((src) => {
		const test = new Function('t', 'return ' + src);
		const rows = document.getElementById('perf-rows').children;
		for (let i = 0; i < rows.length; i++) if (test(rows[i].textContent)) return false;
		return true;
	}, { timeout: 8000, polling: 20 }, src);

	await sample('boot');
	// Play on the CPU engine: the kernel table fills in and changes length as kernels cross
	// Perf.MIN_KERNEL_MS, which is the everyday case the complaint is about.
	await page.click('#play');
	for (let i = 0; i < 6; i++) { await wait(260); await sample('playing ' + i); }
	// An event window: on the GPU engine this row appears and disappears on its own cadence.
	await page.evaluate(() => { Perf.event(29.6, 25.9, 3.2, 0.5, 24.3); Perf.ckpt(12.3); });
	// Not "starts with events": `events` is also the name of a CPU kernel lap, so the kernel
	// row can start with that word too. The round trip's " ms = dl " is in nothing else.
	await rowsMatch('t.indexOf(" ms = dl ") > 0');
	await sample('events + ckpt');
	await rowsAbsent('t.indexOf(" ms = dl ") > 0');
	await sample('events gone again');
	// A kernel table longer than the strip is wide, the case that used to add a wrapped line.
	await page.evaluate(() => {
		const K = Perf.K;
		Perf.kern[K.EVENTS] = 1.9; Perf.kern[K.INTEGRATE] = 1.8; Perf.kern[K.MOVE] = 1.7;
		Perf.kern[K.BIN] = 1.6; Perf.kern[K.RASTER] = 1.5; Perf.kern[K.MANTLE] = 1.4;
		Perf.kern[K.EDGES] = 1.3; Perf.kern[K.CONTACT] = 1.2; Perf.kern[K.APPLY] = 1.1;
		Perf.kern[K.COLUMN] = 1.0; Perf.kern[K.SURFACE] = 0.9; Perf.kern[K.FORCES] = 0.8;
		Perf.kern[K.REDUCE] = 0.7; Perf.kern[K.DIAG] = 0.6;
		Perf.windowSteps = 1;
		Perf.event(29.6, 25.9, 3.2, 0.5, 24.3); Perf.ckpt(12.3);
	});
	// The last row is the kernel table on both trees, and this is the widest it ever gets:
	// all fourteen kernels over the floor, plus the events and checkpoint rows with it.
	await rowsMatch('t.length > 120');
	const wide = await sample('every kernel over the floor + events + ckpt');
	await page.click('#play');          // pause
	await settle();
	await sample('paused');

	// Resolution switches, the other shape-changing control.
	const switches = [];
	const hasLevel = await page.evaluate(() => !!document.getElementById('level'));
	for (const level of (hasLevel ? opts.levels : [])) {
		const t0 = Date.now();
		await page.evaluate((lv) => {
			const el = document.getElementById('level');
			el.value = String(lv);
			el.dispatchEvent(new Event('change'));
		}, level);
		await page.waitForFunction(
			(lv) => document.getElementById('badge').textContent.indexOf('L' + lv) >= 0,
			{ timeout: 120000 }, level);
		await settle();
		const l = await sample('after L' + level);
		// Did the map actually draw at the new resolution? A blank canvas is a rebuild that
		// only relabelled the page.
		const pixels = await page.evaluate(() => {
			const c = document.getElementById('map');
			const ctx = c.getContext('2d');
			const d = ctx.getImageData(0, 0, c.width, c.height).data;
			const seen = new Set();
			let nonEmpty = 0;
			for (let i = 0; i < d.length; i += 4 * 97) {
				seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
				if (d[i + 3] > 0 && !(d[i] === 20 && d[i + 1] === 26 && d[i + 2] === 39)) nonEmpty++;
			}
			return { canvas: c.width + 'x' + c.height, distinct: seen.size, painted: nonEmpty };
		});
		switches.push({ level: level, ms: Date.now() - t0, badge: l.badge, gridInfo: l.gridInfo,
			stripH: l.strip.h, rowsH: l.rows.h, rowN: l.rowN, controlsTop: l.marks['.controls'].top,
			docH: l.docH, pixels: pixels });
	}

	if (!hasLevel) switches.push({ level: '-', ms: 0, badge: '(this tree has no Resolution select)',
		gridInfo: '', stripH: 0, rowsH: 0, rowN: 0, controlsTop: 0, docH: 0,
		pixels: { canvas: '-', distinct: 0, painted: 0 } });
	if (opts.shot) {
		await page.evaluate(() => { Perf.event(29.6, 25.9, 3.2, 0.5, 24.3); Perf.ckpt(12.3); });
		await settle();
		await page.screenshot({ path: opts.shot, clip: await page.evaluate(() => {
			const r = document.querySelector('.map-panel').getBoundingClientRect();
			return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
		}) });
	}

	// The number the complaint is about: how far the page below the strip moved, and how much
	// the strip's own height changed, over every sample.
	const span = (get) => {
		const v = samples.map(get).filter((x) => Number.isFinite(x));
		return { min: Math.min(...v), max: Math.max(...v), move: +(Math.max(...v) - Math.min(...v)).toFixed(1) };
	};
	const report = {
		label: label, samples: samples.length, wideRowChars: Math.max(...wide.rowsText.map((t) => t.length)),
		stripH: span((s) => s.strip.h),
		rowsH: span((s) => s.rows.h),
		rowN: span((s) => s.rowN),
		textN: span((s) => s.textN),
		docH: span((s) => s.docH),
		marks: {}
	};
	for (const sel of Object.keys(samples[0].marks)) {
		report.marks[sel] = { top: span((s) => s.marks[sel].top), h: span((s) => s.marks[sel].h) };
	}
	return { report: report, samples: samples, switches: switches };
}

(async () => {
	const width = +arg('--width', 1440), height = +arg('--height', 900);
	const oldTree = arg('--old', null);
	const levels = String(arg('--level', '6,5')).split(',').map(Number);
	const shot = arg('--shot', null);
	const servers = [await serve(ROOT, 8123)];
	if (oldTree) servers.push(await serve(oldTree, 8124));

	const puppeteerDir = process.env.PGT_PUPPETEER || '/tmp/rig/node_modules/puppeteer-core';
	const chromeBin = process.env.PGT_CHROME || '/tmp/chromium';
	const libDir = process.env.PGT_LIBS || '/tmp/al2023/lib';
	const puppeteer = require(puppeteerDir);
	if (libDir) process.env.LD_LIBRARY_PATH = libDir + ':/tmp';
	const browser = await puppeteer.launch({
		executablePath: chromeBin,
		args: ['--headless=new', '--no-sandbox', '--no-zygote', '--disable-gpu-sandbox',
			'--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--in-process-gpu',
			'--disable-dev-shm-usage', '--font-render-hinting=none'],
		headless: false, protocolTimeout: 600000
	});
	const out = [];
	try {
		const targets = [{ label: 'new (working tree)', port: 8123, shot: shot }];
		if (oldTree) targets.unshift({ label: 'old (' + path.basename(oldTree) + ')', port: 8124, shot: null });
		for (const target of targets) {
			const page = await browser.newPage();
			await page.setViewport({ width: width, height: height });
			page.on('pageerror', (e) => out.push('[pageerror ' + target.label + '] ' + e.message));
			page.on('console', (m) => { if (m.type() === 'error') out.push('[console ' + target.label + '] ' + m.text()); });
			await page.goto('http://127.0.0.1:' + target.port + '/index.html', { waitUntil: 'networkidle0' });
			await page.waitForFunction('Perf && Perf.rows && document.getElementById("perf-rows").children.length >= 1',
				{ timeout: 60000 });
			out.push(await measure(page, target.label, { levels: levels, shot: target.shot }));
			await page.close();
		}
	} finally {
		await browser.close();
		for (const s of servers) s.close();
	}

	// --- the report ------------------------------------------------------------------------
	const lines = [];
	for (const r of out) {
		if (typeof r === 'string') { lines.push(r); continue; }
		const rep = r.report;
		lines.push('');
		lines.push(rep.label + ' — ' + rep.samples + ' samples at ' + width + 'x' + height
			+ ', longest kernel row ' + rep.wideRowChars + ' chars');
		lines.push('\tstrip height      ' + fmt(rep.stripH) + ' px');
		lines.push('\trows box height   ' + fmt(rep.rowsH) + ' px');
		lines.push('\trows shown        ' + fmt(rep.rowN) + '  (with text: ' + fmt(rep.textN) + ')');
		lines.push('\tdocument height   ' + fmt(rep.docH) + ' px');
		for (const sel of Object.keys(rep.marks)) {
			lines.push('\t' + pad(sel, 18) + 'top ' + fmt(rep.marks[sel].top) + ' px   h ' + fmt(rep.marks[sel].h) + ' px');
		}
		for (const sw of r.switches) {
			lines.push('\tL' + sw.level + ' switch ' + pad(sw.ms + ' ms', 10) + sw.badge + ' · ' + sw.gridInfo
				+ ' · strip ' + sw.stripH + ' px · controls top ' + sw.controlsTop + ' px · doc ' + sw.docH
				+ ' px · canvas ' + sw.pixels.canvas + ' ' + sw.pixels.distinct + ' colours, '
				+ sw.pixels.painted + ' painted samples');
		}
	}
	console.log(lines.join('\n'));
	if (oldTree && out.length === 2 && typeof out[0] !== 'string' && typeof out[1] !== 'string') {
		const [a, b] = [out[0].report, out[1].report];
		console.log('');
		console.log('MOVED BY THE STRIP (max - min over the same samples):');
		console.log('\tstrip height   ' + a.stripH.move + ' px -> ' + b.stripH.move + ' px');
		console.log('\tcontrols top   ' + a.marks['.controls'].top.move + ' px -> ' + b.marks['.controls'].top.move + ' px');
		console.log('\tnotes top      ' + a.marks['.notes'].top.move + ' px -> ' + b.marks['.notes'].top.move + ' px');
		console.log('\tdocument height ' + a.docH.move + ' px -> ' + b.docH.move + ' px');
		console.log('\tbadge left/width ' + a.marks['#badge'].h.move + ' px -> ' + b.marks['#badge'].h.move + ' px (h)');
	}
})().catch((e) => { console.error('HUD-REFLOW-FAIL', e && e.stack || e); process.exit(1); });

function fmt(s) { return pad(s.min + ' … ' + s.max + '  (moves ' + s.move + ')', 34); }
function pad(text, n) { text = String(text); return text + ' '.repeat(Math.max(0, n - text.length)); }

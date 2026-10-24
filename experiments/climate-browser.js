// Optional real-browser 0.9.1 gate; no package is needed by the page itself.
// PGT_CHROME=/path/to/chrome PGT_PUPPETEER=/path/to/puppeteer-core \
//   node experiments/climate-browser.js
// PGT_SHOT_DIR=/writable/dir optionally saves the boot and restored views.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PGT_PUPPETEER || 'puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;

async function main() {
	const executablePath = process.env.PGT_CHROME || puppeteer.executablePath();
	browser = await puppeteer.launch({
		executablePath: executablePath, headless: true,
		defaultViewport: { width: 1440, height: 1000 },
		// Web security stays on: this is the actual sibling-file + postMessage contract.
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote',
			'--ignore-gpu-blocklist', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader',
			'--enable-unsafe-swiftshader']
	});
	const page = await browser.newPage(), errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
	page.on('requestfailed', (request) => errors.push(request.url() + ': '
		+ (request.failure() ? request.failure().errorText : 'unknown')));
	const timeout = 60000;
	await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load', timeout });
	await page.evaluate(() => {
		window.globeGridBefore = Grid;
		window.geologyT = () => parseFloat(document.querySelector('#time').textContent);
	});
	await page.click('#climate-toggle');
	await page.waitForFunction(() => ClimateHost.state === 'running' || ClimateHost.state === 'refused', { timeout });
	const boot = await page.evaluate(() => ({ state: ClimateHost.state, reason: ClimateHost.reason }));
	assert.equal(boot.state, 'running', boot.reason);
	await page.waitForFunction(() => ClimateHost.weatherDays > 0, { timeout });
	assert.ok(await page.evaluate(() => Grid === window.globeGridBefore), 'climate replaced the globe Grid');
	const shotDir = process.env.PGT_SHOT_DIR;
	if (shotDir) {
		fs.mkdirSync(shotDir, { recursive: true });
		await page.screenshot({ path: path.join(shotDir, 'climate-boot.png') });
	}

	// Each pause is independent. Read the globe's 150 ms label only after it has settled.
	await page.click('#play');
	await page.waitForFunction(() => geologyT() > 0, { timeout });
	await page.click('#climate-play');
	await page.waitForFunction(() => !ClimateHost.weatherRunning, { timeout });
	const pausedDays = await page.evaluate(() => ClimateHost.weatherDays);
	const geologyBefore = await page.evaluate(() => geologyT());
	await page.waitForFunction((t) => geologyT() > t, { timeout }, geologyBefore);
	assert.equal(await page.evaluate(() => ClimateHost.weatherDays), pausedDays, 'paused weather advanced');
	await page.click('#play');
	await sleep(500);
	const stoppedGeology = await page.evaluate(() => geologyT());
	await page.click('#climate-play');
	await page.waitForFunction((days) => ClimateHost.weatherRunning && ClimateHost.weatherDays > days, { timeout }, pausedDays);
	assert.equal(await page.evaluate(() => geologyT()), stoppedGeology, 'paused geology advanced');

	// This is a manual snapshot, not an implicit per-frame coupling path.
	await page.click('#climate-refresh');
	await page.waitForFunction(() => !document.querySelector('#climate-refresh').disabled, { timeout });
	const refreshed = await page.evaluate(() => ({ t: geologyT(), surface: ClimateHost.surfaceTMyr, reason: ClimateHost.reason }));
	assert.equal(refreshed.reason, '', 'surface refresh refused');
	assert.ok(Math.abs(refreshed.surface - refreshed.t) <= 0.11, 'refresh used a stale geological surface');
	await page.click('#climate-play');
	await page.waitForFunction(() => !ClimateHost.weatherRunning, { timeout });

	// Keep the actual Blob in the page so a multi-megabyte binary never crosses the Node CDP
	// bridge as a number array. Loading it back still uses the real file input and FileReader.
	await page.evaluate(() => {
		window.savedClimateBlob = null;
		const original = URL.createObjectURL;
		URL.createObjectURL = function (blob) { window.savedClimateBlob = blob; return original.call(URL, blob); };
	});
	await page.click('#save');
	await page.waitForFunction(() => window.savedClimateBlob && !document.querySelector('#save').disabled, { timeout });
	const saved = await page.evaluate(async () => {
		const bytes = new Uint8Array(await window.savedClimateBlob.arrayBuffer());
		const packet = Session.read(bytes);
		window.savedClimateBlobForLoad = window.savedClimateBlob;
		return {
			bytes: bytes.length, level: packet.head.level,
			t: new DataView(packet.world.buffer, packet.world.byteOffset).getFloat64(Checkpoint.HEAD, true),
			weatherSeconds: packet.climate.state.simTime,
			surfaceTMyr: packet.climate.surface.tMyr,
			format: packet.climate.format
		};
	});
	assert.equal(saved.format, 'pgt-climate-state');
	await page.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File([window.savedClimateBlobForLoad], 'joint.pgts'));
		const input = document.querySelector('#load');
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.waitForFunction(() => /weather day/.test(document.querySelector('#probe').textContent), { timeout });
	const restored = await page.evaluate(() => ({
		t: geologyT(), weatherSeconds: ClimateHost.weatherDays * 86400,
		running: ClimateHost.weatherRunning, state: ClimateHost.state,
		gridIsolated: Grid === window.globeGridBefore
	}));
	assert.ok(Math.abs(restored.t - saved.t) <= 1e-8, 'geological clock did not round trip');
	assert.ok(Math.abs(restored.weatherSeconds - saved.weatherSeconds) <= 1e-5, 'weather clock did not round trip');
	assert.equal(restored.running, false, 'weather pause did not round trip');
	assert.equal(restored.state, 'running');
	assert.ok(restored.gridIsolated);
	if (shotDir) {
		await page.evaluate(() => document.querySelector('#climate-panel').scrollIntoView({ block: 'start' }));
		await page.screenshot({ path: path.join(shotDir, 'climate-restored.png') });
	}

	await page.click('#climate-toggle');
	const closed = await page.evaluate(() => ({ state: ClimateHost.state, t: geologyT(), isolated: Grid === window.globeGridBefore }));
	assert.equal(closed.state, 'closed');
	assert.ok(closed.isolated);
	await page.click('#step');
	await page.waitForFunction((t) => geologyT() > t, { timeout }, closed.t);
	assert.deepEqual(errors, [], 'browser console/page/request errors');
	console.log(JSON.stringify({
		pass: true, boot: 'file:// + WebGL2, web security enabled',
		independentPauses: true, manualSurfaceTMyr: refreshed.surface,
		saved: saved, restored: restored, globeStepAfterClose: true, browserErrors: errors.length
	}, null, '\t'));
	await browser.close();
	browser = null;
}
main().catch(async (error) => {
	console.error(error.stack || error);
	if (browser) await browser.close();
	process.exitCode = 1;
});

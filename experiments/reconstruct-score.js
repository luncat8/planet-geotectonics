// Reconstruction gate (0.4.6 plan §10): put the modern pack's columns at a past epoch with
// Mode K and measure how close the resulting land mask comes to the committed pack for that
// epoch, as intersection-over-union on the same grid. This is the number that decides whether
// the rotation model, the crosswalk and the handedness are right: a mirrored or wrongly
// composed reconstruction lands the continents in the ocean and scores near zero, so a
// passing score cannot be faked.
//
//   node experiments/reconstruct-score.js [--epochs=250,200] [--level=5] [--seed=7]
//                                         [--preset=realistic]
//
// Reference masks are the committed historical packs' own land masks, i.e. the Scotese
// PaleoDEM coastlines. The plan's threshold is IoU >= 0.60 per epoch.
const Grid = require('../js/geodesics.js'), State = require('../js/state.js');
const Earth = require('../js/earth.js');
require('../js/data/earth-1deg.js');
require('../js/data/earth-250Ma.js');
require('../js/data/earth-200Ma.js');

const flag = (name, value) => {
	const arg = process.argv.find((a) => a.startsWith('--' + name + '='));
	return arg === undefined ? value : arg.slice(name.length + 3);
};
const LEVEL = +flag('level', 5), SEED = +flag('seed', 7);
const PRESET = flag('preset', 'realistic');
const THRESHOLD = +flag('threshold', 0.6);
const EPOCHS = flag('epochs', '250,200').split(',').map(Number);

const modern = Earth.pick(LEVEL, 'earth');
if (!modern) { console.error('FAIL: no modern pack'); process.exit(1); }
const grid = new Grid(LEVEL, SEED).build();
const state = new State(grid, SEED);
Earth.apply(state, modern, { realistic: PRESET === 'realistic' });
console.log('[*] reconstruct-score: ' + modern.name + ' (' + modern.plates.count + ' plates, epoch '
	+ modern.epoch + ' Ma) reconstructed onto L' + LEVEL + ' seed ' + SEED
	+ ', ' + state.n + ' columns, ' + grid.V + ' cells');

// The baseline: how much does the modern mask already agree with each historical one? A
// reconstruction has to beat doing nothing by a wide margin, or the gate proves nothing.
const atHome = Earth.landFromState(state);
let failed = false;
for (const epoch of EPOCHS) {
	const ref = Earth.pick(LEVEL, epoch === 250 ? 'pangaea' : epoch === 200 ? 'gondwana' : null);
	if (!ref) { console.log('    ' + epoch + ' Ma: no committed pack, skipped'); continue; }
	const refMask = Earth.landFromPack(ref, grid);
	const base = Earth.iou(atHome, refMask);
	const r = Earth.reconstruct(state, epoch);
	const mask = Earth.landFromState(state);
	const got = Earth.iou(mask, refMask);
	const ok = got.iou >= THRESHOLD;
	if (!ok) failed = true;
	console.log('  ' + epoch + ' Ma · moved ' + r.moved + ' columns, ' + r.stuck + ' left put ('
		+ r.stuckPlates + ' plates the crosswalk has no plate for)');
	console.log('    land ' + (100 * Earth.fraction(mask)).toFixed(2) + '% vs reference '
		+ (100 * Earth.fraction(refMask)).toFixed(2) + '%  ·  IoU ' + got.iou.toFixed(4)
		+ ' (unreconstructed ' + base.iou.toFixed(4) + ')  ·  ' + (ok ? 'PASS' : 'FAIL')
		+ ' against ' + THRESHOLD.toFixed(2));
	// Reversibility is the point of Mode K, so measure it rather than assert it in prose.
	Earth.reconstruct(state, modern.epoch);
	const back = Earth.iou(Earth.landFromState(state), atHome);
	console.log('    back to ' + modern.epoch + ' Ma: IoU with the starting mask ' + back.iou.toFixed(6));
}
console.log(failed ? 'FAIL reconstruct-score: an epoch is below ' + THRESHOLD : 'PASS reconstruct-score');
process.exit(failed ? 1 : 0);

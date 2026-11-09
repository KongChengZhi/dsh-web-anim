/**
 * pipeline.test.mjs — the tool handlers, end to end, against a real browser.
 *
 * selftest.mjs proves the engine works; this proves the *tools* work: that a
 * capture is reachable in one call, that a zoom re-reads a stored cell without a
 * browser, that gc reports honestly, and that the artifact budget holds under a
 * burst of captures.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-pipe-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { runZoom } = await import('../lib/handlers/zoom.js');
const { runGc } = await import('../lib/handlers/gc.js');
const { runProbe } = await import('../lib/handlers/probe.js');
const { closeBrowser } = await import('../lib/browser.js');
const { readMeta } = await import('../lib/store.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = 'file:///' + join(here, '..', 'fixtures', 'animation.html').replace(/\\/g, '/');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

// No attachments service here: every handler must still return a complete text
// result. That is the degradation path a headless profile actually hits.
const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

try {
  console.log('pipeline');

  const probe = await runProbe(ctx, { url: fixture, width: 900, height: 520 });
  check('probe returns text', typeof probe.text === 'string' && probe.text.includes('suggested capture'), probe.text.slice(0, 120));
  check('probe classifies the fixture', probe.probe.animationCount >= 1, String(probe.probe.animationCount));

  const capture = await runCaptureTool(ctx, { url: fixture, width: 900, height: 520, from: 0, to: 600, frames: 6, label: 'pipeline' });
  check('capture returns ok', capture.ok === true);
  check('capture has a capture id', typeof capture.captureId === 'string' && capture.captureId.startsWith('cap-'));
  check('capture text cites the cells', capture.text.includes('#1') && capture.text.includes('web_anim_zoom'), capture.text.slice(0, 160));
  check('capture degrades to text without attachments', capture.images.length === 0 && capture.warnings.some((w) => w.includes('could not be attached')), JSON.stringify(capture.warnings));
  check('capture wrote metadata', readMeta(capture.captureId) !== null);
  check('capture reports a token estimate', capture.text.includes('tokens'), capture.text.split('\n').find((line) => line.includes('tokens')) ?? '(no token line)');

  const zoom = await runZoom(ctx, { captureId: capture.captureId, cell: 3 });
  check('zoom returns ok', zoom.ok === true);
  check('zoom reports the cell time', typeof zoom.t === 'number' && zoom.cell === 3, `cell=${zoom.cell} t=${zoom.t}`);
  check('zoom touches the capture for LRU', readMeta(capture.captureId).accessCount >= 1);

  let missing = null;
  try {
    await runZoom(ctx, { captureId: 'cap-does-not-exist', cell: 1 });
  } catch (error) {
    missing = String(error.message);
  }
  check('zoom on a missing capture fails with a helpful message', missing !== null && missing.includes('no such capture'), String(missing));

  const status = await runGc(ctx, { action: 'status' });
  check('gc status lists the capture', status.text.includes(capture.captureId));
  check('gc status reports usage', typeof status.usage.used === 'number' && status.usage.used > 0);

  const pin = await runGc(ctx, { action: 'pin', captureId: capture.captureId });
  check('pin sets the flag', pin.pinned === true && readMeta(capture.captureId).pinned === true);
  const unpin = await runGc(ctx, { action: 'unpin', captureId: capture.captureId });
  check('unpin clears the flag', unpin.pinned === false);

  const refused = await runGc(ctx, { action: 'clear' });
  check('clear refuses without confirmation', refused.ok === false && refused.text.includes('confirm'));

  // A burst of captures of the same page: the oldest must be flagged superseded.
  const second = await runCaptureTool(ctx, { url: fixture, width: 900, height: 520, from: 0, to: 600, frames: 6 });
  const statusAfter = await runGc(ctx, { action: 'status' });
  check('a repeat capture supersedes the first', statusAfter.text.includes('stale'), statusAfter.text.slice(-260));

  const pruneResult = await runGc(ctx, { action: 'prune' });
  check('prune releases the superseded capture', pruneResult.removed.includes(capture.captureId), JSON.stringify(pruneResult.removed));
  check('prune keeps the newest capture', existsSync(join(sandbox, 'captures', second.captureId)));
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'pipeline passed' : `pipeline failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

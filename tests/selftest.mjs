/**
 * selftest.mjs — end-to-end check against a real headless browser.
 *
 * No mocks: it launches Chrome/Edge, loads fixtures/animation.html, and drives
 * the same modules the tools use. If this passes, the plugin can actually see a
 * page; if it fails, the failure is in the part that matters.
 *
 * Run: node tests/selftest.mjs
 */

import { closeBrowser } from '../lib/browser.js';
import { openPage } from '../lib/page.js';
import { planCapture, runCapture } from '../lib/capture.js';
import { decodePng } from '../lib/png.js';
import { composeSheet, frameDiff, imageTokens } from '../lib/image.js';
import { manual } from '../lib/help.js';
import { usage, statusLine, listCaptures } from '../lib/store.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'animation.html');

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

async function main() {
  console.log('web-anim selftest');
  console.log('fixture:', fixture);

  // ---- pure modules, no browser ------------------------------------------
  const sheetOf2 = composeSheet([
    { data: Buffer.alloc(40 * 30 * 4, 200), width: 40, height: 30, t: 0 },
    { data: Buffer.alloc(40 * 30 * 4, 20), width: 40, height: 30, t: 100 },
  ]);
  check('composeSheet produces a PNG', sheetOf2.png.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])));
  const roundTrip = decodePng(sheetOf2.png);
  check('decodePng reads our own PNG', roundTrip.width === sheetOf2.width && roundTrip.height === sheetOf2.height,
    `${roundTrip.width}x${roundTrip.height} vs ${sheetOf2.width}x${sheetOf2.height}`);

  const a = Buffer.alloc(10 * 10 * 4, 0);
  const b = Buffer.alloc(10 * 10 * 4, 0);
  for (let i = 0; i < 50; i += 1) b[i * 4] = 255;
  const diff = frameDiff(a, b, { width: 10 });
  check('frameDiff sees a half-frame change', Math.abs(diff.changedRatio - 0.5) < 0.01, String(diff.changedRatio));
  check('frameDiff reports a bbox', diff.bbox !== null);

  check('imageTokens grows with area', imageTokens(400, 400) < imageTokens(1200, 1200));
  check('manual has topics', manual('cost').includes('image tokens') && manual().length > 500);

  // ---- real browser -------------------------------------------------------
  const opened = await openPage({ url: 'file:///' + fixture.replace(/\\/g, '/'), width: 900, height: 520, waitMs: 350 });
  try {
    const probe = opened.probe;
    check('injection ran on the document', probe.injectionInstalled !== false, JSON.stringify(probe.reasons));
    check('probe found the CSS animation', probe.animationCount >= 1, `animationCount=${probe.animationCount}`);
    check('probe classified the page', ['html', 'hybrid', 'canvas', 'timeline'].includes(probe.kind), probe.kind);
    check('probe saw the rAF loop', (probe.rafCount ?? 0) > 0, String(probe.rafCount));

    const plan = planCapture(probe, { from: 0, to: 600, frames: 7 });
    check('plan picks virtual mode', plan.mode === 'virtual' || plan.mode === 'timeline', plan.mode);
    check('plan produces the requested cells', plan.frameTimes.length === 7, String(plan.frameTimes.length));

    const captured = await runCapture({ page: opened.page, probe, plan, label: 'selftest' });
    check('capture produced a sheet', captured.meta.sheet.width > 0 && captured.meta.sheet.height > 0);
    check('capture recorded every cell', captured.meta.cells.length === 7);
    check('capture wrote a file', captured.paths.sheet.includes(captured.captureId));

    // Determinism: same page, same plan, run twice from a fresh document — the
    // tool always opens the page per call, so this is the honest comparison.
    const reopened = await openPage({ url: 'file:///' + fixture.replace(/\\/g, '/'), width: 900, height: 520, waitMs: 350 });
    let second;
    try {
      const plan2 = planCapture(reopened.probe, { from: 0, to: 600, frames: 7 });
      second = await runCapture({ page: reopened.page, probe: reopened.probe, plan: plan2, label: 'selftest-repeat' });
    } finally {
      await reopened.release({ unfreeze: true });
    }
    // Determinism is asserted on pixels, not on PNG bytes: Page.captureScreenshot
    // rasterises asynchronously, so an anti-aliased edge can differ by one level
    // between runs even when the DOM is identical. "No visible difference" is the
    // property a debugging tool actually needs, and the one we can hold.
    const sheetA = decodePng(captured.sheetPng);
    const sheetB = decodePng(second.sheetPng);
    const drift = frameDiff(sheetA.data, sheetB.data, { width: sheetA.width, threshold: 4 });
    check('capture is visually deterministic',
      drift.changedRatio === 0 && drift.meanDelta < 0.05,
      `changedRatio=${drift.changedRatio} meanDelta=${drift.meanDelta.toFixed(4)}`);
    check('deterministic runs agree on the timeline',
      JSON.stringify(captured.meta.cells.map((c) => c.t)) === JSON.stringify(second.meta.cells.map((c) => c.t)));

    const moving = captured.meta.diff.filter((entry) => entry.changedRatio > 0.0005).length;
    check('capture sees motion between cells', moving >= 2, `${moving} of ${captured.meta.diff.length} transitions moved`);

    const store = usage();
    check('store reports usage', store.used > 0 && store.budget > 0, statusLine());
    check('store lists the captures', listCaptures().length >= 2);
  } finally {
    await opened.release({ unfreeze: true });
    await closeBrowser();
  }

  console.log('');
  console.log(failures === 0 ? 'selftest passed' : `selftest failed: ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('selftest crashed:', error);
  process.exit(2);
});

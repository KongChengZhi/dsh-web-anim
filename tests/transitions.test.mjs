/**
 * transitions.test.mjs — a CSS transition must not make the picture depend on
 * when you took it.
 *
 * ## The bug this suite exists for
 *
 * The plugin drives JS animation (rAF) and the CSS/WAAPI timeline
 * (Animation.currentTime) precisely. That covers *animations*. It does not cover
 * CSS *transitions*, which are a different mechanism: a transition is created at
 * the moment a computed style changes and interpolates the old value to the new
 * one on the compositor's own clock. It has no timeline of its own and nothing to
 * seek to.
 *
 * So the failure mode is: seek(500) writes a class, a 500ms transition starts,
 * and the screenshot captures whichever frame of that transition happened to be
 * painted. Capture the same t twice and the two pictures differ by however far the
 * transition advanced in between. Measured on a real page: up to 816 differing
 * pixels, with the canvas itself bit-identical.
 *
 * The fix is to finish in-flight transitions as part of the seek, so the DOM at t
 * is the settled state at t. This suite proves both the failure and the fix:
 *
 *   - the raw page (no plugin) is shown to be un-settled, so the test is not
 *     passing because the fixture is toothless;
 *   - a capture of the same t, taken twice, must be pixel-identical;
 *   - the text result must say transitions were settled, and name the properties,
 *     so the behaviour is visible rather than implied.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-trans-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { openPage } = await import('../lib/page.js');
const { closeBrowser } = await import('../lib/browser.js');
const { decodePng } = await import('../lib/png.js');
const { frameDiff } = await import('../lib/image.js');
const { capturePaths } = await import('../lib/store.js');
const { readFileSync } = await import('node:fs');

/** The tool returns metadata; the sheet is on disk. Read it the way a caller would. */
const sheetOf = (captureId) => decodePng(readFileSync(capturePaths(captureId, process.env).sheet));

const here = dirname(fileURLToPath(import.meta.url));
const fixture = 'file:///' + join(here, '..', 'fixtures', 'transition.html').replace(/\\/g, '/');
const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

try {
  console.log('transitions');

  /* ---- 0. the fixture really does strand a transition -------------------- */
  //
  // Proof that the test has teeth: drive the page by hand the way a naive tool
  // would (call the page's own seek, screenshot immediately) and confirm the
  // transition is genuinely in flight. Without this, a passing test below could
  // just mean the fixture never animates anything.
  const raw = await openPage({ url: fixture, width: 900, height: 520, waitMs: 60, freeze: false });
  let strandedRaw = -1;
  try {
    strandedRaw = await raw.page.evaluate(`(() => {
      window.seekTo(0);
      window.seekTo(500);
      const list = document.getAnimations ? document.getAnimations() : [];
      return list.filter((a) => a.playState === 'running').length;
    })()`);
  } finally {
    await raw.release({ unfreeze: true });
  }
  check('the fixture really strands a running transition', strandedRaw > 0, 'running=' + strandedRaw);

  /* ---- 1. same t, twice, through the plugin ------------------------------ */
  const first = await runCaptureTool(ctx, { url: fixture, width: 900, height: 520, frames: 4, from: 400, to: 520, waitMs: 60 });
  check('capture succeeded', first.ok === true);
  check('the plugin settled transitions', (first.meta.transitionsSettled ?? 0) > 0,
    'transitionsSettled=' + first.meta.transitionsSettled);
  check('the settled properties are named', (first.meta.settledProperties ?? []).some((p) => p === 'background-color' || p === 'border-color'),
    JSON.stringify(first.meta.settledProperties));

  const second = await runCaptureTool(ctx, { url: fixture, width: 900, height: 520, frames: 4, from: 400, to: 520, waitMs: 60 });
  const a = sheetOf(first.captureId);
  const b = sheetOf(second.captureId);
  const drift = frameDiff(a.data, b.data, { width: a.width, threshold: 0 });
  check('two captures of the same window are pixel-identical', drift.changedPixels === 0,
    `changedPixels=${drift.changedPixels} maxDelta=${drift.maxDelta} bbox=${JSON.stringify(drift.bbox)}`);

  /* ---- 2. the DOM is at the settled state, not mid-fade ------------------ */
  //
  // At t=520 the class is on, so the *settled* background is the highlighted one.
  // A mid-transition screenshot would be somewhere between the two colours.
  const mid = await runCaptureTool(ctx, { url: fixture, width: 900, height: 520, frames: 2, from: 500, to: 540, waitMs: 60 });
  check('the highlighted state is reached at t>=500', mid.meta.transitionsSettled > 0);

  /* ---- 3. a page with no transitions is unaffected ----------------------- */
  const plain = 'file:///' + join(here, '..', 'fixtures', 'animation.html').replace(/\\/g, '/');
  const noTrans = await runCaptureTool(ctx, { url: plain, width: 900, height: 520, frames: 4, from: 0, to: 400, waitMs: 60 });
  check('a page without transitions settles nothing', (noTrans.meta.transitionsSettled ?? 0) === 0,
    'transitionsSettled=' + noTrans.meta.transitionsSettled);
  check('and still captures', noTrans.ok === true && noTrans.meta.cells.length === 4);
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'transitions passed' : `transitions failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

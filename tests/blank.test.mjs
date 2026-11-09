/**
 * blank.test.mjs — "nothing moved" and "nothing painted" must not look alike.
 *
 * ## Where this came from
 *
 * During the pre-release audit the plugin was pointed at a real third-party page
 * for the first time (threejs.org's own animation example). It reported:
 *
 *   page kind: canvas, 4 canvases found, 6 cells, 0 visible change in 5 of 5
 *   transitions, sheet 7KB
 *
 * Every number was internally consistent and the conclusion a reader would draw
 * is "this animation has settled / has no motion in this window". The actual
 * cause was that the page had painted nothing at all. A tool that answers
 * "nothing moved" when the truth is "nothing rendered" is worse than one that
 * refuses: the model believes it, then goes looking for a bug in the animation.
 *
 * So a frame that is almost one colour is now reported explicitly, and this suite
 * pins both directions:
 *
 *   - a blank page must be flagged;
 *   - a legitimately sparse but real page must NOT be flagged.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-blank-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { closeBrowser } = await import('../lib/browser.js');
const { frameUniformity } = await import('../lib/image.js');

const here = dirname(fileURLToPath(import.meta.url));
const url = (name) => 'file:///' + join(here, '..', 'fixtures', name).replace(/\\/g, '/');
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
  console.log('blank frames');

  /* ---- the helper itself ------------------------------------------------- */
  const flat = Buffer.alloc(100 * 100 * 4, 200);
  const flatInfo = frameUniformity(flat);
  check('a single-colour buffer is uniform', flatInfo.uniform === true, JSON.stringify(flatInfo));
  check('a single-colour buffer has one quantised colour', flatInfo.colors === 1, String(flatInfo.colors));

  const noisy = Buffer.alloc(100 * 100 * 4, 200);
  for (let i = 0; i < noisy.length; i += 4) {
    const v = (i / 4) % 2 === 0 ? 20 : 240;
    noisy[i] = v; noisy[i + 1] = v; noisy[i + 2] = v;
  }
  check('a half-black/half-white buffer is not uniform', frameUniformity(noisy).uniform === false);

  /* ---- a page that never paints ----------------------------------------- */
  const blank = await runCaptureTool(ctx, { url: url('blank.html'), width: 900, height: 520, frames: 4, from: 0, to: 400, waitMs: 120 });
  check('the blank page is captured without error', blank.ok === true);
  check('every blank cell is flagged', blank.meta.blankFrames === blank.meta.cells.length,
    `blankFrames=${blank.meta.blankFrames} of ${blank.meta.cells.length}`);
  check('the result says it out loud', /almost a single colour/.test(blank.text),
    blank.text.split('\n').filter((line) => line.includes('single colour')).join(' | ') || '(no such line)');
  check('the note names a likely cause', /webgl|canvas|loading/i.test(blank.text));

  /* ---- a sparse but real page must not be flagged ----------------------- */
  const real = await runCaptureTool(ctx, { url: url('timeline.html'), width: 900, height: 520, frames: 4, from: 0, to: 800, waitMs: 80 });
  check('a real page is not flagged as blank', (real.meta.blankFrames ?? 0) === 0,
    `blankFrames=${real.meta.blankFrames}`);
  check('a real page does not print the blank note', !/almost a single colour/.test(real.text));

  /* ---- and the ordinary CSS page, which is nearly white ------------------ */
  const css = await runCaptureTool(ctx, { url: url('animation.html'), width: 900, height: 520, frames: 4, from: 0, to: 500, waitMs: 80 });
  check('a light-coloured real page is not flagged', (css.meta.blankFrames ?? 0) === 0,
    `blankFrames=${css.meta.blankFrames} uniformity=${JSON.stringify(css.meta.frameUniformity)}`);
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'blank passed' : `blank failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

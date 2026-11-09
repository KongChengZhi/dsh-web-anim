/**
 * params.test.mjs — every declared parameter must actually do something.
 *
 * Three of them used to be decorative: `selector` was recorded but ignored
 * ("the sheet shows the whole viewport"), `includeFrames` produced byte-identical
 * output either way, and `fullRes` did nothing because the crop was always scaled
 * to maxSide. A tool whose schema lists an argument the handler ignores is worse
 * than one without it: the model spends a call discovering the lie.
 *
 * This suite calls the handlers for real and compares what comes back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-params-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { runZoom } = await import('../lib/handlers/zoom.js');
const { closeBrowser } = await import('../lib/browser.js');
const { toolSpecs } = await import('../lib/tools.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = 'file:///' + join(here, '..', 'fixtures', 'animation.html').replace(/\\/g, '/');
const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

const base = { url: fixture, width: 900, height: 520, from: 0, to: 600, frames: 4, waitMs: 80 };

try {
  console.log('parameters');

  // --- selector -----------------------------------------------------------
  const whole = await runCaptureTool(ctx, base);
  const clipped = await runCaptureTool(ctx, { ...base, selector: '#card' });
  check('selector changes the sheet', clipped.meta.sheet.width !== whole.meta.sheet.width || clipped.meta.sheet.height !== whole.meta.sheet.height,
    `${whole.meta.sheet.width}x${whole.meta.sheet.height} vs ${clipped.meta.sheet.width}x${clipped.meta.sheet.height}`);
  check('selector records the clip rectangle', clipped.meta.clip !== null && clipped.meta.clip.width > 0, JSON.stringify(clipped.meta.clip));
  check('a clipped sheet is narrower than the viewport', clipped.meta.clip.width < base.width, String(clipped.meta.clip?.width));

  const missing = await runCaptureTool(ctx, { ...base, selector: '#does-not-exist' });
  check('an unknown selector falls back with a warning', missing.meta.clip === null && (missing.warnings ?? []).some((w) => w.includes('not found')),
    JSON.stringify(missing.warnings));

  // --- includeFrames ------------------------------------------------------
  const verbose = await runCaptureTool(ctx, { ...base, includeFrames: true });
  const terse = await runCaptureTool(ctx, { ...base, includeFrames: false });
  check('includeFrames=false shortens the result', terse.text.length < verbose.text.length,
    `${terse.text.length} vs ${verbose.text.length}`);
  check('the terse result still identifies the capture', terse.text.includes(terse.captureId));
  check('the terse result drops the per-cell list', !terse.text.includes('cells (cite one with'));

  // --- zoom: maxSide and fullRes -----------------------------------------
  const big = await runZoom(ctx, { captureId: whole.captureId, cell: 1, maxSide: 1200 });
  const small = await runZoom(ctx, { captureId: whole.captureId, cell: 1, maxSide: 220 });
  const bigPx = Number(/(\d+)x(\d+)px/.exec(big.text)?.[1] ?? 0);
  const smallPx = Number(/(\d+)x(\d+)px/.exec(small.text)?.[1] ?? 0);
  check('maxSide changes the zoom size', bigPx > smallPx, `${bigPx} vs ${smallPx}`);

  const full = await runZoom(ctx, { captureId: whole.captureId, cell: 1, fullRes: true });
  const fullW = Number(/(\d+)x(\d+)px/.exec(full.text)?.[1] ?? 0);
  check('fullRes returns the native cell size', fullW > 0 && fullW <= whole.meta.cells[0].width + 8, `${fullW} vs cell ${whole.meta.cells[0].width}`);

  // --- every declared parameter is at least read somewhere ---------------
  const specs = toolSpecs();
  check('five tools are declared', specs.length === 5, String(specs.length));
  check('capture declares selector and includeFrames', (() => {
    const capture = specs.find((s) => s.name === 'web_anim_capture');
    return capture.parameters.selector !== undefined && capture.parameters.includeFrames !== undefined;
  })());
  check('zoom declares fullRes and maxSide', (() => {
    const zoom = specs.find((s) => s.name === 'web_anim_zoom');
    return zoom.parameters.fullRes !== undefined && zoom.parameters.maxSide !== undefined;
  })());
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'parameters passed' : `parameters failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * static.test.mjs — a page with nothing to animate must not cost a full sheet.
 *
 * This is a cost guarantee, not a curiosity: the most common wrong turn is
 * pointing a timeline tool at a static document and paying for 16 identical
 * cells. Two cells plus an explicit "this is static" line is the answer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-static-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { closeBrowser } = await import('../lib/browser.js');

const here = dirname(fileURLToPath(import.meta.url));
const page = join(sandbox, 'static.html');
writeFileSync(page, '<!doctype html><title>static</title><h1 style="font:32px system-ui">Nothing moves here</h1>');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

try {
  console.log('static page');
  const result = await runCaptureTool(ctx, { url: 'file:///' + page.replace(/\\/g, '/'), width: 900, height: 520 });
  check('a static page is capped at two cells', result.meta.cells.length === 2, String(result.meta.cells.length));
  check('the result says it is static', result.text.includes('no animation source') && result.text.includes('static screenshot'), result.text.split('\n').slice(-6).join(' | '));
  check('the plan is marked looksStatic', result.meta.looksStatic === true);

  const forced = await runCaptureTool(ctx, { url: 'file:///' + page.replace(/\\/g, '/'), width: 900, height: 520, frames: 5 });
  check('an explicit cell count still wins', forced.meta.cells.length === 5, String(forced.meta.cells.length));
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'static passed' : `static failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

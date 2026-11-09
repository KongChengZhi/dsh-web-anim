import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_WEB_ANIM_DIR = mkdtempSync(join(tmpdir(), 'dsh-web-anim-real-'));
const { runProbe } = await import('../lib/handlers/probe.js');
const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { closeBrowser } = await import('../lib/browser.js');

const target = process.argv[2];
const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

const probe = await runProbe(ctx, { url: target, width: 1280, height: 720 });
console.log('--- probe ---');
console.log(probe.text.split('\n').filter(l => l.trim()).slice(0, 20).join('\n'));
console.log('');
const cap = await runCaptureTool(ctx, { url: target, width: 1280, height: 720, frames: 8 });
console.log('--- capture ---');
console.log(cap.text);
// Copy out only when the caller asked where to put it. A hardcoded destination
// makes this script fail on anyone else's machine.
const out = process.argv[3];
if (out) {
  const { copyFileSync } = await import('node:fs');
  copyFileSync(join(process.env.DSH_WEB_ANIM_DIR, 'captures', cap.captureId, 'sheet.png'), out);
  console.log('sheet written to', out);
}
await closeBrowser();
process.exit(0);

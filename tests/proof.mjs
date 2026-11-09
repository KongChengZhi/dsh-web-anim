import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-proof-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { closeBrowser, describeBrowserEnvironment } = await import('../lib/browser.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = 'file:///' + join(here, '..', 'fixtures', 'animation.html').replace(/\\/g, '/');
const ctx = { logger: { info() {}, warn() {}, error() {} }, get() { return undefined; } };

const before = process.getProcessMemoryInfo ? null : null;
const t0 = Date.now();
const result = await runCaptureTool(ctx, { url: fixture, width: 1280, height: 720, from: 0, to: 600, frames: 8, label: 'proof' });
const elapsed = Date.now() - t0;

const walk = (dir) => {
  let total = 0, files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { const sub = walk(p); total += sub.total; files += sub.files; }
    else { total += statSync(p).size; files += 1; }
  }
  return { total, files };
};
const tree = walk(sandbox);

console.log('capture id:', result.captureId);
console.log('elapsed:', elapsed + 'ms for 8 cells @1280x720');
console.log('files written:', tree.files, 'total bytes:', tree.total);
console.log('sheet tokens:', result.meta.sheet.tokens, 'sheet px:', result.meta.sheet.width + 'x' + result.meta.sheet.height);
console.log('cells:', result.meta.cells.length, 'diffs:', result.meta.diff.length);
console.log('mode:', result.meta.mode, 'deterministic:', result.meta.deterministic);
console.log('');
console.log(result.text);
console.log('');
console.log('browser environment:', JSON.stringify(describeBrowserEnvironment()));
await closeBrowser();
rmSync(sandbox, { recursive: true, force: true });
// No process.exit(): let Node run its own teardown so the browser's exit hook and
// any pending fs handles finish. Calling exit() here is what used to strand a
// headless profile in TEMP.


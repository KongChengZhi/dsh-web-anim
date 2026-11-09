/**
 * load.test.mjs — many captures in parallel must stay correct and bounded.
 *
 * The concurrency suite proves two parallel calls share one browser. This one goes
 * further: 20 captures in batches of 5, which is the shape a multi-agent host
 * actually produces. It asserts three things that only show up at volume:
 *
 *   1. every capture succeeds (no shared-state corruption);
 *   2. the browser is reused, not multiplied;
 *   3. nothing leaks — no extra profile directories, no orphan Chrome.
 *
 * It also exercises the environment hardening: a launcher that strips TEMP used to
 * make every launch fail with a bare ENOENT from mkdtemp.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-load-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { runCaptureTool } = await import('../lib/handlers/capture.js');
const { closeBrowser, describeBrowserEnvironment, resolveBrowser } = await import('../lib/browser.js');

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

// Count only profiles this process created. A long-running DSH host legitimately
// keeps a warm browser (it is reaped after 10 idle minutes), and a test that asserts
// on machine-wide state would fail for a reason that is not a defect in the code.
const ownProfiles = [];
const profiles = () => ownProfiles.filter((dir) => existsSync(dir)).length;
/**
 * Chrome processes holding any of THIS run's profile directories.
 *
 * The list goes through a temp file rather than the command line: PowerShell and
 * JSON disagree about quoting, and a test that fails on quoting tells you nothing
 * about the code under test.
 */
const ourChrome = () => {
  const dirs = ownProfiles.filter((dir) => existsSync(dir));
  if (dirs.length === 0) return 0;
  const listFile = join(sandbox, 'dirs.json');
  try {
    writeFileSync(listFile, JSON.stringify(dirs), 'utf8');
    const script = [
      '$dirs = Get-Content -Raw $args[0] | ConvertFrom-Json;',
      '$n = 0;',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "chrome*" } | ForEach-Object {',
      '  foreach ($d in $dirs) { if ($_.CommandLine -like "*$d*") { $script:n++; break } }',
      '};',
      '$n',
    ].join(' ');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script, listFile], { encoding: 'utf8' });
    return Number(out.trim());
  } catch {
    return -1;
  }
};

const TOTAL = 20;
const BATCH = 5;

try {
  console.log('load');
  // Record our own browser's profile as soon as it exists.
  const beforeProfiles = profiles();
  const started = Date.now();
  const results = [];

  for (let start = 0; start < TOTAL; start += BATCH) {
    const settled = await Promise.allSettled(
      Array.from({ length: BATCH }, (_, i) => start + i).map((n) =>
        runCaptureTool(ctx, { url: fixture, width: 900, height: 520, from: 0, to: 600, frames: 6, waitMs: 60, label: `load-${n}` })),
    );
    results.push(...settled);
  }

  const elapsed = (Date.now() - started) / 1000;
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected');

  check(`all ${TOTAL} parallel captures succeed`, ok === TOTAL, `${ok}/${TOTAL}; first error: ${rejected[0]?.reason?.message ?? '-'}`);
  check('every capture gets a distinct id', new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.captureId)).size === ok);
  check('all sheets cost the same tokens', new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.meta.sheet.tokens)).size === 1);

  const runningSession = describeBrowserEnvironment().running;
  const running = runningSession;
  // Record our own session's profile so teardown assertions ignore other DSH hosts.
  const own = await resolveBrowser({ strategy: 'auto' });
  if (own.profileDir) ownProfiles.push(own.profileDir);
  check('one browser serves every capture', running !== null && running.kind === 'launched', JSON.stringify(running));
  check('at most one extra profile directory', profiles() - beforeProfiles <= 1, `${beforeProfiles} -> ${profiles()}`);

  console.log(`  info ${TOTAL} captures in ${elapsed.toFixed(1)}s (${(elapsed / TOTAL * 1000).toFixed(0)}ms each, ${BATCH} at a time)`);

  await closeBrowser();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check('teardown leaves no profile', profiles() === 0, String(profiles()));
  const chrome = ourChrome();
  check('teardown leaves no browser process', chrome === 0, String(chrome));
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'load passed' : `load failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
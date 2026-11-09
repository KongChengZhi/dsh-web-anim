/**
 * idle.test.mjs — a warm browser must not become a permanent occupant.
 *
 * Reusing one headless instance makes consecutive captures fast, but it also holds a
 * process and a ~10MB profile for as long as the host runs. This checks that the
 * idle reaper gives both back without closing the browser out from under a caller.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-idle-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { resolveBrowser, closeBrowser, describeBrowserEnvironment } = await import('../lib/browser.js');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

try {
  console.log('idle reaper');

  const first = await resolveBrowser({ strategy: 'launch' });
  check('a browser is launched', first.ownsProcess === true);
  check('the profile exists while it runs', existsSync(first.profileDir), first.profileDir);

  const second = await resolveBrowser({ strategy: 'auto' });
  check('a second call reuses the same instance', second.port === first.port, `${first.port} vs ${second.port}`);
  check('reuse keeps it alive', describeBrowserEnvironment().running !== null);

  await closeBrowser();
  // Assert on THIS session's profile, not on the temp directory: another DSH process
  // may legitimately have its own browser running.
  check('closeBrowser reclaims its profile', !existsSync(first.profileDir), first.profileDir);
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'idle passed' : `idle failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

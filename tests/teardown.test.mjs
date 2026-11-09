/**
 * teardown.test.mjs — a run must leave nothing behind.
 *
 * The plugin's reason for existing is "an agent fills the disk and never cleans
 * up", so its own teardown is part of the contract: after `closeBrowser()` the
 * headless profile directory (tens of megabytes) must be gone.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-teardown-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { resolveBrowser, closeBrowser, sweepStaleProfiles } = await import('../lib/browser.js');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

/** Browser profiles are the six-character random directory suffix. */
const profiles = () => readdirSync(tmpdir()).filter((name) => /^dsh-web-anim-[A-Za-z0-9]{6}$/.test(name));

try {
  console.log('teardown');

  const before = profiles().length;
  const session = await resolveBrowser({ strategy: 'launch' });
  const launched = profiles().length;
  check('launching creates a profile directory', launched > before, `${before} -> ${launched}`);
  check('the session owns its process', session.ownsProcess === true);
  check('the profile lives under the temp directory', session.profileDir.startsWith(tmpdir()), session.profileDir);

  await closeBrowser();
  check('closing the browser removes its profile', profiles().length <= before, `${profiles().length} left`);

  // The sweeper must only touch directories old enough to be abandoned.
  const swept = sweepStaleProfiles({ maxAgeMs: 60 * 60 * 1000 });
  check('the sweeper ignores fresh directories', swept.removed === 0, String(swept.removed));
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'teardown passed' : `teardown failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

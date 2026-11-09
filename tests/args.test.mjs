/**
 * args.test.mjs — DSH_WEB_ANIM_BROWSER_ARGS actually reaches the browser.
 *
 * ## Why this exists
 *
 * CI runs on a bare Linux runner with no GPU, and a recent Chrome refuses to create
 * a WebGL context in headless without `--enable-unsafe-swiftshader`. Every WebGL
 * fixture then paints nothing and the suites fail for a reason unrelated to the code.
 * The escape hatch is an environment variable rather than a default, because on a
 * machine that *does* have a GPU, forcing software rendering makes every capture
 * slower and subtly different from what the user sees locally.
 *
 * ## The bug this pins
 *
 * The first implementation split the variable with `/s+/` instead of `/\s+/` — a
 * regex with its backslash eaten somewhere in the edit. The consequence was not a
 * clean error: `--enable-unsafe-swiftshader` was chopped at every letter "s" into
 * `--enable-un`, `afe-`, ````wift`, `hader`, and the browser exited with
 * "Multiple targets are not supported in headless mode". A parsing bug in a config
 * path surfaces as a browser that will not start, three layers away.
 *
 * So this suite asserts the *parsed* result, not the launch, and it also checks the
 * no-argument path stays untouched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-args-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { parseBrowserArgs } = await import('../lib/browser.js');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

try {
  console.log('browser args');

  const none = parseBrowserArgs({});
  check('an unset variable yields no arguments', none.length === 0, JSON.stringify(none));

  const blank = parseBrowserArgs({ DSH_WEB_ANIM_BROWSER_ARGS: '   ' });
  check('a blank variable yields no arguments', blank.length === 0, JSON.stringify(blank));

  const one = parseBrowserArgs({ DSH_WEB_ANIM_BROWSER_ARGS: '--enable-unsafe-swiftshader' });
  check('a single switch survives intact', one.length === 1 && one[0] === '--enable-unsafe-swiftshader', JSON.stringify(one));

  const two = parseBrowserArgs({ DSH_WEB_ANIM_BROWSER_ARGS: '--enable-unsafe-swiftshader  --disable-gpu-sandbox' });
  check('two switches split on whitespace', two.length === 2 && two[1] === '--disable-gpu-sandbox', JSON.stringify(two));

  const padded = parseBrowserArgs({ DSH_WEB_ANIM_BROWSER_ARGS: '  --a   --b  ' });
  check('padding and repeated spaces are ignored', JSON.stringify(padded) === '["--a","--b"]', JSON.stringify(padded));

  // The regression itself: no switch may be chopped at an "s".
  check('no switch is split mid-word', !one.some((arg) => arg === '--enable-un' || arg === 'hader'),
    JSON.stringify(one));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'args passed' : `args failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

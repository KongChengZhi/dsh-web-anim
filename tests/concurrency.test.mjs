/**
 * concurrency.test.mjs — parallel captures must not multiply resources.
 *
 * A multi-agent host calls tools concurrently. Before the fixes this suite covers,
 * five concurrent captures launched several Chromes and left orphan tabs inside
 * them. These assertions pin the two properties that make concurrency safe:
 *
 *   1. concurrent callers share ONE browser (single-flight);
 *   2. `closeBrowser()` reclaims every browser this process owns, including one
 *      that lost a race, together with its profile.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-conc-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const lib = '../lib';
const { resolveBrowser, closeBrowser } = await import(lib + '/browser.js');
const { openPage } = await import(lib + '/page.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = (name) => 'file:///' + join(here, '..', 'fixtures', name).replace(/\\/g, '/');

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

try {
  console.log('concurrency');

  // 1. Concurrent resolution shares one browser.
  const sessions = await Promise.all([
    resolveBrowser({ strategy: 'launch' }),
    resolveBrowser({ strategy: 'launch' }),
    resolveBrowser({ strategy: 'launch' }),
  ]);
  const ports = new Set(sessions.map((session) => session.port));
  check('concurrent resolve launches ONE browser', ports.size === 1, [...ports].join(','));
  for (const session of sessions) if (session.profileDir) ownProfiles.push(session.profileDir);

  // 2. Concurrent page acquisition gives each caller its own isolated tab.
  const leases = await Promise.all([sessions[0].acquirePage(), sessions[0].acquirePage(), sessions[0].acquirePage()]);
  check('each acquire gets its own connection', new Set(leases.map((l) => l.connection)).size === 3);
  check('each acquire gets its own target', new Set(leases.map((l) => l.targetId)).size === 3);
  for (const lease of leases) await lease.release();
  // Closing a target is asynchronous on the browser side, so poll rather than
  // sampling once: the meaningful claim is "they all go away", not "instantly".
  let openAfter = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    openAfter = (await (await fetch('http://127.0.0.1:' + sessions[0].port + '/json/list')).json())
      .filter((target) => target.type === 'page').length;
    if (openAfter <= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('released targets are closed', openAfter <= 1, String(openAfter));

  // 3. Five concurrent captures: one profile, and every one sees its own page.
  const before = profiles();
  const results = await Promise.all(
    ['animation.html', 'timeline.html', 'canvas.html', 'animation.html', 'timeline.html'].map(async (name) => {
      const opened = await openPage({ url: fixtureUrl(name), width: 640, height: 360, waitMs: 60 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const seen = await opened.page.evaluate('location.href');
      await opened.release({ unfreeze: true });
      return { wanted: name, saw: decodeURIComponent(String(seen)).split('/').pop() };
    }),
  );
  check('every concurrent capture sees its own page', results.every((r) => r.saw === r.wanted), JSON.stringify(results));
  check('five captures added at most one profile', profiles() - before <= 1, `${before} -> ${profiles()}`);

  // 4. Teardown reclaims everything.
  await closeBrowser();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check('teardown removes every profile', profiles() === 0, `${profiles()} left`);
  const chromeCount = ourChrome();
  check('teardown leaves no browser process', chromeCount === 0, `${chromeCount} chrome processes`);
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'concurrency passed' : `concurrency failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
/**
 * run-all.mjs — one entry point for the whole suite.
 *
 * Order matters: the pure modules first (instant, and they catch a broken build),
 * then registration (no browser), then the browser-backed tests. A failure in an
 * early group stops the run so a browser problem never masks a logic problem.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['storage', 'storage.test.mjs'],
  ['registration', 'registration.test.mjs'],
  ['args', 'args.test.mjs'],
  ['selftest', 'selftest.mjs'],
  ['classify', 'classify.test.mjs'],
  ['host', 'host.test.mjs'],
  ['static', 'static.test.mjs'],
  ['teardown', 'teardown.test.mjs'],
  ['idle', 'idle.test.mjs'],
  ['concurrency', 'concurrency.test.mjs'],
  ['load', 'load.test.mjs'],
  ['params', 'params.test.mjs'],
  ['transitions', 'transitions.test.mjs'],
  ['blank', 'blank.test.mjs'],
  ['pipeline', 'pipeline.test.mjs'],
];

let failed = 0;
for (const [label, file] of suites) {
  console.log('');
  console.log('=== ' + label + ' ===');
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.log('--- ' + label + ' FAILED (exit ' + result.status + ')');
  }
}

console.log('');
console.log(failed === 0 ? 'all suites passed' : failed + ' suite(s) failed');
process.exit(failed === 0 ? 0 : 1);

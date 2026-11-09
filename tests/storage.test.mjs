/**
 * storage.test.mjs — the budget is the point.
 *
 * This plugin exists partly because a debugging agent fills a disk and never
 * cleans up. So the store's contract is tested as strictly as the capture path:
 * one budget, whole-capture eviction, newest-first protection, pins respected,
 * and a status line that changes its wording as the store fills.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-store-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const store = await import('../lib/store.js');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

/** Write a synthetic capture of a known size. */
function makeCapture(id, bytes, { url = 'http://example.test/', selector = '', window = [0, 600], accessCount = 1, pinned = false, createdAt = Date.now() } = {}) {
  const dir = join(store.capturesDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sheet.png'), Buffer.alloc(bytes, 7));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    version: 1,
    id,
    kind: 'capture',
    url,
    selector,
    window,
    createdAt,
    lastAccessAt: createdAt,
    accessCount,
    pinned,
    cells: [{ index: 1, t: 0 }, { index: 2, t: 300 }],
  }));
}

console.log('storage');

check('root honours DSH_WEB_ANIM_DIR', store.storeRoot() === sandbox);

// --- empty store ------------------------------------------------------------
{
  const usage = store.usage();
  check('empty store reports zero', usage.used === 0 && usage.captures === 0);
  check('empty store status line is short', store.statusLine().startsWith('store: 0B'));
}

// --- budget accounting ------------------------------------------------------
{
  makeCapture('cap-a', 1000);
  makeCapture('cap-b', 2000);
  const usage = store.usage();
  check('counts bytes across captures', usage.used >= 3000, String(usage.used));
  check('counts captures', usage.captures === 2, String(usage.captures));
  check('budget has a default', usage.budget === store.DEFAULT_BUDGET_BYTES, String(usage.budget));
}

// --- budget override --------------------------------------------------------
{
  process.env.DSH_WEB_ANIM_BUDGET_MB = '1';
  check('budget override is applied', store.budgetBytes() === 1024 * 1024, String(store.budgetBytes()));
  delete process.env.DSH_WEB_ANIM_BUDGET_MB;
}

// --- eviction ---------------------------------------------------------------
{
  rmSync(store.capturesDir(), { recursive: true, force: true });
  const now = Date.now();
  makeCapture('old-1', 100_000, { createdAt: now - 60_000 });
  makeCapture('old-2', 100_000, { createdAt: now - 50_000 });
  makeCapture('mid-1', 100_000, { createdAt: now - 40_000 });
  makeCapture('new-1', 100_000, { createdAt: now - 30_000 });
  makeCapture('new-2', 100_000, { createdAt: now - 20_000 });

  // Budget of 250KB against 500KB of captures: the oldest must go.
  const result = store.prune({ budget: 250 * 1024, pinCount: 1 });
  check('prune removes captures', result.removed.length >= 2, String(result.removed.length));
  check('prune frees the bytes it claims', result.used <= 250 * 1024, String(result.used));
  check('prune keeps the newest capture', existsSync(join(store.capturesDir(), 'new-2')));
  check('prune removes whole captures only', !existsSync(join(store.capturesDir(), 'old-1')));
}

// --- pins are never evicted --------------------------------------------------
{
  rmSync(store.capturesDir(), { recursive: true, force: true });
  const now = Date.now();
  makeCapture('pinned-baseline', 200_000, { createdAt: now - 90_000, pinned: true });
  makeCapture('fresh-1', 200_000, { createdAt: now - 10_000 });
  makeCapture('fresh-2', 200_000, { createdAt: now - 5_000 });
  const result = store.prune({ budget: 150 * 1024, pinCount: 1 });
  check('a pinned capture survives eviction', existsSync(join(store.capturesDir(), 'pinned-baseline')));
  check('pinned bytes are not counted as freed', result.freed < 400_000 || !existsSync(join(store.capturesDir(), 'pinned-baseline')));
}

// --- staleness --------------------------------------------------------------
{
  rmSync(store.capturesDir(), { recursive: true, force: true });
  makeCapture('v1', 1000, { url: 'http://a.test/', selector: '#x', createdAt: Date.now() - 20_000 });
  makeCapture('v2', 1000, { url: 'http://a.test/', selector: '#x', createdAt: Date.now() - 10_000 });
  makeCapture('other', 1000, { url: 'http://b.test/', selector: '#x', createdAt: Date.now() - 5_000 });
  const stale = store.staleCaptures();
  const byId = Object.fromEntries(stale.map((item) => [item.id, item]));
  check('a superseded capture is flagged stale', byId.v1.stale === true, JSON.stringify(byId.v1?.reasons));
  check('the newest of a group is not stale for supersession', !byId.v2.reasons.some((r) => r.includes('superseded')));
  check('a different target is not superseded', !byId.other.reasons.some((r) => r.includes('superseded')));
}

// --- touch changes LRU order ------------------------------------------------
{
  rmSync(store.capturesDir(), { recursive: true, force: true });
  makeCapture('first', 1000, { createdAt: Date.now() - 30_000 });
  makeCapture('second', 1000, { createdAt: Date.now() - 20_000 });
  store.touchCapture('first');
  const list = store.listCaptures();
  check('touching a capture moves it to the front', list[0].id === 'first', JSON.stringify(list.map((item) => item.id)));
  check('touching increments the read count', store.readMeta('first').accessCount === 2);
}

// --- status line escalates --------------------------------------------------
{
  rmSync(store.capturesDir(), { recursive: true, force: true });
  process.env.DSH_WEB_ANIM_BUDGET_MB = '1';
  makeCapture('big', 900 * 1024);
  const line = store.statusLine();
  check('status line warns when nearly full', line.includes('⚠'), line);
  check('status line suggests the gc tool', line.includes('web_anim_gc'), line);
  delete process.env.DSH_WEB_ANIM_BUDGET_MB;
}

// --- formatting -------------------------------------------------------------
{
  check('formatBytes handles small values', store.formatBytes(512) === '512B', store.formatBytes(512));
  check('formatBytes handles megabytes', store.formatBytes(5 * 1024 * 1024) === '5.0MB', store.formatBytes(5 * 1024 * 1024));
  check('formatAge handles minutes', store.formatAge(5 * 60_000) === '5m', store.formatAge(5 * 60_000));
}

rmSync(sandbox, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'storage passed' : `storage failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

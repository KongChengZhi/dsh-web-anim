/**
 * handlers/gc.js — web_anim_gc.
 *
 * The store prunes itself, so this tool is not the mechanism that keeps disk use
 * bounded — it is the mechanism that keeps *your* baselines alive. Pruning by
 * recency alone will eventually eat the reference capture the agent keeps
 * comparing against, so the useful actions are: see what is there, pin what
 * matters, and release what is genuinely superseded.
 *
 * The staleness heuristic is deliberately conservative and explainable:
 *   - superseded: a newer capture exists for the same url + selector + window;
 *   - never read: written but no zoom/verify touched it since.
 * Anything else is only removed when the budget forces it.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  capturesDir,
  clearAll,
  formatBytes,
  listCaptures,
  readMeta,
  staleCaptures,
  statusLine,
  usage,
  writeMeta,
} from '../store.js';

export async function runGc(ctx, args) {
  const action = String(args?.action ?? 'status').toLowerCase();
  if (action === 'status') return status();
  if (action === 'prune') return pruneStale();
  if (action === 'pin' || action === 'unpin') return setPin(args, action);
  if (action === 'clear') return clear(args);
  throw new Error(`unknown action: ${action} (expected status | prune | pin | unpin | clear)`);
}

function status() {
  const current = usage();
  const captures = listCaptures();
  const stale = staleCaptures();
  const lines = [statusLine(), ''];
  lines.push(`root: ${current.root}`);
  if (captures.length === 0) {
    lines.push('the store is empty.');
  } else {
    lines.push('captures, newest use first:');
    for (const capture of captures) {
      const flags = [];
      if (capture.pinned) flags.push('pinned');
      const info = stale.find((item) => item.id === capture.id);
      if (info?.stale) flags.push(`stale: ${info.reasons[0]}`);
      const url = capture.url ? `  ${capture.url}` : '';
      lines.push(`  ${capture.id}  ${formatBytes(capture.bytes)}  ${capture.cellCount} cells${url}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
    }
    const staleCount = stale.filter((item) => item.stale && !item.pinned).length;
    if (staleCount > 0) {
      lines.push('');
      lines.push(`${staleCount} capture(s) look stale and could be released with action:"prune".`);
    }
  }
  return { ok: true, text: lines.join('\n'), usage: current, captures };
}

function pruneStale() {
  const stale = staleCaptures().filter((item) => item.stale && !item.pinned);
  const removed = [];
  for (const item of stale) {
    try {
      rmSync(join(capturesDir(), item.id), { recursive: true, force: true });
      removed.push(item);
    } catch {
      /* a locked directory is retried on the next prune */
    }
  }
  const freed = removed.reduce((sum, item) => sum + item.bytes, 0);
  const lines = [`released ${removed.length} capture(s), freed ${formatBytes(freed)}`];
  if (removed.length) lines.push(`removed: ${removed.map((item) => item.id).join(', ')}`);
  lines.push(statusLine());
  return { ok: true, text: lines.join('\n'), removed: removed.map((item) => item.id), freed };
}

function setPin(args, action) {
  const captureId = String(args?.captureId ?? '').trim();
  if (!captureId) throw new Error(`${action} needs captureId`);
  const meta = readMeta(captureId);
  if (!meta) throw new Error(`no such capture: ${captureId}`);
  meta.pinned = action === 'pin';
  writeMeta(captureId, meta);
  const text = action === 'pin'
    ? `${captureId} is pinned — it will not be pruned or evicted while you keep comparing against it.`
    : `${captureId} is unpinned — it can be pruned again.`;
  return { ok: true, text: `${text}\n\n${statusLine()}`, captureId, pinned: meta.pinned };
}

function clear(args) {
  if (String(args?.confirm ?? '').toLowerCase() !== 'yes') {
    return { ok: false, text: 'refusing to clear every stored capture without confirm:"yes"' };
  }
  const result = clearAll();
  return { ok: true, text: `cleared the store, freed ${formatBytes(result.freed)}`, freed: result.freed };
}

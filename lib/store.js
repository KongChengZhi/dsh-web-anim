/**
 * store.js — the artifact store: one directory, one budget, one pruning rule.
 *
 * ## Why this file exists at all
 *
 * The failure mode this plugin is built to avoid is "the agent screenshots a
 * page frame by frame, writes every frame to disk, and never deletes any of
 * them". A debugging tool that fixes the token cost but keeps filling the disk
 * has only moved the problem. So the store is not an afterthought: it is the
 * component with a hard number attached to it.
 *
 * ## The rules
 *
 *   1. **Frames never touch disk.** A capture decodes frames in memory, composes
 *      one sheet, and writes exactly two files: `sheet.png` and `meta.json`.
 *   2. **One budget for everything.** Sheets, metadata and any future artifact
 *      share a single ceiling (default 300 MB). Separate ceilings per artifact
 *      type are how total disk use becomes unbounded.
 *   3. **Prune whole captures, oldest-unused first.** "Unused" is the last time
 *      anything *read* the capture (zoom, verify, explicit stat), not when it was
 *      written. Deleting half a capture leaves a sheet with no timeline, which
 *      the agent reads as "the plugin is broken" and re-runs — worse than keeping it.
 *   4. **Pinned captures are never pruned.** The last few captures of a live
 *      session stay until the session explicitly releases them.
 *
 * ## Why the reminder lives here
 *
 * Pruning is the fallback. The primary mechanism is that the agent knows the
 * store exists and releases what it no longer needs — see `statusLine()`, which
 * every tool appends to its result, and the system-prompt section in
 * `lib/index.js`. A `gc` tool nobody knows to call is decoration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 300 MB across every artifact this plugin ever writes. */
export const DEFAULT_BUDGET_BYTES = 300 * 1024 * 1024;
/** Captures touched within this window are protected from pruning. */
const DEFAULT_PIN_COUNT = 3;

/**
 * Root directory for artifacts.
 *
 * Kept out of the workspace on purpose: a debugging tool that litters the user's
 * project with PNGs is exactly the complaint this package answers.
 */
export function storeRoot(env = process.env) {
  if (env.DSH_WEB_ANIM_DIR) return env.DSH_WEB_ANIM_DIR;
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'dsh-web-anim');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'dsh-web-anim');
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-web-anim');
}

/** Directory holding one capture each. */
export function capturesDir(env = process.env) {
  return join(storeRoot(env), 'captures');
}

/** Configured budget in bytes. */
export function budgetBytes(env = process.env) {
  const configured = Number(env.DSH_WEB_ANIM_BUDGET_MB);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 1024 * 1024);
  return DEFAULT_BUDGET_BYTES;
}

/** Recursively sum file sizes, tolerating files disappearing mid-walk. */
function directoryBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(path);
      else total += statSync(path).size;
    } catch {
      /* raced with a prune: fine */
    }
  }
  return total;
}

/** Read one capture's metadata, or null when it is missing or unreadable. */
export function readMeta(captureId, env = process.env) {
  const file = join(capturesDir(env), captureId, 'meta.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Overwrite one capture's metadata. */
export function writeMeta(captureId, meta, env = process.env) {
  const dir = join(capturesDir(env), captureId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/** Record that something read this capture — this is what LRU orders by. */
export function touchCapture(captureId, env = process.env) {
  const meta = readMeta(captureId, env);
  if (!meta) return null;
  meta.lastAccessAt = Date.now();
  meta.accessCount = (meta.accessCount ?? 0) + 1;
  writeMeta(captureId, meta, env);
  return meta;
}

/** List every capture with its size and recency, newest access first. */
export function listCaptures(env = process.env) {
  const dir = capturesDir(env);
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const meta = readMeta(entry.name, env);
    let bytes = 0;
    try {
      bytes = directoryBytes(path);
    } catch {
      bytes = 0;
    }
    out.push({
      id: entry.name,
      bytes,
      createdAt: meta?.createdAt ?? 0,
      lastAccessAt: meta?.lastAccessAt ?? meta?.createdAt ?? 0,
      url: meta?.url ?? null,
      cellCount: meta?.cells?.length ?? 0,
      pinned: meta?.pinned === true,
      kind: meta?.kind ?? 'capture',
    });
  }
  out.sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  return out;
}

/** Total bytes currently used, and the ceiling. */
export function usage(env = process.env) {
  const captures = listCaptures(env);
  const used = captures.reduce((sum, capture) => sum + capture.bytes, 0);
  const budget = budgetBytes(env);
  return {
    used,
    budget,
    ratio: budget > 0 ? used / budget : 0,
    captures: captures.length,
    count: captures.length,
    root: storeRoot(env),
    oldest: captures.length ? captures[captures.length - 1] : null,
  };
}

/**
 * Delete captures until the store fits its budget.
 *
 * Pinned captures, and the `pinCount` most recently used ones, are skipped.
 * Returns what was removed so a tool result can say it out loud — silent
 * deletion is how a user loses a baseline they were comparing against.
 *
 * @param {{env?:object, budget?:number, pinCount?:number, keepIds?:string[]}} [options]
 */
export function prune(options = {}) {
  const env = options.env ?? process.env;
  const budget = options.budget ?? budgetBytes(env);
  const pinCount = options.pinCount ?? DEFAULT_PIN_COUNT;
  const keep = new Set(options.keepIds ?? []);

  const captures = listCaptures(env);
  let used = captures.reduce((sum, capture) => sum + capture.bytes, 0);
  const removed = [];

  const protectedIds = new Set(captures.slice(0, pinCount).filter((c) => c.pinned || true).map((c) => c.id));
  const candidates = captures.filter((capture) => !capture.pinned && !keep.has(capture.id) && !protectedIds.has(capture.id));

  for (let i = candidates.length - 1; i >= 0 && used > budget; i -= 1) {
    const capture = candidates[i];
    try {
      rmSync(join(capturesDir(env), capture.id), { recursive: true, force: true });
      used -= capture.bytes;
      removed.push({ id: capture.id, bytes: capture.bytes, url: capture.url });
    } catch {
      /* locked file: leave it for the next pass */
    }
  }

  return { removed, used, budget, freed: removed.reduce((sum, item) => sum + item.bytes, 0) };
}

/** Best-effort whole-store wipe. Used by `web_anim_gc{action:'clear'}`. */
export function clearAll(env = process.env) {
  const dir = capturesDir(env);
  const before = directoryBytes(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* locked: report what we managed */
  }
  return { freed: before, root: storeRoot(env) };
}

/** Human-readable size, matching how the rest of the UI talks about disk. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/** Short age like "2.1h", for the status line. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'new';
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The one line every tool appends to its result.
 *
 * This is reminder R1 from the design: it appears exactly when the agent has
 * just looked at a picture and is best placed to judge whether it still needs
 * it. Wording escalates with pressure — a warning at 70% is information, a
 * warning at 75% that is phrased the same way is wallpaper.
 *
 * @param {object} [env]
 * @param {{staleBefore?:number}} [options]
 */
export function statusLine(env = process.env, options = {}) {
  const current = usage(env);
  const percent = Math.round(current.ratio * 100);
  const oldest = current.oldest;
  const age = oldest ? formatAge(Date.now() - oldest.lastAccessAt) : null;

  const head = `store: ${formatBytes(current.used)}/${formatBytes(current.budget)} (${percent}%) · ${current.captures} capture${current.captures === 1 ? '' : 's'}${oldest ? ` · oldest ${age}` : ''}`;

  if (current.ratio >= 0.9) {
    return `${head} · ⚠⚠ nearly full: the next capture will evict the oldest first${oldest ? ` (${oldest.id})` : ''}. Release what you no longer need with web_anim_gc{action:"prune"}, or pin a baseline with web_anim_gc{action:"pin", captureId}.`;
  }
  if (current.ratio >= 0.7) {
    return `${head} · ⚠ over 70%: the next few captures will start evicting older ones${oldest ? ` (oldest ${oldest.id})` : ''}. If you are done with any capture, run web_anim_gc{action:"prune"}.`;
  }
  if (current.ratio >= 0.5) {
    return `${head} · web_anim_gc releases captures you no longer need.`;
  }
  if (current.captures > 0) {
    // Even at 5% the reminder is worth its ~15 tokens: the whole point is that the
    // agent should not have to discover the gc tool by accident, and a release that
    // happens early costs the user nothing.
    return `${head} · web_anim_gc{action:"prune"} releases captures you are done with.`;
  }
  return head;
}

/**
 * Whether a capture is worth keeping, when the agent asks for advice rather
 * than an action. Three signals, in this order:
 *
 *   1. superseded — a newer capture of the same url+selector+window exists;
 *   2. never referenced again — written but not read since;
 *   3. old — beyond the configured age.
 */
export function staleCaptures(env = process.env, options = {}) {
  const captures = listCaptures(env);
  const bySignature = new Map();
  for (const capture of captures) {
    const meta = readMeta(capture.id, env);
    if (!meta) continue;
    const signature = `${meta.url ?? ''}|${meta.selector ?? ''}|${(meta.window ?? []).join(',')}`;
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push({ capture, meta });
  }

  const superseded = new Set();
  for (const [, group] of bySignature) {
    group.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
    for (const item of group.slice(1)) superseded.add(item.capture.id);
  }

  // A capture with no reads is only suspicious once it has had a chance to be
  // read: reporting a capture created seconds ago as "never read again" would make
  // prune delete the result the caller is still looking at.
  const idleGraceMs = options.idleGraceMs ?? 2 * 60_000;
  const neverRead = new Set(
    captures
      .filter((capture) => (readMeta(capture.id, env)?.accessCount ?? 0) === 0)
      .filter((capture) => Date.now() - capture.createdAt >= idleGraceMs)
      .map((capture) => capture.id),
  );

  return captures.map((capture) => {
    const reasons = [];
    if (superseded.has(capture.id)) reasons.push('superseded by a newer capture of the same target');
    if (neverRead.has(capture.id)) reasons.push('written but never read again');
    return { ...capture, stale: reasons.length > 0, reasons };
  });
}

/** A stable, sortable id. Timestamps first so `ls` reads chronologically. */
export function newCaptureId(kind = 'cap') {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const random = Math.random().toString(36).slice(2, 6);
  return `${kind}-${stamp}-${random}`;
}

/** Path helpers used by the capture writer. */
export function capturePaths(captureId, env = process.env) {
  const dir = join(capturesDir(env), captureId);
  return { dir, sheet: join(dir, 'sheet.png'), meta: join(dir, 'meta.json') };
}

/** Make sure the store exists before writing into it. */
export function ensureStore(env = process.env) {
  mkdirSync(capturesDir(env), { recursive: true });
  return storeRoot(env);
}

/** Where scratch work goes when a caller explicitly wants a temp file. */
export function scratchDir(env = process.env) {
  const dir = join(env.DSH_WEB_ANIM_DIR ?? tmpdir(), 'dsh-web-anim-scratch');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Does a path exist (re-exported so tools do not import node:fs). */
export function exists(path) {
  return existsSync(path);
}

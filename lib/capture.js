/**
 * capture.js — turn a live page into one citable contact sheet.
 *
 * This is the piece that replaces "write a script that screenshots 40 frames".
 * The plan is fixed before a single pixel is taken, because the expensive
 * mistakes are all planning mistakes:
 *
 *   - sampling every frame of a 30s animation (900 frames, then 900 PNGs on disk);
 *   - sampling a page whose animation is over after 600ms;
 *   - sampling uniformly when 95% of the change happens in the first 200ms.
 *
 * So the shape is: probe → plan (how many cells, at which times, what kind of
 * stepping) → drive → compose → report. Every stage is bounded by a parameter
 * the model can see in the tool schema.
 *
 * Frame pacing has three sources, and the plan records which one was used,
 * because a capture that silently degrades to "wall clock screenshots" must say
 * so rather than pretend it was deterministic:
 *
 *   `timeline` — the page exposes its own seek API (Remotion, HyperFrames, …).
 *                Exact, fast, no clock trickery. Preferred when available.
 *   `virtual`  — our injected clock drives rAF and WAAPI `currentTime`. Exact for
 *                JS/CSS animation, and the only mode that can seek *backwards*.
 *   `wall`     — no injection possible (cross-origin frames, CSP, ...): fall back
 *                to real time and record `deterministic: false`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { readAnimatedBoxes, readSettledTransitions, resetClock, seekOwnTimeline, stepTo } from './inject.js';
import { composeSheet, frameDiff, frameUniformity, imageTokens } from './image.js';
import { decodePng } from './png.js';
import { capturePaths, ensureStore, newCaptureId, prune, writeMeta } from './store.js';

/** Hard ceiling on frames, independent of any other parameter. */
const MAX_FRAMES = 48;
/** Hard ceiling on sheet area; beyond this a sheet stops being readable anyway. */
const MAX_SHEET_SIDE = 1300;

/**
 * Decide how to sample.
 *
 * The rules encode what actually goes wrong when you sample uniformly:
 *   - an `infinite` CSS animation has no end, so a duration must be supplied;
 *   - an entrance animation finishes early, so a window longer than its length
 *     spends most of its cells on an identical end state;
 *   - easing means equal time steps are not equal visual change, so the first
 *     cells get the same budget as the last ones.
 *
 * @param {object} probe result of `probePage`
 * @param {{durationMs?:number, frames?:number, from?:number, to?:number, fps?:number, uniform?:boolean}} options
 */
export function planCapture(probe, options = {}) {
  const notes = [];
  const fps = clampNumber(options.fps, 60, 1, 240);

  const animationDurations = (probe.animations ?? [])
    .map((animation) => (typeof animation.duration === 'number' ? animation.duration : null))
    .filter((value) => Number.isFinite(value) && value > 0);

  const hasInfinite = (probe.animations ?? []).some((animation) => animation.iterations === Infinity);

  // Longest finite animation is the natural window, unless the caller knows better.
  const naturalWindow = animationDurations.length ? Math.max(...animationDurations) : null;

  let from = clampNumber(options.from, 0, 0, 600_000);
  let to = Number.isFinite(options.to) ? Number(options.to) : null;

  if (to === null && Number.isFinite(options.durationMs)) to = from + Number(options.durationMs);
  if (to === null && naturalWindow !== null && !hasInfinite) to = from + naturalWindow;
  if (to === null) {
    to = from + 1000;
    notes.push('no finite animation duration found; defaulted the window to 1000ms — pass durationMs to be explicit');
  }
  if (hasInfinite) {
    notes.push('at least one animation iterates forever, so the capture shows one window of it, not "the end"');
  }
  if (to <= from) to = from + 200;

  const windowMs = to - from;

  // Nothing animates here at all: no CSS/WAAPI animation, no canvas, no rAF loop,
  // no timeline API. Sampling a sheet of a static page is pure waste — two cells
  // prove the point, and the result says so rather than leaving the model to
  // notice that every cell happens to be identical.
  const looksStatic = (probe.animationCount ?? 0) === 0
    && (probe.canvases?.length ?? 0) === 0
    && (probe.rafCount ?? 0) === 0
    && (probe.timelineApis?.length ?? 0) === 0;

  // Cell count: enough to see motion, few enough to stay one readable image.
  let cells = Number.isFinite(options.frames) ? Math.round(Number(options.frames)) : null;
  if (cells === null) {
    // ~8 cells/second is enough for a 300ms ease to show 2-3 intermediate states,
    // and it keeps a 1s window at 8 cells (one 3x3 sheet).
    cells = Math.round((windowMs / 1000) * 8);
    cells = Math.max(4, Math.min(16, cells));
    notes.push(`cell count auto-chosen as ${cells} for a ${Math.round(windowMs)}ms window`);
  }
  cells = Math.max(2, Math.min(MAX_FRAMES, cells));

  if (looksStatic && !Number.isFinite(Number(options.frames))) {
    cells = 2;
    notes.push('the page exposes no animation source (no CSS/WAAPI, no canvas, no rAF loop, no timeline API); sampling 2 cells to confirm it is static instead of spending a full sheet');
  }

  const times = [];
  const step = windowMs / cells;
  for (let i = 0; i < cells; i += 1) {
    times.push(Math.round(from + step * (i + 0.5)));
  }


  const kind = probe.kind ?? 'html';
  let mode = 'virtual';
  if (kind === 'timeline' && (probe.timelineApis ?? []).length > 0) mode = 'timeline';
  if (options.mode === 'wall' || options.mode === 'virtual' || options.mode === 'timeline') mode = options.mode;

  return {
    mode,
    kind,
    looksStatic,
    fps,
    from,
    to,
    windowMs,
    cells,
    frameTimes: times,
    stepMs: Math.round(step),
    notes,
    deterministic: mode !== 'wall',
  };
}

/**
 * Run a capture end to end.
 *
 * @param {object} input
 * @param {import('./cdp.js').CdpConnection} input.page
 * @param {object} input.probe
 * @param {object} input.plan
 * @param {string} [input.selector]
 * @param {string} [input.label] human label used in the meta and the result text
 * @returns {Promise<object>} the capture record (also written to disk)
 */
export async function runCapture(input) {
  const { page, probe, plan } = input;
  const env = input.env ?? process.env;
  const startedAt = Date.now();

  ensureStore(env);
  const captureId = newCaptureId('cap');

  const frames = [];
  const stepErrors = [];
  const seekResults = [];

  // Start every capture from the same virtual instant. Without this, running the
  // same plan twice on one page continues from wherever the last one stopped and
  // the two sheets are not comparable.
  if (plan.mode === 'virtual') {
    await resetClock(page, plan.from).catch(() => 0);
  }

  /**
   * `selector`: capture only the element that animates.
   *
   * Resolve the box once, before the loop, and crop every frame to it. Resolving it
   * per frame would be wrong for exactly the pages this tool is for — an element
   * that is moving has a different box at every timestamp, so the crop would follow
   * the motion and the sheet would show a static-looking object.
   */
  const clip = input.selector ? await resolveClip(page, input.selector, { freezeAt: plan.frameTimes[0] }) : null;
  const clipWarning = input.selector && !clip
    ? `selector "${input.selector}" was not found (or has a zero-size box), so the sheet shows the whole viewport`
    : null;

  for (let index = 0; index < plan.frameTimes.length; index += 1) {
    const targetTime = plan.frameTimes[index];
    const delta = index === 0 ? targetTime : targetTime - plan.frameTimes[index - 1];

    if (plan.mode === 'timeline') {
      const seek = await seekOwnTimeline(page, Math.round((targetTime / 1000) * plan.fps), plan.fps);
      seekResults.push(seek);
    } else if (plan.mode === 'virtual') {
      const step = await stepTo(page, delta);
      if (step.errors?.length) stepErrors.push(...step.errors);
    } else {
      await new Promise((resolve) => setTimeout(resolve, delta));
    }

    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    }, { timeoutMs: 15_000 });
    const decoded = decodePng(Buffer.from(shot.data, 'base64'));
    frames.push({ ...decoded, t: targetTime });
  }

  // Pixel evidence between consecutive cells. This is what lets the model say
  // "cells 4-6 are identical" without spending a second look.
  const diffs = [];
  for (let i = 1; i < frames.length; i += 1) {
    const diff = frameDiff(frames[i - 1].data, frames[i].data, { width: frames[i].width, threshold: 4 });
    diffs.push({
      fromCell: i,
      toCell: i + 1,
      meanDelta: Math.round(diff.meanDelta * 1000) / 1000,
      changedRatio: Math.round(diff.changedRatio * 10_000) / 10_000,
      bbox: diff.bbox,
    });
  }

  /*
   * Is the picture actually a picture?
   *
   * Every other signal in this function measures *change*, so a page that never
   * renders measures perfectly: no movement, no error, no missing cell. The one
   * thing that distinguishes "this animation has settled" from "this page painted
   * nothing" is how uniform the frame is.
   */
  // The threshold is calibrated against every fixture in this repo; see the
  // table in frameUniformity's doc comment before changing it.
  const uniformity = frames.map((frame) => frameUniformity(frame.data));
  const blankFrames = uniformity.filter((entry) => entry.uniform).length;

  const boxes = plan.mode === 'virtual' ? await readAnimatedBoxes(page).catch(() => []) : [];
  // CSS transitions are settled, not seeked (see inject.js: settleTransitions).
  // Report them so the caller knows the DOM shows settled states at each t.
  const transitions = await readSettledTransitions(page).catch(() => null);
  const sheet = composeSheet(frames, { maxSide: MAX_SHEET_SIDE });
  const paths = capturePaths(captureId, env);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.sheet, sheet.png);

  const meta = {
    version: 1,
    id: captureId,
    kind: 'capture',
    label: input.label ?? null,
    selector: input.selector ?? null,
    clip: clip ?? null,
    url: probe.url ?? null,
    title: probe.title ?? null,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    accessCount: 0,
    pinned: false,
    pageKind: probe.kind ?? 'html',
    libraries: probe.libraries ?? [],
    timelineApis: probe.timelineApis ?? [],
    mode: plan.mode,
    deterministic: plan.deterministic,
    looksStatic: plan.looksStatic === true,
    window: [plan.from, plan.to],
    fps: plan.fps,
    sheet: { width: sheet.width, height: sheet.height, bytes: sheet.png.length, tokens: imageTokens(sheet.width, sheet.height) },
    cells: sheet.cells.map((cell, index) => ({
      index: cell.index,
      t: cell.t,
      label: cell.label,
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      frameWidth: frames[index]?.width ?? null,
      frameHeight: frames[index]?.height ?? null,
      diffFromPrevious: diffs[index - 1] ?? null,
    })),
    diff: diffs,
    animatedBoxes: boxes,
    blankFrames,
    blankRatio: frames.length > 0 ? blankFrames / frames.length : 0,
    frameUniformity: uniformity.map((entry) => ({ colors: entry.colors, dominantRatio: Math.round(entry.dominantRatio * 1000) / 1000 })),
    transitionsSettled: transitions?.count ?? 0,
    transitionsStranded: transitions?.stranded ?? 0,
    settledProperties: transitions?.properties ?? [],
    settledStrandedDetail: transitions?.strandedDetail ?? [],
    stepErrors: stepErrors.slice(0, 10),
    seekResults: seekResults.slice(0, 3),
    planNotes: plan.notes ?? [],
    elapsedMs: Date.now() - startedAt,
    viewport: probe.viewport ?? null,
  };

  if (clipWarning) meta.clipWarning = clipWarning;
  writeMeta(captureId, meta, env);
  const pruned = prune({ env });

  return { meta, sheetPng: sheet.png, paths, pruned, captureId, clipWarning };
}

/**
 * Resolve a CSS selector to a screenshot clip rectangle.
 *
 * Returns null (rather than throwing) when the element is missing or invisible: a
 * capture of the page is still useful, and the caller reports what happened.
 *
 * @param {object} page
 * @param {string} selector
 * @param {{freezeAt?:number}} [options]
 * @returns {Promise<{x:number,y:number,width:number,height:number}|null>}
 */
export async function resolveClip(page, selector, options = {}) {
  try {
    const raw = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return null;
      if (r.width < 1 || r.height < 1) return null;
      // 留一点边，避免把投影/描边裁掉
      const pad = 6;
      const x = Math.max(0, Math.floor(r.x - pad));
      const y = Math.max(0, Math.floor(r.y - pad));
      return JSON.stringify({
        x, y,
        width: Math.min(Math.ceil(r.width + pad * 2), Math.max(1, innerWidth - x)),
        height: Math.min(Math.ceil(r.height + pad * 2), Math.max(1, innerHeight - y)),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
      });
    })()`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height, tag: parsed.tag, id: parsed.id };
  } catch {
    return null;
  }
}

/** Clamp a possibly-undefined number into a range. */
function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
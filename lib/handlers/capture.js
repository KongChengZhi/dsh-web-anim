/**
 * handlers/capture.js — web_anim_capture.
 *
 * One call does the whole job: open the page, classify it, plan the sampling,
 * drive the clock, compose one sheet, write it to the budgeted store, and return
 * it with a text timeline the model can cite. There is deliberately no required
 * first-step probe: making the model call two tools to see one animation is the
 * exact overhead this package exists to remove.
 */

import { runCapture, planCapture } from '../capture.js';
import { openPage } from '../page.js';
import { describeCapture, attachImage } from '../render.js';
import { statusLine } from '../store.js';
import { num } from './shared.js';

export async function runCaptureTool(ctx, args) {
  const opened = await openPage({
    url: args.url,
    width: args.width,
    height: args.height,
    waitMs: args.waitMs,
    browser: args.browser,
    freeze: true,
  });

  try {
    const probe = opened.probe;
    const plan = planCapture(probe, {
      frames: args.frames,
      from: args.from,
      to: args.to,
      durationMs: args.durationMs,
      fps: num(args.fps, 60, 1, 240),
      mode: args.mode && args.mode !== 'auto' ? args.mode : undefined,
    });

    // A page whose injection did not run cannot be driven deterministically.
    if (!probe.injectionInstalled && plan.mode !== 'wall') {
      plan.mode = 'wall';
      plan.deterministic = false;
      plan.notes = [...(plan.notes ?? []), 'clock injection did not run on this document; fell back to wall-clock sampling'];
    }

    const captured = await runCapture({
      page: opened.page,
      probe,
      plan,
      selector: args.selector ?? null,
      label: args.label ?? null,
    });

    // `selector` really crops now (see resolveClip). The only thing to report is the
    // case where it could not be honoured.
    const warnings = [];
    if (captured.clipWarning) warnings.push(captured.clipWarning);

    const text = describeCapture(captured.meta, {
      pruned: captured.pruned,
      includeFrames: args.includeFrames !== false,
    });
    const attached = await attachImage(ctx, captured.sheetPng, `web-anim-${captured.captureId}.png`);
    if (attached.error) warnings.push(`the sheet could not be attached (${attached.error}); the timeline above is complete`);

    const images = attached.ref ? [{ ref: attached.ref, name: `web-anim-${captured.captureId}.png` }] : [];
    const body = [text, '', `next: web_anim_zoom{captureId:"${captured.captureId}", cell:N} to enlarge a moment`, statusLine()].join('\n');

    return {
      ok: true,
      text: body,
      images,
      warnings,
      captureId: captured.captureId,
      meta: captured.meta,
    };
  } finally {
    await opened.release({ unfreeze: true });
  }
}
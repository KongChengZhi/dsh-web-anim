/**
 * handlers/probe.js — web_anim_probe.
 *
 * Answers one question: what kind of motion does this page have? The answer
 * decides whether a capture should seek a page-owned timeline, drive a virtual
 * clock, or give up and take wall-clock screenshots. It costs no image tokens,
 * so it is safe to call when the agent is unsure how to frame a capture.
 */

import { openPage } from '../page.js';
import { statusLine } from '../store.js';

export async function runProbe(ctx, args) {
  const opened = await openPage({
    url: args.url,
    width: args.width,
    height: args.height,
    waitMs: args.waitMs,
    browser: args.browser,
    freeze: false,
  });

  try {
    const probe = opened.probe;
    const lines = [];
    lines.push(`${probe.kind} · ${probe.url ?? args.url}`);
    if (probe.title) lines.push(`title: ${probe.title}`);
    lines.push(`viewport ${probe.viewport?.width}x${probe.viewport?.height} @${probe.viewport?.dpr ?? 1}x · page ${probe.size?.scrollWidth ?? '?'}x${probe.size?.scrollHeight ?? '?'}`);
    lines.push('');
    if (probe.reasons?.length) {
      for (const reason of probe.reasons) lines.push(`· ${reason}`);
      lines.push('');
    }
    if (probe.timelineApis?.length) {
      lines.push(`deterministic timeline available: ${probe.timelineApis.join(', ')}`);
      lines.push('  → web_anim_capture will seek through it (mode=timeline)');
      lines.push('');
    }
    if (probe.animationCount > 0) {
      lines.push(`animations (${probe.animationCount}):`);
      for (const animation of (probe.animations ?? []).slice(0, 12)) {
        const target = animation.target;
        const name = target?.id ? `#${target.id}` : target?.className ? `.${String(target.className).split(/\s+/)[0]}` : target?.tag ?? '?';
        const duration = animation.duration === null ? '?' : `${Math.round(animation.duration)}ms`;
        const iterations = animation.iterations === Infinity ? '∞' : animation.iterations ?? 1;
        lines.push(`  ${name}  ${animation.animationName ?? animation.kind}  ${duration} x${iterations}  ${animation.playState}`);
      }
      if (probe.animationCount > 12) lines.push(`  … ${probe.animationCount - 12} more`);
      lines.push('');
    }
    if (probe.canvases?.length) {
      lines.push(`canvases (${probe.canvases.length}): ${probe.canvases.slice(0, 4).map((canvas) => `${canvas.width}x${canvas.height}`).join(', ')}`);
      lines.push('  canvas content is only visible through pixels — a capture will show it, but per-element reasoning will not work');
      lines.push('');
    }
    if (probe.wallClock?.readers?.length) {
      lines.push(`determinism caveat: ${probe.wallClock.readers.join('; ')}`);
      lines.push('');
    }
    if (probe.installed === false) {
      lines.push('warning: the clock injection did not run on this document; captures will fall back to wall-clock sampling');
    }

    const suggested = suggestPlan(probe);
    lines.push(`suggested capture: web_anim_capture{url:"${args.url}"${suggested}}`);
    lines.push('');
    lines.push(statusLine());

    return { ok: true, text: lines.join('\n'), probe };
  } finally {
    await opened.release({ unfreeze: false });
  }
}

/** Turn the probe into the shortest capture call that would show the motion. */
function suggestPlan(probe) {
  const parts = [];
  const finite = (probe.animations ?? [])
    .map((animation) => (typeof animation.duration === 'number' ? animation.duration : null))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (finite.length) {
    const longest = Math.max(...finite);
    parts.push(`, to: ${Math.ceil(longest / 50) * 50}`);
    parts.push(`, frames: ${Math.max(4, Math.min(12, Math.round(longest / 100)))}`);
  }
  if (probe.kind === 'timeline') parts.push(', mode: "timeline"');
  const firstTarget = (probe.animations ?? []).map((animation) => animation.target).find((target) => target?.id);
  if (firstTarget?.id) parts.push(`, selector: "#${firstTarget.id}"`);
  return parts.join('');
}

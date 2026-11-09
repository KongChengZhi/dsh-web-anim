/**
 * handlers/zoom.js — web_anim_zoom.
 *
 * Two very different operations share one tool name because the model thinks of
 * them as one act ("look at that moment again"):
 *
 *   crop  — take the stored sheet, cut one cell out at higher scale. Cheap, no
 *           browser, works on a capture from an hour ago.
 *   resample — re-drive the live page over a narrow window and compose a fresh,
 *           denser sheet. Expensive, needs `url`, and is the only way to see
 *           something shorter than the original sampling step.
 */

import { composeSheet, imageTokens } from '../image.js';
import { decodePng } from '../png.js';
import { readMeta, touchCapture, statusLine, capturePaths } from '../store.js';
import { attachImage } from '../render.js';
import { openPage } from '../page.js';
import { planCapture, runCapture } from '../capture.js';
import { num } from './shared.js';
import { readFileSync } from 'node:fs';

export async function runZoom(ctx, args) {
  const captureId = String(args.captureId ?? '').trim();
  if (!captureId) throw new Error('captureId is required');
  const meta = readMeta(captureId);
  if (!meta) throw new Error(`no such capture: ${captureId} (run web_anim_gc{action:"status"} to list what exists)`);

  if (args.url && (args.from !== undefined || args.to !== undefined)) {
    return resample(ctx, args, meta);
  }
  return cropCell(ctx, args, captureId, meta);
}

/** Cut one cell out of the stored sheet and scale it up. */
async function cropCell(ctx, args, captureId, meta) {
  const cellIndex = Number.isFinite(Number(args.cell)) ? Math.round(Number(args.cell)) : 1;
  const cell = meta.cells.find((item) => item.index === cellIndex);
  if (!cell) throw new Error(`capture ${captureId} has no cell ${cellIndex} (it has ${meta.cells.length})`);

  const paths = capturePaths(captureId);
  const sheet = decodePng(readFileSync(paths.sheet));
  const cropW = Math.min(cell.width, sheet.width - cell.x);
  const cropH = Math.min(cell.height, sheet.height - cell.y);
  const crop = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    sheet.data.copy(crop, y * cropW * 4, ((cell.y + y) * sheet.width + cell.x) * 4, ((cell.y + y) * sheet.width + cell.x + cropW) * 4);
  }

  // fullRes: hand back the cell at its native pixel size instead of a scaled copy.
  // The sheet is already a downscaled composite, so this is the sharpest a stored
  // capture can be — the honest ceiling is the frame size recorded when it was taken.
  const fullRes = args.fullRes === true;
  const maxSide = num(args.maxSide, fullRes ? Math.max(cropW, cropH) : 900, 200, 4000);
  const scale = fullRes ? 1 : Math.min(maxSide / cropW, maxSide / cropH);
  const targetW = Math.max(1, Math.round(cropW * scale));
  const targetH = Math.max(1, Math.round(cropH * scale));
  const frame = { data: crop, width: cropW, height: cropH, t: cell.t, label: cell.label };
  const sheetOut = composeSheet([frame], {
    maxSide: fullRes ? Math.max(cropW, cropH) + 8 : maxSide,
    columns: 1, gap: 2, padding: 2,
    ...(fullRes ? { budgetPx: 4_000_000 } : {}),
  });

  touchCapture(captureId);
  const attached = await attachImage(ctx, sheetOut.png, `web-anim-${captureId}-cell${cellIndex}.png`);
  const warnings = [];
  if (attached.error) warnings.push(`the crop could not be attached (${attached.error})`);

  const text = [
    `cell #${cellIndex} of ${captureId} · t=${cell.t}ms · ${targetW}x${targetH}px · ~${imageTokens(sheetOut.width, sheetOut.height)} tokens`,
    meta.cells.length > 1 ? `context: cells span ${meta.window[0]}–${meta.window[1]}ms at ${meta.cells.length} samples` : '',
    statusLine(),
  ].filter(Boolean).join('\n');

  return {
    ok: true,
    text,
    images: attached.ref ? [{ ref: attached.ref, name: `web-anim-${captureId}-cell${cellIndex}.png` }] : [],
    warnings,
    captureId,
    cell: cellIndex,
    t: cell.t,
  };
}

/** Re-drive the live page over a narrow window, densely. */
async function resample(ctx, args, meta) {
  const opened = await openPage({
    url: args.url,
    width: meta.viewport?.width,
    height: meta.viewport?.height,
    waitMs: 200,
    freeze: true,
  });

  try {
    const plan = planCapture(opened.probe, {
      from: args.from,
      to: args.to,
      frames: args.frames ?? 8,
      fps: meta.fps,
      mode: meta.mode,
    });
    const captured = await runCapture({
      page: opened.page,
      probe: opened.probe,
      plan,
      selector: args.selector ?? meta.selector,
      label: `zoom of ${meta.id}`,
    });

    const attached = await attachImage(ctx, captured.sheetPng, `web-anim-${captured.captureId}.png`);
    const warnings = [];
    if (attached.error) warnings.push(`the sheet could not be attached (${attached.error})`);

    const lines = [
      `re-sampled ${args.from ?? plan.from}–${args.to ?? plan.to}ms at ${plan.cells} cells · mode=${plan.mode}${plan.deterministic ? ' (deterministic)' : ' (wall clock)'}`,
      `capture ${captured.captureId} · ~${captured.meta.sheet.tokens} tokens`,
    ];
    for (const cell of captured.meta.cells) {
      const diff = cell.diffFromPrevious;
      lines.push(`  #${cell.index}  t=${cell.t}ms${diff ? ` · changed ${(diff.changedRatio * 100).toFixed(1)}%` : ''}`);
    }
    if (captured.pruned?.removed?.length) {
      lines.push(`evicted ${captured.pruned.removed.length} older capture(s): ${captured.pruned.removed.map((item) => item.id).join(', ')}`);
    }
    lines.push('');
    lines.push(statusLine());

    return {
      ok: true,
      text: lines.join('\n'),
      images: attached.ref ? [{ ref: attached.ref, name: `web-anim-${captured.captureId}.png` }] : [],
      warnings,
      captureId: captured.captureId,
      meta: captured.meta,
    };
  } finally {
    await opened.release({ unfreeze: true });
  }
}
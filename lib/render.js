/**
 * render.js — how a tool result reaches the model.
 *
 * Two things happen here, and both are about not wasting the user's context:
 *
 *   1. **One image per call.** A capture produces exactly one sheet. We never
 *      attach individual frames, thumbnails or a second "diff overview" — that
 *      is the behaviour this package exists to replace.
 *   2. **The image goes through the host attachment service**, guarded by
 *      runtime detection. If `ctx.attachments` is missing (older host build,
 *      headless profile without the attachment plugin), the tool still returns
 *      a complete textual result and says the image could not be shown. It does
 *      NOT throw: a debugging tool that dies because it cannot decorate its
 *      answer is worse than one that answers in text.
 */

/**
 * Fetch an optional service from a cordis context.
 *
 * `ctx.attachments` would throw when the service is not injected — cordis
 * proxies throw on undeclared access, and optional chaining does not catch a
 * throw. `ctx.get()` is the supported way to ask for an optional dependency.
 */
export function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch {
    /* not registered */
  }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Submit one PNG as a durable attachment.
 *
 * Returns `{ ref, error }` — never throws. The caller decides how to degrade.
 *
 * @param {object} ctx plugin context
 * @param {Buffer} png
 * @param {string} name
 */
export async function attachImage(ctx, png, name) {
  const attachments = serviceOf(ctx, 'attachments');
  const saveImage = attachments?.saveImage;
  if (typeof saveImage !== 'function') {
    return { ref: null, error: 'this DSH build exposes no attachments service, so the sheet cannot be shown as an image' };
  }
  try {
    // `.call` matters: the implementation reads `this.compression`.
    const ref = await saveImage.call(attachments, { data: png, mediaType: 'image/png', name });
    return { ref, error: null };
  } catch (error) {
    return { ref: null, error: String(error?.message ?? error).slice(0, 240) };
  }
}

/**
 * Build the content blocks a tool returns.
 *
 * @param {{text:string, images?:Array<{ref:object, name:string}>, warnings?:string[]}} input
 * @returns {Array<object>} content blocks
 */
export function contentOf(input) {
  const blocks = [{ type: 'text', text: input.text }];
  for (const warning of input.warnings ?? []) {
    blocks.push({ type: 'text', text: `note: ${warning}` });
  }
  for (const image of input.images ?? []) {
    if (!image?.ref) continue;
    blocks.push({ type: 'image', attachment: image.ref });
  }
  return blocks;
}

/**
 * The text half of a capture result.
 *
 * Written to be read once and acted on: what was captured, whether it is
 * deterministic, where each cell is in time, and what changed between cells.
 * The model should not have to re-derive any of that from the picture.
 *
 * @param {object} meta capture metadata
 * @param {{pruned?:object}} [options]
 */
export function describeCapture(meta, options = {}) {
  const lines = [];
  const windowText = `${Math.round(meta.window[0])}–${Math.round(meta.window[1])}ms`;
  lines.push(`capture ${meta.id} · ${windowText} · ${meta.cells.length} cells · mode=${meta.mode}${meta.deterministic ? ' (deterministic)' : ' (wall clock — not deterministic)'}`);
  if (meta.url) lines.push(`page: ${meta.url}${meta.title ? ` — ${meta.title}` : ''}`);
  if (meta.selector) lines.push(`element: ${meta.selector}`);

  const kindText = [`page kind: ${meta.pageKind}`];
  if (meta.libraries?.length) kindText.push(`libs: ${meta.libraries.join(', ')}`);
  if (meta.timelineApis?.length) kindText.push(`timeline api: ${meta.timelineApis.join(', ')}`);
  lines.push(kindText.join(' · '));

  lines.push(`sheet: ${meta.sheet.width}×${meta.sheet.height}px · ~${meta.sheet.tokens} tokens · ${(meta.sheet.bytes / 1024).toFixed(0)}KB`);
  const includeFrames = options.includeFrames !== false;
  if (!includeFrames) {
    if (meta.clipWarning) lines.push(`note: ${meta.clipWarning}`);
    return lines.join('\n');
  }
  lines.push('');
  lines.push('cells (cite one with web_anim_zoom{cell:N}):');

  for (const cell of meta.cells) {
    const diff = cell.diffFromPrevious;
    let delta = '';
    if (diff) {
      const moved = diff.changedRatio >= 0.001
        ? `changed ${(diff.changedRatio * 100).toFixed(1)}%`
        : 'no visible change';
      delta = ` · ${moved} (meanΔ ${diff.meanDelta.toFixed(2)})`;
    }
    lines.push(`  #${cell.index}  t=${cell.t}ms${delta}`);
  }

  const staticCells = meta.cells.filter((cell) => cell.diffFromPrevious && cell.diffFromPrevious.changedRatio < 0.001).length;
  if (staticCells > 0) {
    lines.push('');
    lines.push(`${staticCells} of ${meta.cells.length - 1} inter-cell transitions show no difference — the animation had already settled (or never started) in that part of the window.`);
  }

  if (meta.animatedBoxes?.length) {
    const moved = meta.animatedBoxes.filter((box) => box.box).slice(0, 3);
    if (moved.length) {
      lines.push('');
      lines.push('dom truth at the freeze point (boxes, not pixels):');
      for (const box of moved) {
        const name = box.id ? `#${box.id}` : box.tag;
        lines.push(`  ${name} x=${box.box.x} y=${box.box.y} w=${box.box.width} h=${box.box.height} opacity=${box.opacity}`);
      }
    }
  }

  /*
   * CSS transitions are settled, not seeked (see inject.js: settleTransitions).
   * Saying so is not decoration: it changes what the sheet *means*. At each cell
   * the DOM shows the state a transition was heading to, not a frame in the middle
   * of it — which is the accurate reading of a settled instant, but it is a
   * statement about the page's animation style and the caller should hear it once.
   */
  if (meta.transitionsSettled > 0) {
    lines.push('');
    lines.push(`note: ${meta.transitionsSettled} CSS transition(s) were finished at each step`
      + (meta.settledProperties?.length ? ` (${meta.settledProperties.join(', ')})` : '')
      + ' — the DOM shows each transition end state at t, not a mid-transition frame');
  }
  if (meta.transitionsStranded > 0) {
    const detail = (meta.settledStrandedDetail ?? [])
      .map((entry) => (entry.property || '?') + (entry.target?.className ? '.' + String(entry.target.className).split(' ')[0] : ''))
      .filter(Boolean)
      .slice(0, 4);
    lines.push('');
    lines.push(`note: ${meta.transitionsStranded} transition(s) could not be finished (infinite or detached)`
      + (detail.length ? ` — ${detail.join(', ')}` : '')
      + '; those DOM properties may still be mid-flight in the sheet');
  }
  if (meta.clipWarning) {
    lines.push('');
    lines.push(`note: ${meta.clipWarning}`);
  }
  /*
   * A frame that is almost one colour is the shape of "the page never painted".
   * Saying it here is the difference between a tool that reports what it saw and
   * one that reports what it hoped for.
   */
  if (meta.blankFrames > 0) {
    const sample = meta.frameUniformity?.find((entry) => entry.dominantRatio >= 0.96);
    lines.push('');
    lines.push(`note: ${meta.blankFrames} of ${meta.cells.length} cell(s) are almost a single colour`
      + (sample ? ` (${Math.round(sample.dominantRatio * 100)}% of the frame in one quantised colour)` : '')
      + ' — the page may not have rendered at all (a refused WebGL context, a canvas that never drew,'
      + ' or a loading screen that never left). If the animation really is this flat, ignore this note.');
  }
  if (meta.looksStatic === true) {
    lines.push('');
    lines.push('this page declares no animation source at all — treat the sheet as a static screenshot, not as a timeline.');
  }
  if (meta.planNotes?.length) {
    lines.push('');
    for (const note of meta.planNotes) lines.push(`note: ${note}`);
  }
  if (meta.stepErrors?.length) {
    lines.push(`note: ${meta.stepErrors.length} page callback(s) threw while stepping; first: ${meta.stepErrors[0]}`);
  }
  if (meta.seekResults?.length) {
    const ok = meta.seekResults.filter((seek) => seek.tried?.length).length;
    if (ok === 0 && meta.mode === 'timeline') {
      lines.push('note: the page advertises a timeline API but none of the known methods ran — falling back to virtual stepping would be safer.');
    }
  }
  if (options.pruned?.removed?.length) {
    lines.push('');
    lines.push(`the store was over budget, so ${options.pruned.removed.length} older capture(s) were evicted: ${options.pruned.removed.map((item) => item.id).join(', ')}`);
  }

  return lines.join('\n');
}
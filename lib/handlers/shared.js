/**
 * handlers/shared.js — glue shared by the tool handlers.
 *
 * Two responsibilities only: turn a handler's canonical value into content
 * blocks, and attach a sheet image when the host allows it. Nothing here reads
 * tool arguments — the schema owns that, and mixing the two is how a parameter
 * ends up honoured in one tool and ignored in another.
 */

import { statusLine } from '../store.js';
import { attachImage, contentOf } from '../render.js';

/**
 * Default renderer: text, plus the storage line appended once.
 *
 * The status line is reminder R1 in the design: it appears on every result,
 * right when the agent has the context to decide whether it still needs what it
 * just looked at.
 */
export function renderText(args, value) {
  return contentOf({ text: value?.text ?? '', images: value?.images ?? [], warnings: value?.warnings ?? [] });
}

/**
 * Attach a sheet PNG and append the storage status line.
 *
 * Never throws: a missing attachments service degrades to text plus a warning,
 * because losing the picture is a worse outcome than losing the decoration.
 *
 * @param {object} ctx
 * @param {{png:Buffer, name:string, text:string, warnings?:string[]}} input
 */
export async function withSheet(ctx, input) {
  const attached = await attachImage(ctx, input.png, input.name);
  const warnings = [...(input.warnings ?? [])];
  const images = [];
  if (attached.ref) images.push({ ref: attached.ref, name: input.name });
  else if (attached.error) warnings.push(`the sheet image could not be attached (${attached.error}); the text below is complete`);

  const text = [input.text, '', statusLine()].join('\n');
  return { ok: true, text, images, warnings };
}

/** Clamp a number argument with a default. */
export function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

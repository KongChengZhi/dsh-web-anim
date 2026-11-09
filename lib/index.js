/**
 * index.js — plugin entry: five tools plus one standing prompt section.
 *
 * Everything the host might not provide is treated as optional at runtime:
 *
 *  - `@deepseek-ai/dsh-tools` ships inside the host's app.asar and often will not
 *    resolve from a plugin directory, so `defineTool` has a local fallback;
 *  - the `attachments` service may be absent (headless profile, older build), so
 *    sheets degrade to text instead of throwing;
 *  - the `systemPrompt` service may be absent, so the storage reminder is skipped.
 *
 * The invariant is that the worst case is a missing feature, never a failed start.
 * So `apply` catches its own failure, registration is individually guarded, and the
 * only declared dependency is `tools` — cordis' `inject` is a hard prefix, and
 * declaring a service a profile does not mount leaves the plugin stuck in loading.
 */

import { compatDefineTool } from './define-tool.js';
import { toolSpecs } from './tools.js';
import { manual } from './help.js';
import { formatBytes, usage } from './store.js';
import { runProbe } from './handlers/probe.js';
import { runCaptureTool } from './handlers/capture.js';
import { runZoom } from './handlers/zoom.js';
import { runGc } from './handlers/gc.js';
import { renderText } from './handlers/shared.js';

export const name = 'dsh-web-anim';
export const inject = ['tools'];

const APPLY_TIMEOUT_MS = 15_000;

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (error) {
    try {
      ctx?.logger?.error?.(`[dsh-web-anim] failed to load: ${error?.stack ?? error}`);
    } catch {
      /* logging itself failed */
    }
    if (process.env.DSH_WEB_ANIM_DEBUG) throw error;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool(ctx?.logger);
  const specs = new Map(toolSpecs().map((spec) => [spec.name, spec]));
  const disposers = [];

  const make = (toolName, execute) => defineTool({
    ...specs.get(toolName),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (args, value) => renderText(args, value),
    },
    timeoutMs: 180_000,
    execute,
  });

  const register = (toolName, execute) => {
    const dispose = ctx.tools.register(make(toolName, execute));
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register('web_anim_capture', (args) => runCaptureTool(ctx, args));
  register('web_anim_zoom', (args) => runZoom(ctx, args));
  register('web_anim_probe', (args) => runProbe(ctx, args));
  register('web_anim_gc', (args) => runGc(ctx, args));
  register('web_anim_help', async (args) => ({ ok: true, text: manual(args?.topic) }));

  registerStorageReminder(ctx, disposers);

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* a disposer must never break teardown */
      }
    }
  };
}

/**
 * The standing reminder.
 *
 * ## Why this text is a CONSTANT
 *
 * The host evaluates a section's `text` at every assembly, which makes it tempting
 * to report live numbers here ("42.1MB of 300MB, 3 captures, oldest 2.1h"). That is
 * what an earlier version did, and it was a mistake with a measurable cost:
 *
 *   - the system prompt is the **first** node of the request, so changing it
 *     invalidates the prefix cache from the very first token;
 *   - `@deepseek-ai/dsh-system-prompt` states the contract directly: "只要身份、
 *     persona、变量、段文本与顺序的渲染完全相同，前缀就保持稳定… 因此头节点重写
 *     会从首个变化的 token 起失去前缀复用" (README.zh.md:156);
 *   - worse, the numbers change *by themselves*: the "oldest" figure is a function
 *     of wall-clock time, so the prompt differed even between two turns that did
 *     nothing at all.
 *
 * Per-turn numbers do not have to live in the prompt. They are in every tool result
 * already (`store: 42.1MB/300MB (14%) · 3 captures · oldest 2.1h`), which is both
 * more timely and cache-safe because tool results are appended, never rewritten.
 *
 * What stays here is the part that must be known *before* the first capture: that
 * the store exists, that it is budgeted, and what to call to release it. That text
 * never changes, so the section renders identically on every step.
 */
const STORAGE_REMINDER = [
  'Web-animation captures (web_anim_capture) are stored locally under a fixed disk budget',
  'and pruned oldest-unused-first when it runs out, so nothing grows without bound. Pruning is',
  'the fallback: every tool result reports the current usage, and you can release captures you',
  'are done comparing with via web_anim_gc{action:"prune"}, or protect a baseline you keep',
  'coming back to with web_anim_gc{action:"pin", captureId}.',
].join(' ');

function registerStorageReminder(ctx, disposers) {
  const systemPrompt = (() => {
    try {
      if (typeof ctx.get === 'function') return ctx.get('systemPrompt');
      return ctx.systemPrompt;
    } catch {
      return null;
    }
  })();
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return;

  try {
    const off = systemPrompt.section({
      name: 'web-anim:storage',
      order: 900,
      // A **string**, not a function. The host renders this identically on every
      // step, so the head of the request stays byte-stable and the prefix cache
      // survives. Live numbers live in tool results instead (see the comment above).
      text: STORAGE_REMINDER,
    });
    if (typeof off === 'function') disposers.push(off);
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`[dsh-web-anim] storage reminder skipped: ${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
  }
}

/** Load the host's defineTool, falling back to the bundled compatible copy. */
async function loadDefineTool(logger) {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  } catch {
    /* packaged inside the host asar; resolution from a plugin usually fails */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (typeof mod?.defineTool === 'function') return mod.defineTool;
    } catch {
      /* the explicit override was wrong; keep falling back */
    }
  }
  try {
    logger?.warn?.('[dsh-web-anim] @deepseek-ai/dsh-tools did not resolve; using the bundled compatible defineTool (arguments are not validated at runtime).');
  } catch {
    /* ignore */
  }
  return compatDefineTool;
}

/** Keep one slow await from freezing application startup. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
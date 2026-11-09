/**
 * tools.js — the five tool contracts.
 *
 * Kept apart from the handlers so the schema can be inspected (and diffed)
 * without dragging in the browser. The host filters arguments by schema, so a
 * parameter that exists in a handler but not here is silently dropped — the
 * classic way this class of tool \"does not work and says nothing\".
 *
 * Design constraint on the split: a capture must be reachable in **one** call.
 * web_anim_capture {url} opens the page, probes it, plans the sampling, drives
 * the clock and returns a sheet. probe exists for the case where the agent
 * wants to choose the window itself, not as a mandatory first step.
 */

export const PROBE = 'web_anim_probe';
export const CAPTURE = 'web_anim_capture';
export const ZOOM = 'web_anim_zoom';
export const GC = 'web_anim_gc';
export const HELP = 'web_anim_help';

const DESC_URL = 'Page URL (http/https or file://). Required unless captureId/resume is used.';
const DESC_SELECTOR = 'Capture only this element (CSS selector). Omit for the whole viewport.';

export function probeTool() {
  return {
    name: PROBE,
    description: [
      'Classify what a page animates with BEFORE capturing: CSS/WAAPI animations, a JS rAF loop,',
      'Canvas/WebGL, or a page that exposes its own deterministic timeline (Remotion/HyperFrames).',
      'Returns the animation sources, their durations, canvases, detected libraries and the viewport.',
      'Free — no image tokens. Use it when you need to choose the window yourself; otherwise',
      'web_anim_capture plans this automatically.',
    ].join('\n'),
    parameters: {
      url: { type: 'string', required: true, description: DESC_URL },
      selector: { type: 'string', description: DESC_SELECTOR },
      width: { type: 'integer', description: 'Viewport width (default 1280).' },
      height: { type: 'integer', description: 'Viewport height (default 720).' },
      waitMs: { type: 'integer', description: 'Extra settle time after load, in ms (default 300).' },
      browser: { type: 'string', enum: ['auto', 'launch', 'attach'], description: 'auto (default) reuses the plugin browser, then attaches to an existing DevTools endpoint, then launches.' },
    },
  };
}

export function captureTool() {
  return {
    name: CAPTURE,
    description: [
      'Freeze a page animation clock and sample it into ONE numbered contact sheet you can cite',
      '(\"cell 5 = 500ms\"). Cells carry burned-in #index and t=ms labels, and the text result gives',
      'per-cell pixel change so you can see where motion actually happened without a second look.',
      '',
      'Replaces the usual \"write a Playwright script, screenshot 40 frames, read 40 images\" loop:',
      'one call, one image (~200-990 tokens instead of thousands), and frames never touch disk.',
      '',
      'Sampling is deterministic by default: requestAnimationFrame and the CSS/WAAPI timeline are',
      'both driven by the plugin, so t=500ms is the same picture every run. Pages that expose their',
      'own timeline API are seeked through it instead (mode=timeline).',
      '',
      'Costs: one image (see web_anim_help for the token table). Artifacts are written to a local',
      'store under a hard budget; the result tells you what it currently costs.',
    ].join('\n'),
    parameters: {
      url: { type: 'string', required: true, description: DESC_URL },
      selector: { type: 'string', description: DESC_SELECTOR },
      frames: { type: 'integer', description: 'Number of cells (2-48). Omit to auto-pick from the window (~8/second, clamped to 4-16).' },
      from: { type: 'number', description: 'Window start in ms (default 0).' },
      to: { type: 'number', description: 'Window end in ms. Omit to use the page own animation duration.' },
      durationMs: { type: 'number', description: 'Alternate to to: window length in ms.' },
      fps: { type: 'integer', description: 'Nominal composition fps used for timeline pages (default 60).' },
      mode: { type: 'string', enum: ['auto', 'virtual', 'timeline', 'wall'], description: 'Frame pacing source. auto (default) picks timeline when the page has one, else virtual.' },
      width: { type: 'integer', description: 'Viewport width (default 1280).' },
      height: { type: 'integer', description: 'Viewport height (default 720).' },
      waitMs: { type: 'integer', description: 'Extra settle time after load before freezing, in ms (default 300).' },
      label: { type: 'string', description: 'Human label stored with the capture (e.g. checkout fade-in, before fix).' },
      browser: { type: 'string', enum: ['auto', 'launch', 'attach'], description: 'auto (default) reuses, then attaches, then launches.' },
      includeFrames: { type: 'boolean', description: 'Report per-cell metadata in the text result (default true).' },
    },
  };
}

export function zoomTool() {
  return {
    name: ZOOM,
    description: [
      'Re-read one part of an existing capture at a readable size: a single cell, or a sub-window',
      'of the timeline at full resolution. Cite a cell from a previous web_anim_capture (\"look at',
      'cell 7 again\") instead of re-running the whole capture.',
      '',
      'Two uses: cell to enlarge one moment of a stored sheet; url+from+to to re-drive a live page',
      'and sample a narrow window densely (a 120ms flinch is invisible in a 1s overview). Only the',
      're-sample gains real detail — cropping a stored sheet is bounded by the pixels it already has.',
    ].join('\n'),
    parameters: {
      captureId: { type: 'string', required: true, description: 'Capture id from a previous web_anim_capture.' },
      cell: { type: 'integer', description: '1-based cell index to enlarge.' },
      from: { type: 'number', description: 'Window start in ms when re-sampling a live page.' },
      to: { type: 'number', description: 'Window end in ms when re-sampling a live page.' },
      frames: { type: 'integer', description: 'Cells for a re-sampled window (2-24).' },
      url: { type: 'string', description: 'Re-drive a live page for the window instead of cropping the stored sheet.' },
      fullRes: { type: 'boolean', description: 'Return the cell at its native pixel size, with no upscaling. This is often SMALLER than the default (which upscales to maxSide but cannot invent detail). For genuinely more detail, re-sample the live page with url+from+to.' },
      maxSide: { type: 'integer', description: 'Longest side of the returned image (default 900).' },
    },
  };
}

export function gcTool() {
  return {
    name: GC,
    description: [
      'Inspect or release the capture store. Everything web_anim_* writes lives under one hard',
      'budget (default 300MB) and is pruned oldest-unused first, but pruning is a fallback —',
      'releasing what you are done with keeps your own baselines alive longer.',
      '',
      'status — usage, per-capture sizes, and which captures look stale (superseded by a newer',
      'capture of the same page, or written but never read again).',
      'prune — delete everything stale and unpinned; reports exactly what went.',
      'pin / unpin — protect a baseline from pruning and from prune.',
      'clear — wipe the store (requires confirm:\"yes\").',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'prune', 'pin', 'unpin', 'clear'], description: 'What to do.' },
      captureId: { type: 'string', description: 'Target capture for pin/unpin.' },
      confirm: { type: 'string', description: 'Must be \"yes\" to run action clear.' },
    },
  };
}

export function helpTool() {
  return {
    name: HELP,
    description: 'Manual for the web_anim_* tools: token costs, sampling strategy, modes and limits. Free — no image tokens, no browser. Read it when a parameter or its cost is unclear.',
    parameters: {
      topic: { type: 'string', enum: ['cost', 'modes', 'sampling', 'limits', 'workflow', 'storage'], description: 'Omit for all topics.' },
    },
  };
}

/** Every tool contract, in the order they should appear to the model. */
export function toolSpecs() {
  return [captureTool(), zoomTool(), probeTool(), gcTool(), helpTool()];
}

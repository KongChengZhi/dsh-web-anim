/**
 * help.js — the manual, kept out of the tool descriptions.
 *
 * Tool descriptions are re-sent on every request. A cost table and a strategy
 * matrix are exactly the kind of text that does not earn that rent: they are
 * read once or twice per session. So they live here and are fetched on demand.
 */

/** @type {Record<string, string[]>} */
const TOPICS = {};

TOPICS.workflow = [
  '## Recommended loop',
  '',
  '  capture (whole viewport, default window)      <- see what moves',
  '  capture (selector + from/to around the motion) <- only if the first was too coarse',
  '  zoom {cell:N}                                  <- one moment, bigger (upscaled)',
  '  zoom {url, from, to, frames}                    <- narrow window, re-sampled = real detail',
  '  ... fix the code ...',
  '  capture again with the same arguments          <- same times, comparable sheets',
  '',
  'Because sampling is deterministic, two captures with the same arguments produce',
  'comparable sheets. Use web_anim_gc{action:"status"} to see whether an older capture',
  'of the same page has been superseded by a newer one.'
];

TOPICS.cost = [
  '## What one capture costs',
  '',
  'A capture returns exactly ONE image. Its price depends on the sheet size, which',
  'the plugin picks from the cell count:',
  '',
  '| cells | sheet (approx) | image tokens |',
  '|---|---|---|',
  '| 4  | 900x520    | ~330 |',
  '| 6  | 990x330    | ~202 |',
  '| 9  | 1000x1000  | ~620 |',
  '| 12 | 1200x800   | ~602 |',
  '| 16 | 1300x1300  | ~994 |',
  '',
  'The text half of the result is roughly 40 tokens per cell.',
  '',
  'For comparison, the same information taken frame by frame:',
  '',
  '| approach | images | tokens |',
  '|---|---|---|',
  '| 8 screenshots at 1280x720 | 8 | ~4600 |',
  '| 8 screenshots at 480x260  | 8 | ~1540 |',
  '| one 8-cell contact sheet  | 1 | ~500 |',
  '',
  'And the frame-by-frame version also leaves 8 PNG files on disk unless something',
  'deletes them.'
];

TOPICS.modes = [
  '## Frame pacing modes',
  '',
  '| mode | how the clock moves | exact? | when |',
  '|---|---|---|---|',
  '| virtual | the plugin owns requestAnimationFrame, performance.now and the CSS/WAAPI timeline | yes, and seeking backwards works | CSS keyframes, WAAPI, GSAP, anime.js, Framer Motion, hand-written lerps |',
  '| timeline | the page own seek API is called (remotion_setFrame, __hf.seek, seekTo, __timeline.seek) | yes, by construction | Remotion, HyperFrames, any composition that ships a seek function |',
  '| wall | real time; only screenshots are taken | no | last resort when injection cannot run |',
  '',
  'auto picks timeline when the probe finds a seek API, virtual otherwise.',
  '',
  '### CSS transitions are settled, not seeked',
  '',
  'An *animation* has a timeline: it exists from the start and currentTime is a real',
  'coordinate, so seeking it to t means "show this page at t".',
  '',
  'A *transition* does not. It is the interpolation between an element old computed style',
  'and its new one, created at the instant the style changed, running on the compositor own',
  'clock. There is nothing to seek to. Left alone it makes the sheet depend on how fast the',
  'screenshot followed the seek - measured on a real Three.js page: up to 816 differing',
  'pixels between two captures of the same t, while the WebGL canvas was bit-identical.',
  '',
  'So the plugin *finishes* every in-flight transition as part of the seek. The DOM at t is',
  'the settled state at t, and two captures of the same t are pixel-identical. The result',
  'says how many transitions were settled and which properties, so you can see it happening.',
  '',
  'The trade-off, stated plainly: you see where a transition *ended*, never a frame from the',
  'middle of it. If the mid-transition frame is the thing you are debugging, animate it with',
  'setTimeout/WAAPI and keyframes (a real timeline) instead of a CSS transition.',
  '',
  '### What virtual mode does NOT control',
  '',
  '- A transition that cannot finish (infinite duration, detached target) is left running and',
  '  reported as "could not be finished"; that DOM property may still be mid-flight.',
  '- WebGL/Canvas content drawn in a loop that does not use requestAnimationFrame (rare, but',
  '  it exists). The probe reports canvas presence so you know to expect this.',
  '- Code that schedules work from Date.now arithmetic. Those reads are counted and reported',
  '  as a determinism caveat instead of being silently ignored.'
];

TOPICS.sampling = [
  '## How the window and cell count are chosen',
  '',
  'Without arguments:',
  '',
  '1. window = the longest finite animation duration found by the probe (or 1000ms if none);',
  '2. an infinite animation does not extend the window - you see one window of a loop, not the end;',
  '3. cells = about 8 per second of window, clamped to 4..16.',
  '',
  'Overrides, in the order they matter:',
  '',
  '- from/to or durationMs - say exactly which slice you care about;',
  '- frames - denser sampling; raise it when the interesting part is short;',
  '- selector - capture only the element that animates. Usually the biggest readability win.',
  '',
  'Rule of thumb: an entrance animation is over in 300-600ms, so 6 cells over 600ms show',
  'the whole thing. A 1.2s page transition wants from=0 to=1200 frames=10.'
];

TOPICS.storage = [
  '## Where the artifacts go',
  '',
  'Every capture writes exactly two files - sheet.png and meta.json - under one directory:',
  '',
  '  Windows  %LOCALAPPDATA%\\dsh-web-anim\\captures\\<id>\\',
  '  macOS    ~/Library/Caches/dsh-web-anim/captures/<id>/',
  '  Linux    $XDG_CACHE_HOME/dsh-web-anim/captures/<id>/',
  '',
  'Frames are never written to disk: they are decoded in memory, composed into the sheet,',
  'and dropped.',
  '',
  'The whole store shares ONE budget (default 300MB; DSH_WEB_ANIM_BUDGET_MB overrides it).',
  'Over budget, whole captures are evicted oldest-unused first; pinned captures are never',
  'evicted.',
  '',
  'Three things keep your own baselines alive:',
  '',
  '  web_anim_gc{action:"status"}              see usage and which captures look stale',
  '  web_anim_gc{action:"prune"}               release stale, unpinned captures now',
  '  web_anim_gc{action:"pin", captureId}      protect the one you keep comparing against'
];

TOPICS.limits = [
  '## Known limits',
  '',
  '- Cross-origin iframes are not captured separately: what they paint is in the screenshot,',
  '  but their internal animations are not driven by the injected clock.',
  '- A transition is sampled at its end state, never mid-flight (see modes). :hover cannot be',
  '  triggered at all by a frozen clock, so hover styling is simply absent from the sheet.',
  '- Screenshots have a hard 15s timeout. A page that never produces a new composited frame',
  '  fails with a typed error instead of hanging.',
  '- The clock is per document. Navigating mid-capture restarts it, so capture after navigation.',
  '- A page that accumulates its own frame counter (t += 16) rather than using the timestamp it is',
  '  given cannot be rewound: two captures will differ slightly. Deriving position from the callback',
  '  timestamp fixes it. The probe reports this style only indirectly, via stepErrors and diff noise.',
  '- Sheet side is capped at 1300px; beyond that the provider downscales anyway and cell',
  '  labels blur.'
];

/**
 * Render the manual.
 * @param {string} [topic] one of the TOPICS keys, or omitted for all
 * @returns {string}
 */
export function manual(topic) {
  const key = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
  if (key && TOPICS[key]) return TOPICS[key].join('\n');
  const order = ['workflow', 'cost', 'modes', 'sampling', 'storage', 'limits'];
  return order.map((name) => TOPICS[name].join('\n')).join('\n\n');
}

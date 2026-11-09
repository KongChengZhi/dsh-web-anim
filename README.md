# dsh-web-anim

Web-animation debugging for DeepSeek Harness: **freeze a page's clock, sample it once,
get one citable contact sheet** — instead of writing a throwaway script, screenshotting frame
by frame, and leaving those frames on disk.

## Why

The default way an agent inspects a web animation is: write a Playwright script, take N
screenshots, read N images, keep the files. That is expensive three ways at once.

| cost | frame-by-frame (8 frames @1280x720) | one 8-cell sheet |
|---|---|---|
| images the model reads | 8 | **1** |
| image tokens | ~4 600 | **~272** |
| files left on disk | 8 per run, never deleted | **2 per capture, budgeted** |

Measured on this machine, not estimated: a full 8-cell capture at 1280x720 takes **1.9s** and
writes **2 files, 13KB total**.

## Tools

| tool | one line |
|---|---|
| `web_anim_capture` | freeze the clock, sample the timeline, return **one** numbered sheet + a citable text index |
| `web_anim_zoom` | re-read one cell bigger, or re-sample a narrow window densely |
| `web_anim_probe` | classify the page first (CSS/WAAPI, Canvas/WebGL, own-timeline) — no image cost |
| `web_anim_gc` | inspect / prune / pin the artifact store |
| `web_anim_help` | cost table, modes, sampling rules, limits — on demand, not resident |

A capture is reachable in **one call**: `web_anim_capture {url}` opens the page, classifies it,
plans the sampling, drives the clock and returns the sheet.

## Determinism

Three time sources drive a page, and all three are handled:

1. `requestAnimationFrame` — replaced with a queue this plugin steps;
2. `performance.now()` — overridden to the same virtual clock, so a library measuring elapsed
   time does not see wall time while the queue is frozen;
3. CSS/WAAPI animations — these never go through rAF, so they are paused individually and
   driven by `currentTime`, which is also what makes **seeking backwards** work.

`Date.now()` is deliberately **not** frozen: pages use it for cache busting and logging, and
freezing it breaks more than it fixes. It is counted instead and reported as a determinism
caveat.

A page that owns its own timeline (Remotion, HyperFrames, or anything exporting a seek
function) is driven through that API instead of through a clock we impersonate — exact by
construction, and cheaper to sample.

### CSS transitions are settled, not steered

An *animation* has a timeline: it exists from the start, `currentTime` is a real coordinate, and
seeking it to t means "show this page at t". A CSS *transition* is a different mechanism — it is
the interpolation between an element's old computed style and its new one, created at the instant
the style changed and running on the compositor's own clock. It has nothing to seek to.

Left alone, that makes the sheet depend on how fast the screenshot followed the seek. Measured on
a real Three.js page: two captures of the same `t` differed by up to **816 pixels in 1 of 5 rounds**,
while the WebGL canvas was bit-identical. So the plugin **finishes** every in-flight transition as
part of the seek (`Animation.finish()`). The DOM at t is the settled state at t, and the same page
then measured **0 differing pixels across every round**.

The trade-off is reported, not hidden: each result says how many transitions were settled and which
properties, so you can see that at time t you are looking at where a transition *ended*, never a
frame from the middle of it. A transition that cannot finish (infinite, detached target) is left
running and called out as "could not be finished".

If a mid-transition frame is exactly what you are debugging, animate it with keyframes or WAAPI —
a real timeline, which *can* be seeked.

Verified: repeated captures of the same page produce the same picture, seeking a CSS animation to
1500ms, 200ms and back to 1500ms yields identical pixels, and a page that flips a class onto a 500ms
transition captures identically twice (`transitions` suite).

The exact wording matters, so here is a measured number rather than a claim. Two captures of the
same real page (a Three.js scene, timeline mode, 8 cells) differ in **34 of 430,000 pixels by less
than one level of one channel** (maxΔ 0.67, meanΔ 0.00003) — the PNG downscale rounding, not the
picture. At any threshold ≥ 1 the difference is **exactly zero**. So: bit-identical at 8 bits per
channel, which is the honest ceiling for a tool that screenshots a compositor.

## Storage — the part that matters as much as the pictures

This is a hard requirement, not an optimisation:

- **Frames never touch disk.** They are decoded in memory, composed into one sheet, dropped.
- **One budget for everything** (default 300MB, `DSH_WEB_ANIM_BUDGET_MB`): over budget, whole
  captures are evicted oldest-unused first. Never half a capture — a sheet without its timeline
  reads as a broken plugin and causes a re-run.
- **Pinned captures are never evicted**: pin the baseline you keep comparing against.
- **The agent is reminded, repeatedly, so it releases what it no longer needs**:
  - every tool result ends with `store: 12.7KB/300.0MB (0%) · 1 capture · oldest 0s` plus the
    exact call to release something;
  - the wording escalates past 70% (names the capture that will go next) and 90%;
  - a standing system-prompt section explains the budget and the release call (a fixed string —
    see below for why it must not carry live numbers).

Pruning is the fallback. The reminder is the mechanism — a `gc` tool nobody knows to call is
decoration.

### The reminder is a constant, on purpose

An earlier version put **live** numbers in the standing prompt section (`42.1MB of 300MB, 3
captures, oldest 2.1h`). It looked helpful and quietly broke the prompt cache:

- the system prompt is the **first** node of the request, so the host documents that
  "头节点重写会从首个变化的 token 起失去前缀复用" (`@deepseek-ai/dsh-system-prompt`,
  README.zh.md:156) — any change there invalidates the prefix from token 0;
- the figures changed *by themselves*: the "oldest" value is a function of wall-clock time,
  so two consecutive turns that did nothing still produced different prompts.

Live numbers now live only in tool results, which are **appended**, never rewritten. The prompt
section is a fixed string that says the store exists, is budgeted, and how to release from it.
`registration.test.mjs` asserts the text contains no live numbers, so this cannot regress.


## Page classification

| kind | detected by | pacing |
|---|---|---|
| `timeline` | a seek API (`remotion_setFrame`, `seekTo`, `__hf.seek`, `__timeline.seek`, …) | the page's own API — exact by construction |
| `html` | CSS/WAAPI animations, no canvas | virtual clock |
| `canvas` | canvas with no CSS/WAAPI animation | virtual clock + pixel evidence only |
| `hybrid` | both | virtual clock |

A page with **no** animation source is detected before sampling and costs two cells, not a
full sheet — with an explicit line saying the result is a static screenshot.

## A page that never painted

Releasing this plugin meant pointing it at other people's pages for the first time, and the first
one broke the tool's honesty in a way no unit test could have caught.

Its own animation example - a real three.js scene - captured like this:

    page kind: canvas - 4 canvases found - mode=virtual (deterministic)
    cells: 6 - "no visible change" in 5 of 5 transitions - sheet 7KB

Every number was internally consistent, and the conclusion a reader draws is *"this animation has
settled, or has no motion in this window."* The actual cause was that the page had painted nothing
at all - a refused WebGL context in a headless browser.

A tool that answers "nothing moved" when the truth is "nothing rendered" is worse than one that
refuses: the model believes it, then goes looking for a bug in an animation that never ran. So a
frame that is essentially one colour is now reported explicitly, in the same result:

    note: 6 of 6 cell(s) are almost a single colour (100% of the frame in one quantised colour)
          - the page may not have rendered at all ...

The threshold is not the obvious one. Measured across every fixture:

| fixture | distinct colours | dominant share |
|---|---|---|
| blank (never painted) | **1** | 1.000 |
| timeline.html | 9-11 | 0.95-0.97 |
| animation.html | 18-32 | 0.95 |
| canvas.html | 28-30 | 0.969 |
| static.html (sparse but real) | **146** | 0.984 |

"One colour covers >=96% of the frame" flags the sparse *real* page and barely clears the canvas
fixture. The colour **count** separates them with a wide margin, so that is the criterion. The
`blank` suite pins both directions: the blank page must be flagged, and four real pages must not.

## Limits (measured, not guessed)

- **A transition is sampled at its end state**, never mid-flight (see Determinism). `:hover` /
  `:focus` cannot be triggered by a frozen clock at all, so hover styling is simply absent.
- **A page that accumulates its own frame counter** (`t += 16`) is not rewindable: two captures
  will differ slightly. Deriving position from the callback timestamp fixes it.
- **Cross-origin iframes** appear in the screenshot but their animations are not driven.
- **A page that never produces a composited frame** fails with a 15s typed timeout rather than
  hanging.
- **The host's attachment store never deletes files.** This plugin stays under that ceiling by
  submitting exactly one image per capture and never submitting frames; it cannot change the
  host's retention policy.
- **WebGL needs a GPU or an explicit opt-in.** On a headless machine with no GPU, a recent Chrome
  refuses to create a WebGL context and WebGL pages capture as blank rectangles (see "A page that
  never painted" — the capture now says so). Set `DSH_WEB_ANIM_BROWSER_ARGS=--enable-unsafe-swiftshader`
  to permit software rendering. It is not the default: on a machine that has a GPU it makes every
  capture slower and subtly different from what the user sees locally.
- **Persistent artifacts** are two files per capture under one budgeted directory; the headless
  browser profile is deleted on teardown, and any profile left by a crash is reclaimed on the
  next launch (covered by the `teardown` suite).
- **The warm browser expires.** Reusing one headless instance makes consecutive captures ~5x
  faster, but it is still a process and a ~10MB profile. After `DSH_WEB_ANIM_IDLE_MIN` (default
  10) minutes without a call it is closed and the profile removed; the next call cold-starts in
  about a second (`idle` suite).
- **Concurrency is single-flight.** A multi-agent host calls tools in parallel. Concurrent
  captures share one browser, and each gets its own page target so they cannot navigate over
  each other; the target is closed on release (`concurrency` suite).
- **Teardown is verified, not assumed.** `closeBrowser` waits for the process tree to exit, then
  kills any child still holding the profile directory, then removes it with retries
  (`teardown` + `load` suites).

## Install

See [INSTALL.md](INSTALL.md). Short version:

```bash
dsh plugin --profile <profile> add link:$(pwd)
# then add "dsh-web-anim" to the profile's dsh.profile.bundles and restart
```

## Browser

**No npm dependencies.** Chrome is driven over the DevTools Protocol using Node's built-in
`WebSocket`, and PNG encode/decode uses `node:zlib`. Resolution order:

1. **reuse** the instance this plugin launched earlier in the process;
2. **attach** to an existing DevTools endpoint — `DSH_WEB_ANIM_CDP_PORT`, or ego-browser's
   published port (`%LOCALAPPDATA%\ego-lite-linux\browser.json`). An attached browser is never
   killed by this plugin, and a non-headless ego instance is skipped so the agent never fights
   a human for the window;
3. **launch** a private headless instance with a throwaway profile removed on exit.

Executable discovery covers Chrome/Edge on Windows, macOS and Linux; `DSH_WEB_ANIM_BROWSER`
overrides it.

## Test

```bash
npm test
```

15 suites, 177 assertions. Browser suites launch a real headless Chrome; three pure suites run
without one, so a broken module fails in seconds instead of looking like a browser problem.

| suite | proves | browser |
|---|---|---|
| `storage` | budget, whole-capture eviction, pins, staleness, status-line escalation | no |
| `registration` | five tools register through `apply`; a throwing registry cannot crash startup | no |
| `args` | `DSH_WEB_ANIM_BROWSER_ARGS` is parsed correctly — a switch must never be chopped at a letter (see the note in that suite) | no |
| `selftest` | clock takeover, deterministic stepping, PNG round-trip, sheet composition | yes |
| `classify` | the three page kinds are told apart and get the right pacing mode | yes |
| `host` | tools registered through `apply`, rendered through `output.render`, host image block | yes |
| `static` | an animation-free page costs two cells and says so | yes |
| `teardown` | closing the browser removes its profile; the sweeper ignores fresh directories | yes |
| `idle` | a warm browser is reused, then reclaimed on close/idle | yes |
| `concurrency` | two parallel calls share one browser, each gets its own tab | yes |
| `load` | 20 captures in batches of 5: all succeed, one browser, zero leaks | yes |
| `params` | every declared parameter changes the result (`selector` crops, `includeFrames` shortens, `fullRes` is native) | yes |
| `transitions` | a class-swapped CSS transition is settled at each step: two captures of the same window are pixel-identical. Also asserts the fixture *does* strand a transition, and that disabling the fix makes the comparison fail | yes |
| `blank` | a page that never painted is flagged as such ("nothing moved" and "nothing painted" must not look alike), and a sparse-but-real page is not | yes |
| `pipeline` | capture -> zoom -> gc, including supersession and prune | yes |

Fixtures under `fixtures/` are the three page kinds the classifier must separate, plus the
static case and `transition.html` (a page whose only animation is a class-swapped CSS transition).

## Layout

```
lib/
  index.js        plugin entry: registration + the standing storage reminder
  tools.js        the five tool contracts (schemas live here, not in handlers)
  page.js         open a URL into a controllable page (the ordering is load-bearing)
  inject.js       the page-side clock takeover and classification probe
  capture.js      plan -> drive -> compose -> write
  image.js        downscale, diff, contact-sheet layout, token estimate
  png.js          PNG codec on node:zlib
  font.js         5x7 bitmap font for burned-in labels
  cdp.js          minimal DevTools Protocol client over the built-in WebSocket
  browser.js      find / attach / launch / clean up a browser
  store.js        the budgeted artifact store and the status line
  render.js       result -> content blocks, with graceful degradation
  define-tool.js  local fallback for the host's defineTool
  handlers/       one file per tool
```
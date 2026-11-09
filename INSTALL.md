# Installing dsh-web-anim

## 1. Requirements

- **Node.js 22+** (the plugin uses the built-in `WebSocket` and `fetch`).
- **A Chromium-based browser**: Chrome, Chromium, or Edge. Nothing is downloaded — the plugin
  uses the browser already on the machine.
- **DeepSeek Harness 0.2.1-rc.3 or newer**.

Check that a browser is found before anything else:

```bash
node -e "import('./lib/browser.js').then(m => console.log(m.describeBrowserEnvironment()))"
```

If `executable` is null, set `DSH_WEB_ANIM_BROWSER` to the full path of a Chromium binary.

## 2. Add the plugin to a profile

### Option A — local development (link)

```bash
cd <this directory>
dsh plugin --profile <profile> add link:$(pwd)
```

Then edit the profile's `package.json` and add the bundle:

```json
"dependencies": { "dsh-web-anim": "link:D:/path/to/dsh-web-anim" },
"dsh": { "profile": { "bundles": [ "...", "dsh-web-anim" ] } }
```

### Option B — installed package

```bash
dsh plugin --profile <profile> add dsh-web-anim
```

Add `"dsh-web-anim"` to `dsh.profile.bundles` the same way.

Restart DSH after changing the bundle list — the profile is composed at boot.

## 3. Verify it loaded

Ask the agent to run:

```
web_anim_help {}
```

A manual is the proof that the plugin registered; if the tool is missing, the plugin did not
load. Check the host log for `[dsh-web-anim]`:

| log line | meaning |
|---|---|
| `did not resolve; using the bundled compatible defineTool` | expected on most installs — `@deepseek-ai/dsh-tools` lives inside the host's asar and plugins usually cannot import it. Tools work; arguments are not validated at runtime. |
| `storage reminder skipped` | the host has no `systemPrompt` service. Tools still work, the standing reminder is gone. |
| `failed to load` | the plugin is inoperative. Re-run with `DSH_WEB_ANIM_DEBUG=1` to see the error instead of a silent empty registration. |

## 4. First real capture

```
web_anim_capture { url: "http://localhost:5173/", frames: 6 }
```

What to expect:

- one image, with `#1 t=43ms`-style labels burned into each cell;
- a text timeline listing each cell's time and how much of the frame changed;
- a closing line like `store: 0.2MB/300.0MB (0%) · 1 capture`.

If instead you get text without an image, the host has no `attachments` service — the
capture still happened and the timeline is still valid.

## 5. Settings

All configuration is by environment variable: nothing is written into the plugin directory.

| variable | default | meaning |
|---|---|---|
| `DSH_WEB_ANIM_BROWSER` | auto-detected | full path to the Chrome/Chromium/Edge binary |
| `DSH_WEB_ANIM_BROWSER_ARGS` | — | extra browser switches, space-separated. Needed on a headless Linux box with no GPU: `--enable-unsafe-swiftshader`, or WebGL pages capture as blank rectangles |
| `DSH_WEB_ANIM_CDP_PORT` | — | attach to an existing DevTools endpoint instead of launching |
| `DSH_WEB_ANIM_DIR` | `%LOCALAPPDATA%\dsh-web-anim` | artifact store location |
| `DSH_WEB_ANIM_BUDGET_MB` | `300` | store budget in megabytes |
| `DSH_WEB_ANIM_IDLE_MIN` | `10` | minutes without a call before the warm browser is closed and its profile reclaimed (`0` disables) |
| `DSH_WEB_ANIM_DEBUG` | — | rethrow plugin load errors instead of swallowing them |
| `DSH_TOOLS_PATH` | — | explicit path to the host's `dsh-tools/lib/index.js` |

## 6. Uninstall

```bash
dsh plugin --profile <profile> remove dsh-web-anim
```

Then delete the artifact store if you want the disk space back:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-web-anim"
```

## Troubleshooting

**`no Chrome/Chromium/Edge executable found`** — set `DSH_WEB_ANIM_BROWSER`. The error
lists every path that was checked.

**`the browser exited immediately after launch`** — the binary is probably not Chromium
(a Firefox or Safari path, or a stub). Point the variable at a real Chrome.

**Capture hangs on screenshot** — a page that never produces a composited frame (offscreen
tab, GPU stall) hits a 15s typed timeout rather than hanging forever. Retry with the window
visible, or use `mode: "wall"`.

**A capture looks different from the last one** — open `web_anim_help{topic:"limits"}`: a page
that accumulates its own frame counter cannot be rewound. So can a page whose motion is driven
by `:hover` transitions, which do not advance on a frozen clock.

**Disk keeps filling** — it should not: the store has a hard budget. Check with
`web_anim_gc{action:"status"}`; if `used` is far below `budget` yet the disk is full, the
growth is elsewhere (the host's own attachment store never deletes files - see below).

**Host attachments never shrink** — `@deepseek-ai/dsh-attachment` keeps every image it has
ever stored. This plugin stays under that ceiling by submitting exactly **one** image per
capture and never submitting frames. If you capture very often, the host's attachment
directory will still grow; that is a host-level retention policy, not something a plugin can
change.

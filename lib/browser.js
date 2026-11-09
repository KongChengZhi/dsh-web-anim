/**
 * browser.js — find a browser, launch it headless, expose a CDP port, clean up.
 *
 * Three sources, in this order:
 *   1. **reuse** an already-running browser that this plugin started earlier
 *      (same process, warm — navigating is instant);
 *   2. **attach** to an existing DevTools endpoint the operator already has open
 *      (ego-browser writes one to `%LOCALAPPDATA%\ego-lite-linux\browser.json`,
 *      Playwright users can point at their own). Attaching is read-only from our
 *      side: we never kill a browser we did not start;
 *   3. **launch** a private headless instance with a throwaway profile.
 *
 * The launch path deliberately uses `--user-data-dir` under the temp directory
 * and removes it on close, because a leaked Chrome profile is tens of megabytes
 * and this plugin exists partly to reduce disk litter.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CdpError, connect, delay, listTargets, waitForDevTools } from './cdp.js';

/** Raised when no usable browser can be found. Carries what we looked at. */
export class BrowserError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'BrowserError';
    this.code = code ?? 'BROWSER_UNAVAILABLE';
    this.details = details ?? null;
  }
}

/** Candidate executables, most preferred first. */
function executableCandidates(env = process.env) {
  const list = [];
  if (env.DSH_WEB_ANIM_BROWSER) list.push(env.DSH_WEB_ANIM_BROWSER);
  const local = env.LOCALAPPDATA ?? '';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  if (process.platform === 'win32') {
    list.push(
      join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      join(local, 'Chromium\\Application\\chrome.exe'),
      join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return list;
}

/**
 * Every external DevTools endpoint we can borrow, in preference order.
 *
 * ego-browser publishes `{ port, wsUrl, headless, binary, profileDir }`; we only
 * read `port` and `headless` and refuse a non-headless instance by default —
 * capturing frames from a window the human is using would fight them for focus.
 */
function attachCandidates(env = process.env) {
  const list = [];
  if (env.DSH_WEB_ANIM_CDP_PORT) list.push({ kind: 'env', port: Number(env.DSH_WEB_ANIM_CDP_PORT), source: 'DSH_WEB_ANIM_CDP_PORT' });

  const stateDirs = [];
  if (env.LOCALAPPDATA) stateDirs.push(join(env.LOCALAPPDATA, 'ego-lite-linux'));
  if (env.EGO_LINUX_STATE_DIR) stateDirs.push(env.EGO_LINUX_STATE_DIR);
  for (const dir of stateDirs) {
    const file = join(dir, 'browser.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Number.isFinite(parsed?.port)) {
        list.push({ kind: 'ego', port: Number(parsed.port), headless: parsed.headless === true, source: file });
      }
    } catch {
      /* a corrupt state file is not an error: just skip it */
    }
  }
  return list;
}

/**
 * Pick a browser executable.
 * @returns {{path:string, checked:string[]}}
 */
export function findBrowser(env = process.env) {
  const checked = [];
  for (const candidate of executableCandidates(env)) {
    if (!candidate) continue;
    checked.push(candidate);
    if (existsSync(candidate)) return { path: candidate, checked };
  }
  throw new BrowserError(
    'no Chrome/Chromium/Edge executable found. Set DSH_WEB_ANIM_BROWSER to the full path of a Chromium-based browser.',
    'BROWSER_NOT_FOUND',
    { checked },
  );
}

/** Is an external endpoint alive? Returns its /json/version payload or null. */
async function probeEndpoint(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** A launched browser plus the profile directory we are responsible for. */
class LaunchedBrowser {
  constructor(child, port, profileDir) {
    this.child = child;
    this.port = port;
    this.profileDir = profileDir;
    this.kind = 'launched';
  }
}

/**
 * A browser session the rest of the plugin talks to.
 *
 * `ownsProcess` decides whether `close()` kills the browser. Attached sessions
 * are never killed — the user or another plugin owns them.
 */
export class BrowserSession {
  constructor({ port, wsUrl, kind, ownsProcess, profileDir, child, executable, reusedFrom }) {
    this.port = port;
    this.wsUrl = wsUrl;
    this.kind = kind;
    this.ownsProcess = ownsProcess === true;
    this.profileDir = profileDir ?? null;
    this.child = child ?? null;
    this.executable = executable ?? null;
    this.reusedFrom = reusedFrom ?? null;
    this.browserConnection = null;
    this.pageConnection = null;
    this.targetId = null;
  }

  /** Connection to the browser-level endpoint (Target.* commands). */
  async browser() {
    if (!this.browserConnection) this.browserConnection = await connect(this.wsUrl, 'browser');
    return this.browserConnection;
  }

  /**
   * Acquire a page target for one capture.
   *
   * Each acquisition gets its own target, because two captures sharing one tab would
   * navigate over each other — which is exactly what a multi-agent host produces
   * when it runs several tool calls at once. The target is closed on release, so a
   * capture cannot leave a tab behind.
   *
   * @returns {Promise<{connection: object, targetId: string, release: Function}>}
   */
  async acquirePage() {
    const browserConnection = await this.browser();
    const created = await browserConnection.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created.targetId;
    let connection;
    try {
      const targets = await listTargets(this.port);
      const target = targets.find((item) => item.id === targetId);
      if (!target?.webSocketDebuggerUrl) throw new CdpError('the page target has no DevTools endpoint', 'BROWSER_NO_TARGET');
      connection = await connect(target.webSocketDebuggerUrl, 'page');
      await connection.send('Page.enable');
      await connection.send('Runtime.enable');
    } catch (error) {
      await browserConnection.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        connection.close();
      } catch {
        /* already closed */
      }
      await browserConnection.send('Target.closeTarget', { targetId }).catch(() => {});
    };

    return { connection, targetId, release };
  }

  /** Legacy single-page accessor kept for callers that only read state. */
  async page() {
    if (this.pageConnection && !this.pageConnection.closed) return this.pageConnection;
    const lease = await this.acquirePage();
    this.pageConnection = lease.connection;
    return lease.connection;
  }


  /** Kill the browser if we own it, then remove our temporary profile. */
  async close() {
    try {
      this.pageConnection?.close();
    } catch {
      /* already gone */
    }
    try {
      this.browserConnection?.close();
    } catch {
      /* already gone */
    }
    if (this.ownsProcess && this.child) {
      await killTree(this.child);
      // taskkill returns before the tree has actually exited; the profile handles
      // are still open for a few hundred milliseconds after it does.
      await waitForExit(this.child, 4000);
    }
    if (this.ownsProcess && this.profileDir) {
      // Backstop: a child that outlived taskkill still holds the directory open.
      killProcessesUsingProfile(this.profileDir);
      await delay(150);
      await removeDirWithRetry(this.profileDir);
    }
    this.pageConnection = null;
    this.pagePending = null;
    this.browserConnection = null;
  }
}

/**
 * On Windows a killed browser leaves renderer children behind unless the whole
 * tree goes; `taskkill /T` is the only reliable way without a job object.
 */
async function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
      setTimeout(resolve, 5000);
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
}

/** Wait until a child has actually exited (or the timeout elapses). */
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => finish(true));
  });
}

/**
 * Kill any process still holding `profileDir`.
 *
 * taskkill /T returns once the tree has been signalled, not once it has exited, and
 * Chrome's GPU/utility children can outlive their parent by a moment. Without this
 * backstop a teardown can report success while a browser is still running.
 */
function killProcessesUsingProfile(profileDir) {
  if (process.platform !== 'win32') return;
  try {
    const list = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*` + profileDir.replace(/\\/g, '\\\\') + `*' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8', timeout: 8000 });
    for (const line of list.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* the backstop failing must not fail the teardown */
  }
}

/** Remove a directory, retrying while Windows releases its handles. */
async function removeDirWithRetry(path, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      return true;
    } catch {
      await delay(120);
    }
  }
  return false;
}

/** Cached session, so consecutive tool calls reuse one browser. */
let cached = null;

/**
 * Every browser this process launched, including ones a race replaced.
 *
 * `cached` answers "what do I reuse"; this answers "what am I responsible for
 * cleaning up". Without it, losing a race means leaking a Chrome and its profile —
 * which is precisely the class of leak this package exists to prevent.
 */
const owned = new Set();

/** In-flight resolution, so concurrent callers share one launch. */
let resolving = null;

/**
 * Reclaim on process exit.
 *
 * Tool handlers call `closeBrowser()` in a `finally`, but a test harness, a SIGINT
 * or an unhandled rejection goes straight past that. Registering one idempotent
 * exit hook means a normal process shutdown never leaves a browser or a 40MB
 * profile behind — which is the whole reason this package exists.
 */
/**
 * Idle reaping.
 *
 * Keeping one browser warm between calls makes consecutive captures ~5x faster, but
 * a warm browser is a real process plus a ~10MB profile for as long as the host
 * runs. "An agent leaves resources behind" is exactly what this package exists to
 * prevent, so the warm instance expires: no tool call for `idleTimeoutMin`, and it
 * is closed and its profile removed. The next call cold-starts in ~1s.
 */
const IDLE_DEFAULT_MIN = 10;
let idleTimer = null;
let lastActivityAt = 0;

/** Mark that a tool just used the browser, pushing its expiry out. */
export function touchActivity() {
  lastActivityAt = Date.now();
}

/** Idle timeout in ms; 0 disables reaping. */
function idleTimeoutMs(env = process.env) {
  const configured = Number(env.DSH_WEB_ANIM_IDLE_MIN);
  const minutes = Number.isFinite(configured) && configured >= 0 ? configured : IDLE_DEFAULT_MIN;
  return minutes * 60_000;
}

/** Start (or restart) the idle reaper for a cached session. */
function armIdleReaper(logger) {
  const timeoutMs = idleTimeoutMs();
  if (timeoutMs === 0) return;
  if (idleTimer) clearInterval(idleTimer);
  lastActivityAt = Date.now();
  // Check four times per timeout: cheap, and the worst case overshoot is 25%.
  const tick = Math.max(1000, Math.floor(timeoutMs / 4));
  idleTimer = setInterval(() => {
    if (!cached || !cached.ownsProcess) return;
    if (Date.now() - lastActivityAt < timeoutMs) return;
    const session = cached;
    clearInterval(idleTimer);
    idleTimer = null;
    void session.close().then(
      () => logger?.info?.('[dsh-web-anim] closed the idle browser and reclaimed its profile'),
      () => {},
    );
    if (cached === session) cached = null;
  }, tick);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    const session = cached;
    cached = null;
    if (!session) return;
    // On exit only synchronous work is possible: signal the whole process tree and
    // let sweepStaleProfiles reclaim the directory next run. Trying to delete it
    // here races Chrome's own file handles and silently fails.
    if (session.ownsProcess && session.child) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          session.child.kill('SIGKILL');
        }
      } catch {
        /* already gone */
      }
    }
  });
}

/**
 * Resolve a browser session according to the configured strategy.
 *
 * `strategy`:
 *   - `auto`     reuse our own instance, else attach, else launch
 *   - `launch`   always our own instance
 *   - `attach`   only an existing endpoint; fails if none is alive
 *   - `reuse`    alias of auto (kept for readability in tool arguments)
 *
 * @param {{strategy?:string, headless?:boolean, allowNonHeadlessAttach?:boolean}} options
 * @returns {Promise<BrowserSession>}
 */
export async function resolveBrowser(options = {}) {
  // Single-flight, unconditionally.
  //
  // A multi-agent host calls tools in parallel, and two simultaneous launches are
  // two Chromes. "Give me my own instance" has no meaning for a tool call — the
  // session is shared by design and each capture gets its own page target. `launch`
  // therefore means "do not attach to a foreign browser", not "start a second one".
  if (resolving) {
    touchActivity();
    return resolving;
  }
  resolving = resolveBrowserInner(options).finally(() => {
    resolving = null;
  });
  return resolving;
}

async function resolveBrowserInner(options = {}) {
  const strategy = options.strategy ?? 'auto';
  const env = process.env;

  if (cached && (await probeEndpoint(cached.port))) {
    touchActivity();
    return cached;
  }
  if (cached) {
    // It died on its own; forget it (its profile was already reclaimed, or the
    // sweeper will take it).
    cached = null;
  }

  if (strategy === 'auto' || strategy === 'attach' || strategy === 'reuse') {
    for (const candidate of attachCandidates(env)) {
      const version = await probeEndpoint(candidate.port);
      if (!version) continue;
      if (candidate.kind === 'ego' && candidate.headless === false && options.allowNonHeadlessAttach !== true) {
        continue;                             // never fight the human for their window
      }
      const session = new BrowserSession({
        port: candidate.port,
        wsUrl: version.webSocketDebuggerUrl,
        kind: 'attached',
        ownsProcess: false,
        reusedFrom: candidate.source,
      });
      cached = session;
      return session;
    }
    if (strategy === 'attach') {
      throw new BrowserError(
        'no attachable DevTools endpoint found. Set DSH_WEB_ANIM_CDP_PORT to a running Chrome remote-debugging port, or use strategy "launch".',
        'BROWSER_NO_ENDPOINT',
        { candidates: attachCandidates(env).map((c) => c.port) },
      );
    }
  }

  const session = await launchBrowser({ headless: options.headless !== false, env: options.env });
  cached = session;
  owned.add(session);
  installExitHook();
  armIdleReaper(options.logger);
  return session;
}

/**
 * Remove profile directories left behind by a previous run that did not shut down
 * cleanly (a crash, a kill, a machine that slept through teardown).
 *
 * A debugging tool that itself leaks a 40MB Chrome profile per crash is the same
 * complaint it was written to answer, so this runs before every launch. The age
 * gate keeps it from deleting a profile another live process is using right now.
 */
export function sweepStaleProfiles(options = {}) {
  const env = options.env ?? process.env;
  // Ten seconds is enough for a just-killed Chrome to release its handles, and it
  // means a plugin process that exits leaves nothing behind for the next one to
  // trip over. Anything younger might still be a live browser, so it is left alone.
  const maxAgeMs = options.maxAgeMs ?? 10 * 1000;
  let root;
  try {
    root = options.root ?? usableTempDir();
  } catch {
    return { removed: 0 };              // nothing we can sweep, nothing to break
  }
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed };
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-web-anim-')) continue;
    const path = join(root, entry.name);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs < maxAgeMs) continue;      // possibly in use
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      /* still locked: try again next time */
    }
  }
  return { removed };
}

/**
 * A temp directory we can actually write to.
 *
 * `os.tmpdir()` reads TEMP/TMP/TMPDIR and returns a literal "undefined\temp" when
 * none is set — a launcher that strips the environment produces exactly that, and
 * the failure surfaces as a confusing ENOENT from mkdtemp. Fall back to a path
 * we know exists instead of trusting the environment.
 */
function usableTempDir() {
  const candidates = [
    process.env.TMP,
    process.env.TEMP,
    process.env.TMPDIR,
    tmpdir(),
    process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0 && !candidate.includes('undefined'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new BrowserError(
    'no usable temporary directory: set TMP or TEMP, or DSH_WEB_ANIM_DIR to a writable directory.',
    'BROWSER_NO_TEMP',
    { candidates },
  );
}

/**
 * Escape hatch for flags this plugin deliberately does not pick for you.
 *
 * The motivating case is CI: a bare Linux runner has no GPU, and a recent Chrome
 * refuses to create a WebGL context in headless without `--enable-unsafe-swiftshader`.
 * Every WebGL fixture then paints nothing and suites fail for a reason unrelated
 * to the code.
 *
 * It is opt-in rather than a default because it is a *portability* flag with a
 * real cost: on a machine that does have a GPU, forcing software rendering makes
 * every capture slower and subtly different from what the user sees locally. The
 * plugin should not decide that for someone else's machine.
 *
 * Space-separated; quoted values are not supported (these are browser switches,
 * not a shell command line).
 */
export function parseBrowserArgs(env = process.env) {
  const raw = env.DSH_WEB_ANIM_BROWSER_ARGS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

/** Launch a private headless instance on an ephemeral port. */
export async function launchBrowser(options = {}) {
  sweepStaleProfiles(options);
  const { path: executable, checked } = findBrowser();
  const port = options.port ?? await findFreePort();
  const profileDir = mkdtempSync(join(usableTempDir(), 'dsh-web-anim-'));
  const args = [
    options.headless === false ? '--headless=old' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,720',
    ...parseBrowserArgs(options.env ?? process.env),
    'about:blank',
  ];

  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.on('error', () => {});

  try {
    const version = await Promise.race([
      waitForDevTools(port, { timeoutMs: options.timeoutMs ?? 30_000 }),
      exited.then(() => {
        throw new BrowserError(
          'the browser exited immediately after launch. Check DSH_WEB_ANIM_BROWSER and that the binary is a Chromium build that accepts --headless=new.',
          'BROWSER_EXITED',
          { executable },
        );
      }),
    ]);
    return new BrowserSession({
      port,
      wsUrl: version.webSocketDebuggerUrl,
      kind: 'launched',
      ownsProcess: true,
      profileDir,
      child,
      executable,
    });
  } catch (error) {
    await killTree(child);
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* best effort */
    }
    if (error instanceof BrowserError) throw error;
    throw new BrowserError(`failed to start ${executable}: ${error.message}`, 'BROWSER_LAUNCH_FAILED', { checked, executable });
  }
}

/** Ask the OS for a free TCP port by binding and releasing one. */
async function findFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** What a `browser_status` style report should say without launching anything. */
export function describeBrowserEnvironment(env = process.env) {
  let executable = null;
  let error = null;
  let checked = [];
  try {
    const found = findBrowser(env);
    executable = found.path;
    checked = found.checked;
  } catch (e) {
    error = e.message;
    checked = e.details?.checked ?? [];
  }
  return {
    executable,
    error,
    checked,
    attachCandidates: attachCandidates(env).map((c) => ({ port: c.port, kind: c.kind, source: c.source })),
    running: cached ? { port: cached.port, kind: cached.kind, ownsProcess: cached.ownsProcess } : null,
    platform: process.platform,
  };
}

/** Close and forget the cached session (used by the gc tool and teardown). */
export async function closeBrowser() {
  cached = null;
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  // Close every browser this process owns, not just the cached one. A session that
  // lost a race is no longer reachable through `cached` but is still running.
  const sessions = [...owned];
  owned.clear();
  await Promise.all(sessions.map((session) => session.close().catch(() => {})));
}

/** Give the renderer a beat to flush a style change before the next screenshot. */
export async function settle(connection, ms = 0) {
  await connection.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    .catch(() => {});
  if (ms > 0) await delay(ms);
}
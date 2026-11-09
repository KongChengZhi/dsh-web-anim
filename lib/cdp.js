/**
 * cdp.js — a minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
 *
 * Why not Playwright: this package only needs navigate / evaluate / screenshot /
 * addScriptOnNewDocument, and every one of those is a raw CDP domain call that
 * Playwright itself wraps. Taking the dependency would add ~300MB of Chromium to
 * the install and still leave the interesting part (deterministic time control)
 * to be done over CDP anyway. Node 22+ ships `WebSocket` and `fetch`, so the
 * whole client is ~150 lines with zero packages.
 *
 * The client is intentionally small and synchronous-looking: `send()` returns a
 * promise, every call has a timeout, and a dead socket rejects everything that
 * is still pending instead of leaving callers hanging forever.
 */

/** Raised for protocol-level failures we want callers to distinguish. */
export class CdpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CdpError';
    this.code = code ?? 'CDP_ERROR';
  }
}

/** Default per-call timeout. Screenshots and heavy evaluates get their own. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * One connection to one browser target.
 *
 * A target is either the browser endpoint (for `Target.*`) or a page endpoint
 * (for everything else). We keep them separate because mixing them is how you
 * end up screenshotting the wrong tab.
 */
export class CdpConnection {
  /**
   * @param {WebSocket} socket
   * @param {string} label used in error messages
   */
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.closeReason = null;

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new CdpError(`${entry.method}: ${message.error.message}`, message.error.code));
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners) {
          try {
            listener(message.method, message.params);
          } catch {
            /* a listener must never break the socket */
          }
        }
      }
    });

    socket.addEventListener('close', () => this.failAll('socket closed'));
    socket.addEventListener('error', () => this.failAll('socket error'));
  }

  /** Reject everything still waiting, so no caller can hang on a dead socket. */
  failAll(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError(`connection closed: ${reason}`, 'CDP_CLOSED'));
    }
    this.pending.clear();
  }

  /** Subscribe to protocol events. Returns an unsubscribe function. */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send one protocol command.
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?:number}} [options]
   */
  send(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new CdpError(`${method}: connection already closed`, 'CDP_CLOSED'));
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, 'CDP_TIMEOUT'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method}: ${error.message}`, 'CDP_SEND'));
      }
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * `awaitPromise` is always on: half the helpers we inject are async (image
   * decoding, animation settling), and a silent "returned a Promise object"
   * is a debugging nightmare.
   */
  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise !== false,
      userGesture: options.userGesture === true,
    }, { timeoutMs: options.timeoutMs });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'evaluation failed';
      throw new CdpError(detail.split('\n')[0].slice(0, 400), 'CDP_EVALUATE');
    }
    return result.result?.value;
  }

  /** Navigate and wait for the load event (or the timeout). */
  async navigate(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const loaded = new Promise((resolve) => {
      const off = this.onEvent((method) => {
        if (method === 'Page.loadEventFired') {
          off();
          resolve(true);
        }
      });
    });
    await this.send('Page.navigate', { url });
    const raced = await Promise.race([
      loaded,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return { loaded: raced === true };
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
    this.failAll('closed by caller');
  }
}

/**
 * Open a connection to a DevTools WebSocket endpoint.
 * @param {string} wsUrl
 * @param {string} [label]
 * @returns {Promise<CdpConnection>}
 */
export async function connect(wsUrl, label = 'cdp') {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpError(`${label}: connect timed out`, 'CDP_CONNECT_TIMEOUT')), 15_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CdpError(`${label}: cannot connect to ${wsUrl}`, 'CDP_CONNECT'));
    });
  });
  return new CdpConnection(socket, label);
}

/**
 * Poll the DevTools HTTP endpoint until it answers.
 * @param {number} port
 * @param {{timeoutMs?:number, host?:string}} [options]
 */
export async function waitForDevTools(port, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(120);
  }
  throw new CdpError(`DevTools endpoint on port ${port} never came up (${lastError})`, 'CDP_NO_ENDPOINT');
}

/** List page targets on a DevTools port. */
export async function listTargets(port, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const response = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new CdpError(`cannot list targets: HTTP ${response.status}`, 'CDP_LIST');
  return response.json();
}

/** Promise-based delay. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

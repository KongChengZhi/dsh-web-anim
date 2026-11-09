/**
 * page.js — open a URL into a controllable page and hand it to a handler.
 *
 * The ordering inside `openPage` is the single most important detail in this
 * plugin:
 *
 *   1. connect to the target and enable Page/Runtime;
 *   2. install the injection script for **new documents**;
 *   3. navigate;
 *   4. wait for load;
 *   5. give the page a settle beat;
 *   6. freeze.
 *
 * The injection must be installed before navigation, or the document that just
 * loaded never saw it and `requestAnimationFrame` is still the real one. Freezing
 * must happen after load, or the load itself stalls on a paused rAF (a page whose
 * first paint is driven by rAF never paints at all).
 */

import { resolveBrowser } from './browser.js';
import { delay } from './cdp.js';
import { buildInjectionScript, freezePage, primePage, probePage, unfreezePage } from './inject.js';

/**
 * Open `url` in a controllable page.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.width] viewport width, default 1280
 * @param {number} [options.height] viewport height, default 720
 * @param {number} [options.waitMs] settle time after load, default 300
 * @param {'auto'|'launch'|'attach'} [options.browser]
 * @param {boolean} [options.freeze] freeze the clock once loaded (default true)
 * @returns {Promise<{page:object, session:object, probe:object, release:Function}>}
 */
export async function openPage(options) {
  if (!options?.url || typeof options.url !== 'string') throw new Error('a page url is required');

  const session = await resolveBrowser({ strategy: options.browser ?? 'auto' });
  // One target per capture. Sharing a tab between concurrent captures means they
  // navigate over each other, which is what a multi-agent host triggers.
  const lease = await session.acquirePage();
  const page = lease.connection;

  const width = clampViewport(options.width, 1280);
  const height = clampViewport(options.height, 720);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Install the clock takeover for every document this target will create.
  const injection = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildInjectionScript(),
  });

  const navigation = await page.navigate(options.url, { timeoutMs: 30_000 });
  const settleMs = Number.isFinite(options.waitMs) ? Math.max(0, Number(options.waitMs)) : 300;
  await delay(settleMs);

  // Flush the callbacks the page queued on its first frame. Without this a page
  // whose setup is driven by rAF looks completely static: the callbacks are
  // sitting in our queue and are never run.
  let primed = 0;
  const preFreeze = await probePage(page);
  if (preFreeze.installed !== false) {
    primed = await primePage(page, 3).catch(() => 0);
    await delay(16);
  }

  let freezeInfo = { frozenAnimations: 0 };
  if (options.freeze !== false) {
    freezeInfo = await freezePage(page);
  }

  const late = preFreeze.installed === false ? null : await probePage(page).catch(() => null);
  const base = late ?? preFreeze;

  const probe = {
    ...base,
    loaded: navigation.loaded,
    url: base.url ?? options.url,
    viewport: base.viewport ?? { width, height, dpr: 1 },
    frozenAnimations: freezeInfo.frozenAnimations,
    primedCallbacks: primed,
    injectionInstalled: base.installed !== false,
  };

  if (probe.installed === false) {
    probe.reasons = [...(probe.reasons ?? []), 'falling back to wall-clock sampling'];
  }

  const release = async ({ unfreeze = true } = {}) => {
    try {
      if (unfreeze) await unfreezePage(page);
    } catch {
      /* page may already be gone */
    }
    try {
      await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
    } catch {
      /* target closed */
    }
    // Close the tab too: a capture that leaves one behind leaves it for the life of
    // the host process.
    try {
      await lease.release();
    } catch {
      /* already gone */
    }
  };

  return { page, session, probe, release };
}

/** Viewport bounds: below 200 a sheet cell is unreadable, above 3840 it is pointless. */
function clampViewport(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(3840, Math.max(200, number)));
}

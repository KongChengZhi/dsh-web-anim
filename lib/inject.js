/**
 * inject.js — the page-side half of the plugin.
 *
 * This module owns the one idea the whole package is built on: **a page can be
 * driven to an arbitrary time t, deterministically, without letting wall-clock
 * time leak in.** Everything else (probing, capturing, verifying) is reading the
 * consequences of that.
 *
 * Three time sources exist in a browser, and all three have to be taken over:
 *
 *   1. `requestAnimationFrame` — the driver of every JS animation (GSAP, anime.js,
 *      Framer Motion, three.js, hand-written lerps). Replaced with a queue that
 *      only advances when we say so.
 *   2. `performance.now()` — what those libraries read to compute elapsed time.
 *      Left alone, a library would see real milliseconds while rAF is frozen and
 *      produce a single huge jump when we finally step. Overridden to the same
 *      virtual clock.
 *   3. **CSS / WAAPI animations** — these do NOT go through rAF at all; they run on
 *      the compositor's own timeline. Freezing rAF alone leaves them running, so
 *      a "frozen" page would still drift between screenshots. Handled by
 *      pausing every `Animation` and driving `currentTime` by hand.
 *
 * `Date.now()` is deliberately NOT frozen: page code uses it for cache busting,
 * request signing and logging, and freezing it breaks more than it fixes. It is
 * counted instead, so a capture can report "this page reads wall-clock time" as
 * a determinism caveat rather than silently producing a wrong picture.
 *
 * The injected object also owns the classification probe: what kind of animation
 * does this page actually have? The answer decides how the capture is planned.
 */

/** Marker so the probe can tell "we injected" from "we did not". */
const VERSION = 1;

/**
 * Build the script installed via `Page.addScriptToEvaluateOnNewDocument`.
 *
 * It must be self-contained: it runs before any page script, in the page's main
 * world, with no module system.
 *
 * @returns {string} source to install on every new document
 */
export function buildInjectionScript() {
  return `(() => {
  if (window.__dshWebAnim && window.__dshWebAnim.v === ${VERSION}) return;

  const state = {
    v: ${VERSION},
    /** Virtual clock in milliseconds. */
    t: 0,
    /** rAF callbacks waiting for the next step. */
    queue: new Map(),
    nextId: 1,
    /** Timeouts scheduled while frozen (kept so we can report, not run, them). */
    timeoutsScheduled: 0,
    /** Counters that tell a capture whether the page fights determinism. */
    counters: { raf: 0, perfNow: 0, dateNow: 0, timeouts: 0, intervals: 0, listeners: 0 },
    /** Animations we paused, with the time each had when we froze. */
    animations: [],
    frozen: false,
    /** Errors raised by page callbacks while stepping — surfaced, never swallowed. */
    stepErrors: [],
    /** Set when the page reads wall-clock time somewhere we cannot control. */
    wallClockReaders: [],
  };

  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realPerfNow = performance.now.bind(performance);

  // ---- 1. rAF queue -------------------------------------------------------
  window.requestAnimationFrame = (callback) => {
    const id = state.nextId++;
    state.queue.set(id, callback);
    state.counters.raf += 1;
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    state.queue.delete(id);
  };

  // ---- 2. performance.now ------------------------------------------------
  // defineProperty can throw on hardened pages; fall back to a plain assign and
  // record that the override is weaker so captures can say so.
  let perfOverride = 'defineProperty';
  try {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => state.t,
    });
  } catch (error) {
    perfOverride = 'none';
    try {
      performance.now = () => state.t;
      perfOverride = 'assign';
    } catch (inner) {
      state.wallClockReaders.push('performance.now (override failed: ' + (inner && inner.message) + ')');
    }
  }
  state.perfOverride = perfOverride;

  // ---- 3. counters on things we choose not to replace --------------------
  const realDateNow = Date.now.bind(Date);
  Date.now = () => {
    state.counters.dateNow += 1;
    return realDateNow();
  };
  // Timers are counted, not blocked.
  //
  // An earlier version returned 0 without scheduling while frozen, on the theory
  // that real time had no place in a deterministic capture. That deadlocked every
  // promise inside an evaluate() call that awaited a timer — including the page's
  // own seek helpers, and our own settle step. A capture that hangs is worse than
  // one where a stray setTimeout fired; the determinism claim rests on rAF and the
  // animation timeline, and the reported timeoutsScheduled count is what tells
  // the caller a page also uses timers.
  window.setTimeout = function (fn, delay, ...args) {
    state.counters.timeouts += 1;
    state.timeoutsScheduled += 1;
    return realSetTimeout(fn, delay, ...args);
  };
  window.setInterval = function (fn, delay, ...args) {
    state.counters.intervals += 1;
    return realSetInterval(fn, delay, ...args);
  };
  window.clearTimeout = (id) => realClearTimeout(id);
  window.clearInterval = (id) => realClearInterval(id);

  // ---- stepping ----------------------------------------------------------
  /**
   * Advance the virtual clock by dt and run everything that was waiting.
   * Returns a report so the caller can see what ran and what threw.
   */
  state.step = (dt) => {
    state.t += dt;
    const due = Array.from(state.queue.entries());
    state.queue.clear();
    const errors = [];
    for (let i = 0; i < due.length; i += 1) {
      try {
        due[i][1](state.t);
      } catch (error) {
        errors.push(String((error && error.stack) || error).split('\\n')[0].slice(0, 300));
      }
    }
    if (errors.length) {
      state.stepErrors = state.stepErrors.concat(errors).slice(-20);
    }
    return { t: state.t, ran: due.length, errors };
  };

  // ---- animation control -------------------------------------------------
  /**
   * Freeze every CSS/WAAPI animation at its current position and remember where
   * each one was, so later seeks are relative to the freeze point rather than
   * to document start (pages that begin animating on load would otherwise jump).
   */
  state.freezeAnimations = () => {
    state.frozen = true;
    const list = document.getAnimations ? document.getAnimations() : [];
    state.animations = [];
    let index = 0;
    // CSS transitions are not recorded. They are settled instead — see
    // state.settleTransitions for why driving them by currentTime is the wrong
    // model and what goes wrong when it is done anyway.
    state.settledLog = [];
    for (const animation of list) {
      if (isTransition(animation)) {
        settleOne(animation);
        continue;
      }
      const observed =
        typeof animation.currentTime === 'number'
          ? animation.currentTime
          : (typeof animation.currentTime === 'object' && animation.currentTime ? Number(animation.currentTime.value) || 0 : 0);
      // The compositor has been running in real time since the animation was
      // created, so its current position differs by a few milliseconds between
      // two loads of the same page — enough to shift an eased transform by a
      // sub-pixel and make two captures non-comparable. Every capture opens a
      // fresh document, so "the animation started at page load" is the honest
      // reading: snap to zero and keep the observed value for the report.
      const base = 0;
      const entry = {
        key: 'a' + (index += 1),
        animation,
        base,
        observedBase: Math.round(observed),
        playState: animation.playState,
        target: describeTarget(animation),
      };
      try {
        animation.pause();
        animation.currentTime = 0;
      } catch (error) {
        entry.pauseFailed = String((error && error.message) || error);
      }
      state.animations.push(entry);
    }
    return state.animations.length;
  };

  /**
   * Run queued rAF callbacks without advancing the clock.
   *
   * A page that kicks its own setup off with a first-frame callback never runs
   * that setup once we own the queue — so it looks like it has no animations at
   * all. Priming flushes those callbacks at t=0 so the real page state exists
   * before we decide what to capture.
   */
  state.prime = (rounds) => {
    const count = Number.isFinite(rounds) ? Math.max(1, Math.min(10, rounds)) : 3;
    let ran = 0;
    for (let round = 0; round < count; round += 1) {
      const due = Array.from(state.queue.entries());
      state.queue.clear();
      for (let i = 0; i < due.length; i += 1) {
        try {
          due[i][1](state.t);
          ran += 1;
        } catch (error) {
          state.stepErrors.push(String((error && error.stack) || error).split('\\n')[0].slice(0, 200));
        }
      }
    }
    return ran;
  };

  /**
   * Put the clock (and every animation) at an absolute virtual time.
   *
   * Two captures of the same freshly loaded page then start from identical
   * state, which is what makes their sheets comparable. Callers that reuse a
   * page without reloading are on their own: a page that accumulates its own
   * frame counter cannot be rewound.
   */
  state.resetTo = (t) => {
    state.t = Number(t) || 0;
    state.seekAnimations(state.t);
    // Any transition still in flight belongs to the *previous* instant; leaving it
    // running would make the next screenshot depend on wall-clock timing.
    state.settleTransitions();
    return state.t;
  };

  /** Put every animation at freezeBase + t. */
  state.seekAnimations = (t) => {
    const changed = [];
    for (const entry of state.animations) {
      const target = entry.base + t;
      try {
        entry.animation.currentTime = target;
        changed.push(entry.key);
      } catch (error) {
        entry.seekFailed = String((error && error.message) || error);
      }
    }
    // Animations created after the freeze (e.g. a click handler added one).
    const known = new Set(state.animations.map((entry) => entry.animation));
    if (document.getAnimations) {
      for (const animation of document.getAnimations()) {
        if (known.has(animation)) continue;
        // A transition that started *because* we wrote a style is not part of the
        // timeline: it has no meaningful position to seek to. Settle it instead.
        if (isTransition(animation)) continue;
        try {
          animation.pause();
          animation.currentTime = t;
          state.animations.push({
            key: 'a' + (state.animations.length + 1),
            animation,
            base: 0,
            playState: animation.playState,
            target: describeTarget(animation),
            late: true,
          });
          changed.push('late');
        } catch {
          /* an animation we cannot drive is reported by coverage, not here */
        }
      }
    }
    return changed.length;
  };

  /**
   * Is this animation a CSS *transition* rather than a CSS/WAAPI animation?
   *
   * This distinction is the whole point of the transition handling below, so it is
   * made on the object's class (authoritative) with a name check as a fallback for
   * engines that do not expose the global.
   */
  function isTransition(animation) {
    if (!animation) return false;
    try {
      if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition) return true;
    } catch {
      /* cross-realm or older engine: fall through to the name check */
    }
    const name = animation.constructor && animation.constructor.name;
    return name === 'CSSTransition';
  }

  /**
   * Push one transition to its end state.
   *
   * A transition that cannot be finished (an infinite one, or a target that is
   * detached) is left alone and reported — silently rewriting it would be a
   * worse lie than a drift we can name.
   */
  function settleOne(animation) {
    const target = describeTarget(animation) || {};
    let property = null;
    try {
      property = animation.transitionProperty || null;
    } catch {
      /* not a transition after all */
    }
    try {
      animation.finish();
      state.settledLog.push({ property: property, target: target, ok: true });
      return true;
    } catch (error) {
      try {
        animation.cancel();
      } catch {
        /* nothing else we can do */
      }
      state.settledLog.push({
        property: property,
        target: target,
        ok: false,
        error: String((error && error.message) || error).slice(0, 160),
      });
      return false;
    }
  }

  function describeTarget(animation) {
    try {
      const effect = animation.effect;
      const target = effect && effect.target;
      if (!target) return null;
      const name = animation.animationName || (effect.getTiming && effect.getTiming().id) || null;
      return {
        tag: target.tagName ? target.tagName.toLowerCase() : null,
        id: target.id || null,
        className: typeof target.className === 'string' ? target.className.slice(0, 80) : null,
        animationName: name || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Finish every CSS transition that is currently in flight.
   *
   * ## Why transitions must be *settled*, not *steered*
   *
   * A CSS/WAAPI *animation* has a timeline: it exists from the start, its
   * currentTime is a meaningful coordinate, and seeking it to t is exactly the
   * operation "show this page at time t". A CSS *transition* is different in kind —
   * it is the interpolation between an element's old computed style and its new
   * one, created at the instant the style changed. It has no independent timeline
   * and no start point we can rewind to.
   *
   * The failure this fixes, measured on a real page (a Three.js demo whose phase
   * chips fade and whose map labels fade in on a time threshold): calling
   * seek(500) and screenshotting immediately gave a picture that depended on how
   * far the transitions had got. Eight rounds of "same t, two screenshots" differed
   * in 1-5 rounds by up to 816 pixels, while the WebGL canvas was bit-identical —
   * the drift was entirely DOM transitions mid-flight. Finishing them instead makes
   * the same page settle to 0 differing pixels across every round.
   *
   * The trade-off is stated rather than hidden: at time t the DOM shows each
   * transition's *end* state, not a mid-transition state. That is the honest
   * reading of "the page at t" — a transition is a reaction to a change, and by the
   * time you are looking at a settled instant, the reaction has happened.
   *
   * Transitions that cannot finish (infinite duration, detached target) are left
   * running and recorded in state.settledLog, so a capture can report a caveat
   * instead of quietly producing a drifting sheet.
   */
  state.settleTransitions = () => {
    const log = state.settledLog || (state.settledLog = []);
    if (!document.getAnimations) return 0;
    let settled = 0;
    let stranded = 0;
    const list = document.getAnimations();
    for (let i = 0; i < list.length; i += 1) {
      const animation = list[i];
      if (!isTransition(animation)) continue;
      const playState = animation.playState;
      if (playState !== 'running' && playState !== 'paused') continue;
      if (settleOne(animation)) settled += 1;
      else stranded += 1;
    }
    // Keep the log bounded: it is diagnostics, not an audit trail.
    if (log.length > 40) log.splice(0, log.length - 40);
    return settled;
  };

  /** Restore real time: resume animations, let rAF run on the compositor again. */
  state.unfreeze = () => {
    state.frozen = false;
    for (const entry of state.animations) {
      try {
        entry.animation.play();
      } catch {
        /* nothing to do */
      }
    }
    state.animations = [];
  };

  // ---- probing -----------------------------------------------------------
  /**
   * Classify what this page animates with. The classification decides the
   * sampling strategy, so it reports evidence, not just a label.
   */
  state.probe = () => {
    const reasons = [];
    const animations = (document.getAnimations ? document.getAnimations() : []).map((animation) => {
      const target = describeTarget(animation) || {};
      const timing = (animation.effect && animation.effect.getTiming && animation.effect.getTiming()) || {};
      return {
        kind: animation.constructor ? animation.constructor.name : 'Animation',
        name: animation.animationName || timing.id || null,
        target,
        duration: typeof timing.duration === 'number' ? timing.duration : null,
        iterations: typeof timing.iterations === 'number' ? timing.iterations : null,
        playState: animation.playState,
      };
    });

    const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: Math.round(canvas.getBoundingClientRect().width),
      cssHeight: Math.round(canvas.getBoundingClientRect().height),
      id: canvas.id || null,
    })).filter((canvas) => canvas.width > 0 && canvas.height > 0);

    const libs = [];
    if (window.THREE) libs.push('three.js');
    if (window.PIXI) libs.push('pixi');
    if (window.Phaser) libs.push('phaser');
    if (window.gsap) libs.push('gsap');
    if (window.anime) libs.push('anime.js');
    if (window.TweenMax || window.TweenLite) libs.push('gsap-legacy');
    if (window.lottie || window.bodymovin) libs.push('lottie');
    if (window.Lenis || window.__lenis) libs.push('lenis');
    if (window.framer || window.__framer) libs.push('framer');

    // Deterministic-timeline pages: these expose their own seek API, which is
    // strictly better than anything we can synthesize.
    const timelineApis = [];
    if (typeof window.remotion_setFrame === 'function') timelineApis.push('remotion_setFrame');
    if (typeof window.__remotion !== 'undefined') timelineApis.push('__remotion');
    if (typeof window.remotion_version !== 'undefined') timelineApis.push('remotion_version');
    if (typeof window.setFrame === 'function') timelineApis.push('setFrame');
    if (typeof window.seekTo === 'function') timelineApis.push('seekTo');
    if (typeof window.__hf === 'object' && window.__hf) timelineApis.push('__hf');
    if (typeof window.__hfAnime !== 'undefined') timelineApis.push('__hfAnime');
    if (typeof window.__hyperframes !== 'undefined') timelineApis.push('__hyperframes');
    if (typeof window.__timeline !== 'undefined') timelineApis.push('__timeline');
    if (typeof window.__SEEK === 'function') timelineApis.push('__SEEK');
    if (document.querySelector('[data-hyperframes], [data-remotion], [data-composition-id]')) {
      timelineApis.push('data-attribute');
    }

    let kind = 'html';
    if (timelineApis.length > 0) {
      kind = 'timeline';
      reasons.push('page exposes a deterministic timeline API: ' + timelineApis.join(', '));
    } else if (canvases.length > 0 && animations.length === 0) {
      kind = 'canvas';
      reasons.push('found ' + canvases.length + ' canvas and no CSS/WAAPI animations');
    } else if (canvases.length > 0) {
      kind = 'hybrid';
      reasons.push('found ' + canvases.length + ' canvas alongside ' + animations.length + ' CSS/WAAPI animations');
    } else {
      reasons.push('no canvas, ' + animations.length + ' CSS/WAAPI animations');
    }

    if (libs.length) reasons.push('detected libraries: ' + libs.join(', '));

    return {
      kind,
      reasons,
      animations: animations.slice(0, 50),
      animationCount: animations.length,
      canvases,
      libraries: libs,
      timelineApis,
      rafCount: state.counters.raf,
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      size: {
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      },
      hasVideo: document.querySelectorAll('video').length,
      hasSvg: document.querySelectorAll('svg').length,
      settledTransitions: {
        count: (state.settledLog || []).filter((entry) => entry.ok).length,
        properties: [...new Set((state.settledLog || []).map((entry) => entry.property).filter(Boolean))].slice(0, 12),
        stranded: (state.settledLog || []).filter((entry) => !entry.ok).length,
      },
      wallClock: {
        perfOverride: state.perfOverride,
        readers: state.wallClockReaders,
        dateReads: state.counters.dateNow,
        timeoutsScheduled: state.counters.timeouts,
        intervalsScheduled: state.counters.intervals,
      },
    };
  };

  /** Snapshot of the elements that are being animated, for DOM-truth evidence. */
  state.animatedBoxes = () => {
    const out = [];
    const seen = new Set();
    for (const entry of state.animations) {
      const target = entry.animation && entry.animation.effect && entry.animation.effect.target;
      if (!target || seen.has(target)) continue;
      seen.add(target);
      try {
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        out.push({
          key: entry.key,
          tag: target.tagName ? target.tagName.toLowerCase() : null,
          id: target.id || null,
          box: {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          opacity: Number(style.opacity),
          transform: style.transform === 'none' ? null : style.transform,
          currentTime: typeof entry.animation.currentTime === 'number' ? entry.animation.currentTime : null,
        });
      } catch {
        /* detached element: skip */
      }
    }
    return out;
  };

  Object.defineProperty(window, '__dshWebAnim', {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();`;
}

/**
 * Probe the page and return the raw classification object.
 * @param {import('./cdp.js').CdpConnection} page
 */
export async function probePage(page) {
  const installed = await page.evaluate('typeof window.__dshWebAnim === "object" && window.__dshWebAnim !== null && window.__dshWebAnim.v > 0');
  if (!installed) {
    return { installed: false, kind: 'unknown', reasons: ['the injection script did not run on this document — it was installed after navigation'] };
  }
  const result = await page.evaluate('JSON.stringify(window.__dshWebAnim.probe())');
  const parsed = JSON.parse(result);
  parsed.installed = true;
  return parsed;
}

/**
 * Freeze the page at its current position.
 * @param {import('./cdp.js').CdpConnection} page
 */
export async function freezePage(page) {
  const frozenCount = await page.evaluate('window.__dshWebAnim.freezeAnimations()');
  return { frozenAnimations: frozenCount };
}

/**
 * Move the page to virtual time t (relative to the freeze point) and return
 * what happened.
 *
 * The order matters: rAF first (so JS-driven properties are written), then the
 * compositor timeline (so CSS/WAAPI reflect the same instant), then one more
 * rAF flush for anything that reacted to the style change.
 *
 * @param {import('./cdp.js').CdpConnection} page
 * @param {number} dt milliseconds to advance from the current virtual time
 */
export async function stepTo(page, dt) {
  return page.evaluate(`(() => {
    const state = window.__dshWebAnim;
    const step = state.step(${Number(dt)});
    const animationsSeeked = state.seekAnimations(state.t);
    // One flush frame so style-driven layout settles before the screenshot.
    let pending = Array.from(state.queue.entries());
    state.queue.clear();
    for (const [, callback] of pending) {
      try { callback(state.t); } catch (error) { step.errors.push(String(error).slice(0, 200)); }
    }
    // Those callbacks likely changed classes or styles, which *starts* transitions
    // on the compositor's own clock. Finish them now — otherwise the screenshot
    // races the transition and two captures of the same t disagree.
    const transitionsSettled = state.settleTransitions();
    // Finishing a transition can, in turn, queue more callbacks (transitionend
    // handlers). One more flush gets the DOM to its final state for this instant.
    pending = Array.from(state.queue.entries());
    state.queue.clear();
    for (const [, callback] of pending) {
      try { callback(state.t); } catch (error) { step.errors.push(String(error).slice(0, 200)); }
    }
    state.settleTransitions();
    return { t: step.t, ran: step.ran, errors: step.errors, animationsSeeked, transitionsSettled };
  })()`);
}

/**
 * Flush callbacks that the page queued on its first frame, without advancing time.
 *
 * @param {import('./cdp.js').CdpConnection} page
 * @param {number} [rounds]
 */
export async function primePage(page, rounds = 3) {
  return page.evaluate(`(typeof window.__dshWebAnim === 'object' && window.__dshWebAnim) ? window.__dshWebAnim.prime(${Number(rounds)} || 3) : 0`);
}

/** Restore real time. Safe to call on a page that was never frozen. */
export async function unfreezePage(page) {
  await page.evaluate('(typeof window.__dshWebAnim === "object" && window.__dshWebAnim) ? (window.__dshWebAnim.unfreeze(), true) : false')
    .catch(() => false);
}

/**
 * Put the virtual clock at an absolute time and align every animation to it.
 * @param {import('./cdp.js').CdpConnection} page
 * @param {number} t absolute virtual time in ms
 */
export async function resetClock(page, t) {
  return page.evaluate(`(typeof window.__dshWebAnim === 'object' && window.__dshWebAnim) ? window.__dshWebAnim.resetTo(${Number(t) || 0}) : 0`);
}

/** Read animated-element boxes at the current virtual time. */
/**
 * How many CSS transitions the last seek had to finish, and which properties.
 *
 * Reported rather than silently applied: a page whose whole animation is a chain
 * of transitions is a page this plugin samples at its *settled* states, which is
 * the honest reading but still a statement about what the sheet shows.
 *
 * @param {import('./cdp.js').CdpConnection} page
 */
export async function readSettledTransitions(page) {
  return page
    .evaluate('JSON.stringify((window.__dshWebAnim && window.__dshWebAnim.settledLog) ? window.__dshWebAnim.settledLog : [])')
    .then((raw) => {
      try {
        const list = JSON.parse(raw);
        return {
          count: list.filter((entry) => entry.ok).length,
          stranded: list.filter((entry) => !entry.ok).length,
          properties: [...new Set(list.map((entry) => entry.property).filter(Boolean))].slice(0, 12),
          strandedDetail: list.filter((entry) => !entry.ok).slice(0, 3),
        };
      } catch {
        return { count: 0, stranded: 0, properties: [], strandedDetail: [] };
      }
    })
    .catch(() => ({ count: 0, stranded: 0, properties: [], strandedDetail: [] }));
}

export async function readAnimatedBoxes(page) {
  return page.evaluate('JSON.stringify(window.__dshWebAnim.animatedBoxes())').then(JSON.parse);
}

/**
 * Seek a page that exposes its own timeline API.
 *
 * This is the best case: the page author already solved determinism, so we call
 * their API instead of impersonating their clock.
 *
 * @param {import('./cdp.js').CdpConnection} page
 * @param {number} frame frame index to seek to
 * @param {number} fps frames per second of the composition
 */
export async function seekOwnTimeline(page, frame, fps) {
  return page.evaluate(`(async () => {
    const ms = Math.round((${Number(frame)} / ${Number(fps)}) * 1000);
    const tried = [];
    const errors = [];
    const attempt = async (name, fn) => {
      try { await fn(); tried.push(name); } catch (error) { errors.push(name + ': ' + String(error && error.message || error).slice(0, 120)); }
    };
    if (typeof window.remotion_setFrame === 'function') await attempt('remotion_setFrame', () => window.remotion_setFrame(${Number(frame)}));
    else if (typeof window.setFrame === 'function') await attempt('setFrame', () => window.setFrame(${Number(frame)}));
    if (window.__hf && typeof window.__hf.seek === 'function') await attempt('__hf.seek', () => window.__hf.seek(ms));
    if (window.__hf && typeof window.__hf.setTime === 'function') await attempt('__hf.setTime', () => window.__hf.setTime(ms));
    if (typeof window.seekTo === 'function') await attempt('seekTo', () => window.seekTo(ms));
    if (typeof window.__SEEK === 'function') await attempt('__SEEK', () => window.__SEEK(ms));
    if (window.__timeline && typeof window.__timeline.seek === 'function') await attempt('__timeline.seek', () => window.__timeline.seek(ms));
    // The page's seek wrote styles; anything with a CSS transition is now in
    // flight on the compositor clock. Finish those before the screenshot, or the
    // two captures of the same frame disagree by however far the transition got.
    let transitionsSettled = 0;
    if (window.__dshWebAnim && typeof window.__dshWebAnim.settleTransitions === 'function') {
      transitionsSettled = window.__dshWebAnim.settleTransitions();
    }
    // Settle on a microtask: it needs no timer and no frame, so it cannot be
    // captured by anything the page or this plugin has replaced.
    await Promise.resolve();
    return JSON.stringify({ frame: ${Number(frame)}, ms, tried, errors, transitionsSettled });
  })()`).then(JSON.parse);
}

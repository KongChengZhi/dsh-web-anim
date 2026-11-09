/**
 * classify.test.mjs — the auto-classification the design promises.
 *
 * The plugin claims it can tell the three kinds of page apart and pick the right
 * sampling strategy for each. That claim is exactly the sort of thing that rots,
 * so each fixture exists to prove one branch: HTML/CSS animation (virtual clock),
 * Canvas (pixels only), and a page that owns its timeline (seek API).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-classify-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { openPage } = await import('../lib/page.js');
const { planCapture, runCapture } = await import('../lib/capture.js');
const { closeBrowser } = await import('../lib/browser.js');

const here = dirname(fileURLToPath(import.meta.url));
const url = (name) => 'file:///' + join(here, '..', 'fixtures', name).replace(/\\/g, '/');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

async function inspect(file, options = {}) {
  const opened = await openPage({ url: url(file), width: 900, height: 520, waitMs: 300 });
  try {
    const plan = planCapture(opened.probe, options);
    const captured = await runCapture({ page: opened.page, probe: opened.probe, plan, label: file });
    return { probe: opened.probe, plan, captured };
  } finally {
    await opened.release({ unfreeze: true });
  }
}

try {
  console.log('classification');

  // --- HTML/CSS animation ---------------------------------------------------
  {
    const { probe, plan } = await inspect('animation.html', { frames: 6 });
    check('css page classified as html', probe.kind === 'html', probe.kind);
    check('css page uses the virtual clock', plan.mode === 'virtual', plan.mode);
    check('css page found its animation', probe.animationCount >= 1, String(probe.animationCount));
    check('css page is deterministic', plan.deterministic === true);
  }

  // --- Canvas ---------------------------------------------------------------
  {
    const { probe, plan, captured } = await inspect('canvas.html', { frames: 6 });
    check('canvas page classified as canvas', probe.kind === 'canvas', probe.kind);
    check('canvas page reports its canvas', probe.canvases.length >= 1, JSON.stringify(probe.canvases));
    check('canvas page explains why it is canvas', probe.reasons.some((r) => r.includes('canvas')), JSON.stringify(probe.reasons));
    const moved = captured.meta.diff.filter((entry) => entry.changedRatio > 0.0005).length;
    check('canvas capture still shows motion', moved >= 2, `${moved} transitions moved`);
  }

  // --- Own-timeline page ----------------------------------------------------
  {
    const { probe, plan } = await inspect('timeline.html', { from: 0, to: 2000, frames: 8 });
    check('timeline page classified as timeline', probe.kind === 'timeline', probe.kind);
    check('timeline page reports its seek api', probe.timelineApis.includes('seekTo'), JSON.stringify(probe.timelineApis));
    check('timeline page uses the timeline mode', plan.mode === 'timeline', plan.mode);
    check('timeline mode is deterministic', plan.deterministic === true);
  }
} finally {
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'classification passed' : `classification failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

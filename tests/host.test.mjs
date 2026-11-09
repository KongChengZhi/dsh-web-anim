/**
 * host.mjs — boot the plugin the way the host does, without booting the host.
 *
 * The unit tests call handlers directly. This one goes through `apply()` with a
 * context shaped like cordis', so it exercises the registration path, the
 * optional-service probing and the render pipeline exactly as installed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-host-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const plugin = await import('../lib/index.js');
const { closeBrowser } = await import('../lib/browser.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = 'file:///' + join(here, '..', 'fixtures', 'animation.html').replace(/\\/g, '/');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

/**
 * A minimal stand-in for the host's attachment service.
 *
 * The real `saveImage` reads `this.compression`, so calling it detached from its
 * service throws. Modelling that is the whole point: it is the exact failure a
 * plugin hits when it does `const { saveImage } = ctx.attachments`.
 */
function fakeAttachments() {
  const stored = [];
  const service = {
    stored,
    async saveImage(input) {
      if (this !== service) throw new Error('saveImage called without its service as receiver');
      if (!Buffer.isBuffer(input.data) || input.data.length === 0) throw new Error('empty image data');
      if (input.mediaType !== 'image/png') throw new Error('unexpected media type: ' + input.mediaType);
      const ref = { attachmentId: 'sha256:' + stored.length, mediaType: 'image/png', bytes: input.data.length, name: input.name };
      stored.push(ref);
      return ref;
    },
  };
  return service;
}

console.log('host integration');

const attachments = fakeAttachments();
const sections = [];
const registered = new Map();
const services = {
  attachments,
  systemPrompt: {
    section(spec) {
      sections.push(spec);
      return () => sections.pop();
    },
  },
};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  get(name) {
    return services[name];
  },
};

const dispose = await plugin.apply(ctx);
try {
  check('all five tools registered through apply', registered.size === 5, JSON.stringify([...registered.keys()]));

  const capture = registered.get('web_anim_capture');
  const result = await capture.execute({ url: fixture, width: 900, height: 520, from: 0, to: 600, frames: 6 }, {});

  check('capture succeeded', result.ok === true);
  check('capture produced one image', result.images.length === 1, String(result.images.length));
  check('the host attachment service stored it', attachments.stored.length === 1, String(attachments.stored.length));
  check('the sheet was a PNG of plausible size', (attachments.stored[0]?.bytes ?? 0) > 1000, String(attachments.stored[0]?.bytes));
  if (!result.images.length) console.log('       warnings:', JSON.stringify(result.warnings));

  // Render exactly as the host does, and confirm the image block is well formed.
  const blocks = capture.output.render({}, result);
  check('render emits a text block first', blocks[0].type === 'text' && blocks[0].text.length > 40);
  const imageBlock = blocks.find((block) => block.type === 'image');
  check('render emits an image block with an attachment ref', imageBlock !== undefined && imageBlock.attachment === attachments.stored[0]);

  const text = blocks[0].text;
  check('result text carries the store reminder', text.includes('store:') && text.includes('web_anim_gc'), text.slice(-160));
  check('result text cites cells', text.includes('#1') && text.includes('ms'));

  const reminder = sections[0];
  // The text is a fixed string: live numbers in the system prompt would rewrite the
  // head of every request and invalidate the prefix cache from token 0.
  check('the standing reminder is present', typeof reminder.text === 'string' && reminder.text.length > 40, typeof reminder.text);
  check('the reminder names the release call', reminder.text.includes('web_anim_gc'), reminder.text.slice(0, 80));
  check('the reminder carries no live numbers', !/\d+(\.\d+)?\s?(MB|KB|%)/.test(reminder.text));

  const gc = registered.get('web_anim_gc');
  const status = await gc.execute({ action: 'status' }, {});
  check('gc sees the capture', status.text.includes(result.captureId));

  const cleared = await gc.execute({ action: 'clear', confirm: 'yes' }, {});
  check('clear with confirmation works', cleared.ok === true && cleared.freed > 0, JSON.stringify(cleared.freed));
} finally {
  dispose();
  await closeBrowser();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'host integration passed' : `host integration failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

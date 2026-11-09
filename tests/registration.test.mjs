/**
 * registration.test.mjs — prove the plugin registers without a host.
 *
 * The failure this guards against is the one that has actually bitten plugins:
 * `apply` throws (or hangs) because a host package or service is absent, and the
 * user sees "the plugin is installed but nothing works". A fake cordis context
 * with only `tools` mounted is the smallest thing that reproduces it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the artifact store at a throwaway directory before importing anything that
// reads it: the "empty store" assertions below are about the plugin's behaviour,
// not about whatever the developer happens to have captured locally.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-anim-reg-'));
process.env.DSH_WEB_ANIM_DIR = sandbox;

const { apply, inject, name } = await import('../lib/index.js');
const { compatDefineTool, parametersToJsonSchema } = await import('../lib/define-tool.js');
process.on('exit', () => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
};

function fakeContext(services = {}) {
  const registered = [];
  const sections = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {
          const index = registered.indexOf(tool);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    get(name) {
      return services[name] ?? undefined;
    },
    ...services,
  };
  return { ctx, registered, sections };
}

console.log('registration');

check('plugin declares only the tools dependency', Array.isArray(inject) && inject.length === 1 && inject[0] === 'tools', JSON.stringify(inject));
check('plugin has a name', name === 'dsh-web-anim');

// --- minimal host: tools only, no attachments, no systemPrompt -----------------
{
  const { ctx, registered } = fakeContext();
  const dispose = await apply(ctx);
  check('apply returns a disposer', typeof dispose === 'function');
  const names = registered.map((tool) => tool.name).sort();
  check('registers five tools', names.length === 5, JSON.stringify(names));
  check('capture is registered', names.includes('web_anim_capture'));
  check('zoom is registered', names.includes('web_anim_zoom'));
  check('probe is registered', names.includes('web_anim_probe'));
  check('gc is registered', names.includes('web_anim_gc'));
  check('help is registered', names.includes('web_anim_help'));

  const help = registered.find((tool) => tool.name === 'web_anim_help');
  check('help returns text without a browser', typeof (await help.execute({}, {})).text === 'string');

  const gc = registered.find((tool) => tool.name === 'web_anim_gc');
  const status = await gc.execute({ action: 'status' }, {});
  check('gc status works without a browser', status.ok === true && typeof status.text === 'string');

  dispose();
  check('dispose unregisters everything', registered.length === 0, String(registered.length));
}

// --- host with a systemPrompt service ---------------------------------------
{
  const sections = [];
  const { ctx } = fakeContext({
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => sections.pop();
      },
    },
  });
  const dispose = await apply(ctx);
  check('registers a storage reminder section', sections.length === 1, String(sections.length));
  const spec = sections[0];
  // The text is a CONSTANT on purpose: a system prompt whose head changes on every
  // step invalidates the prefix cache from the very first token. Live numbers belong
  // in tool results, which are appended rather than rewritten.
  check('reminder text is a constant string (cache-safe)', typeof spec.text === 'string' && spec.text.length > 40);
  check('reminder text does not embed live numbers', !/\d+(\.\d+)?\s?(MB|KB|capture\(s\)|%)/.test(spec.text), spec.text.slice(0, 120));
  check('reminder explains where the numbers live', spec.text.includes('tool result'));
  check('reminder names the gc tool', spec.text.includes('web_anim_gc'));
  dispose();
  check('dispose removes the section', sections.length === 0, String(sections.length));
}

// --- a host where registration itself throws --------------------------------
{
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register() { throw new Error('registry boom'); } },
    get() { return undefined; },
  };
  const dispose = await apply(ctx);
  check('a throwing registry does not crash apply', typeof dispose === 'function');
}

// --- schema compilation ------------------------------------------------------
{
  const schema = parametersToJsonSchema({
    url: { type: 'string', required: true, description: 'x' },
    frames: { type: 'integer' },
    mode: { type: 'string', enum: ['a', 'b'] },
  });
  check('required lifts to the parent', Array.isArray(schema.required) && schema.required.includes('url'));
  check('required is removed from the property', !('required' in schema.properties.url));
  check('enums survive compilation', Array.isArray(schema.properties.mode.enum));

  const tool = compatDefineTool({
    name: 'demo',
    description: 'd',
    parameters: { a: { type: 'string' } },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  });
  check('compat defineTool builds a registrable definition', tool.name === 'demo' && tool.parameters.type === 'object');
}

console.log('');
console.log(failures === 0 ? 'registration passed' : `registration failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * define-tool.js — a local stand-in for the host's `defineTool`.
 *
 * The real thing lives in `@deepseek-ai/dsh-tools`, which is bundled inside the
 * host's app.asar. A plugin directory usually cannot resolve it, and a failed
 * dynamic import inside `apply` means **no tools register at all**, silently.
 *
 * This copy reproduces the author-spec -> JSON Schema compilation rules that the
 * host applies (`property-map`: `required: true` lifts to the parent's required
 * array and is removed from the property; `type: 'json'` degrades to an
 * annotation; `properties` and `items` recurse). What it does not reproduce is the
 * host's runtime argument validation — a wrong argument will reach the handler
 * and be handled by its own defaults instead of raising `ToolArgsError`.
 *
 * Preference order at load time is: real package, then `DSH_TOOLS_PATH`, then this.
 */

const AUTHOR_ONLY_JSON = 'json';

/** Compile one property map into `{ properties, required? }`. */
function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${path} must be an object mapping names to value schemas`);
  }
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${path}.${key} must be a value schema object`);
    }
    const { required: mark, ...rest } = spec;
    if (mark !== undefined && mark !== true) throw new Error(`${path}.${key}.required may only be true`);
    if (mark === true) required.push(key);
    properties[key] = compileValue(rest, `${path}.${key}`);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** Compile one value schema; `type: 'json'` becomes an annotation-only node. */
function compileValue(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} must be a value schema object`);
  }
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue;
    if (key === 'properties') {
      const compiled = compilePropertyMap(value, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required) out.required = compiled.required;
      continue;
    }
    if (key === 'items') {
      out.items = compileValue(value, `${path}.items`);
      continue;
    }
    if (key === 'type' && value === AUTHOR_ONLY_JSON) continue;
    out[key] = value;
  }
  return out;
}

/** Compile an author `parameters` map into JSON Schema. */
export function parametersToJsonSchema(spec) {
  const { properties, required } = compilePropertyMap(spec, 'parameters');
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

/** Compile an author `output.schema`. */
export function outputSchemaToJsonSchema(spec) {
  return compileValue(spec, 'schema');
}

/**
 * The compatible `defineTool`. Same signature and same return shape as the host's,
 * minus runtime validation.
 */
export function compatDefineTool(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options must be an object');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || name.length === 0) throw new Error('defineTool: name must be a non-empty string');
  if (!output || typeof output !== 'object') throw new Error(`defineTool(${name}): missing output`);
  if (typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render must be a function`);
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute must be a function`);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${name}): timeoutMs must be positive`);
  }

  const tool = {
    name,
    description,
    parameters: parametersToJsonSchema(parameters ?? {}),
    output: {
      schema: outputSchemaToJsonSchema(output.schema ?? {}),
      render: output.render,
    },
    async execute(args, exec) {
      return execute(args, exec);
    },
  };
  if (options.deferLoading === true) tool.deferLoading = true;
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  if (typeof options.projectContent === 'function') tool.projectContent = options.projectContent;
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = options.finalizeContent;
  if (typeof options.presentCall === 'function') tool.presentCall = options.presentCall;
  if (typeof options.presentResult === 'function') tool.presentResult = options.presentResult;
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = options.isConcurrencySafe;
  return tool;
}

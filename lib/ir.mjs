/* IR 0.1.0 validation per the IR format + the IR format (additive fields).
 * Readable diagnostics, exit-code-1 friendly: callers print `error: <message>`. */

import fs from 'node:fs';

const STATE_TYPES = new Set(['int', 'bool', 'string', 'list']);
const A11Y_ROLES = new Set(['button', 'text', 'image', 'checkbox', 'slider', 'heading', 'none']);
const EVENT_OPS = new Set(['set', 'add', 'sub', 'mul', 'div', 'backspace', 'toggle', 'append', 'removeAt', 'assign']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const A11Y_ROLE_VALUES = [...A11Y_ROLES];

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

export function parseIr(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error.message}`);
  }
  validateIr(data);
  return data;
}

export function loadIr(irPath) {
  if (typeof irPath !== 'string' || irPath === '') {
    fail('IR path must be a non-empty string');
  }
  let text;
  try {
    text = fs.readFileSync(irPath, 'utf8');
  } catch (error) {
    fail(`cannot read IR file ${JSON.stringify(irPath)}: ${error.message}`);
  }
  return parseIr(text);
}

export function stateMap(ir) {
  return new Map(ir.state.map((decl) => [decl.name, decl]));
}

export function validateIr(data) {
  if (!isPlain(data)) fail('IR root must be a JSON object');
  if (data.ir !== '0.1.0') fail(`unsupported ir version ${JSON.stringify(data.ir)}; expected "0.1.0"`);
  if (typeof data.app !== 'string' || data.app === '') fail('app must be a non-empty string');

  if (!Array.isArray(data.state)) fail('state must be an array');
  const decls = new Map();
  data.state.forEach((decl, index) => {
    const where = `state[${index}]`;
    if (!isPlain(decl)) fail(`${where} must be an object`);
    if (typeof decl.name !== 'string' || !IDENT.test(decl.name)) {
      fail(`${where}: name ${JSON.stringify(decl.name)} is not an identifier`);
    }
    if (decls.has(decl.name)) fail(`${where}: duplicate state name ${JSON.stringify(decl.name)}`);
    if (!STATE_TYPES.has(decl.type)) {
      fail(`${where}: unknown type ${JSON.stringify(decl.type)} (expected int|bool|string|list)`);
    }
    const initOk =
      decl.type === 'int' ? Number.isInteger(decl.init)
      : decl.type === 'bool' ? typeof decl.init === 'boolean'
      : decl.type === 'list' ? Array.isArray(decl.init)
      : typeof decl.init === 'string';
    if (!initOk) fail(`${where}: init ${JSON.stringify(decl.init)} does not match type ${decl.type}`);
    decls.set(decl.name, decl);
  });

  if (!isPlain(data.theme)) fail('theme must be an object');
  const theme = data.theme;
  if (!['light', 'dark', 'system'].includes(theme.mode)) {
    fail(`theme.mode ${JSON.stringify(theme.mode)} must be light|dark|system`);
  }
  if (typeof theme.accent !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(theme.accent)) {
    fail(`theme.accent ${JSON.stringify(theme.accent)} must be #RRGGBB`);
  }
  if (typeof theme.radius !== 'number' || !Number.isFinite(theme.radius) || theme.radius < 0) {
    fail(`theme.radius ${JSON.stringify(theme.radius)} must be a non-negative number`);
  }
  if (theme.tokens !== undefined) validateThemeTokens(theme.tokens);
  validateOptionalA11yProps(theme, 'theme');

  // Single-page IR carries one top-level `tree`; multi-page IR carries an
  // `initialRoute` plus a `routes` table and no top-level tree (additive in
  // 0.1.0). Exactly one shape is accepted.
  const multiPage = data.routes !== undefined || data.initialRoute !== undefined;
  if (multiPage) {
    validateRoutes(data, decls);
  } else {
    if (!isPlain(data.tree)) fail('tree must be an object');
    const expectedId = { value: 0 };
    walkTree(data.tree, 'tree', decls, expectedId, false);
  }
  return data;
}

/* Walk one tree pre-order, validating ids, nodes and events. Each route tree
 * must be contiguous from its own first id; `expectedId` is threaded as a
 * mutable holder so a route validates independently. */
function walkTree(node, where, decls, expectedId, multiPage) {
  if (!isPlain(node)) fail(`${where} must be an object`);
  if (!Number.isInteger(node.id) || node.id < 0 || node.id > 0xffffffff) {
    fail(`${where}: id ${JSON.stringify(node.id)} must be a u32 integer`);
  }
  if (node.id !== expectedId.value) {
    fail(`${where}: id ${node.id} breaks pre-order sequence (expected ${expectedId.value})`);
  }
  expectedId.value += 1;
  if (typeof node.kind !== 'string' || !IDENT.test(node.kind)) {
    fail(`${where}: kind ${JSON.stringify(node.kind)} is not an identifier`);
  }
  if (!isPlain(node.props)) fail(`${where}: props must be an object`);
  if (!Array.isArray(node.children)) fail(`${where}: children must be an array`);
  if (!isPlain(node.events)) fail(`${where}: events must be an object`);
  if (node.when !== undefined) {
    if (typeof node.when !== 'string') fail(`${where}: when must be a state name string`);
    const decl = decls.get(node.when);
    if (!decl) fail(`${where}: when references unknown state ${JSON.stringify(node.when)}`);
    if (decl.type !== 'bool') fail(`${where}: when state ${JSON.stringify(node.when)} must be bool, got ${decl.type}`);
  }
  if (node.kind === 'For') {
    const source = node.props.source;
    if (typeof source !== 'string') fail(`${where}: For props.source must be a state name`);
    const sourceDecl = decls.get(source);
    if (!sourceDecl) fail(`${where}: For source references unknown state ${JSON.stringify(source)}`);
    if (sourceDecl.type !== 'list') fail(`${where}: For source ${JSON.stringify(source)} must be list, got ${sourceDecl.type}`);
    if (typeof node.props.item !== 'string' || !IDENT.test(node.props.item)) {
      fail(`${where}: For props.item ${JSON.stringify(node.props.item)} is not an identifier`);
    }
  }
  validateOptionalA11yProps(node.props, `node ${node.id}`);
  if (node.component !== undefined && typeof node.component !== 'string') {
    fail(`node ${node.id}: component must be a string`);
  }
  for (const [eventName, contract] of Object.entries(node.events)) {
    const base = `node ${node.id} event ${JSON.stringify(eventName)}`;
    if (!isPlain(contract)) fail(`${base}: must be an object`);
    validateEventEffects(contract, eventName, decls, base);
    if (Array.isArray(contract.actions)) {
      contract.actions.forEach((action, index) => validateAction(action, eventName, decls, `${base}[${index}]`, multiPage));
    } else if (contract.actions !== undefined) {
      fail(`${base}: actions must be an array`);
    } else if (contract.op !== undefined || (contract.effects === undefined && contract.async === undefined)) {
      validateAction(contract, eventName, decls, base, multiPage);
    }
  }
  node.children.forEach((child, index) => walkTree(child, `${where}.children[${index}]`, decls, expectedId, multiPage));
}

/* Validate the additive multi-page shape: an `initialRoute` naming a declared
 * route, and a `routes` table whose every entry carries a title and a tree.
 * Node ids must be globally unique and cover one contiguous space across all
 * routes; each route's own walk starts at its first id. */
function validateRoutes(data, decls) {
  if (typeof data.initialRoute !== 'string' || data.initialRoute === '') {
    fail('multi-page IR needs a non-empty initialRoute');
  }
  if (!isPlain(data.routes)) fail('routes must be an object keyed by route name');
  const names = Object.keys(data.routes);
  if (names.length === 0) fail('routes must declare at least one route');
  if (!names.includes(data.initialRoute)) {
    fail(`initialRoute ${JSON.stringify(data.initialRoute)} names no declared route`);
  }
  const allIds = new Set();
  for (const name of names) {
    const route = data.routes[name];
    const where = `routes[${JSON.stringify(name)}]`;
    if (!isPlain(route)) fail(`${where} must be an object`);
    if (typeof route.title !== 'string') fail(`${where}: title must be a string`);
    if (!isPlain(route.tree)) fail(`${where}: tree must be an object`);
    // Collect this route's ids for the global uniqueness/contiguity check while
    // validating each node against the shared state + event contract.
    const first = route.tree.id;
    if (!Number.isInteger(first) || first < 0) fail(`${where}: tree id must be a non-negative integer`);
    walkTree(route.tree, `${where}.tree`, decls, { value: first }, true);
    collectIds(route.tree, allIds, where);
  }
  const count = allIds.size;
  for (let id = 0; id < count; id += 1) {
    if (!allIds.has(id)) fail(`route node ids are not contiguous: missing id ${id}`);
  }
}

function collectIds(node, into, where) {
  if (into.has(node.id)) fail(`${where}: duplicate node id ${node.id} across routes`);
  into.add(node.id);
  node.children.forEach((child) => collectIds(child, into, where));
}


function validateOptionalA11yProps(props, where) {
  if (props.role !== undefined && (typeof props.role !== 'string' || !A11Y_ROLES.has(props.role))) {
    fail(`${where}: unknown a11y role ${JSON.stringify(props.role)} (expected ${[...A11Y_ROLES].join('|')})`);
  }
  if (props.fontScale !== undefined) {
    const value = props.fontScale;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 3.0) {
      fail(`${where}: fontScale ${JSON.stringify(value)} must be a number in 0.5..3.0`);
    }
  }
  if (props.highContrast !== undefined && typeof props.highContrast !== 'boolean') {
    fail(`${where}: highContrast must be a boolean`);
  }
  if (props.label !== undefined && typeof props.label !== 'string') {
    fail(`${where}: label must be a string`);
  }
}

function validateThemeTokens(tokens) {
  if (!isPlain(tokens)) fail('theme.tokens must be an object');
  for (const key of ['surface', 'onSurface']) {
    const value = tokens[key];
    if (value !== undefined && (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value))) {
      fail(`theme.tokens.${key} ${JSON.stringify(value)} must be #RRGGBB`);
    }
  }
  // Flattened Material 3 token constants share the object but use the
  // `md-sys-color-*` namespace; validate them with the same strict grammar.
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith('md-sys-color-')) continue;
    if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
      fail(`theme.tokens.${key} ${JSON.stringify(value)} must be #RRGGBB`);
    }
  }
  if (tokens.font !== undefined && typeof tokens.font !== 'string') fail('theme.tokens.font must be a string');
  if (tokens.contrast !== undefined && !['normal', 'high'].includes(tokens.contrast)) {
    fail(`theme.tokens.contrast ${JSON.stringify(tokens.contrast)} must be normal|high`);
  }
}

/* Async event effects, mirroring the language layer's lowering rules: only
 * `tap` events may carry the markers, `effects` requires `"async": true`, and
 * the known kinds are `delay` (0..60000 ms) and `fetch` (string path into a
 * declared string or list state). */
function validateEventEffects(contract, eventName, decls, base) {
  if (contract.async !== undefined && typeof contract.async !== 'boolean') {
    fail(`${base}: async must be a boolean`);
  }
  if (contract.effects === undefined && contract.async === undefined) return;
  if (eventName !== 'tap') fail(`${base}: async effects are only supported on tap events`);
  if (contract.effects === undefined) return;
  if (contract.async !== true) fail(`${base}: effects requires "async": true`);
  if (!Array.isArray(contract.effects)) fail(`${base}: effects must be an array`);
  contract.effects.forEach((effect, index) => {
    const where = `${base}.effects[${index}]`;
    if (!isPlain(effect)) fail(`${where}: must be an object`);
    if (effect.kind === 'delay') {
      if (!Number.isInteger(effect.ms) || effect.ms < 0 || effect.ms > 60000) {
        fail(`${where}: delay 'ms' must be an integer in 0..60000`);
      }
      return;
    }
    if (effect.kind === 'fetch') {
      if (typeof effect.path !== 'string') fail(`${where}: fetch needs a string 'path'`);
      if (typeof effect.into !== 'string') fail(`${where}: fetch needs a string 'into'`);
      const decl = requireDecl(decls, effect.into, where, 'into');
      if (decl.type !== 'string' && decl.type !== 'list') {
        fail(`${where}: fetch into ${JSON.stringify(decl.name)} must be string or list, got ${decl.type}`);
      }
      return;
    }
    fail(`${where}: unknown effect kind ${JSON.stringify(effect.kind)}`);
  });
}

function validateAction(action, eventName, decls, where, multiPage = false) {
  if (!isPlain(action)) fail(`${where}: action must be an object`);
  // Multi-page navigation actions: `push` names a target route, `pop` returns.
  if (multiPage && action.op === 'push') {
    if (typeof action.target !== 'string' || action.target === '') {
      fail(`${where}: push needs a route target name`);
    }
    return;
  }
  if (multiPage && action.op === 'pop') {
    if (action.target !== undefined && action.target !== '') {
      fail(`${where}: pop takes no target`);
    }
    return;
  }
  if (!EVENT_OPS.has(action.op)) {
    fail(`${where}: unknown op ${JSON.stringify(action.op)} (expected set|add|sub|mul|div|backspace|toggle|append|removeAt|assign)`);
  }
  // Reserved patch targets are not state declarations (IR_ADDITIONS §15.4).
  // Only `set @locale` is legal; every other op still needs a declared state.
  if (action.op === 'set' && action.target === '@locale') {
    if (action.valueFrom !== undefined) fail(`${where}: @locale takes a literal tag, not valueFrom`);
    if (typeof action.value !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(action.value)) {
      fail(`${where}: @locale value must be a BCP-47 tag`);
    }
    return;
  }
  if (typeof action.target !== 'string' || !decls.has(action.target)) {
    fail(`${where}: unknown state target ${JSON.stringify(action.target)}`);
  }
  if (action.value !== undefined && action.valueFrom !== undefined) {
    fail(`${where}: action cannot carry both value and valueFrom`);
  }
  const target = decls.get(action.target);
  if (action.valueFrom !== undefined && typeof action.valueFrom !== 'string') {
    fail(`${where}: valueFrom must be a state name string`);
  }

  if (action.op === 'toggle') {
    if (target.type !== 'bool') fail(`${where}: toggle target ${JSON.stringify(target.name)} must be bool, got ${target.type}`);
    if (action.value !== undefined || action.valueFrom !== undefined) fail(`${where}: toggle takes no value`);
    return;
  }

  if (action.op === 'add' || action.op === 'sub' || action.op === 'mul' || action.op === 'div') {
    if (target.type !== 'int') fail(`${where}: ${action.op} target ${JSON.stringify(target.name)} must be int, got ${target.type}`);
    if (action.valueFrom !== undefined) {
      const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
      if (source.type !== 'int') fail(`${where}: valueFrom state ${JSON.stringify(source.name)} must be int for ${action.op}, got ${source.type}`);
      return;
    }
    if (!Number.isInteger(action.value)) fail(`${where}: ${action.op} requires an integer value`);
    if (action.op === 'div' && action.value === 0) fail(`${where}: div requires a non-zero value`);
    return;
  }

  if (action.op === 'backspace') {
    if (target.type !== 'int' && target.type !== 'string') {
      fail(`${where}: backspace target ${JSON.stringify(target.name)} must be int or string, got ${target.type}`);
    }
    if (action.value !== undefined || action.valueFrom !== undefined) fail(`${where}: backspace takes no value`);
    return;
  }

  if (action.op === 'append') {
    if (target.type !== 'list') fail(`${where}: append target ${JSON.stringify(target.name)} must be list, got ${target.type}`);
    if (action.valueFrom !== undefined) {
      const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
      if (source.type !== 'string') fail(`${where}: append valueFrom state ${JSON.stringify(source.name)} must be string, got ${source.type}`);
      return;
    }
    if (typeof action.value !== 'string') fail(`${where}: append requires a string value`);
    return;
  }

  if (action.op === 'removeAt') {
    if (target.type !== 'list') fail(`${where}: removeAt target ${JSON.stringify(target.name)} must be list, got ${target.type}`);
    if (action.valueFrom !== undefined) fail(`${where}: removeAt takes no valueFrom`);
    if (!Number.isInteger(action.value) || action.value < 0) {
      fail(`${where}: removeAt requires a non-negative integer value`);
    }
    return;
  }

  if (action.op === 'assign') {
    if (target.type !== 'list') fail(`${where}: assign target ${JSON.stringify(target.name)} must be list, got ${target.type}`);
    if (action.valueFrom !== undefined) {
      const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
      if (source.type !== 'list') fail(`${where}: assign valueFrom state ${JSON.stringify(source.name)} must be list, got ${source.type}`);
      return;
    }
    // A whole-list replacement carries strings only, matching core's parse.
    if (!Array.isArray(action.value) || !action.value.every((entry) => typeof entry === 'string')) {
      fail(`${where}: assign requires an array of strings`);
    }
    return;
  }

  // op === 'set'
  if (target.type === 'list') fail(`${where}: set cannot target list state ${JSON.stringify(target.name)} (use assign)`);
  if (action.valueFrom !== undefined) {
    const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
    if (source.type !== target.type) {
      fail(`${where}: valueFrom state ${JSON.stringify(source.name)} has type ${source.type}, target wants ${target.type}`);
    }
    return;
  }
  if (action.value === undefined) {
    if (eventName !== 'input') fail(`${where}: set requires value or valueFrom (only input events may omit it)`);
    // Text inputs bind string state; range-style controls (Slider) bind int state.
    if (target.type !== 'string' && target.type !== 'int') {
      fail(`${where}: input target ${JSON.stringify(target.name)} must be string or int, got ${target.type}`);
    }
    return;
  }
  const typeOk =
    target.type === 'int' ? Number.isInteger(action.value)
    : target.type === 'bool' ? typeof action.value === 'boolean'
    : typeof action.value === 'string';
  if (!typeOk) fail(`${where}: value ${JSON.stringify(action.value)} does not match target type ${target.type}`);
}

function requireDecl(decls, name, where, field) {
  const decl = decls.get(name);
  if (!decl) fail(`${where}: ${field} references unknown state ${JSON.stringify(name)}`);
  return decl;
}

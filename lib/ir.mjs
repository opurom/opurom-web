/* IR v0.1 validation per IR_SCHEMA.md + IR_ADDITIONS.md (additive fields).
 * Readable diagnostics, exit-code-1 friendly: callers print `error: <message>`. */

import fs from 'node:fs';

const STATE_TYPES = new Set(['int', 'bool', 'string']);
const A11Y_ROLES = new Set(['button', 'text', 'image', 'checkbox', 'slider', 'heading', 'none']);
const EVENT_OPS = new Set(['set', 'add', 'sub', 'toggle']);
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
  if (data.ir !== '0.1') fail(`unsupported ir version ${JSON.stringify(data.ir)}; expected "0.1"`);
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
      fail(`${where}: unknown type ${JSON.stringify(decl.type)} (expected int|bool|string)`);
    }
    const initOk =
      decl.type === 'int' ? Number.isInteger(decl.init)
      : decl.type === 'bool' ? typeof decl.init === 'boolean'
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
  if (theme.fontScale !== undefined) {
    const value = theme.fontScale;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 3) {
      fail(`theme.fontScale ${JSON.stringify(value)} must be a number in 0.5..3.0`);
    }
  }
  validateOptionalA11yProps(theme, 'theme');

  if (!isPlain(data.tree)) fail('tree must be an object');
  let expectedId = 0;
  const walk = (node, where) => {
    if (!isPlain(node)) fail(`${where} must be an object`);
    if (!Number.isInteger(node.id) || node.id < 0 || node.id > 0xffffffff) {
      fail(`${where}: id ${JSON.stringify(node.id)} must be a u32 integer`);
    }
    if (node.id !== expectedId) {
      fail(`${where}: id ${node.id} breaks pre-order sequence (expected ${expectedId})`);
    }
    expectedId += 1;
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
    validateOptionalA11yProps(node.props, `node ${node.id}`);
    if (node.component !== undefined && typeof node.component !== 'string') {
      fail(`node ${node.id}: component must be a string`);
    }
    for (const [eventName, spec] of Object.entries(node.events)) {
      const base = `node ${node.id} event ${JSON.stringify(eventName)}`;
      if (!isPlain(spec)) fail(`${base}: must be an object`);
      if (Array.isArray(spec.actions)) {
        spec.actions.forEach((action, index) => validateAction(action, eventName, decls, `${base}[${index}]`));
      } else if (spec.actions !== undefined) {
        fail(`${base}: actions must be an array`);
      } else {
        validateAction(spec, eventName, decls, base);
      }
    }
    node.children.forEach((child, index) => walk(child, `${where}.children[${index}]`));
  };
  walk(data.tree, 'tree');
  // A global theme.fontScale is the default for nodes without a local prop.
  // Filling it in once keeps DOM sizing, roles and verification in agreement.
  if (theme.fontScale !== undefined) {
    const inject = (node) => {
      if (node.props.fontScale === undefined) node.props.fontScale = theme.fontScale;
      for (const child of node.children) inject(child);
    };
    inject(data.tree);
  }
  return data;
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
  if (tokens.font !== undefined && typeof tokens.font !== 'string') fail('theme.tokens.font must be a string');
  if (tokens.contrast !== undefined && !['normal', 'high'].includes(tokens.contrast)) {
    fail(`theme.tokens.contrast ${JSON.stringify(tokens.contrast)} must be normal|high`);
  }
}

function validateAction(action, eventName, decls, where) {
  if (!isPlain(action)) fail(`${where}: action must be an object`);
  if (!EVENT_OPS.has(action.op)) fail(`${where}: unknown op ${JSON.stringify(action.op)} (expected set|add|sub|toggle)`);
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

  if (action.op === 'add' || action.op === 'sub') {
    if (target.type !== 'int') fail(`${where}: ${action.op} target ${JSON.stringify(target.name)} must be int, got ${target.type}`);
    if (action.valueFrom !== undefined) {
      const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
      if (source.type !== 'int') fail(`${where}: valueFrom state ${JSON.stringify(source.name)} must be int for ${action.op}, got ${source.type}`);
      return;
    }
    if (!Number.isInteger(action.value)) fail(`${where}: ${action.op} requires an integer value`);
    return;
  }

  // op === 'set'
  if (action.valueFrom !== undefined) {
    const source = requireDecl(decls, action.valueFrom, where, 'valueFrom');
    if (source.type !== target.type) {
      fail(`${where}: valueFrom state ${JSON.stringify(source.name)} has type ${source.type}, target wants ${target.type}`);
    }
    return;
  }
  if (action.value === undefined) {
    if (eventName !== 'input') fail(`${where}: set requires value or valueFrom (only input events may omit it)`);
    // A raw input element always yields a string, so the runtime coerces it
    // to the target type: int targets are parsed, string targets pass through.
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

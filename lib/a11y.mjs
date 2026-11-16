/* Accessibility contract (the framework rules framework rules) applied to IR nodes at compile time:
 * role defaults, accessible labels, initial-state interpolation, `when`
 * visibility and DOM tag mapping. Pure functions shared by the emitter and by
 * the verify expectations (one contract, applied on both sides). */

import { stateMap } from './ir.mjs';

export { stateMap };

const DEFAULT_TEXT_SIZE = 16;

function numeric(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* Effective logical pixel size of a text node: size * fontScale, rounded
 * the way the contract's fixed-point scaling rounds. */
export function textFontSize(node) {
  const size = numeric(node.props.size, DEFAULT_TEXT_SIZE);
  const scale = numeric(node.props.fontScale, 1);
  return Math.max(1, Math.round(size * scale));
}

/* Explicit props.role always wins, including "none". Defaults follow the contract:
 * Button->button, Text->text (heading when effective size >= 24),
 * Image->image, Switch/Checkbox->checkbox, Slider->slider, else none. */
export function effectiveRole(node) {
  if (typeof node.props.role === 'string') return node.props.role;
  switch (node.kind) {
    case 'Button':
      return 'button';
    case 'Text':
      return textFontSize(node) >= 24 ? 'heading' : 'text';
    case 'Image':
      return 'image';
    case 'Switch':
    case 'Checkbox':
      return 'checkbox';
    case 'Slider':
      return 'slider';
    default:
      return 'none';
  }
}

/* label, else value/title/name/placeholder, else empty (the contract label rule). */
export function labelOf(node) {
  const props = node.props;
  for (const key of ['label', 'value', 'title', 'name', 'placeholder']) {
    const value = props[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/* {name} interpolation against initial state; unknown placeholders stay literal. */
export function interpolate(text, decls) {
  return String(text).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => {
    const decl = decls.get(name);
    return decl === undefined ? all : String(decl.init);
  });
}

/* `when` resolved once at emit time against initial state: a subtree whose
 * guard starts false is simply not emitted (documented shortcut). */
export function initiallyVisible(node, decls) {
  if (node.when === undefined) return true;
  const decl = decls.get(node.when);
  return decl !== undefined && decl.init === true;
}

/* Semantic DOM tag for a node under the a11y role it resolves to. Unmapped
 * kinds follow the fallback: containers keep children, leaves render their
 * label/value/title/name as text. */
export function tagFor(node, role) {
  switch (node.kind) {
    case 'Text':
      return role === 'heading' ? 'h2' : 'p';
    case 'Button':
    case 'Switch':
    case 'Checkbox':
      return 'button';
    case 'Slider':
    case 'Input':
      return 'input';
    case 'Column':
    case 'Row':
      return 'div';
    case 'Image':
      // Placeholder box (no image decoding): accessible name comes from
      // aria-label via the contract label chain.
      return 'div';
    default:
      if (node.children.length > 0) return 'div';
      return labelOf(node) !== '' ? 'p' : 'div';
  }
}

/* Pre-order list of visible nodes with their resolved contract facts: the
 * shared expectation for emitter output and verify facts. Pass `tree` to walk
 * a specific route; defaults to the single-page top-level tree. */
export function visibleNodes(ir, tree = ir.tree) {
  const decls = stateMap(ir);
  const out = [];
  const walk = (node) => {
    if (!initiallyVisible(node, decls)) return;
    const role = effectiveRole(node);
    if (node.kind === 'For') {
      // The multi page ships the region as an inert template marker whose rows
      // the router materializes after the facts snapshot; the single page
      // expands rows statically, one contract copy per init element.
      if (isMultiPage(ir)) {
        out.push({ node, role, tag: 'template' });
        return;
      }
      out.push({ node, role, tag: 'div' });
      const list = decls.get(node.props.source)?.init;
      const count = Array.isArray(list) ? list.length : 0;
      for (let i = 0; i < count; i += 1) {
        for (const child of node.children) walk(child);
      }
      return;
    }
    out.push({ node, role, tag: tagFor(node, role) });
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

/* True when the IR declares additive multi-page routes. */
export function isMultiPage(ir) {
  return ir.routes !== undefined && ir.initialRoute !== undefined;
}

/* Pre-order list of every route's visible nodes in `routes` key order. Used by
 * verification to compare against the emitted per-page markup. */
export function visibleRouteNodes(ir) {
  const out = [];
  for (const name of Object.keys(ir.routes)) {
    for (const entry of visibleNodes(ir, ir.routes[name].tree)) {
      out.push({ ...entry, route: name });
    }
  }
  return out;
}

export function expectedDom(ir) {
  if (isMultiPage(ir)) {
    return visibleRouteNodes(ir).map(({ node, role, tag }) => ({ id: node.id, tag, role }));
  }
  return visibleNodes(ir).map(({ node, role, tag }) => ({ id: node.id, tag, role }));
}

/* R3 a11y contract (R3_ADDENDUM section 2) applied to IR nodes at compile time:
 * role defaults, accessible labels, initial-state interpolation, `when`
 * visibility and DOM tag mapping. Pure functions shared by the emitter and by
 * the verify expectations (one contract, applied on both sides). */

import { stateMap } from './ir.mjs';

export { stateMap };

const DEFAULT_TEXT_SIZE = 16;

function numeric(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* Effective logical pixel size of a text node: size * fontScale (R3), rounded
 * the way the contract's fixed-point scaling rounds. */
export function textFontSize(node) {
  const size = numeric(node.props.size, DEFAULT_TEXT_SIZE);
  const scale = numeric(node.props.fontScale, 1);
  return Math.max(1, Math.round(size * scale));
}

/* Explicit props.role always wins, including "none". Defaults follow R3:
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

/* label, else value/title/name/placeholder, else empty (R3 label rule). */
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

/* R2 `when` resolved once at emit time against initial state: a subtree whose
 * guard starts false is simply not emitted (documented shortcut). */
export function initiallyVisible(node, decls) {
  if (node.when === undefined) return true;
  const decl = decls.get(node.when);
  return decl !== undefined && decl.init === true;
}

/* Semantic DOM tag for a node under the a11y role it resolves to. Unmapped
 * kinds follow the R2 fallback: containers keep children, leaves render their
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
      // Placeholder box (no image decoding in R6): accessible name comes from
      // aria-label via the R3 label chain.
      return 'div';
    default:
      if (node.children.length > 0) return 'div';
      return labelOf(node) !== '' ? 'p' : 'div';
  }
}

/* Pre-order list of visible nodes with their resolved contract facts: the
 * shared expectation for emitter output and verify facts. */
export function visibleNodes(ir) {
  const decls = stateMap(ir);
  const out = [];
  const walk = (node) => {
    if (!initiallyVisible(node, decls)) return;
    const role = effectiveRole(node);
    out.push({ node, role, tag: tagFor(node, role) });
    for (const child of node.children) walk(child);
  };
  walk(ir.tree);
  return out;
}

export function expectedDom(ir) {
  return visibleNodes(ir).map(({ node, role, tag }) => ({ id: node.id, tag, role }));
}

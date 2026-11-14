/* Accessibility contract (COMPONENTS_AND_A11Y.md section 2) applied to IR nodes at compile time:
 * role defaults, accessible labels, initial-state interpolation, `when`
 * visibility and DOM tag mapping. Pure functions shared by the emitter and by
 * the verify expectations (one contract, applied on both sides). */

import { stateMap } from './ir.mjs';

export { stateMap };

const DEFAULT_TEXT_SIZE = 16;

export const TEXT_TAGS = /^(p|h[1-6])$/;

/* Content-bearing tags carry their accessible name as text; container tags
 * instead expose children (and an aria-label when they have no text). */
export function contentBearing(tag) {
  return tag === 'button' || TEXT_TAGS.test(tag);
}

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
    case 'Icon':
      // A vector glyph carries its name as an image role, so the tag maps to svg.
      return 'img';
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

/* `when`/`unless` resolved once at emit time against initial state: a subtree
 * whose guard fails (false `when`, or true `unless`) is not emitted. An `else`
 * branch lowers to `unless`, so honoring it keeps only one branch visible. */
export function initiallyVisible(node, decls) {
  if (node.when !== undefined) {
    const decl = decls.get(node.when);
    if (!(decl !== undefined && decl.init === true)) return false;
  }
  if (node.unless !== undefined) {
    const decl = decls.get(node.unless);
    if (decl !== undefined && decl.init === true) return false;
  }
  return true;
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
      // A real image element: the src is emitted as authored, so no resource
      // I/O or decoding happens at emit time.
      return 'img';
    case 'Icon':
      // Vector glyph: the emitter renders an inline svg with role img.
      return 'svg';
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

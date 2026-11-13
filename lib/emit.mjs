/* Compile-time IR -> standalone index.html emitter.
 *
 * All IR interpretation happens HERE, in Node: tag mapping, a11y roles,
 * interpolation, layout props and the gradient spec are baked into static
 * HTML/CSS/JS. The emitted page never sees the IR document. */

import fs from 'node:fs';
import path from 'node:path';

import { contentBearing, effectiveRole, interpolate, initiallyVisible, labelOf, stateMap, tagFor, textFontSize, TEXT_TAGS, visibleNodes } from './a11y.mjs';
import { validateIr } from './ir.mjs';
import { gradientSpec, parseHexColor, particleDots } from './spec.mjs';
import { pageScript } from './page-source.mjs';

const ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch']);

/* Accessible name of the painted gradient panel; exported so verify asserts
 * the label the page actually reports against the label it was emitted with. */
export const CANVAS_ARIA_LABEL = 'Deterministic theme gradient';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function resolveOutDir(outDir) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new Error('out-dir must be a non-empty path');
  }
  let stat = null;
  try {
    stat = fs.statSync(outDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat !== null && !stat.isDirectory()) {
    throw new Error(`out-dir exists and is not a directory: ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  return path.resolve(outDir);
}

/* Numeric prop guard: schema says non-numeric literals arrive as strings, and
 * consumers must ignore unsupported values, so strings never become CSS. */
function numericProp(props, key) {
  const value = props[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/* The renderer defaults a Grid without an explicit column count to two columns
 * and reserves the expanded tier for fluid columns, so the emitter mirrors both:
 * an explicit count maps to a grid-cols-N class and an absent one to grid-fluid. */
function gridColumnClass(node) {
  if (node.kind !== 'Grid') return null;
  const columns = numericProp(node.props, 'columns');
  if (columns !== null && columns >= 1) return `grid-cols-${columns}`;
  return 'grid-fluid';
}

/* Explicit column counts used by any Grid in the IR, so the stylesheet carries
 * one rule per count that is actually referenced. */
function gridColumnCounts(ir) {
  const counts = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'Grid') {
      const columns = numericProp(node.props, 'columns');
      if (columns !== null && columns >= 1) counts.add(columns);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(ir.tree);
  return [...counts].sort((left, right) => left - right);
}

function styleFor(node, role, tag) {
  const parts = [];
  const props = node.props;
  if (tag === 'div') {
    // An IR width becomes a fluid cap rather than a fixed pixel width, so a
    // resized window keeps the element filling its container up to that cap.
    const width = numericProp(props, 'width');
    if (width !== null && width > 0) parts.push(`max-width:${width}px`);
    const gap = numericProp(props, 'gap');
    if (gap !== null) parts.push(`gap:${gap}px`);
    const padding = numericProp(props, 'padding');
    if (padding !== null) parts.push(`padding:${padding}px`);
    const margin = numericProp(props, 'margin');
    if (margin !== null) parts.push(`margin:${margin}px`);
    if (ALIGN_VALUES.has(props.align)) parts.push(`align-items:${props.align}`);
  }
  if (node.kind === 'Grid') {
    // A Grid's gutter prop drives the gap; the .grid class carries the default
    // and the fluid modifier is asserted by the responsive media rules.
    const gutter = numericProp(props, 'gutter');
    if (gutter !== null) parts.push(`gap:${gutter}px`);
  }
  if (role === 'heading' || TEXT_TAGS.test(tag)) {
    parts.push(`font-size:${textFontSize(node)}px`);
  }
  return parts.join('; ');
}

function renderNode(node, decls) {
  if (!initiallyVisible(node, decls)) return '';
  const role = effectiveRole(node);
  const tag = tagFor(node, role);
  const gridClass = gridColumnClass(node);
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="node ${escapeHtml(node.kind.toLowerCase())}${gridClass ? ` ${gridClass}` : ''}"`,
  ];
  if (role === 'heading') attrs.push('aria-level="2"');
  if (tag === 'button') {
    attrs.push('type="button"');
    if (node.kind === 'Switch' || node.kind === 'Checkbox') {
      const decl = typeof node.props.bind === 'string' ? decls.get(node.props.bind) : undefined;
      const checked = decl !== undefined && decl.type === 'bool' && decl.init === true;
      attrs.push(`aria-checked="${checked ? 'true' : 'false'}"`);
    }
  }
  if (tag === 'input') {
    if (node.kind === 'Slider') {
      attrs.push('type="range"');
      for (const key of ['min', 'max']) {
        const value = numericProp(node.props, key);
        if (value !== null) attrs.push(`${key}="${value}"`);
      }
      const decl = typeof node.props.bind === 'string' ? decls.get(node.props.bind) : undefined;
      if (decl !== undefined && decl.type === 'int') attrs.push(`value="${decl.init}"`);
    } else {
      attrs.push('type="text"');
      if (typeof node.props.placeholder === 'string') {
        attrs.push(`placeholder="${escapeHtml(node.props.placeholder)}"`);
      }
    }
  }
  const style = styleFor(node, role, tag);
  if (style !== '') attrs.push(`style="${escapeHtml(style)}"`);

  const hasContent = contentBearing(tag);
  if (!hasContent) {
    const label = labelOf(node);
    if (label !== '') attrs.push(`aria-label="${escapeHtml(interpolate(label, decls))}"`);
  }

  const open = `<${tag} ${attrs.join(' ')}>`;
  if (tag === 'input') return open;
  const inner = hasContent
    ? escapeHtml(interpolate(labelOf(node), decls))
    : node.children.map((child) => renderNode(child, decls)).join('');
  return `${open}${inner}</${tag}>`;
}

function cssFor(ir, spec) {
  const surface = `rgb(${spec.bottom.join(', ')})`;
  const ink = `rgb(${spec.border.join(', ')})`;
  const gridRules = gridColumnCounts(ir)
    .map((columns) => `.grid-cols-${columns} { grid-template-columns: repeat(${columns}, minmax(0, 1fr)); }`)
    .join('\n');
  return `
:root { --accent: ${ir.theme.accent}; --radius: ${ir.theme.radius}px; --surface: ${surface}; --ink: ${ink}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
header.app-header { display: block; padding: 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.12); }
header.app-header h1 { margin: 0 0 12px; font-size: 20px; }
main#app { display: block; padding: 16px; }
#fx { display: block; width: ${spec.width}px; height: ${spec.height}px; border-radius: var(--radius); background: var(--surface); }
.fx-panel { position: relative; display: inline-block; }
#fx-particles { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.particle-field { position: absolute; inset: 0; }
.particle-dot { position: absolute; width: var(--dot-size, 1px); height: var(--dot-size, 1px); border-radius: var(--dot-radius, 0); background: var(--dot-color, transparent); }
.column { display: flex; flex-direction: column; width: 100%; max-width: 100%; }
.row { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; width: 100%; max-width: 100%; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
${gridRules}
/* Viewport tiers mirror opurom-render's logical-pixel breakpoints: compact
 * <600, medium <900, expanded <1200, wide <1600, ultra >=1600. */
@media (max-width: 599px) {
  .row { flex-direction: column; align-items: stretch; }
  .grid { grid-template-columns: 1fr; }
}
@media (min-width: 600px) {
  .row { flex-direction: row; align-items: center; }
}
@media (min-width: 900px) {
  main#app { padding: 24px; }
  .column, .row { gap: 12px; }
}
@media (min-width: 1200px) {
  main#app { padding: 32px; }
  .column, .row { gap: 16px; }
  .grid-fluid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
}
@media (min-width: 1600px) {
  main#app { padding: 32px; }
  .column, .row { gap: 24px; }
}
button { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; border: none; border-radius: var(--radius); background-color: var(--accent); color: #ffffff; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
input { font: inherit; padding: 6px 8px; border: 1px solid rgba(0, 0, 0, 0.25); border-radius: var(--radius); }
p, h1, h2, h3 { line-height: 1.35; }
.image { display: inline-block; width: 64px; height: 64px; border: 1px dashed rgba(0, 0, 0, 0.35); }
#opurom-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`.trim();
}

/* Runtime state changes are announced against the IR's initial values. */
function initialState(ir) {
  return Object.fromEntries(ir.state.map((decl) => [decl.name, decl.init]));
}

/* Deterministic DOM/CSS particle layer: one container per lowered field, one
 * dot per hash position, positioned with the same integer layout the canvas
 * painter rasterizes. The layer overlays the canvas, and dots are decorative
 * texture, so the layer is hidden from assistive technology. */
function particleLayerHtml(spec) {
  const layers = particleDots(spec);
  if (layers.length === 0) {
    return '<div id="fx-particles" class="particle-layer" aria-hidden="true"></div>';
  }
  const fields = layers.map((layer) => {
    const [red, green, blue] = layer.color;
    const dots = layer.dots
      .map((dot) => `<i class="particle-dot" data-x="${dot.x}" data-y="${dot.y}" style="left:${dot.x}px;top:${dot.y}px"></i>`)
      .join('');
    const style = `--dot-size:${2 * layer.radius + 1}px;--dot-radius:${layer.radius}px;` +
      `--dot-color:rgba(${red},${green},${blue},${layer.alpha / 255})`;
    return `<div class="particle-field" data-field="${layer.field}" data-count="${layer.count}" ` +
      `data-seed="${layer.seed}" data-radius="${layer.radius}" data-alpha="${layer.alpha}" ` +
      `data-color="${red},${green},${blue}" style="${style}">${dots}</div>`;
  }).join('');
  return `<div id="fx-particles" class="particle-layer" aria-hidden="true">${fields}</div>`;
}

export function renderHtml(ir, spec) {
  const decls = stateMap(ir);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(ir.app)}</title>`,
    '<meta id="opurom-verify" name="opurom-verify">',
    '<style>',
    cssFor(ir, spec),
    '</style>',
    '</head>',
    '<body>',
    '<header class="app-header">',
    `<h1>${escapeHtml(ir.app)}</h1>`,
    '<div class="fx-panel">',
    `<canvas id="fx" width="${spec.width}" height="${spec.height}" role="img" aria-label="${CANVAS_ARIA_LABEL}"></canvas>`,
    particleLayerHtml(spec),
    '</div>',
    '</header>',
    '<main id="app">',
    renderNode(ir.tree, decls),
    '</main>',
    '<div id="opurom-live" role="status" aria-live="polite" aria-atomic="true"></div>',
    '<script>',
    pageScript(spec, initialState(ir)),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function emitFromIr(ir, outDir) {
  validateIr(ir);
  const resolved = resolveOutDir(outDir);
  const spec = gradientSpec(ir);
  const html = renderHtml(ir, spec);
  const indexPath = path.join(resolved, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');
  return { indexPath, bytes: Buffer.byteLength(html), html };
}

export { escapeHtml };

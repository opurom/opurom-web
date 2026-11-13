/* Compile-time IR -> standalone index.html emitter.
 *
 * All IR interpretation happens HERE, in Node: tag mapping, a11y roles,
 * interpolation, layout props and the gradient spec are baked into static
 * HTML/CSS/JS. The emitted page never sees the IR document. */

import fs from 'node:fs';
import path from 'node:path';

import { contentBearing, effectiveRole, interpolate, initiallyVisible, labelOf, stateMap, tagFor, textFontSize, TEXT_TAGS, visibleNodes } from './a11y.mjs';
import { validateIr } from './ir.mjs';
import { gradientSpec, parseHexColor } from './spec.mjs';
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

function styleFor(node, role, tag) {
  const parts = [];
  const props = node.props;
  if (tag === 'div') {
    const gap = numericProp(props, 'gap');
    if (gap !== null) parts.push(`gap:${gap}px`);
    const padding = numericProp(props, 'padding');
    if (padding !== null) parts.push(`padding:${padding}px`);
    const margin = numericProp(props, 'margin');
    if (margin !== null) parts.push(`margin:${margin}px`);
    if (ALIGN_VALUES.has(props.align)) parts.push(`align-items:${props.align}`);
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
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="node ${escapeHtml(node.kind.toLowerCase())}"`,
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
  return `
:root { --accent: ${ir.theme.accent}; --radius: ${ir.theme.radius}px; --surface: ${surface}; --ink: ${ink}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
header.app-header { display: block; padding: 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.12); }
header.app-header h1 { margin: 0 0 12px; font-size: 20px; }
main#app { display: block; padding: 16px; }
#fx { display: block; width: ${spec.width}px; height: ${spec.height}px; border-radius: var(--radius); background: var(--surface); }
.column { display: flex; flex-direction: column; }
.row { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; }
button { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; border: none; border-radius: var(--radius); background-color: var(--accent); color: #ffffff; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
input { font: inherit; padding: 6px 8px; border: 1px solid rgba(0, 0, 0, 0.25); border-radius: var(--radius); }
p, h1, h2, h3 { line-height: 1.35; }
.image { display: inline-block; width: 64px; height: 64px; border: 1px dashed rgba(0, 0, 0, 0.35); }
`.trim();
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
    `<canvas id="fx" width="${spec.width}" height="${spec.height}" role="img" aria-label="${CANVAS_ARIA_LABEL}"></canvas>`,
    '</header>',
    '<main id="app">',
    renderNode(ir.tree, decls),
    '</main>',
    '<script>',
    pageScript(spec),
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

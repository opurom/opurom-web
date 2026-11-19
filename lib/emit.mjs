/* Compile-time IR -> standalone index.html emitter.
 *
 * All IR interpretation happens HERE, in Node: tag mapping, a11y roles,
 * interpolation, layout props and the gradient contract are baked into static
 * HTML/CSS/JS. The emitted page never sees the IR document. */

import fs from 'node:fs';
import path from 'node:path';

import { catalogOf, effectiveRole, interpolate, interpolateCatalog, initiallyVisible, labelOf, stateMap, tagFor, textFontSize, visibleNodes } from './a11y.mjs';
import { validateIr } from './ir.mjs';
import { gradientSpec, parseHexColor } from './contract.mjs';
import { pageScript, multiPageRouter } from './page-source.mjs';

const TEXT_TAGS = /^(p|h[1-6])$/;
const ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch']);
const FIT_VALUES = new Set(['contain', 'cover', 'fill']);

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
/* Strict #RRGGBB guard: IR colors use the same shape; anything else is ignored
 * rather than passed through to CSS. */
function hexColor(props, key) {
  const value = props[key];
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

/* IR gradient is "#RRGGBB,#RRGGBB". Invalid pairs are ignored, never passed
 * through to CSS; the caller falls back to the solid fill. */
function gradientPair(props) {
  const value = props.gradient;
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const a = parts[0].trim();
  const b = parts[1].trim();
  const hex = /^#[0-9a-fA-F]{6}$/;
  return hex.test(a) && hex.test(b) ? [a, b] : null;
}

/* Per-corner radii: the IR names the corners, CSS orders them top-left,
 * top-right, bottom-right, bottom-left. Each corner is a circular radius or an
 * elliptical [x, y] pair; an omitted corner falls back to the node's scalar
 * radius, then to the required theme radius (render/lang use the same rule).
 * Returns the CSS value, or null when the node declares no corner radii. */
function cornerRadiiCss(props, themeRadius) {
  const corners = props.cornerRadii;
  if (corners === null || typeof corners !== 'object' || Array.isArray(corners)) return null;
  const scalar = numericProp(props, 'radius');
  const fallback = scalar === null ? themeRadius : scalar;
  const horizontal = [];
  const vertical = [];
  let elliptical = false;
  for (const key of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
    const value = corners[key];
    let x = fallback;
    let y = fallback;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      x = value;
      y = value;
    } else if (Array.isArray(value) && value.length === 2
      && Number.isFinite(value[0]) && Number.isFinite(value[1])
      && value[0] >= 0 && value[1] >= 0) {
      x = value[0];
      y = value[1];
      elliptical = true;
    }
    horizontal.push(`${x}px`);
    vertical.push(`${y}px`);
  }
  const h = horizontal.join(' ');
  return elliptical ? `${h} / ${vertical.join(' ')}` : h;
}

function numericProp(props, key) {
  const value = props[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function styleFor(node, role, tag, themeRadius) {
  const parts = [];
  const props = node.props;
  if (tag === 'div') {
    // Flex weight: same contract as the renderer's vertical stack. A weighted
    // child grows from its natural size into the leftover main-axis space, so
    // a bottom pane reaches the end of the stack on every viewport. A zero or
    // absent weight is a no-op, leaving all pinned emit byte-identical.
    const flex = numericProp(props, 'flex');
    if (flex !== null && flex > 0) parts.push(`flex:${flex}`);
    const gap = numericProp(props, 'gap');
    if (gap !== null) parts.push(`gap:${gap}px`);
    const padding = numericProp(props, 'padding');
    if (padding !== null) parts.push(`padding:${padding}px`);
    const margin = numericProp(props, 'margin');
    if (margin !== null) parts.push(`margin:${margin}px`);
    if (ALIGN_VALUES.has(props.align)) {
      parts.push(`align-items:${props.align}`);
      // Flutter MainAxisAlignment.start/center/end; stretch is cross-axis only.
      if (props.align !== 'stretch') parts.push(`justify-content:${props.align}`);
    }
  } else {
    // Box padding applies to every node kind in render (layout.rs:1271).
    // A button/input declaring p must not fall back to the global tag rule.
    const padding = numericProp(props, 'padding');
    if (padding !== null) parts.push(`padding:${padding}px`);
  }
  if (tag !== 'img') {
    for (const key of ['width', 'height']) {
      const value = numericProp(props, key);
      if (value !== null) parts.push(`${key}:${value}px`);
    }
  }
  const cornerRadii = cornerRadiiCss(props, themeRadius);
  if (cornerRadii !== null) {
    parts.push(`border-radius:${cornerRadii}`);
  } else {
    const radius = numericProp(props, 'radius');
    if (radius !== null) parts.push(`border-radius:${radius}px`);
  }
  const border = hexColor(props, 'border');
  if (border !== null) parts.push(`border:1px solid ${border}`);
  const gradient = gradientPair(props);
  if (gradient !== null) {
    // The solid first stop is the degradation path when CSS gradients are
    // unavailable; the theme canvas stays the page backdrop either way.
    const direction = props.gradientDirection === 'horizontal' ? 'to right' : 'to bottom';
    parts.push(`background-color:${gradient[0]}`);
    parts.push(`background:linear-gradient(${direction}, ${gradient[0]}, ${gradient[1]})`);
  } else {
    const fill = hexColor(props, 'color');
    if (fill !== null) parts.push(`background-color:${fill}`);
  }
  const shadow = numericProp(props, 'shadow');
  if (shadow !== null && shadow > 0) {
    parts.push(`box-shadow:0 ${shadow}px ${shadow}px rgba(0, 0, 0, 0.15)`);
  }
  const opacity = numericProp(props, 'opacity');
  if (opacity !== null && opacity <= 1024) {
    parts.push(`opacity:${Math.round(opacity * 1000 / 1024) / 1000}`);
  }
  // Boundary props are opt-in render hints: the browser composites them via
  // CSS containment. A node declaring neither keeps its exact prior style.
  const containment = [];
  if (props.relayoutBoundary === true) containment.push('layout');
  if (props.repaintBoundary === true) containment.push('paint');
  if (containment.length > 0) parts.push(`contain:${containment.join(' ')}`);
  if (role === 'heading' || TEXT_TAGS.test(tag)) {
    parts.push(`font-size:${textFontSize(node)}px`);
  }
  if (tag === 'img') {
    parts.push(`object-fit:${FIT_VALUES.has(props.fit) ? props.fit : 'contain'}`);
  }
  return parts.join('; ');
}

/* Content-bearing tags carry their accessible name as text; container tags
 * instead expose children (and an aria-label when they have no text). */
function contentFor(tag) {
  return tag === 'button' || TEXT_TAGS.test(tag);
}

/* Glass is a class so the shared CSS carries the frost, border, shadow and
 * backdrop-filter; explicit inline props still win over the class rule. */
function nodeClass(node) {
  return `node ${node.kind.toLowerCase()}${node.props.glass === true ? ' glass' : ''}`;
}

/* Source-bearing Image nodes lower to a void img. The alt channel reuses the
 * contract label chain; dimensions are emitted only when IR declares them. */
function imageAttrs(node, decls, catalog) {
  const attrs = [`src="${escapeHtml(String(node.props.src))}"`];
  attrs.push(`alt="${escapeHtml(interpolate(labelOf(node), decls, catalog))}"`);
  for (const key of ['width', 'height']) {
    const value = numericProp(node.props, key);
    if (value !== null) attrs.push(`${key}="${value}"`);
  }
  attrs.push('loading="lazy"');
  return attrs;
}

/* Build a name -> {viewBox, paths} map from the IR `icons` list so both the
 * single-page and multi-page renderers resolve package icons by name. */
function iconTable(ir) {
  const map = new Map();
  const list = Array.isArray(ir.icons) ? ir.icons : [];
  for (const record of list) {
    if (record && typeof record.name === 'string') map.set(record.name, record);
  }
  return map;
}

/* Render an Icon node as an inline SVG from the IR `icons` table. The compiler
 * embeds each referenced package icon as {name, viewBox, paths:[d]}; built-in
 * names absent from the table fall back to a neutral outline so layout is
 * stable. viewBox defaults to the Tabler 24x24 box when unset. */
function iconSvg(name, icons, size) {
  const record = icons ? icons.get(name) : undefined;
  const viewBox = (record && record.viewBox) || '0 0 24 24';
  const px = size || 24;
  const paths = record && Array.isArray(record.paths) ? record.paths : [];
  const inner = paths
    .map((d) => `<path d="${escapeHtml(d)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  return `<svg class="icon" role="img" aria-label="${escapeHtml(name)}" width="${px}" height="${px}" viewBox="${escapeHtml(viewBox)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function renderNode(node, decls, icons, catalog, themeRadius) {
  if (!initiallyVisible(node, decls)) return '';
  const role = effectiveRole(node);
  const tag = tagFor(node, role);
  if (node.kind === 'Icon') {
    const name = typeof node.props.name === 'string' ? node.props.name : '';
    const size = numericProp(node.props, 'size');
    return iconSvg(name, icons, size);
  }
  if (node.kind === 'For') {
    // Single-page output ships no action runtime, so expand the list at
    // compile time: one row per init element with the item bound per row.
    const decl = decls.get(node.props.source);
    const list = decl !== undefined && Array.isArray(decl.init) ? decl.init : [];
    const rows = list
      .map((value) => {
        const bound = new Map(decls);
        bound.set(node.props.item, { init: value });
        return node.children.map((child) => renderNode(child, bound, icons, catalog, themeRadius)).join('');
      })
      .join('');
    return `<div data-node-id="${node.id}" role="${role}" class="node for">${rows}</div>`;
  }
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="${escapeHtml(nodeClass(node))}"`,
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
  const style = styleFor(node, role, tag, themeRadius);
  if (style !== '') attrs.push(`style="${escapeHtml(style)}"`);
  if (tag === 'img') attrs.push(...imageAttrs(node, decls, catalog));

  const hasContent = contentFor(tag);
  if (!hasContent && tag !== 'img') {
    const label = labelOf(node);
    if (label !== '') attrs.push(`aria-label="${escapeHtml(interpolate(label, decls, catalog))}"`);
  }

  const open = `<${tag} ${attrs.join(' ')}>`;
  if (tag === 'input' || tag === 'img') return open;
  const inner = hasContent
    ? escapeHtml(interpolate(labelOf(node), decls, catalog))
    : node.children.map((child) => renderNode(child, decls, icons, catalog, themeRadius)).join('');
  return `${open}${inner}</${tag}>`;
}

/* Data attributes that let the runtime router replay a node's actions: the
 * action list is JSON on `data-actions`, and input/textarea nodes carry their
 * bound state name on `data-bind`. Container `when` guards become
 * `data-when` so the router can show/hide subtrees as state changes. */
function runtimeAttrs(node, catalog) {
  const parts = [];
  if (node.when !== undefined) parts.push(`data-when="${escapeHtml(node.when)}"`);
  if (node.events && Object.keys(node.events).length > 0) {
    const actions = [];
    const effects = [];
    for (const contract of Object.values(node.events)) {
      // @locale is a reserved patch, not state: emit-time catalogs are fixed,
      // so the DOM runtime never applies it to its state mirror.
      const keep = (action) => !(action !== null && typeof action === 'object'
        && action.op === 'set' && action.target === '@locale');
      if (Array.isArray(contract.actions)) actions.push(...contract.actions.filter(keep));
      else if (contract.op !== undefined && keep(contract)) actions.push(contract);
      if (Array.isArray(contract.effects)) effects.push(...contract.effects);
    }
    parts.push(`data-actions='${escapeHtml(JSON.stringify(actions))}'`);
    if (effects.length > 0) {
      parts.push(`data-effects='${escapeHtml(JSON.stringify(effects))}'`);
    }
  }
  if (typeof node.props.bind === 'string') parts.push(`data-bind="${escapeHtml(node.props.bind)}"`);
  // Raw template for labels bound to state: baked text/aria-label hold the
  // compile-time values, so the router re-renders from this at runtime.
  const label = labelOf(node);
  if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(label)) parts.push(`data-label="${escapeHtml(interpolateCatalog(label, catalog))}"`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/* Multi-page render: every route becomes its own <section data-route>, the
 * initial route visible and the rest hidden. Each node also carries the
 * runtime attributes above so the router script can navigate and mutate. */
function renderRouteNode(node, decls, icons, catalog, themeRadius) {
  if (!initiallyVisible(node, decls)) {
    // Still emit a hidden stub carrying the guard so the router can reveal it
    // once the guard state flips at runtime; the children render inside.
    const hidden = renderRouteNode({ ...node, when: undefined }, decls, icons, catalog, themeRadius)
      .replace(/<(\w+) /, `<$1 data-when="${escapeHtml(node.when)}" hidden `);
    return hidden;
  }
  if (node.kind === 'Icon') {
    const name = typeof node.props.name === 'string' ? node.props.name : '';
    const size = numericProp(node.props, 'size');
    return iconSvg(name, icons, size);
  }
  if (node.kind === 'For') {
    // One inert <template> per loop; the router clones it once per list element.
    // The node carries its contract attrs so the facts snapshot pins the region.
    const source = typeof node.props.source === 'string' ? node.props.source : '';
    const item = typeof node.props.item === 'string' ? node.props.item : '';
    const inner = node.children.map((child) => renderRouteNode(child, decls, icons, catalog, themeRadius)).join('');
    return `<template data-node-id="${node.id}" role="none" class="node for" data-for="${escapeHtml(source)}" data-item="${escapeHtml(item)}" data-for-region="${node.id}">${inner}</template>`;
  }
  const role = effectiveRole(node);
  const tag = tagFor(node, role);
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="${escapeHtml(nodeClass(node))}"`,
  ];
  if (role === 'heading') attrs.push('aria-level="2"');
  if (tag === 'button') attrs.push('type="button"');
  if (tag === 'input') {
    const inputType = node.kind === 'Slider' ? 'range' : 'text';
    attrs.push(`type="${inputType}"`);
    if (node.kind === 'Slider') {
      for (const key of ['min', 'max']) {
        const value = numericProp(node.props, key);
        if (value !== null) attrs.push(`${key}="${value}"`);
      }
    } else if (typeof node.props.placeholder === 'string') {
      attrs.push(`placeholder="${escapeHtml(node.props.placeholder)}"`);
    }
  }
  const style = styleFor(node, role, tag, themeRadius);
  if (style !== '') attrs.push(`style="${escapeHtml(style)}"`);
  if (tag === 'img') attrs.push(...imageAttrs(node, decls, catalog));
  const hasContent = contentFor(tag);
  if (!hasContent && tag !== 'img') {
    const label = labelOf(node);
    if (label !== '') attrs.push(`aria-label="${escapeHtml(interpolate(label, decls, catalog))}"`);
  }
  const open = `<${tag} ${attrs.join(' ')}${runtimeAttrs(node, catalog)}>`;
  if (tag === 'input' || tag === 'img') return open;
  const inner = hasContent
    ? escapeHtml(interpolate(labelOf(node), decls, catalog))
    : node.children.map((child) => renderRouteNode(child, decls, icons, catalog, themeRadius)).join('');
  return `${open}${inner}</${tag}>`;
}

function renderMultiPage(ir, contract) {
  const decls = stateMap(ir);
  const iconMap = iconTable(ir);
  const themeRadius = numericProp(ir.theme, 'radius') ?? 0;
  const sections = Object.keys(ir.routes).map((name) => {
    const route = ir.routes[name];
    const hidden = name === ir.initialRoute ? '' : ' hidden';
    return `<section class="route" data-route="${escapeHtml(name)}" aria-label="${escapeHtml(route.title)}"${hidden}>${renderRouteNode(route.tree, decls, iconMap, catalogOf(ir), themeRadius)}</section>`;
  });
  return [
    '<!DOCTYPE html>',
    `<html lang="en"${ir.directionality === 'rtl' ? ' dir="rtl"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(ir.app)}</title>`,
    '<meta id="opurom-verify" name="opurom-verify">',
    '<style>',
    cssFor(ir, contract),
    '</style>',
    '</head>',
    '<body>',
    '<header class="app-header">',
    `<h1>${escapeHtml(ir.app)}</h1>`,
    `<canvas id="fx" width="${contract.width}" height="${contract.height}" role="img" aria-label="Deterministic theme gradient"></canvas>`,
    '</header>',
    '<main id="app">',
    sections.join(''),
    '</main>',
    '<script>',
    pageScript(contract, ir),
    multiPageRouter(ir),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}


function hasSourceImage(node) {
  if (node === undefined || node === null) return false;
  if (node.kind === 'Image' && typeof node.props.src === 'string' && node.props.src !== '') return true;
  return (node.children ?? []).some((child) => hasSourceImage(child));
}

function irHasSourceImage(ir) {
  if (hasSourceImage(ir.tree)) return true;
  if (ir.routes === undefined) return false;
  return Object.values(ir.routes).some((route) => hasSourceImage(route.tree));
}

function hasGlassNode(node) {
  if (node === undefined || node === null) return false;
  if (node.props.glass === true) return true;
  return (node.children ?? []).some((child) => hasGlassNode(child));
}

function irHasGlass(ir) {
  if (hasGlassNode(ir.tree)) return true;
  if (ir.routes === undefined) return false;
  return Object.values(ir.routes).some((route) => hasGlassNode(route.tree));
}

function cssFor(ir, contract) {
  const surface = `rgb(${contract.bottom.join(', ')})`;
  const ink = `rgb(${contract.border.join(', ')})`;
  // Placeholder sizing is the default. A source-bearing img overrides only its
  // own box so declared width/height attributes and object-fit take effect.
  const imageRule = irHasSourceImage(ir) ? '\nimg.image { width: auto; height: auto; border: 0; }' : '';
  // Glass: translucent frost always renders; backdrop-filter is progressive.
  // Without it the fill stays translucent over the theme canvas gradient.
  const dark = ir.theme.mode === 'dark';
  const frost = dark ? 'rgba(30, 35, 46, 0.38)' : 'rgba(255, 255, 255, 0.42)';
  const glassBorder = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.5)';
  const glassRule = irHasGlass(ir)
    ? `\n.glass { background:${frost}; border:1px solid ${glassBorder}; box-shadow:0 2px 8px rgba(17, 24, 39, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.75), inset 0 -1px 0 rgba(0, 0, 0, 0.06); -webkit-backdrop-filter:blur(12px) saturate(140%); backdrop-filter:blur(12px) saturate(140%); }`
    : '';
  return `
:root { --accent: ${ir.theme.accent}; --radius: ${ir.theme.radius}px; --surface: ${surface}; --ink: ${ink}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif;${ir.directionality === 'rtl' ? ' direction: rtl;' : ''} }
header.app-header { display: block; padding: 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.12); }
header.app-header h1 { margin: 0 0 12px; font-size: 20px; }
main#app { display: block; padding: 16px; }
#fx { display: block; width: ${contract.width}px; height: ${contract.height}px; border-radius: var(--radius); background: var(--surface); }
.column { display: flex; flex-direction: column; }
.row { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; }
button { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; border: none; border-radius: var(--radius); background-color: var(--accent); color: #ffffff; font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
input { font: inherit; padding: 6px 8px; border: 1px solid rgba(0, 0, 0, 0.25); border-radius: var(--radius); }
p, h1, h2, h3 { line-height: 1.35; }
.image { display: inline-block; width: 64px; height: 64px; border: 1px dashed rgba(0, 0, 0, 0.35); }${imageRule}${glassRule}
@media (max-width: 600px) {
  header.app-header, main#app { padding: 12px; }
  #fx { width: 100%; height: auto; }
}
`.trim();
}

export function renderHtml(ir, contract) {
  if (ir.routes !== undefined && ir.initialRoute !== undefined) {
    return renderMultiPage(ir, contract);
  }
  const decls = stateMap(ir);
  const iconMap = iconTable(ir);
  const themeRadius = numericProp(ir.theme, 'radius') ?? 0;
  return [
    '<!DOCTYPE html>',
    `<html lang="en"${ir.directionality === 'rtl' ? ' dir="rtl"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(ir.app)}</title>`,
    '<meta id="opurom-verify" name="opurom-verify">',
    '<style>',
    cssFor(ir, contract),
    '</style>',
    '</head>',
    '<body>',
    '<header class="app-header">',
    `<h1>${escapeHtml(ir.app)}</h1>`,
    `<canvas id="fx" width="${contract.width}" height="${contract.height}" role="img" aria-label="Deterministic theme gradient"></canvas>`,
    '</header>',
    '<main id="app">',
    renderNode(ir.tree, decls, iconMap, catalogOf(ir), themeRadius),
    '</main>',
    '<script>',
    pageScript(contract, ir),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function emitFromIr(ir, outDir) {
  validateIr(ir);
  const resolved = resolveOutDir(outDir);
  const contract = gradientSpec(ir);
  const html = renderHtml(ir, contract);
  const indexPath = path.join(resolved, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');
  return { indexPath, bytes: Buffer.byteLength(html), html };
}

export { escapeHtml };

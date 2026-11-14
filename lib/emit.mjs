/* Compile-time IR -> standalone index.html emitter.
 *
 * All IR interpretation happens HERE, in Node: tag mapping, a11y roles,
 * interpolation, layout props and the gradient spec are baked into static
 * HTML/CSS/JS. The emitted page never sees the IR document. */

import fs from 'node:fs';
import path from 'node:path';

import { contentBearing, effectiveRole, interpolate, initiallyVisible, labelOf, stateMap, tagFor, textFontSize, TEXT_TAGS, visibleNodes } from './a11y.mjs';
import { DEFAULT_ICON_SIZE, FALLBACK_ICON_PATH, iconPath } from './icons.mjs';
import { validateIr } from './ir.mjs';
import { gradientSpec, parseHexColor, particleDots } from './spec.mjs';
import { designCss } from './design.mjs';
import { gestureNames, normalizeActions, pageScript } from './page-source.mjs';

const ALIGN_VALUES = new Set(['start', 'center', 'end', 'stretch']);
const IMAGE_FITS = new Set(['contain', 'cover', 'fill']);

/* A neutral tile for an Image without src; it stays self-contained and avoids
 * an external placeholder file. */
const IMAGE_PLACEHOLDER_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOoaJnzHwAFqAKYOwcf8AAAAABJRU5ErkJggg==';

/* Accessible name of the painted gradient panel; exported so verify asserts
 * the label the page actually reports against the label it was emitted with. */
export const CANVAS_ARIA_LABEL = 'Deterministic theme gradient';

/* Official 64x64 framework favicon, inlined as a data URI so the emitted page
 * stays a single standalone index.html with no side files. */
export const FAVICON_DATA_URI = 'data:image/png;base64,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';

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

/* Kinds whose `color` prop is a surface/fill (opurom-render fill_and_border).
 * Text, Icon, Spacer, Divider, Spinner, Progress and Slider keep `color` as a
 * foreground/track color instead, so they are excluded here. */
const FILL_KINDS = new Set([
  'Column', 'Row', 'Container', 'Card', 'List', 'Grid', 'Scroll', 'Dialog',
  'Input', 'Image', 'Switch', 'Checkbox', 'Radio', 'Tabs', 'Button', 'Badge',
  'Avatar', 'Table', 'Chart', 'Calendar', 'RichText', 'Player', 'Map',
  'Menu', 'Tooltip', 'Extended',
]);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/* Canonical style props arrive as strings; unsupported values are ignored so a
 * bad literal never becomes CSS. */
function hexColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : null;
}

/* `gradient` is a "#RRGGBB,#RRGGBB" two-stop pair; the renderer paints it top
 * to bottom, so the CSS direction mirrors that. */
function gradientStops(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const top = hexColor(parts[0]);
  const bottom = hexColor(parts[1]);
  return top && bottom ? [top, bottom] : null;
}

/* `animate` is an entry curve: opurom-render's entry_transform grows the node's
 * box from its centre and fades it in, so the page mirrors it with one shared
 * keyframe animation. The duration is fixed so a replayed page is reproducible;
 * `none` (and any unsupported curve) stays static. */
const ENTRY_ANIMATION_MS = 480;
const ANIMATE_CURVES = new Set(['spring', 'ease', 'inertia', 'collision']);

/* Map the native curves to CSS timing functions. The spring curve is a
 * cubic-bezier approximation of the renderer's overshooting spring, not the
 * exact spring solution. */
const ENTRY_ANIMATION_CSS = `
@keyframes opurom-entry {
  from { transform: scale(0); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.anim-entry { transform-origin: center; animation: opurom-entry ${ENTRY_ANIMATION_MS}ms ease-out both; }
.anim-spring { animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
@media (prefers-reduced-motion: reduce) { .anim-entry { animation: none; } }
.anim-ease { animation-timing-function: ease-out; }
.anim-inertia { animation-timing-function: ease-in-out; }
.anim-collision { animation-timing-function: cubic-bezier(0.5, 1.6, 0.4, 1); }`.trim();

function entryAnimClass(node) {
  return ANIMATE_CURVES.has(node.props.animate) ? ` anim-entry anim-${node.props.animate}` : '';
}

/* Page transitions mirror Flutter's PageTransitionsBuilder: a slide, a fade or
 * a scale, applied to the page root when the IR's `transition` fires. The
 * keyframes are timing constants; only the class that matches the IR's own
 * `transition` is emitted, so IR without it keeps byte-identical CSS. */
const TRANSITION_KEYFRAMES = {
  slide: `@keyframes opurom-transition-slide {
  from { transform: translateX(40px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}`,
  fade: `@keyframes opurom-transition-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}`,
  scale: `@keyframes opurom-transition-scale {
  from { transform: scale(0.94); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}`,
};

function transitionCss(kind) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITION_KEYFRAMES, kind)) return '';
  return `#app { transform-origin: center; }
.opurom-transition-${kind} { animation: opurom-transition-${kind} 320ms cubic-bezier(0.2, 0, 0, 1) both; }
@media (prefers-reduced-motion: reduce) { .opurom-transition-${kind} { animation: none; } }
${TRANSITION_KEYFRAMES[kind]}`;
}

/* Deterministic control colors, mirroring opurom-render's raster constants.
 * The ink/line/land/bubble palettes are theme-independent; only the accent is
 * taken from the theme, so both painters agree on the controls. */
const RENDER_INK = '#1b1f27';
const RENDER_LINE = '#9098a8';
const RENDER_LIGHT = '#ffffff';
const RENDER_LAND = '#dfe6d8';
const RENDER_BUBBLE = '#242a38';
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const CHART_STAND_IN = [3, 8, 5, 10, 6, 4];

/* Kinds whose deterministic control is drawn by the DOM/SVG renderers below
 * instead of the generic empty container. */
const ADVANCED_KINDS = new Set([
  'Table', 'Chart', 'Calendar', 'Player', 'Map', 'Menu', 'Tabs', 'Spinner',
  'Tooltip', 'Divider',
]);

/* A numeric prop, clamped to the renderer's documented bound. */
function clampInt(props, key, fallback, min, max) {
  const raw = numericProp(props, key);
  const n = raw === null ? fallback : raw;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* Tab labels / menu items: an array of strings or one comma-separated string,
 * trimmed, matching opurom-render's labels_prop. */
function listProp(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    return value.split(',').map((p) => p.trim()).filter((p) => p !== '');
  }
  return [];
}

/* A chart value series: an array of integers or one comma-separated string. */
function intListProp(value) {
  if (Array.isArray(value)) return value.map((v) => Math.trunc(Number(v))).filter(Number.isFinite);
  if (typeof value === 'string') {
    return value.split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => Number.parseInt(p, 10))
      .filter(Number.isFinite);
  }
  return [];
}

/* lerp(accent, white, 1/2) in the renderer's fixed-point rounding. */
function mixHalfToWhite(hex) {
  const [r, g, b] = parseHexColor(hex);
  const mix = (c) => c + Math.floor((256 - c) / 2);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/* A vertical separator at the cell's right edge: the renderer draws one
 * between columns (c = 1..cols-1), so the last column has no outer border. */
function rightSeparator(isLast) {
  return isLast ? '' : `border-right:1px solid ${RENDER_LINE};`;
}

function renderTable(node) {
  const props = node.props;
  const cols = clampInt(props, 'columns', 3, 1, 16);
  const rows = clampInt(props, 'rows', 3, 1, 16);
  const headers = listProp(props.labels);
  const head = [...Array(cols)]
    .map((_, c) => `<th style="background:var(--accent);color:${RENDER_LIGHT};${rightSeparator(c === cols - 1)}">${escapeHtml(headers[c] ?? '')}</th>`)
    .join('');
  const body = [];
  let num = 1;
  for (let r = 0; r < rows; r += 1) {
    const cells = [...Array(cols)]
      .map((_, c) => {
        const value = num;
        num += 1;
        return `<td style="color:${RENDER_INK};${rightSeparator(c === cols - 1)}border-top:1px solid ${RENDER_LINE}">${value}</td>`;
      })
      .join('');
    body.push(`<tr>${cells}</tr>`);
  }
  return `<table class="opu-table" style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed">` +
    `<thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

function renderChart(node, theme) {
  const values = intListProp(node.props.values);
  const series = values.length > 0 ? values : CHART_STAND_IN;
  const max = Math.max(1, ...series.map((v) => Math.max(0, v)));
  const count = series.length;
  const barW = 160 / count;
  const base = 99;
  const light = mixHalfToWhite(theme.accent);
  const bars = series
    .map((v, i) => {
      const h = Math.round((98 * Math.max(0, v)) / max);
      if (h <= 0) return '';
      const x = Math.round(i * barW);
      const fill = i % 2 === 0 ? 'var(--accent)' : light;
      return `<rect x="${x}" y="${base - h}" width="${Math.round(barW - 1)}" height="${h}" fill="${fill}"></rect>`;
    })
    .join('');
  return `<svg class="opu-chart" viewBox="0 0 160 100" preserveAspectRatio="none" style="width:100%;height:100%;display:block">` +
    `<line x1="0" y1="${base}" x2="160" y2="${base}" stroke="${RENDER_INK}" stroke-width="1"></line>${bars}</svg>`;
}

function renderCalendar(node) {
  const props = node.props;
  const cols = clampInt(props, 'columns', 7, 1, 9);
  const rows = clampInt(props, 'rows', 5, 1, 9);
  const head = [...Array(cols)]
    .map((_, c) => `<div style="background:var(--accent);color:${RENDER_LIGHT};${rightSeparator(c === cols - 1)}">${WEEKDAYS[c % 7]}</div>`)
    .join('');
  const body = [];
  let day = 1;
  const hc = 1 % cols;
  const hr = 2 % rows;
  for (let r = 0; r < rows; r += 1) {
    const cells = [...Array(cols)]
      .map((_, c) => {
        const value = day;
        day += 1;
        const today = c === hc && r === hr;
        const fill = today ? `background:var(--accent);color:${RENDER_LIGHT};` : `color:${RENDER_INK};`;
        return `<div style="${fill}${rightSeparator(c === cols - 1)}border-top:1px solid ${RENDER_LINE}">${value}</div>`;
      })
      .join('');
    body.push(cells);
  }
  return `<div class="opu-calendar" style="display:grid;grid-template-columns:repeat(${cols},1fr);` +
    `grid-template-rows:repeat(${rows + 1},1fr);width:100%;height:100%">${head}${body.join('')}</div>`;
}

function renderPlayer() {
  return `<div style="position:relative;width:100%;height:100%">` +
    `<div style="position:absolute;left:4px;right:4px;top:50%;height:2px;transform:translateY(-1px);background:${RENDER_LINE}"></div>` +
    `<div style="position:absolute;left:4px;top:50%;width:40%;height:2px;transform:translateY(-1px);background:var(--accent)"></div>` +
    `<svg viewBox="0 0 10 20" style="position:absolute;left:6px;top:50%;transform:translateY(-50%);height:50%;width:auto;fill:var(--accent)">` +
    `<polygon points="0,0 10,10 0,20"></polygon></svg>` +
    `<div style="position:absolute;left:calc(4px + 40%);top:50%;transform:translate(-50%,-50%);` +
    `width:6px;height:6px;border-radius:50%;background:var(--accent)"></div></div>`;
}

function renderMap() {
  const w = 160;
  const h = 100;
  const roads = [1, 2, 3].map((f) => {
    const x = (w * f) / 4;
    const y = (h * f) / 4;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${RENDER_LINE}" stroke-width="2"></line>` +
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${RENDER_LINE}" stroke-width="2"></line>`;
  }).join('');
  const cx = (5 * w) / 8;
  const cy = (3 * h) / 8;
  const r = Math.max(2, Math.min(h, w) / 5) / 2;
  return `<svg class="opu-map" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${RENDER_LAND}"></rect>${roads}` +
    `<line x1="0" y1="${h / 3}" x2="${w}" y2="${(2 * h) / 3}" stroke="var(--accent)" stroke-width="2"></line>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--accent)" stroke="${RENDER_LIGHT}" stroke-width="2"></circle></svg>`;
}

function renderMenu(node) {
  const items = listProp(node.props.items);
  const list = items.length > 0 ? items : ['File', 'Edit', 'View'];
  const rows = list
    .map((item, i) => {
      const head = i === 0;
      const fill = head ? `background:var(--accent);color:${RENDER_LIGHT};` : `color:${RENDER_INK};`;
      const sep = i + 1 < list.length ? `<div style="height:1px;background:${RENDER_LINE}"></div>` : '';
      return `<div style="flex:1;display:flex;align-items:center;padding-left:4px;${fill}">${escapeHtml(item)}</div>${sep}`;
    })
    .join('');
  return `<div style="display:flex;flex-direction:column;width:100%;height:100%">${rows}</div>`;
}

function renderTabs(node, decls) {
  // A labels prop may name a string state holding a comma list; resolve it so
  // the strip shows its entries rather than the state name.
  const raw = node.props.labels;
  const decl = typeof raw === 'string' && decls && decls.get(raw);
  const labels = listProp(decl && typeof decl.init === 'string' ? decl.init : raw);
  const selected = 0;
  const tabs = labels
    .map((label, i) => {
      const underline = i === selected ? `border-bottom:2px solid var(--accent);` : '';
      return `<div style="color:var(--accent);${underline}padding:0 8px;white-space:nowrap">${escapeHtml(label)}</div>`;
    })
    .join('');
  return `<div style="display:flex;flex-direction:row;align-items:flex-end;width:100%;height:100%">${tabs}</div>`;
}

function renderSpinner() {
  const cx = 50;
  const cy = 50;
  const rad = 48;
  // 8 compass directions; phase 0 leaves the top tick as the deterministic gap.
  const dirs = [[0, 1], [707, 707], [1000, 0], [707, -707], [0, -1], [-707, -707], [-1000, 0], [-707, 707]];
  const ticks = dirs.slice(1)
    .map(([dx, dy]) => {
      const x = cx + (dx / 1000) * (rad / 2) - 2;
      const y = cy + (dy / 1000) * (rad / 2) - 2;
      return `<rect x="${x}" y="${y}" width="4" height="4" fill="var(--accent)"></rect>`;
    })
    .join('');
  return `<svg class="opu-spinner" viewBox="0 0 100 100" style="width:100%;height:100%;display:block">` +
    `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="var(--accent)" stroke-width="2"></circle>${ticks}</svg>`;
}

function renderTooltip(node) {
  const text = typeof node.props.text === 'string' ? node.props.text
    : typeof node.props.label === 'string' ? node.props.label : '';
  return `<span class="opu-tooltip" style="display:inline-block;background:${RENDER_BUBBLE};` +
    `color:${RENDER_LIGHT};border:1px solid ${RENDER_LINE};border-radius:var(--radius);padding:4px 8px">` +
    `${escapeHtml(text)}</span>`;
}

/* Deterministic control content for the advanced kinds, mirroring
 * opurom-render's draw_control. Returns '' for Divider, whose 1px line is the
 * element's own style. */
function renderAdvanced(node, theme, decls) {
  switch (node.kind) {
    case 'Table': return renderTable(node);
    case 'Chart': return renderChart(node, theme);
    case 'Calendar': return renderCalendar(node);
    case 'Player': return renderPlayer();
    case 'Map': return renderMap();
    case 'Menu': return renderMenu(node);
    case 'Tabs': return renderTabs(node, decls);
    case 'Spinner': return renderSpinner();
    case 'Tooltip': return renderTooltip(node);
    default: return '';
  }
}

/* The renderer's integer-luminance contrast color: pure white on a dark fill,
 * pure black on a light one (opurom-render contrast_text). */
function contrastColor(hex) {
  const [r, g, b] = parseHexColor(hex);
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  return luminance < 128 ? '#ffffff' : '#000000';
}

function styleFor(node, role, tag, theme, surface) {
  const parts = [];
  const props = node.props;
  if (tag === 'div') {
    // An IR width becomes a fluid cap rather than a fixed pixel width, so a
    // resized window keeps the element filling its container up to that cap.
    const width = numericProp(props, 'width');
    if (width !== null && width > 0) parts.push(`max-width:${width}px`);
    const height = numericProp(props, 'height');
    if (height !== null && height > 0) parts.push(`min-height:${height}px`);
    const gap = numericProp(props, 'gap');
    if (gap !== null) parts.push(`gap:${gap}px`);
    const padding = numericProp(props, 'padding');
    if (padding !== null) parts.push(`padding:${padding}px`);
    const margin = numericProp(props, 'margin');
    if (margin !== null) parts.push(`margin:${margin}px`);
    if (ALIGN_VALUES.has(props.align)) parts.push(`align-items:${props.align}`);
    // The renderer rounds container corners and centres text-bearing leaves;
    // these carry the visual polish without affecting the verified roles.
    const radius = numericProp(props, 'radius');
    if (radius !== null && radius > 0) parts.push(`border-radius:${radius}px`);
    if (node.kind === 'Card' || node.kind === 'Container') parts.push('overflow:hidden');
  }
  if (tag === 'p') {
    parts.push('margin:0');
  }
  if (node.kind === 'Grid') {
    // A Grid's gutter prop drives the gap; the .grid class carries the default
    // and the fluid modifier is asserted by the responsive media rules.
    const gutter = numericProp(props, 'gutter');
    if (gutter !== null) parts.push(`gap:${gutter}px`);
  }
  if (node.kind === 'Icon') {
    // The Icon is an inline svg: size from the prop, colour from the prop or
    // the theme accent, centred in its node box.
    const size = numericProp(props, 'size') ?? DEFAULT_ICON_SIZE;
    const color = typeof props.color === 'string' && props.color !== '' ? props.color : theme.accent;
    parts.push(`display:block`, `width:${size}px`, `height:${size}px`, `color:${color}`, `align-self:center`);
  }
  if (node.kind === 'Badge') {
    // A topic pill stays one line in a horizontal row, never shrinking to wrap.
    parts.push('flex:none', 'white-space:nowrap', 'align-self:center',
      'background:#EEF0FF', 'color:#4F46E5', 'border-radius:999px',
      'padding:3px 10px', 'font-size:12px', 'font-weight:600', 'text-align:center');
  }
  if (node.kind === 'Spacer') parts.push('flex:none');
  // Per-node visual effects, mirroring opurom-render's fill/effects: a vertical
  // gradient wins over a flat background, then glass, then bg, then the fill
  // `color` for container kinds. Glass always contributes its blur.
  const stops = gradientStops(props.gradient);
  const glass = props.glass === true;
  const shadow = numericProp(props, 'shadow');
  const borderColor = hexColor(props.border);
  const bgColor = hexColor(props.bg);
  const fillColor = hexColor(props.color);
  // A Divider is a 1px filled line in the border color, with no box of its own.
  if (node.kind === 'Divider') {
    parts.push(`height:1px`, `background:${borderColor ?? RENDER_LINE}`);
    return parts.join('; ');
  }
  if (glass) parts.push(`backdrop-filter:blur(2px) saturate(1.5) contrast(1.12) brightness(1.04)`);
  // The node's own solid fill, matching how the background is chosen below and
  // the fill the renderer uses as the contrast-text background.
  const backgroundFill = stops ? stops[0] : (bgColor ?? (FILL_KINDS.has(node.kind) ? fillColor : null));
  if (stops) {
    parts.push(`background:linear-gradient(to bottom, ${stops[0]}, ${stops[1]})`);
  } else if (glass) {
    // Liquid glass: a thin translucent lamina over the stage. The backdrop
    // chain above refracts and slightly amplifies what is behind it instead of
    // only frosting it.
    const frost = theme.mode === 'dark' ? 'rgba(30, 35, 46, 0.38)' : 'rgba(255, 255, 255, 0.42)';
    parts.push(`background:${frost}`);
  } else if (backgroundFill) {
    parts.push(`background-color:${backgroundFill}`);
  }
  if (shadow !== null && shadow > 0) {
    // A layered, low-alpha shadow reads as depth rather than a hard drop edge.
    const tier = Math.min(3, Math.max(1, Math.round(shadow)));
    parts.push(`box-shadow:0 ${tier}px ${tier * 3}px rgba(17, 24, 39, 0.08), 0 ${tier * 2}px ${tier * 6}px rgba(17, 24, 39, 0.06)`);
  } else if (glass) {
    // Liquid glass depth: a soft drop, a specular top edge and a darker lower
    // interior, so the lamina reads as a thick glass tile over the stage.
    const edge = theme.mode === 'dark' ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.6)';
    parts.push('box-shadow:0 6px 22px rgba(17, 24, 39, 0.12), 0 1px 3px rgba(17, 24, 39, 0.08),'
      + ` inset 0 1px 0 ${edge}, inset 0 -12px 28px rgba(17, 24, 39, 0.07)`);
    parts.push(`border:1px solid ${theme.mode === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.5)'}`);
  }
  if (borderColor) parts.push(`border:1px solid ${borderColor}`);
  // Image and Avatar draw a soft tile: a fixed box with rounded corners. Image
  // carries its own width/height; an Avatar fills its wrapper with an initial.
  if (node.kind === 'Image' || node.kind === 'Avatar') {
    const w = numericProp(props, 'width');
    const h = numericProp(props, 'height');
    if (w !== null && w > 0) parts.push(`width:${w}px`, `max-width:100%`);
    if (h !== null && h > 0) parts.push(`height:${h}px`);
    // An unsized Avatar takes a compact fixed tile: 100% would fill the whole
    // row and collapse the identity line beside it.
    if (w === null && node.kind === 'Avatar') parts.push('width:40px', 'height:40px');
    const ir = numericProp(props, 'radius');
    parts.push(`border-radius:${ir !== null && ir > 0 ? ir : Math.max(8, Math.round((w ?? 40) / 4))}px`);
    parts.push('display:flex', 'align-items:center', 'justify-content:center', 'box-sizing:border-box');
    if (node.kind === 'Image' && IMAGE_FITS.has(props.fit)) parts.push(`object-fit:${props.fit}`);
    if (node.kind === 'Avatar') {
      // Decorative soft tile: the name stays in the DOM as text for assistive
      // tech but is not painted, so a small tile never shows clipped letters.
      parts.push('overflow:hidden', 'font-size:0', 'color:transparent',
        'background:linear-gradient(135deg, #DDE1F7, #C9D2F5)');
    }
  }
  // Buttons adopt a readable text colour from their own fill so a light chip
  // never renders white-on-white.
  if (tag === 'button' && backgroundFill) {
    parts.push(`color:${contrastColor(backgroundFill)}`);
  }
  // Hard-wrap long body text inside cards instead of letting it overflow.
  if (tag === 'p') parts.push('overflow-wrap:anywhere');
  // `highContrast` mirrors opurom-render: a 2px outline in the contrast color
  // of the node's own fill, and a text colour swapped to that contrast color.
  const highContrast = props.highContrast === true;
  if (highContrast && backgroundFill) {
    parts.push(`border:2px solid ${contrastColor(backgroundFill)}`);
  }
  // A `color` prop on a text-bearing node is the foreground, not a surface.
  if (TEXT_TAGS.test(tag)) {
    const textColor = hexColor(props.color);
    if (highContrast) {
      // Text on its own fill (or the page surface) flips to the contrast color.
      const behind = backgroundFill ?? (glass ? null : surface);
      if (behind) parts.push(`color:${contrastColor(behind)}`);
    } else if (textColor) {
      parts.push(`color:${textColor}`);
    }
  }
  if (role === 'heading' || TEXT_TAGS.test(tag)) {
    parts.push(`font-size:${textFontSize(node)}px`);
  }
  return parts.join('; ');
}

/* State plan for the runtime: split a label into literal parts and state-name
 * parts, so the emitted page can re-render a restored snapshot without an
 * unresolved `{name}` placeholder ever reaching its markup. */
function planParts(text) {
  const parts = [];
  let index = 0;
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > index) parts.push(text.slice(index, match.index));
    parts.push({ n: match[1] });
    index = match.index + match[0].length;
  }
  if (index < text.length) parts.push(text.slice(index));
  return parts;
}

/* Inline vector glyph for an Icon node: known names use their stroke path, and
 * an unknown name paints the neutral fallback disc. Both stay deterministic and
 * never throw. The accessible name is the icon name. */
function renderIcon(node, attrs, theme) {
  const props = node.props;
  const name = typeof props.name === 'string' ? props.name : '';
  const known = iconPath(name);
  const path = known ?? FALLBACK_ICON_PATH;
  const size = numericProp(props, 'size') ?? DEFAULT_ICON_SIZE;
  return `<svg ${attrs.join(' ')} viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="${known === null ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round"><path d="${escapeHtml(path)}"></path></svg>`;
}

/* Page surface as a hex color, for the highContrast text fallback when a text
 * node has no own fill. Mirrors the resolved gradientSpec bottom stop. */
function surfaceHex(spec) {
  return '#' + spec.bottom.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function renderNode(node, decls, plan, theme, surface) {
  if (!initiallyVisible(node, decls)) return '';
  const role = effectiveRole(node);
  const tag = tagFor(node, role);
  const rawLabel = labelOf(node);
  if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rawLabel)) {
    plan.push({ id: node.id, field: contentBearing(tag) ? 'text' : 'label', parts: planParts(rawLabel) });
  }
  const gridClass = gridColumnClass(node);
  const animClass = entryAnimClass(node);
  // A large authored width on a layout column is a desktop cap; tag it so the
  // compact tier can release it to full width (a phone has no 260px sidebar).
  const capWidth = numericProp(node.props, 'width');
  const capClass = capWidth !== null && capWidth >= 200
    && ['Column', 'Row', 'Card', 'Container'].includes(node.kind) ? ' cap-lg' : '';
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="node ${escapeHtml(node.kind.toLowerCase())}${gridClass ? ` ${gridClass}` : ''}${animClass}${capClass}"`,
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
  if (tag === 'img') {
    const src = typeof node.props.src === 'string' && node.props.src.trim() !== ''
      ? node.props.src
      : IMAGE_PLACEHOLDER_DATA_URI;
    attrs.push(`src="${escapeHtml(src)}"`, `alt="${escapeHtml(interpolate(labelOf(node), decls))}"`, 'loading="lazy"');
    for (const key of ['width', 'height']) {
      const value = numericProp(node.props, key);
      if (value !== null && value > 0) attrs.push(`${key}="${value}"`);
    }
  }
  if (typeof node.props.bind === 'string') {
    const bind = node.props.bind;
    if (tag === 'input') plan.push({ id: node.id, field: 'value', name: bind, type: decls.get(bind)?.type });
    if (node.kind === 'Switch' || node.kind === 'Checkbox') plan.push({ id: node.id, field: 'checked', name: bind });
  }
  const style = styleFor(node, role, tag, theme, surface);
  if (style !== '') attrs.push(`style="${escapeHtml(style)}"`);

  const hasContent = contentBearing(tag);
  if (!hasContent) {
    const label = labelOf(node);
    if (label !== '') attrs.push(`aria-label="${escapeHtml(interpolate(label, decls))}"`);
  }

  const open = `<${tag} ${attrs.join(' ')}>`;
  if (tag === 'input' || tag === 'img') return open;
  if (tag === 'svg') return renderIcon(node, attrs, theme);
  // Advanced kinds draw their deterministic control from the same props the
  // native renderer uses, so both targets agree; children are ignored.
  const inner = ADVANCED_KINDS.has(node.kind)
    ? renderAdvanced(node, theme, decls)
    : (hasContent
      ? escapeHtml(interpolate(labelOf(node), decls))
      : node.children.map((child) => renderNode(child, decls, plan, theme, surface)).join(''));
  return `${open}${inner}</${tag}>`;
}

function cssFor(ir, spec) {
  const surface = `rgb(${spec.bottom.join(', ')})`;
  const ink = `rgb(${spec.border.join(', ')})`;
  // A liquid-glass stage: themes that adopt glass declare a `tokens.stage`
  // tint so translucent laminas have something to refract. Themes that do not
  // keep the stage identical to the surface, so every pinned token color and
  // the verify contract stay byte-identical.
  const stageToken = ir.theme.tokens && ir.theme.tokens.stage;
  const stage = stageToken
    ? `rgb(${[1, 3, 5].map((i) => parseInt(stageToken.slice(i, i + 2), 16)).join(', ')})`
    : surface;
  // A CSS font-family list resolves to the first installed family, so one
  // declaration renders PingFang on macOS, YaHei on Windows and Noto Sans CJK /
  // Roboto on Linux and Android without a per-OS branch. A theme fontFamily
  // leads the stack so a project can ship its own typeface.
  const systemStack = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft JhengHei', 'Segoe UI', Roboto, 'Noto Sans CJK SC', 'Source Han Sans SC', 'Noto Sans CJK JP', 'Helvetica Neue', Arial, sans-serif";
  const custom = ir.theme && ir.theme.fontFamily;
  const fontStack = custom ? `${custom}, ${systemStack}` : systemStack;
  const gridRules = gridColumnCounts(ir)
    .map((columns) => `.grid-cols-${columns} { grid-template-columns: repeat(${columns}, minmax(0, 1fr)); }`)
    .join('\n');
  const design = designCss(ir, spec);
  const transition = transitionCss(typeof ir.transition === 'string' ? ir.transition : '');
  return `
:root { --accent: ${ir.theme.accent}; --radius: ${ir.theme.radius}px; --surface: ${surface}; --stage: ${stage}; --ink: ${ink}; --font-ui: ${fontStack}; }
* { box-sizing: border-box; }
/* A flex/grid child defaults to min-width:auto, which lets an oversized fixed
 * child (e.g. a wide image) push the page past the viewport. Every node may
 * shrink below its content size, so a narrow column never overflows sideways. */
.node { min-width: 0; max-width: 100%; }
body { margin: 0; background: var(--stage); color: var(--ink); font-family: var(--font-ui); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
header.app-header { display: block; padding: 10px 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.06); }
header.app-header h1 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #9aa1ad; }
main#app { display: block; padding: 16px; }
#fx { display: block; width: ${spec.width}px; height: ${spec.height}px; border-radius: var(--radius); background: var(--surface); }
.fx-panel { position: relative; display: none; }
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
  .grid { grid-template-columns: 1fr; }
  /* Desktop-only width caps on layout columns must not leave a half-width
   * column on a phone; release them to the full column width. */
  .cap-lg { max-width: 100% !important; }
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
.image { display: inline-block; width: 64px; height: 64px; border: none; border-radius: 12px; background: rgba(120, 132, 156, 0.16); }
/* Rows wrap instead of force-stacking on phones: children keep their natural
 * size and drop to the next line only when the row runs out of width, so an
 * avatar line, a photo strip and an action row all survive a narrow column. */
/* A column or row nested in a row shares the line instead of claiming its
 * width:100% for itself (which would force every sibling onto the next line);
 * an inline fixed width, such as a 280px sidebar, is still respected. */
.row > .column, .row > .row { flex: 1 1 auto; width: auto; min-width: 0; }
#opurom-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
${ENTRY_ANIMATION_CSS}
${transition}
${design}
`.trim();
}

/* Runtime state changes are announced against the IR's initial values. */
function initialState(ir) {
  // List state is compile-time only, so it never enters the runtime snapshot.
  return Object.fromEntries(
    ir.state.filter((decl) => decl.type !== 'list').map((decl) => [decl.name, decl.init]),
  );
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

/* Runtime gesture wiring: every interactive node (a Button, or any node that
 * declares an event) gets the native gesture recognizers. Each recognized
 * gesture name maps to its ordered action list; a `nav` or `push` action instead
 * sets the `nav` flag that plays the page transition on tap. Compiled at emit time, so
 * the markup never carries handlers and identical IR stays byte-identical. */
function gestureBindings(ir) {
  const bindings = {};
  const walk = (node) => {
    if (!initiallyVisible(node, stateMap(ir))) return;
    const names = gestureNames(node.events);
    if (node.kind === 'Button' || Object.keys(node.events ?? {}).length > 0) {
      const map = {};
      let nav = false;
      for (const name of names) {
        const spec = node.events[name];
        // `nav` and `push` are pure navigation signals, not state changes:
        // they play the page transition and are kept out of the action list
        // the runtime executes.
        const actions = normalizeActions(spec);
        map[name] = actions.filter((action) => action.op !== 'nav' && action.op !== 'push');
        if (actions.some((action) => action.op === 'nav' || action.op === 'push')) nav = true;
      }
      if (nav) map.nav = true;
      bindings[node.id] = map;
    }
    for (const child of node.children) walk(child);
  };
  walk(ir.tree);
  return bindings;
}

export function renderHtml(ir, spec) {
  const decls = stateMap(ir);
  const plan = [];
  const gestures = gestureBindings(ir);
  const nav = {
    gestures,
    bindings: Object.keys(gestures).map(Number).map((id) => ({ id })),
    transition: typeof ir.transition === 'string' ? ir.transition : '',
  };
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(ir.app)}</title>`,
    `<link rel="icon" type="image/png" href="${FAVICON_DATA_URI}">`,
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
    renderNode(ir.tree, decls, plan, ir.theme, surfaceHex(spec)),
    '</main>',
    '<div id="opurom-live" role="status" aria-live="polite" aria-atomic="true"></div>',
    '<script>',
    pageScript(spec, initialState(ir), plan, nav),
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* Collect the static image references an IR emits: node `src` props plus the
 * string or list state that interpolation may resolve to at runtime. Paths
 * containing `{` are compile-time templates, not assets. */
function imageSources(ir) {
  const out = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const src = value.trim();
    if (src === '' || src.includes('{') || src.startsWith('data:')) return;
    out.add(src);
  };
  const walk = (node) => {
    if (node && node.props) add(node.props.src);
    for (const child of (node && node.children) || []) walk(child);
  };
  walk(ir.tree);
  for (const decl of ir.state || []) {
    const init = decl && decl.init;
    if (Array.isArray(init)) init.forEach(add);
    else add(init);
  }
  return out;
}

/* Resolve the directory an authored `src` is relative to. Assets commonly sit
 * in a project-level `assets/` while the IR lives in a nested app folder, so
 * walk up from the IR directory until the reference resolves to a real file.
 * Every candidate stays within `assetBase`'s own ancestor chain; `..` paths
 * and absolute paths are rejected up front. */
function findAssetRoot(src, assetBase) {
  const decoded = src.replace(/^(\.\/)+/, '');
  if (path.isAbsolute(decoded) || decoded.split(/[\\/]/).includes('..')) return null;
  let dir = path.resolve(assetBase);
  for (;;) {
    const source = path.resolve(dir, decoded);
    if (source.startsWith(dir + path.sep)) {
      try {
        if (fs.statSync(source).isFile()) return { decoded, source };
      } catch { /* keep walking up */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* Copy the referenced assets into the output directory so an emitted page is
 * self-contained. Only safe relative paths are followed: an authored IR must
 * never read outside its own project. Returns the copied relative paths. */
function copyAssets(ir, resolved, assetBase) {
  if (assetBase === undefined || assetBase === null) return [];
  const copied = [];
  for (const src of imageSources(ir)) {
    const found = findAssetRoot(src, assetBase);
    if (found === null) continue;
    const target = path.resolve(resolved, found.decoded);
    // The destination must stay under the output directory.
    if (target !== resolved && !target.startsWith(resolved + path.sep)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(found.source, target);
      copied.push(found.decoded);
    } catch {
      // A missing or unreadable asset stays a broken link rather than failing
      // the whole emit; the page still renders its accessible image tile.
    }
  }
  return copied;
}

export function emitFromIr(ir, outDir, opts = {}) {
  validateIr(ir);
  const resolved = resolveOutDir(outDir);
  const spec = gradientSpec(ir);
  const html = renderHtml(ir, spec);
  const indexPath = path.join(resolved, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');
  const assets = copyAssets(ir, resolved, opts.assetBase);
  return { indexPath, bytes: Buffer.byteLength(html), html, assets };
}

export { escapeHtml };

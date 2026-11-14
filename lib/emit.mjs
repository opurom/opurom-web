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

function renderTabs(node) {
  const labels = listProp(node.props.labels);
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
function renderAdvanced(node, theme) {
  switch (node.kind) {
    case 'Table': return renderTable(node);
    case 'Chart': return renderChart(node, theme);
    case 'Calendar': return renderCalendar(node);
    case 'Player': return renderPlayer();
    case 'Map': return renderMap();
    case 'Menu': return renderMenu(node);
    case 'Tabs': return renderTabs(node);
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
  if (node.kind === 'Icon') {
    // The Icon is an inline svg: size from the prop, colour from the prop or
    // the theme accent, centred in its node box.
    const size = numericProp(props, 'size') ?? DEFAULT_ICON_SIZE;
    const color = typeof props.color === 'string' && props.color !== '' ? props.color : theme.accent;
    parts.push(`display:block`, `width:${size}px`, `height:${size}px`, `color:${color}`, `align-self:center`);
  }
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
  if (glass) parts.push(`backdrop-filter:blur(6px)`);
  // The node's own solid fill, matching how the background is chosen below and
  // the fill the renderer uses as the contrast-text background.
  const backgroundFill = stops ? stops[0] : (bgColor ?? (FILL_KINDS.has(node.kind) ? fillColor : null));
  if (stops) {
    parts.push(`background:linear-gradient(to bottom, ${stops[0]}, ${stops[1]})`);
  } else if (glass) {
    // Frosted fill: a translucent layer over whatever is behind it. Dark mode
    // uses the dark surface so the frost reads against the dark palette.
    const frost = theme.mode === 'dark' ? 'rgba(17, 24, 39, 0.7)' : 'rgba(255, 255, 255, 0.7)';
    parts.push(`background:${frost}`);
  } else if (backgroundFill) {
    parts.push(`background-color:${backgroundFill}`);
  }
  if (shadow !== null && shadow > 0) {
    const spread = Math.min(8, Math.round(shadow));
    parts.push(`box-shadow:0 ${spread}px ${spread}px rgba(0, 0, 0, 0.15)`);
  }
  if (borderColor) parts.push(`border:1px solid ${borderColor}`);
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
  const attrs = [
    `data-node-id="${node.id}"`,
    `role="${role}"`,
    `class="node ${escapeHtml(node.kind.toLowerCase())}${gridClass ? ` ${gridClass}` : ''}${animClass}"`,
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
  if (tag === 'input') return open;
  if (tag === 'svg') return renderIcon(node, attrs, theme);
  // Advanced kinds draw their deterministic control from the same props the
  // native renderer uses, so both targets agree; children are ignored.
  const inner = ADVANCED_KINDS.has(node.kind)
    ? renderAdvanced(node, theme)
    : (hasContent
      ? escapeHtml(interpolate(labelOf(node), decls))
      : node.children.map((child) => renderNode(child, decls, plan, theme, surface)).join(''));
  return `${open}${inner}</${tag}>`;
}

function cssFor(ir, spec) {
  const surface = `rgb(${spec.bottom.join(', ')})`;
  const ink = `rgb(${spec.border.join(', ')})`;
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
:root { --accent: ${ir.theme.accent}; --radius: ${ir.theme.radius}px; --surface: ${surface}; --ink: ${ink}; --font-ui: ${fontStack}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font-family: var(--font-ui); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
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
 * gesture name maps to its ordered action list; a `nav` action instead sets the
 * `nav` flag that plays the page transition on tap. Compiled at emit time, so
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
        // A `nav` action is a pure navigation signal, not a state change: it
        // plays the page transition and is kept out of the action list the
        // runtime executes.
        const actions = normalizeActions(spec);
        map[name] = actions.filter((action) => action.op !== 'nav');
        if (actions.some((action) => action.op === 'nav')) nav = true;
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

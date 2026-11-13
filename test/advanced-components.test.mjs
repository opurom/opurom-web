/* Advanced controls: Table, Chart, Calendar, Player and Map (and the captain's
 * extension: Menu, Tabs, Spinner, Tooltip, Divider) render the same
 * deterministic content the native renderer draws, from the same IR props.
 * The regression test keeps the breakpoints, fluid grid, Icon svg, canvas layer
 * and entry animation intact. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

/* One column holding every advanced kind, with and without props. */
function advancedIr() {
  return ir(
    node(0, 'Column', { gap: 8 }, [
      node(1, 'Table', { columns: 3, rows: 2, labels: 'A,B,C' }, []),
      node(2, 'Chart', { type: 'bar' }, []),
      node(3, 'Calendar', { date: '2026-01-01' }, []),
      node(4, 'Player', {}, []),
      node(5, 'Map', {}, []),
      node(6, 'Menu', { items: 'A,B' }, []),
      node(7, 'Tabs', { labels: 'A,B,C' }, []),
      node(8, 'Spinner', {}, []),
      node(9, 'Tooltip', { text: 'hi' }, []),
      node(10, 'Divider', {}, []),
    ]),
  );
}

function emitted(irValue = advancedIr()) {
  const dir = tmpDir();
  const result = emitFromIr(irValue, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8') };
}

/* The sub-block for one node, balanced over nested tags so counts stay scoped
 * to a single control even when the control itself contains divs. */
function block(html, kind, tag = 'div') {
  const openRe = new RegExp(`<${tag}\\b[^>]*class="node ${kind}"[^>]*>`);
  const start = openRe.exec(html);
  if (!start) return '';
  const openTag = start[0];
  let depth = 1;
  let i = start.index + openTag.length;
  while (i < html.length) {
    const open = new RegExp(`<${tag}\\b`, 'g');
    const close = new RegExp(`</${tag}>`, 'g');
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) break;
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + o[0].length;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(start.index + openTag.length, c.index);
      i = c.index + c[0].length;
    }
  }
  return html.slice(start.index + openTag.length);
}

test('Table renders a real table with header row and numbered cell grid', () => {
  const { dir, html } = emitted();
  try {
    const table = block(html, 'table');
    assert.match(table, /<table class="opu-table"/);
    assert.match(table, /<thead>/);
    assert.match(table, /<tbody>/);
    assert.equal((table.match(/<th[ >]/g) ?? []).length, 3, 'one header per column');
    assert.equal((table.match(/<td[ >]/g) ?? []).length, 6, 'columns x rows data cells');
    assert.match(table, /A/);
    assert.match(table, /C/);
    // Cell numbers increment across the grid, row-major.
    assert.match(table, />1</);
    assert.match(table, />4</);
    assert.match(table, />6</);
    // Separators sit between columns only: (cols - 1) per row band.
    assert.equal(
      (table.match(/border-right:1px solid #9098a8/g) ?? []).length,
      (3 - 1) * (2 + 1),
      'one vertical separator between each adjacent column',
    );
  } finally {
    cleanup(dir);
  }
});

test('Table clamps columns and rows to the renderer bounds', () => {
  const { dir, html } = emitted(
    ir(node(0, 'Column', {}, [node(1, 'Table', { columns: 99, rows: 0 }, [])])),
  );
  try {
    const table = block(html, 'table');
    assert.equal((table.match(/<th[ >]/g) ?? []).length, 16, 'columns clamp to 16');
    assert.equal((table.match(/<td[ >]/g) ?? []).length, 16, 'rows clamp to 1');
  } finally {
    cleanup(dir);
  }
});

test('Chart renders one bar per value, with the deterministic stand-in', () => {
  const { dir, html } = emitted();
  try {
    const chart = block(html, 'chart');
    assert.match(chart, /<svg class="opu-chart"/);
    assert.match(chart, /<line[^>]*stroke="#1b1f27"/, 'baseline in ink');
    assert.equal((chart.match(/<rect/g) ?? []).length, 6, 'stand-in bars');
  } finally {
    cleanup(dir);
  }
  const withValues = emitted(
    ir(node(0, 'Column', {}, [node(1, 'Chart', { values: '1,2,3' }, [])])),
  );
  try {
    const chart = block(withValues.html, 'chart');
    assert.equal((chart.match(/<rect/g) ?? []).length, 3, 'one bar per explicit value');
  } finally {
    cleanup(withValues.dir);
  }
});

test('Calendar renders the weekday headers and the deterministic today cell', () => {
  const { dir, html } = emitted();
  try {
    const cal = block(html, 'calendar');
    assert.match(cal, /class="opu-calendar"/);
    assert.match(cal, /grid-template-columns:repeat\(7,1fr\)/);
    assert.match(cal, /grid-template-rows:repeat\(6,1fr\)/);
    for (const letter of ['S', 'M', 'T', 'W', 'F']) assert.match(cal, new RegExp(`>${letter}<`));
    // Native highlights cell (col 1, row 2): 2 * 7 + 1 + 1 = 16.
    const todayCell = cal.split('<div').find((cell) => cell.includes('">16<'));
    assert.ok(todayCell, 'the deterministic today cell is present');
    assert.match(todayCell, /background:var\(--accent\);color:#ffffff;/);
  } finally {
    cleanup(dir);
  }
});

test('Player renders a track, filled portion, play glyph and thumb', () => {
  const { dir, html } = emitted();
  try {
    const player = block(html, 'player');
    assert.match(player, /left:4px;right:4px/, 'track spans the box');
    assert.match(player, /background:#9098a8/, 'track in the line color');
    assert.match(player, /width:40%/, 'filled portion at 2/5');
    assert.match(player, /<polygon points="0,0 10,10 0,20"/, 'play glyph');
    assert.match(player, /border-radius:50%/, 'thumb');
  } finally {
    cleanup(dir);
  }
});

test('Map renders the land, road grid, diagonal and marker in SVG', () => {
  const { dir, html } = emitted();
  try {
    const map = block(html, 'map');
    assert.match(map, /<svg class="opu-map"/);
    assert.match(map, /fill="#dfe6d8"/, 'land background');
    assert.ok((map.match(/<line/g) ?? []).length >= 6, '3x3 road grid plus diagonal');
    assert.match(map, /<circle/, 'marker');
  } finally {
    cleanup(dir);
  }
});

test('Menu renders the items with the first row highlighted', () => {
  const { dir, html } = emitted();
  try {
    const menu = block(html, 'menu');
    assert.match(menu, /background:var\(--accent\);color:#ffffff;/);
    assert.match(menu, /flex:1/);
    assert.match(menu, />A</);
    assert.match(menu, />B</);
    assert.match(menu, /height:1px;background:#9098a8/, 'row separator');
  } finally {
    cleanup(dir);
  }
});

test('Tabs render the labels with the selected tab underlined', () => {
  const { dir, html } = emitted();
  try {
    const tabs = block(html, 'tabs');
    assert.match(tabs, /border-bottom:2px solid var\(--accent\)/);
    assert.match(tabs, />A</);
    assert.match(tabs, />C</);
  } finally {
    cleanup(dir);
  }
});

test('Spinner renders the ring with seven of the eight ticks', () => {
  const { dir, html } = emitted();
  try {
    const spinner = block(html, 'spinner');
    assert.match(spinner, /<svg class="opu-spinner"/);
    assert.match(spinner, /<circle[^>]*stroke="var\(--accent\)"/);
    assert.equal((spinner.match(/<rect/g) ?? []).length, 7, 'one gap leaves seven ticks');
  } finally {
    cleanup(dir);
  }
});

test('Tooltip renders its text in a bordered box', () => {
  const { dir, html } = emitted();
  try {
    const tooltip = block(html, 'tooltip');
    assert.match(tooltip, /class="opu-tooltip"/);
    assert.match(tooltip, /background:#242a38/);
    assert.match(tooltip, /border:1px solid #9098a8/);
    assert.match(tooltip, />hi</);
  } finally {
    cleanup(dir);
  }
});

test('Divider renders a 1px line in the border color', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /class="node divider" style="height:1px; background:#9098a8"/);
  } finally {
    cleanup(dir);
  }
  const bordered = emitted(ir(node(0, 'Column', {}, [node(1, 'Divider', { border: '#123456' }, [])])));
  try {
    assert.match(bordered.html, /class="node divider" style="height:1px; background:#123456"/);
  } finally {
    cleanup(bordered.dir);
  }
});

test('advanced nodes keep data-node-id, role, class and effect CSS', () => {
  const { dir, html } = emitted(
    ir(node(0, 'Column', {}, [
      node(1, 'Table', { columns: 2, rows: 1, bg: '#ffffff', border: '#E4E9F2', shadow: 2, animate: 'spring' }, []),
    ])),
  );
  try {
    assert.match(html, /<div data-node-id="1" role="none" class="node table anim-entry anim-spring"/);
    assert.match(html, /background-color:#ffffff/);
    assert.match(html, /border:1px solid #E4E9F2/);
    assert.match(html, /box-shadow:0 2px 2px rgba\(0, 0, 0, 0\.15\)/);
  } finally {
    cleanup(dir);
  }
});

test('breakpoints, fluid grid, Icon svg, canvas and entry animation stay intact', () => {
  const { dir, html } = emitted(
    ir(node(0, 'Column', {}, [
      node(1, 'Icon', { name: 'star' }, []),
      node(2, 'Grid', { columns: 2 }, [
        node(3, 'Table', { columns: 2, rows: 1 }, []),
        node(4, 'Map', {}, []),
      ]),
    ])),
  );
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    for (const px of ['599px', '600px', '900px', '1200px', '1600px']) {
      assert.ok(css.includes(px), `expected ${px} in the emitted CSS`);
    }
    assert.match(css, /\.grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); width: 100%; \}/);
    assert.match(css, /\.grid-cols-2 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(css, /@keyframes opurom-entry \{/);
    assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="star"/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /name="viewport"/);
  } finally {
    cleanup(dir);
  }
});

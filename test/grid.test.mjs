/* CSS grid layout: a Grid node emits a real CSS grid. Explicit column counts
 * map to grid-cols-N rules, an absent count becomes grid-fluid, the compact
 * tier collapses every grid to one column and the expanded tier makes the
 * fluid grid fill the width. The CSS assertions run with no browser; the
 * real-browser test evaluates the emitted rules at a compact and an expanded
 * viewport when a Chromium-family engine is available. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { browserEnvironmentFailure, findBrowser, runBrowser } from '../lib/browser.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

/* One explicit-count Grid (columns 3, gutter 14) and one fluid Grid (no
 * columns) so both modifier classes are exercised. */
function gridIr() {
  return ir(
    node(0, 'Column', {}, [
      node(1, 'Grid', { columns: 3, gutter: 14 }, [
        node(2, 'Card', {}, [node(3, 'Text', { value: 'a' })]),
        node(4, 'Card', {}, [node(5, 'Text', { value: 'b' })]),
        node(6, 'Card', {}, [node(7, 'Text', { value: 'c' })]),
      ]),
      node(8, 'Grid', {}, [
        node(9, 'Card', {}, [node(10, 'Text', { value: 'x' })]),
        node(11, 'Card', {}, [node(12, 'Text', { value: 'y' })]),
      ]),
    ]),
  );
}

/* Emit the fixture once and return the raw CSS block plus the whole page. */
function emitted() {
  const dir = tmpDir();
  const result = emitFromIr(gridIr(), dir);
  const html = fs.readFileSync(result.indexPath, 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  return { dir, html, css };
}

/* The whole media block for one query, matched by balanced braces. */
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `expected the ${query} media query`);
  let depth = 0;
  for (let index = start + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced @media ${query}`);
}

test('emitted CSS declares a real .grid rule with grid-template-columns', () => {
  const { dir, css } = emitted();
  try {
    assert.match(css, /\.grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); width: 100%; \}/);
    assert.match(css, /\.grid-cols-3 \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  } finally {
    cleanup(dir);
  }
});

test('Grid nodes carry the grid class, their count and the gutter gap', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /<div data-node-id="1" role="none" class="node grid grid-cols-3"[^>]*style="[^"]*gap:14px/);
    assert.match(html, /class="node grid grid-fluid"/, 'a Grid without an explicit count is fluid');
  } finally {
    cleanup(dir);
  }
});

test('the compact rule collapses grids to a single column', () => {
  const { dir, css } = emitted();
  try {
    const compact = mediaBlock(css, '(max-width: 599px)');
    assert.match(compact, /\.grid \{ grid-template-columns: 1fr; \}/);
    assert.doesNotMatch(compact, /grid-cols-3/, 'the compact tier must override explicit counts');
  } finally {
    cleanup(dir);
  }
});

test('the expanded rule makes the fluid grid fill the width', () => {
  const { dir, css } = emitted();
  try {
    const expanded = mediaBlock(css, '(min-width: 1200px)');
    assert.match(expanded, /\.grid-fluid \{ grid-template-columns: repeat\(auto-fill, minmax\(120px, 1fr\)\); \}/);
  } finally {
    cleanup(dir);
  }
});

test('the five breakpoints, .row rules and the canvas layer stay intact', () => {
  const { dir, css, html } = emitted();
  try {
    for (const px of ['599px', '600px', '900px', '1200px', '1600px']) {
      assert.ok(css.includes(px), `expected ${px} in the emitted CSS`);
    }
    assert.match(css, /\.row \{ display: flex; flex-direction: row; flex-wrap: wrap/);
    assert.match(css, /@media \(min-width: 600px\) \{[\s\S]*?\.row \{ flex-direction: row; align-items: center; \}/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
  } finally {
    cleanup(dir);
  }
});

test('a real browser collapses the grid at compact and fills it at expanded', async (t) => {
  const browser = findBrowser();
  if (browser.path === null) {
    t.skip(`headless browser unavailable: ${browser.reason}`);
    return;
  }
  const { dir, css } = emitted();
  try {
    // A probe page carries the exact emitted CSS and reports the computed
    // `grid-template-columns` of a fluid grid, so the media rules are
    // evaluated by a real engine.
    const probe = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><style>',
      css,
      '</style></head>',
      '<body><div class="grid grid-fluid"><span>a</span><span>b</span><span>c</span><span>d</span><span>e</span>',
      '<span>f</span><span>g</span><span>h</span><span>i</span><span>j</span><span>k</span><span>l</span>',
      '<script>document.documentElement.setAttribute(',
      "'data-cols', window.getComputedStyle(document.querySelector('.grid-fluid')).gridTemplateColumns.split(' ').length);",
      '</script></body>',
      '</html>',
      '',
    ].join('\n');
    const probePath = path.join(dir, 'probe.html');
    fs.writeFileSync(probePath, probe, 'utf8');
    const url = pathToFileURL(probePath).href;

    const compact = await runBrowser(browser.path, url, { windowSize: '480,600' });
    if (browserEnvironmentFailure(compact)) {
      t.skip(`headless browser could not start in this environment: ${compact.stderr.slice(0, 200)}`);
      return;
    }
    assert.equal(compact.code, 0, `compact run failed: ${compact.stderr}`);
    assert.match(compact.stdout, /data-cols="1"/);

    // The headless window is wider than its content viewport; the expanded
    // tier is the widest rule that fills, so a window well past 1200 must
    // produce several fluid columns rather than a single stacked column.
    const expanded = await runBrowser(browser.path, url, { windowSize: '1400,900' });
    assert.equal(expanded.code, 0, `expanded run failed: ${expanded.stderr}`);
    const cols = /data-cols="(\d+)"/.exec(expanded.stdout);
    assert.ok(cols, `no column count in expanded output: ${expanded.stdout}`);
    assert.ok(Number(cols[1]) >= 2, `expanded viewport produced ${cols[1]} columns, expected >= 2`);
  } finally {
    cleanup(dir);
  }
});

/* Icon rendering: an IR Icon node emits a real inline svg glyph. Known names
 * map to their path data, an unknown name paints the neutral fallback disc,
 * and the color/size props apply. A regression test keeps the responsive
 * breakpoints, the fluid grid, the responsive text and the canvas layer intact. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { browserEnvironmentFailure, findBrowser, runBrowser } from '../lib/browser.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { FALLBACK_ICON_PATH, ICON_NAMES, ICON_PATHS } from '../lib/icons.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

/* A labelled gallery: one known icon, one prop-driven icon, one unknown name,
 * and a Grid so the regression assertions have something to compare against. */
function iconIr() {
  return ir(
    node(0, 'Column', { gap: 12 }, [
      node(1, 'Icon', { name: 'star' }, []),
      node(2, 'Icon', { name: 'home', size: 20, color: '#ff0000' }, []),
      node(3, 'Icon', { name: 'not_a_real_icon' }, []),
      node(4, 'Grid', { columns: 2 }, [
        node(5, 'Icon', { name: 'check' }, []),
        node(6, 'Icon', { name: 'bell' }, []),
      ]),
    ]),
  );
}

/* Emit the fixture once and return the whole page plus each emitted svg. */
function emitted() {
  const dir = tmpDir();
  const result = emitFromIr(iconIr(), dir);
  const html = fs.readFileSync(result.indexPath, 'utf8');
  const svgs = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  return { dir, html, svgs };
}

test('every Icon node emits a non-empty inline svg with a path', () => {
  const { dir, svgs } = emitted();
  try {
    assert.equal(svgs.length, 5, 'one svg per Icon node');
    for (const svg of svgs) {
      assert.match(svg, /^<svg[^>]*>/);
      const path = /<path d="([^"]+)"/.exec(svg);
      assert.ok(path && path[1].length > 0, 'each svg must carry a non-empty path');
    }
  } finally {
    cleanup(dir);
  }
});

test('a known icon name maps to its canonical path data', () => {
  const { dir, svgs } = emitted();
  try {
    const star = svgs[0];
    assert.match(star, /aria-label="star"/);
    assert.ok(star.includes(ICON_PATHS.star), 'the star icon must carry the star path');
    assert.match(star, /fill="none"/);
  } finally {
    cleanup(dir);
  }
});

test('the icon table covers the canonical names and every path is non-empty', () => {
  assert.equal(ICON_NAMES.length, 31);
  assert.deepEqual([...ICON_NAMES].sort(), Object.keys(ICON_PATHS).sort());
  for (const name of ICON_NAMES) {
    assert.ok(ICON_PATHS[name].length > 0, `${name} has empty path data`);
  }
});

test('an unknown icon name renders the fallback without throwing', () => {
  const { dir, svgs } = emitted();
  try {
    const unknown = svgs[2];
    assert.match(unknown, /aria-label="not_a_real_icon"/);
    assert.ok(unknown.includes(FALLBACK_ICON_PATH), 'the fallback disc path must be painted');
    assert.match(unknown, /fill="currentColor"/);
    assert.doesNotMatch(unknown, /fill="none"/);
  } finally {
    cleanup(dir);
  }
});

test('icon size and color props apply, with size/color fallbacks', () => {
  const { dir, svgs } = emitted();
  try {
    const propIcon = svgs[1];
    assert.match(propIcon, /width:20px; height:20px/);
    assert.match(propIcon, /color:#ff0000/);
    assert.match(propIcon, /width="20" height="20"/);
    // A bare icon falls back to the theme accent and the default size.
    const bare = svgs[0];
    assert.match(bare, /width:16px; height:16px/);
    assert.match(bare, /color:#097FEB/);
  } finally {
    cleanup(dir);
  }
});

test('responsive breakpoints, fluid grid, text rules and the canvas layer stay intact', () => {
  const { dir, html, svgs } = emitted();
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    for (const px of ['599px', '600px', '900px', '1200px', '1600px']) {
      assert.ok(css.includes(px), `expected ${px} in the emitted CSS`);
    }
    assert.match(css, /\.grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); width: 100%; \}/);
    assert.match(css, /\.row \{ display: flex; flex-direction: row; flex-wrap: wrap/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.ok(svgs.length > 0, 'icons must still emit');
  } finally {
    cleanup(dir);
  }
});

test('a real browser reports the icon svg with its path', async (t) => {
  const browser = findBrowser();
  if (browser.path === null) {
    t.skip(`headless browser unavailable: ${browser.reason}`);
    return;
  }
  const { dir, html } = emitted();
  try {
    const probe = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="utf-8">',
      html.match(/<style>[\s\S]*?<\/style>/)[0],
      '</head>',
      '<body>',
      html.match(/<main id="app">[\s\S]*?<\/main>/)[0],
      '<script>',
      "var svg = document.querySelector('[data-node-id=\"1\"]');",
      "document.documentElement.setAttribute('data-svg', svg ? svg.tagName.toLowerCase() : 'none');",
      "document.documentElement.setAttribute('data-path', svg && svg.querySelector('path') ? svg.querySelector('path').getAttribute('d').length : 0);",
      "document.documentElement.setAttribute('data-aria', svg ? svg.getAttribute('aria-label') : 'none');",
      '</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
    const probePath = path.join(dir, 'probe.html');
    fs.writeFileSync(probePath, probe, 'utf8');
    const result = await runBrowser(browser.path, pathToFileURL(probePath).href, { windowSize: '1200,900' });
    if (browserEnvironmentFailure(result)) {
      t.skip(`headless browser could not start in this environment: ${result.stderr.slice(0, 200)}`);
      return;
    }
    assert.equal(result.code, 0, `browser run failed: ${result.stderr}`);
    assert.match(result.stdout, /data-svg="svg"/);
    assert.match(result.stdout, /data-path="[1-9][0-9]*"/);
    assert.match(result.stdout, /data-aria="star"/);
  } finally {
    cleanup(dir);
  }
});

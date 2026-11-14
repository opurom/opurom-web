/* Responsive layout: the emitted CSS mirrors the renderer's five logical-pixel
 * breakpoints and stacks rows on compact widths. The CSS assertions run with
 * no browser; the real-browser test evaluates the emitted rules at a compact
 * and a boundary viewport when a Chromium-family engine is available. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { browserEnvironmentFailure, findBrowser, runBrowser } from '../lib/browser.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

/* Emit the counter fixture once and return the raw CSS block it embeds. */
function emittedCss() {
  const dir = tmpDir();
  const result = emitFromIr(counterIr, dir);
  const html = fs.readFileSync(result.indexPath, 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  return { dir, html, css };
}

/* The compact rule and its `.row` direction, asserted as emitted CSS. */
function compactRule(css) {
  const match = css.match(/@media \(max-width: 599px\) \{([\s\S]*?)\}/);
  assert.ok(match, 'expected the compact media query');
  return match[0];
}

test('emitted CSS declares all five renderer breakpoints', () => {
  const { dir, css } = emittedCss();
  try {
    for (const px of ['599px', '600px', '900px', '1200px', '1600px']) {
      assert.ok(css.includes(px), `expected ${px} in the emitted CSS`);
    }
  } finally {
    cleanup(dir);
  }
});

test('rows wrap at every tier instead of force-stacking on phones', () => {
  const { dir, css } = emittedCss();
  try {
    // Children keep their natural size and drop to the next line only when the
    // row runs out of width, so avatar lines, photo strips and action rows
    // survive a narrow column without scattering into centered stacks.
    assert.match(css, /\.row \{[^}]*flex-wrap: wrap/);
    assert.doesNotMatch(css, /\.row \{[^}]*flex-direction: column/);
  } finally {
    cleanup(dir);
  }
});

test('an IR width is emitted as a fluid max-width cap', () => {
  const dir = tmpDir();
  try {
    const value = ir(
      node(0, 'Column', {}, [node(1, 'Row', { width: 320, gap: 8 }, [node(2, 'Text', { value: 'hi' })])]),
    );
    const result = emitFromIr(value, dir);
    const html = fs.readFileSync(result.indexPath, 'utf8');
    assert.match(html, /max-width:320px/, 'the IR width must become a fluid cap');
    assert.ok(
      !/(^|;)\s*width:320px/.test(html),
      'the IR width must not become a fixed pixel width',
    );
  } finally {
    cleanup(dir);
  }
});

test('emitted page keeps the canvas effect layer and the viewport meta', () => {
  const { dir, html } = emittedCss();
  try {
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /#fx \{ display: block; width: 480px; height: 270px/);
  } finally {
    cleanup(dir);
  }
});

test('a real browser stacks rows on a compact viewport', async (t) => {
  const browser = findBrowser();
  if (browser.path === null) {
    t.skip(`headless browser unavailable: ${browser.reason}`);
    return;
  }
  const { dir, css } = emittedCss();
  try {
    // A probe page carries the exact emitted CSS and reports the computed
    // `.row` direction, so the media rules are evaluated by a real engine.
    const probe = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><style>',
      css,
      '</style></head>',
      '<body><div class="row"><span>a</span><span>b</span></div>',
      '<script>document.documentElement.setAttribute(',
      "'data-flex', window.getComputedStyle(document.querySelector('.row')).flexDirection);",
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
    assert.match(compact.stdout, /data-flex="column"/);

    // Exactly 600 logical pixels is the first medium tier, so rows stay row.
    // The headless window is 8 px wider than its content viewport, so the
    // window size is raised to land the viewport exactly on the boundary.
    const boundary = await runBrowser(browser.path, url, { windowSize: '608,600' });
    assert.equal(boundary.code, 0, `boundary run failed: ${boundary.stderr}`);
    assert.match(boundary.stdout, /data-flex="row"/);
  } finally {
    cleanup(dir);
  }
});

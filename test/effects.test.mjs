/* Per-node visual effects: gradient, shadow, glass, bg and border lower into
 * the emitted inline CSS, mirroring opurom-render's fill/effects. The dashboard
 * end-to-end check counts the gradients and shadows the web-dom build now
 * produces, and a regression test keeps the breakpoints, fluid grid, Icon svg
 * and canvas layer intact. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, ROOT, tmpDir } from '../test-helpers/helpers.mjs';

/* One node carrying every effect prop, plus a text child to show the fill does
 * not leak onto text and the text colour stays a foreground. */
function effectIr(overrides = {}, theme = { mode: 'light', accent: '#097FEB', radius: 12 }) {
  return ir(
    node(0, 'Container', {
      gradient: '#097FEB,#043B70',
      shadow: 3,
      glass: true,
      bg: '#FFFFFF',
      border: '#E4E9F2',
      ...overrides,
    }, [
      node(1, 'Text', { value: 'hi', color: '#101828' }, []),
    ]),
    { theme },
  );
}

function emitted(irValue) {
  const dir = tmpDir();
  const result = emitFromIr(irValue, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8') };
}

test('gradient, shadow and border lower to the matching CSS', () => {
  const { dir, html } = emitted(effectIr({ glass: false }));
  try {
    assert.match(html, /background:linear-gradient\(to bottom, #097FEB, #043B70\)/);
    assert.match(html, /box-shadow:0 3px 9px rgba\(17, 24, 39, 0\.08\), 0 6px 18px rgba\(17, 24, 39, 0\.06\)/);
    assert.match(html, /border:1px solid #E4E9F2/);
  } finally {
    cleanup(dir);
  }
});

test('bg and container fill color lower to background-color', () => {
  const { dir, html } = emitted(effectIr({ gradient: undefined, shadow: undefined, glass: false, border: undefined }));
  try {
    // bg wins over the container fill color.
    assert.match(html, /background-color:#FFFFFF/);
    assert.doesNotMatch(html, /background-color:#1D4ED8/);
  } finally {
    cleanup(dir);
  }
  const fillOnly = emitted(effectIr({
    gradient: undefined, shadow: undefined, glass: false, border: undefined, bg: undefined, color: '#1D4ED8',
  }));
  try {
    assert.match(fillOnly.html, /background-color:#1D4ED8/);
  } finally {
    cleanup(fillOnly.dir);
  }
});

test('a gradient wins over a flat bg for the background', () => {
  const { dir, html } = emitted(effectIr({ glass: false }));
  try {
    assert.match(html, /background:linear-gradient\(to bottom, #097FEB, #043B70\)/);
    assert.doesNotMatch(html, /background-color:#FFFFFF/, 'the gradient must replace the flat background');
  } finally {
    cleanup(dir);
  }
});

test('glass lowers a blur and a translucent fill that follows the theme', () => {
  const light = emitted(effectIr({ gradient: undefined, shadow: undefined, border: undefined }));
  try {
    assert.match(light.html, /backdrop-filter:blur\(6px\)/);
    assert.match(light.html, /background:rgba\(255, 255, 255, 0\.7\)/);
  } finally {
    cleanup(light.dir);
  }
  const dark = emitted(effectIr(
    { gradient: undefined, shadow: undefined, border: undefined },
    { mode: 'dark', accent: '#097FEB', radius: 12 },
  ));
  try {
    assert.match(dark.html, /background:rgba\(17, 24, 39, 0\.7\)/);
  } finally {
    cleanup(dark.dir);
  }
});

test('shadow zero or absent emits no box-shadow', () => {
  const { dir, html } = emitted(effectIr({ shadow: 0, glass: false, gradient: undefined }));
  try {
    assert.doesNotMatch(html, /box-shadow/);
  } finally {
    cleanup(dir);
  }
  const none = emitted(effectIr({ shadow: undefined, glass: false, gradient: undefined }));
  try {
    assert.doesNotMatch(none.html, /box-shadow/);
  } finally {
    cleanup(none.dir);
  }
});

test('bad gradient and border literals are ignored; a shadow clamps to the renderer bound', () => {
  const { dir, html } = emitted(effectIr({
    gradient: 'not-a-gradient', border: 'blue', glass: false, shadow: 9,
  }));
  try {
    // The container node's inline style must drop the bad gradient and border
    // literals; the stylesheet's .image tile gradient is unrelated to this node.
    const nodeStyle = (html.match(/<div data-node-id="0"[^>]*style="([^"]*)"/) ?? ['', ''])[1];
    assert.doesNotMatch(nodeStyle, /linear-gradient/);
    assert.doesNotMatch(nodeStyle, /blue/);
    // The emitter caps the shadow tier at 3, so shadow 9 lowers to the layered 3 tier.
    assert.match(nodeStyle, /box-shadow:0 3px 9px rgba\(17, 24, 39, 0\.08\), 0 6px 18px rgba\(17, 24, 39, 0\.06\)/);
  } finally {
    cleanup(dir);
  }
});

test('the dashboard web-dom build now carries gradients and shadows', () => {
  const workspace = path.resolve(ROOT, '..');
  const cli = path.join(workspace, 'opurom-cli', 'bin', 'opurom.mjs');
  const src = path.join(workspace, 'opurom-examples', 'dashboard', 'main.opu');
  if (!fs.existsSync(cli) || !fs.existsSync(src)) {
    return;
  }
  const out = tmpDir();
  try {
    const result = spawnSync(process.execPath, [
      cli, 'build', '--src', src, '--target', 'web-dom', '--out', out,
    ], { encoding: 'utf8', timeout: 120_000, cwd: ROOT });
    assert.equal(result.status, 0, `dashboard build failed:\n${result.stdout}${result.stderr}`);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const gradients = (html.match(/linear-gradient/g) ?? []).length;
    const shadows = (html.match(/box-shadow/g) ?? []).length;
    assert.ok(gradients > 0, `expected linear-gradient occurrences, got ${gradients}`);
    assert.ok(shadows > 0, `expected box-shadow occurrences, got ${shadows}`);
  } finally {
    cleanup(out);
  }
});

test('breakpoints, fluid grid, Icon svg and the canvas layer stay intact', () => {
  const value = ir(
    node(0, 'Column', {}, [
      node(1, 'Icon', { name: 'star' }, []),
      node(2, 'Grid', { columns: 2 }, [
        node(3, 'Card', { bg: '#FFFFFF' }, []),
        node(4, 'Card', { bg: '#FFFFFF' }, []),
      ]),
    ]),
  );
  const { dir, html } = emitted(value);
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    for (const px of ['599px', '600px', '900px', '1200px', '1600px']) {
      assert.ok(css.includes(px), `expected ${px} in the emitted CSS`);
    }
    assert.match(css, /\.grid \{ display: grid; gap: 12px; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); width: 100%; \}/);
    assert.match(css, /\.grid-cols-2 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="star"/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /name="viewport"/);
  } finally {
    cleanup(dir);
  }
});

/* ---- highContrast: mirrors opurom-render's contrast_text fill/border swap ---- */

test('highContrast adds a 2px contrast border on a filled node', () => {
  const dark = emitted(ir(node(0, 'Container', { bg: '#112233', highContrast: true }, [])));
  try {
    // A dark fill gets a white outline.
    assert.match(dark.html, /background-color:#112233; border:2px solid #ffffff/);
  } finally {
    cleanup(dark.dir);
  }
  const light = emitted(ir(node(0, 'Container', { bg: '#EEEEEE', highContrast: true }, [])));
  try {
    // A light fill gets a black outline.
    assert.match(light.html, /background-color:#EEEEEE; border:2px solid #000000/);
  } finally {
    cleanup(light.dir);
  }
});

test('highContrast swaps a text node foreground to the contrast color', () => {
  const { dir, html } = emitted(ir(node(0, 'Column', {}, [
    node(1, 'Text', { value: 'hi', highContrast: true }, []),
  ])));
  try {
    // The fixture surface is light -> the contrast text color is black.
    assert.match(html, /<p data-node-id="1"[^>]*style="margin:0; overflow-wrap:anywhere; color:#000000; font-size:16px"/);
  } finally {
    cleanup(dir);
  }
});

test('a container with gradient and highContrast outlines the gradient top stop', () => {
  const { dir, html } = emitted(ir(node(0, 'Container', {
    gradient: '#112233,#334455', highContrast: true,
  }, [])));
  try {
    assert.match(html, /border:2px solid #ffffff/);
  } finally {
    cleanup(dir);
  }
});

test('a node without highContrast gets no border or colour swap', () => {
  const plain = emitted(ir(node(0, 'Column', {}, [
    node(1, 'Container', { bg: '#112233' }, []),
    node(2, 'Text', { value: 'plain' }, []),
  ])));
  try {
    assert.doesNotMatch(plain.html, /border:2px solid/);
    assert.doesNotMatch(plain.html, /color:#000000/);
    assert.doesNotMatch(plain.html, /color:#ffffff/);
  } finally {
    cleanup(plain.dir);
  }
});

test('highContrast outlines a container whose fill arrives as color', () => {
  // A Container's `bg` lowers to a fill `color`; the outline must still apply.
  const { dir, html } = emitted(ir(node(0, 'Container', { color: '#112233', highContrast: true }, [])));
  try {
    assert.match(html, /background-color:#112233; border:2px solid #ffffff/);
  } finally {
    cleanup(dir);
  }
});

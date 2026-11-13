/* Entry animations: a node whose `animate` prop is a supported curve emits a
 * shared keyframe animation that grows the box from its centre and fades it in,
 * mirroring opurom-render's entry_transform. `animate: none` and an unsupported
 * curve stay static. The counter build checks the end-to-end emission, and the
 * regression test keeps the breakpoints, fluid grid, Icon svg and canvas layer
 * intact. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, ROOT, tmpDir } from '../test-helpers/helpers.mjs';

function animIr() {
  return ir(
    node(0, 'Column', { gap: 8 }, [
      node(1, 'Container', { animate: 'spring', bg: '#FFFFFF' }, []),
      node(2, 'Container', { animate: 'none', bg: '#EEEEEE' }, []),
      node(3, 'Container', {}, []),
      node(4, 'Button', { animate: 'inertia', label: 'go' }, []),
      node(5, 'Container', { animate: 'ease', bg: '#FFFFFF' }, []),
    ]),
  );
}

function emitted(irValue = animIr()) {
  const dir = tmpDir();
  const result = emitFromIr(irValue, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8') };
}

test('a spring node gets the entry class and the spring timing function', () => {
  const { dir, html } = emitted();
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(css, /@keyframes opurom-entry \{/);
    assert.match(css, /from \{ transform: scale\(0\); opacity: 0; \}/);
    assert.match(css, /to \{ transform: scale\(1\); opacity: 1; \}/);
    assert.match(css, /animation: opurom-entry 480ms ease-out both;/);
    assert.match(css, /transform-origin: center;/);
    assert.match(css, /animation-timing-function: cubic-bezier\(0\.34, 1\.56, 0\.64, 1\);/);
    assert.match(html, /class="node container anim-entry anim-spring"/);
  } finally {
    cleanup(dir);
  }
});

test('animate none and an absent prop get no animation class', () => {
  const { dir, html } = emitted();
  try {
    const node2 = /<[a-z]+ data-node-id="2"[^>]*>/.exec(html);
    const node3 = /<[a-z]+ data-node-id="3"[^>]*>/.exec(html);
    assert.ok(node2 && node2[0].includes('class="node container"'), 'the none node must keep its plain class');
    assert.ok(node3 && node3[0].includes('class="node container"'), 'the no-prop node must keep its plain class');
    assert.doesNotMatch(node2[0], /anim-entry/);
    assert.doesNotMatch(node3[0], /anim-entry/);
  } finally {
    cleanup(dir);
  }
});

test('ease and inertia map to their documented timing functions', () => {
  const { dir, html } = emitted();
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(css, /animation-timing-function: ease-out;/);
    assert.match(css, /animation-timing-function: ease-in-out;/);
    assert.match(html, /class="node container anim-entry anim-ease"/);
    assert.match(html, /class="node button anim-entry anim-inertia"/);
  } finally {
    cleanup(dir);
  }
});

test('an unsupported curve stays static', () => {
  const { dir, html } = emitted(
    ir(node(0, 'Container', { animate: 'bounce' }, [])),
  );
  try {
    // The shared keyframes and class rules are always present; only the element
    // class list must stay free of the animation.
    assert.match(html, /\.anim-entry \{ transform-origin: center;/);
    assert.doesNotMatch(html, /class="node [^"]*anim-entry/);
  } finally {
    cleanup(dir);
  }
});

test('the counter web-dom build carries the keyframes and the animation classes', () => {
  const workspace = path.resolve(ROOT, '..');
  const cli = path.join(workspace, 'opurom-cli', 'bin', 'opurom.mjs');
  const src = path.join(workspace, 'opurom-examples', 'counter.opu');
  if (!fs.existsSync(cli) || !fs.existsSync(src)) {
    return;
  }
  const out = tmpDir();
  try {
    const result = spawnSync(process.execPath, [
      cli, 'build', '--src', src, '--target', 'web-dom', '--out', out,
    ], { encoding: 'utf8', timeout: 120_000, cwd: ROOT });
    assert.equal(result.status, 0, `counter build failed:\n${result.stdout}${result.stderr}`);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /@keyframes opurom-entry \{/);
    assert.match(html, /class="node container anim-entry anim-ease"/);
    assert.match(html, /class="node button anim-entry anim-spring"/);
    assert.ok((html.match(/anim-entry/g) ?? []).length >= 3, 'expected at least three animated nodes');
  } finally {
    cleanup(out);
  }
});

test('breakpoints, fluid grid, Icon svg and the canvas layer stay intact', () => {
  const { dir, html } = emitted(
    ir(node(0, 'Column', {}, [
      node(1, 'Icon', { name: 'star' }, []),
      node(2, 'Grid', { columns: 2 }, [
        node(3, 'Card', { animate: 'spring' }, []),
        node(4, 'Card', {}, []),
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
    assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="star"/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /name="viewport"/);
  } finally {
    cleanup(dir);
  }
});

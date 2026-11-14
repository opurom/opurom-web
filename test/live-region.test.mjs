/* ARIA live-region announcements: the emitted page's own inline script runs
 * against a minimal DOM stub, so these tests exercise the exact code the
 * browser runs. One change announces once, repeats announce nothing, and
 * user text never becomes markup. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

function emitted(value) {
  const dir = tmpDir();
  emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(path.join(dir, 'index.html'), 'utf8') };
}

/* Just enough DOM for the emitted script to paint, collect facts and install
 * window.opuromAnnounceState; the live region records every text assignment. */
function runPage(html) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1].trim();
  const writes = [];
  const markupWrites = [];
  const live = {
    set textContent(text) { writes.push(text); },
    set innerHTML(markup) { markupWrites.push(markup); },
  };
  const meta = { setAttribute() {} };
  const canvas = {
    width: 480,
    height: 270,
    getAttribute: () => null,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
  };
  const document = {
    title: 'Fixture',
    documentElement: { lang: 'en' },
    getElementById: (id) => ({ fx: canvas, 'opurom-live': live, 'opurom-verify': meta })[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  window.window = window;
  new Function('document', 'window', script)(document, window);
  return { announce: window.opuromAnnounceState, writes, markupWrites };
}

test('one state change produces exactly one live-region announcement', () => {
  const value = ir(node(0, 'Text', { value: 'Count: {count}' }), {
    state: [{ name: 'count', type: 'int', init: 0 }],
  });
  const { dir, html } = emitted(value);
  try {
    assert.match(html, /<div id="opurom-live" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
    const { announce, writes, markupWrites } = runPage(html);
    assert.equal(announce('count', 1), true);
    assert.deepEqual(writes, ['count: 1']);
    assert.deepEqual(markupWrites, []);
  } finally {
    cleanup(dir);
  }
});

test('repeated identical values and initial values produce no announcement', () => {
  const value = ir(node(0, 'Column', {}, [node(1, 'Text', { value: 'x' })]), {
    state: [
      { name: 'count', type: 'int', init: 0 },
      { name: 'note', type: 'string', init: 'hi' },
    ],
  });
  const { dir, html } = emitted(value);
  try {
    const { announce, writes } = runPage(html);
    assert.equal(announce('count', 0), false, 'initial value is not a change');
    assert.deepEqual(writes, []);
    assert.equal(announce('count', 1), true);
    assert.equal(announce('count', 1), false);
    assert.equal(announce('count', 1), false);
    assert.deepEqual(writes, ['count: 1']);
    assert.equal(announce('note', 'hi'), false, 'another state keeps its own last value');
    assert.equal(announce('note', 'bye'), true);
    assert.equal(announce('count', 2), true);
    assert.equal(announce('extra', 'x'), true, 'previously unseen names are tracked');
    assert.equal(announce('extra', 'x'), false);
    assert.deepEqual(writes, ['count: 1', 'note: bye', 'count: 2', 'extra: x']);
  } finally {
    cleanup(dir);
  }
});

test('announcement text is escaped and cannot inject markup', () => {
  const hostile = '</script><script>alert("x")</script> <img src=x onerror=alert(1)>';
  const value = ir(node(0, 'Text', { value: hostile }), {
    app: 'A<b>&"App"',
    state: [{ name: 'note', type: 'string', init: hostile }],
  });
  const { dir, html } = emitted(value);
  try {
    assert.equal(html.match(/<script/g)?.length ?? 0, 1, 'IR text must not add script tags');
    assert.equal(html.match(/<\/script>/g)?.length ?? 0, 1, 'IR text must not close the script');
    assert.ok(html.includes('\\u003c/script>'), 'embedded IR text must escape "<"');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    assert.ok(script.includes('live.textContent = text'), 'announcements must be written as text');
    assert.ok(!script.includes('innerHTML'), 'announcements must never write markup');
    const { announce, writes, markupWrites } = runPage(html);
    assert.equal(announce('note', '<b>bold</b> & more'), true);
    assert.equal(announce('<img src=x onerror=alert(1)>', 'v'), true);
    assert.deepEqual(writes, ['note: <b>bold</b> & more', '<img src=x onerror=alert(1)>: v']);
    assert.deepEqual(markupWrites, []);
  } finally {
    cleanup(dir);
  }
});

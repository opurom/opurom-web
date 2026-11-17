/* Boundary props are additive render hints (INCREMENTAL_RENDER_PIPELINE §5):
 * validation tolerates them, the DOM emitter maps them to opt-in CSS
 * containment, and programs declaring neither keep byte-identical output. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, multipageIr, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

test('emit tolerates both boundary props and maps them to CSS containment', () => {
  const value = ir(node(0, 'Column', { repaintBoundary: true, relayoutBoundary: true }, [
    node(1, 'Text', { value: 'inside', repaintBoundary: true }),
  ]));
  const { dir, html } = emit(value);
  try {
    assert.match(html, /class="node column" style="contain:layout paint">/);
    assert.match(html, /class="node text" style="contain:paint; font-size:16px">/, 'hints combine with prior styles');
  } finally {
    cleanup(dir);
  }
});

test('one boundary prop maps alone; truthy non-boolean values are ignored', () => {
  const value = ir(node(0, 'Column', { relayoutBoundary: true }, [
    node(1, 'Column', { repaintBoundary: true }),
    node(2, 'Column', { repaintBoundary: 'true', relayoutBoundary: 1 }),
  ]));
  const { dir, html } = emit(value);
  try {
    assert.match(html, /class="node column" style="contain:layout">/);
    assert.match(html, /class="node column" style="contain:paint">/);
    assert.ok(!/<div data-node-id="2"[^>]*style="[^"]*contain:/.test(html), 'non-boolean hints never become CSS');
  } finally {
    cleanup(dir);
  }
});

test('multi-page routes accept boundary props', () => {
  const home = node(0, 'Column', { repaintBoundary: true, gap: 8 }, [node(1, 'Text', { value: 'Home' })]);
  const value = multipageIr({ Home: { title: 'Home', tree: home } }, 'Home');
  const { dir, html } = emit(value);
  try {
    assert.match(html, /class="node column" style="gap:8px; contain:paint"/);
  } finally {
    cleanup(dir);
  }
});

test('a program without boundary props keeps its byte-identical golden', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    assert.equal(bytes, 6202);
    assert.ok(!html.includes('contain:'));
    assert.ok(!html.includes('repaintBoundary') && !html.includes('relayoutBoundary'));
  } finally {
    cleanup(dir);
  }
});

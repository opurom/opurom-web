/* HTML structure: the emitter produces one standalone, semantically tagged,
 * deterministic index.html with no IR interpreter at runtime. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, node, runCli, tmpDir, writeJson } from '../test-helpers/helpers.mjs';

function emitted() {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const dir = tmpDir();
  const result = emitFromIr(counter, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

test('emit writes exactly one standalone index.html into out-dir', () => {
  const { dir, html, bytes } = emitted();
  try {
    assert.deepEqual(fs.readdirSync(dir), ['index.html']);
    assert.ok(bytes > 1000);
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en">/);
    assert.match(html, /<\/html>\n$/);
  } finally {
    cleanup(dir);
  }
});

test('emit produces semantic header/main/button/canvas structure', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /<header class="app-header">/);
    assert.match(html, /<h1>Counter<\/h1>/);
    assert.match(html, /<main id="app">/);
    assert.match(html, /<button data-node-id="3" role="button" class="node button" type="button">-<\/button>/);
    assert.match(html, /<button data-node-id="4" role="button" class="node button" type="button">\+<\/button>/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /<style>/);
  } finally {
    cleanup(dir);
  }
});

test('emit bakes the theme accent and gradient canvas size into the page', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /--accent: #097FEB/);
    assert.match(html, /--radius: 12px/);
    assert.match(html, /#fx \{ display: block; width: 480px; height: 270px/);
    assert.match(html, /var SPEC = \{"width":480,"height":270,/);
  } finally {
    cleanup(dir);
  }
});

test('emit resolves state interpolation at compile time', () => {
  const { dir, html } = emitted();
  try {
    assert.ok(html.includes('Count: 0'), 'expected {count} resolved from initial state');
    assert.ok(!html.includes('{count}'), 'raw placeholder must not reach the page');
  } finally {
    cleanup(dir);
  }
});

test('emit contains no runtime IR: no IR JSON, events or interpreter markers', () => {
  const { dir, html } = emitted();
  try {
    for (const marker of ['"tree"', '"events"', '"state"', 'counter.opuir', '"ir":']) {
      assert.ok(!html.includes(marker), `page must not embed ${marker}`);
    }
    // Only the single real script tag; the IR text must never be re-parsed.
    assert.equal(html.match(/<script/g)?.length ?? 0, 1);
  } finally {
    cleanup(dir);
  }
});

test('emit HTML-escapes IR text and attributes', () => {
  const dir = tmpDir();
  try {
    const hostile = ir(
      node(0, 'Column', {}, [
        node(1, 'Text', { value: '<script>alert("x")</script> & more' }),
        node(2, 'Button', { label: "it's <b>bold</b>" }),
      ]),
      { app: 'A<b>&"App"' },
    );
    emitFromIr(hostile, dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal(html.match(/<script/g)?.length ?? 0, 1, 'hostile text must not add script tags');
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more'));
    assert.ok(html.includes('it&#39;s &lt;b&gt;bold&lt;/b&gt;'));
    assert.match(html, /<title>A&lt;b&gt;&amp;&quot;App&quot;<\/title>/);
  } finally {
    cleanup(dir);
  }
});

test('emit omits subtrees guarded by a false initial `when`', () => {
  const dir = tmpDir();
  try {
    const guarded = ir(
      node(0, 'Column', {}, [
        node(1, 'Text', { value: 'always' }),
        { ...node(2, 'Text', { value: 'secret' }), when: 'show' },
      ]),
      { state: [{ name: 'show', type: 'bool', init: false }] },
    );
    emitFromIr(guarded, dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('always'));
    assert.ok(!html.includes('secret'));
    assert.ok(!html.includes('data-node-id="2"'));
  } finally {
    cleanup(dir);
  }
});

test('emit is deterministic: identical IR yields byte-identical HTML', () => {
  const a = emitted();
  const b = emitted();
  try {
    assert.equal(a.html, b.html);
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

test('CLI emit reports the output path and exits 0', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['emit', COUNTER_FIXTURE, dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout.trim(),
      new RegExp(`^emit: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/index\\.html \\(\\d+ bytes\\)$`),
    );
  } finally {
    cleanup(dir);
  }
});

test('emit accepts an input event bound to an int state', () => {
  // A Slider bound to an int state carries a raw input event whose value is a
  // string at runtime; the emitter must accept it and coerce to int.
  const tree = node(0, 'Column', {}, [
    node(1, 'Slider', { bind: 'load', min: 0, max: 100 }, [], { input: { op: 'set', target: 'load' } }),
  ]);
  const data = ir(tree, { state: [{ name: 'load', type: 'int', init: 64 }] });
  const dir = tmpDir();
  try {
    const result = emitFromIr(data, dir);
    const html = fs.readFileSync(result.indexPath, 'utf8');
    assert.match(html, /type="range"/);
    assert.match(html, /parseInt/);
  } finally {
    cleanup(dir);
  }
});

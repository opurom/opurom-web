/* Layout parity: explicit width/height, non-wrapping rows and main-axis
 * distribution. Counter golden moves once by the documented nowrap change. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, multipageIr, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

function styleOf(html, id) {
  const tag = new RegExp(`<[^>]*data-node-id="${id}"[^>]*>`).exec(html);
  assert.ok(tag !== undefined, `node ${id} missing`);
  return /style="([^"]*)"/.exec(tag[0])?.[1] ?? '';
}

test('width and height become CSS pixels with guards for invalid values', () => {
  const value = ir(node(0, 'Column', { width: 120, height: 0 }, [
    node(1, 'Text', { value: 'x', width: -1, height: '80' }),
    node(2, 'Container', { width: 0, height: 64 }),
  ]));
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0), 'width:120px; height:0px');
    assert.equal(styleOf(html, 1), 'font-size:16px');
    assert.equal(styleOf(html, 2), 'width:0px; height:64px');
  } finally {
    cleanup(dir);
  }
});

test('align maps to cross and main axis; stretch stays cross-axis only', () => {
  for (const [align, expected] of [
    ['start', 'align-items:start; justify-content:start'],
    ['center', 'align-items:center; justify-content:center'],
    ['end', 'align-items:end; justify-content:end'],
    ['stretch', 'align-items:stretch'],
    ['baseline', ''],
  ]) {
    const { dir, html } = emit(ir(node(0, 'Row', { align }, [])));
    try {
      assert.equal(styleOf(html, 0), expected, `align=${align}`);
    } finally {
      cleanup(dir);
    }
  }
});

test('declared padding reaches button and input, not just div', () => {
  const value = ir(node(0, 'Column', {}, [
    node(1, 'Button', { label: 'Save', padding: 12, radius: 20 }),
    node(2, 'Button', { label: 'Bad', padding: -1 }),
    node(3, 'Input', { placeholder: 'name', padding: 8 }),
  ]));
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 1), 'padding:12px; border-radius:20px');
    assert.equal(styleOf(html, 2), '');
    assert.equal(styleOf(html, 3), 'padding:8px');
    // Without a declared padding a button keeps the global 8px 16px rule.
    assert.doesNotMatch(html, /<button[^>]*style="[^"]*padding:8px 16px/);
  } finally {
    cleanup(dir);
  }
});

test('row CSS never wraps and keeps the remaining flex defaults', () => {
  const { dir, html } = emit(ir(node(0, 'Row', {}, [])));
  try {
    assert.match(html, /\.row \{ display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; \}/);
    assert.ok(!/\.row \{[^}]*flex-wrap: wrap/.test(html));
  } finally {
    cleanup(dir);
  }
});

test('source-bearing Image keeps width/height as attributes, not CSS pixels', () => {
  const { dir, html } = emit(ir(node(0, 'Column', {}, [
    node(1, 'Image', { src: 'a.png', width: 80, height: 40, fit: 'cover' }),
  ])));
  try {
    const tag = /<img[^>]*>/.exec(html)[0];
    assert.match(tag, /style="object-fit:cover"/);
    assert.match(tag, /\bwidth="80" height="40"/);
    assert.ok(!/style="[^"]*width:/.test(tag));
  } finally {
    cleanup(dir);
  }
});

test('multi-page routes apply width/height and main-axis alignment', () => {
  const value = multipageIr({ Home: {
    title: 'Home',
    tree: node(0, 'Column', { width: 100, align: 'end' }, [node(1, 'Text', { value: 'x' })]),
  } }, 'Home');
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0), 'align-items:end; justify-content:end; width:100px');
  } finally {
    cleanup(dir);
  }
});

test('counter golden is pinned to the post-nowrap byte baseline', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    const sha = crypto.createHash('sha256').update(html).digest('hex');
    assert.equal(bytes, 6541);
    assert.equal(sha, 'e13a842580499564309df329e309211eaf6ce553d7dbbbb7ff6a574d91a6b71a');
  } finally {
    cleanup(dir);
  }
});

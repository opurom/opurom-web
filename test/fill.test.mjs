/* Fill parity: two-stop gradients and the glass lamina. Both keep a solid
 * degradation path; nodes without these props keep the pinned golden. */

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

test('vertical gradient emits the solid first stop before the CSS gradient', () => {
  const { dir, html } = emit(ir(node(0, 'Container', { gradient: '#112233, #445566', color: '#AABBCC' }, [])));
  try {
    assert.equal(styleOf(html, 0),
      'background-color:#112233; background:linear-gradient(to bottom, #112233, #445566)');
  } finally {
    cleanup(dir);
  }
});

test('horizontal gradient follows the IR direction flag', () => {
  const { dir, html } = emit(ir(node(0, 'Container', { gradient: '#010203,#040506', gradientDirection: 'horizontal' }, [])));
  try {
    assert.equal(styleOf(html, 0),
      'background-color:#010203; background:linear-gradient(to right, #010203, #040506)');
  } finally {
    cleanup(dir);
  }
});

test('invalid gradients fall back to the solid fill and never reach CSS', () => {
  for (const gradient of ['#112233', '#112233,red', '#112233,#44556']) {
    const { dir, html } = emit(ir(node(0, 'Container', { gradient, color: '#AABBCC' }, [])));
    try {
      assert.equal(styleOf(html, 0), 'background-color:#AABBCC');
    } finally {
      cleanup(dir);
    }
  }
});

test('glass gets a class rule with frost, border, shadow and progressive blur', () => {
  const { dir, html } = emit(ir(node(0, 'Container', { glass: true }, [])));
  try {
    assert.equal(styleOf(html, 0), '');
    assert.match(html, /class="node container glass"/);
    assert.match(html, /\.glass \{ background:rgba\(255, 255, 255, 0\.42\); border:1px solid rgba\(255, 255, 255, 0\.5\);/);
    assert.match(html, /-webkit-backdrop-filter:blur\(12px\) saturate\(140%\); backdrop-filter:blur\(12px\) saturate\(140%\);/);
  } finally {
    cleanup(dir);
  }
});

test('explicit border and shadow win over the glass class rule', () => {
  const { dir, html } = emit(ir(node(0, 'Container', { glass: true, border: '#314754', shadow: 2 }, [])));
  try {
    assert.equal(styleOf(html, 0),
      'border:1px solid #314754; box-shadow:0 2px 2px rgba(0, 0, 0, 0.15)');
    assert.match(html, /class="node container glass"/);
  } finally {
    cleanup(dir);
  }
});

test('dark theme glass uses the dark frost and border channels', () => {
  const value = ir(node(0, 'Container', { glass: true }, []), { theme: { mode: 'dark', accent: '#4F46E5', radius: 12 } });
  const { dir, html } = emit(value);
  try {
    assert.match(html, /\.glass \{ background:rgba\(30, 35, 46, 0\.38\); border:1px solid rgba\(255, 255, 255, 0\.12\);/);
  } finally {
    cleanup(dir);
  }
});

test('multi-page glass nodes carry the class and the page rule', () => {
  const value = multipageIr({ Home: {
    title: 'Home',
    tree: node(0, 'Column', {}, [node(1, 'Container', { glass: true }, [])]),
  } }, 'Home');
  const { dir, html } = emit(value);
  try {
    assert.match(html, /<div data-node-id="1"[^>]*class="node container glass"/);
    assert.match(html, /\.glass \{/);
  } finally {
    cleanup(dir);
  }
});

test('a program without gradient or glass keeps its byte-identical golden', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    const sha = crypto.createHash('sha256').update(html).digest('hex');
    assert.equal(bytes, 6202);
    assert.equal(sha, '7d8bcc75432cc6392163ef3d96c7afc466941babf2eb7969f319d75e913bec2f');
    assert.ok(!html.includes('.glass {'));
  } finally {
    cleanup(dir);
  }
});

/* Node decoration parity: radius, border, fill, shadow and opacity map to CSS
 * with Flutter BoxDecoration parameters; unchanged IR keeps the pinned golden. */

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

test('visual props map to CSS with deterministic parameter order', () => {
  const value = ir(node(0, 'Container', {
    radius: 8, border: '#AABBCC', color: '#102030', shadow: 4, opacity: 512,
  }, []));
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0),
      'border-radius:8px; border:1px solid #AABBCC; background-color:#102030; '
      + 'box-shadow:0 4px 4px rgba(0, 0, 0, 0.15); opacity:0.5');
  } finally {
    cleanup(dir);
  }
});

test('invalid and out-of-range visual props are ignored', () => {
  const value = ir(node(0, 'Container', {
    radius: -1, border: 'AABBCC', color: 'red', shadow: 0, opacity: 2048,
  }, []));
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0), '');
  } finally {
    cleanup(dir);
  }
});

test('zero radius and opacity endpoints stay representable', () => {
  for (const [opacity, expected] of [[0, '0'], [512, '0.5'], [1024, '1']]) {
    const { dir, html } = emit(ir(node(0, 'Container', { radius: 0, opacity }, [])));
    try {
      assert.equal(styleOf(html, 0), `border-radius:0px; opacity:${expected}`);
    } finally {
      cleanup(dir);
    }
  }
});

test('source-bearing Image keeps fit and gains the declared border', () => {
  const { dir, html } = emit(ir(node(0, 'Column', {}, [
    node(1, 'Image', { src: 'a.png', border: '#314754', fit: 'cover' }),
  ])));
  try {
    const tag = /<img[^>]*>/.exec(html)[0];
    assert.match(tag, /style="border:1px solid #314754; object-fit:cover"/);
    assert.ok(!/style="[^"]*width:/.test(tag));
  } finally {
    cleanup(dir);
  }
});

test('multi-page nodes carry the same decoration mapping', () => {
  const value = multipageIr({ Home: {
    title: 'Home',
    tree: node(0, 'Container', { radius: 3, color: '#010203', shadow: 1 }, [node(1, 'Text', { value: 'x' })]),
  } }, 'Home');
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0),
      'border-radius:3px; background-color:#010203; box-shadow:0 1px 1px rgba(0, 0, 0, 0.15)');
  } finally {
    cleanup(dir);
  }
});

test('a program without visual props keeps its byte-identical golden', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    const sha = crypto.createHash('sha256').update(html).digest('hex');
    assert.equal(bytes, 6202);
    assert.equal(sha, '7d8bcc75432cc6392163ef3d96c7afc466941babf2eb7969f319d75e913bec2f');
  } finally {
    cleanup(dir);
  }
});

/* Global theme.fontScale is the default for nodes without a local prop. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { validateIr } from '../lib/ir.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(data) {
  const dir = tmpDir();
  try {
    return emitFromIr(data, dir).html;
  } finally {
    cleanup(dir);
  }
}

function fontSize(html) {
  const match = /font-size:(\d+)px/.exec(html);
  assert.ok(match, 'emitted HTML must declare a font size');
  return Number(match[1]);
}

function scaled(overrides) {
  return ir(node(0, 'Column', {}, [node(1, 'Text', { value: 'Hello', size: 16 })]), overrides);
}

function themeWith(value) {
  return { theme: { mode: 'light', accent: '#097FEB', radius: 12, fontScale: value } };
}

test('theme fontScale scales text without a local prop', () => {
  const plain = emit(scaled());
  const doubled = emit(scaled(themeWith(2)));
  assert.equal(fontSize(doubled), 2 * fontSize(plain));
});

test('a local fontScale overrides the theme value', () => {
  const base = scaled(themeWith(2));
  base.tree.children[0].props.fontScale = 1;
  assert.equal(fontSize(emit(base)), fontSize(emit(scaled())));
});

test('theme fontScale rejects values outside 0.5..3.0', () => {
  const cases = [0.49, 3.01, '2', null, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of cases) {
    const data = scaled(themeWith(value));
    assert.throws(() => validateIr(data), /theme\.fontScale/, `value ${String(value)} must fail`);
  }
});

test('validation does not mutate a tree that has no global scale', () => {
  const data = scaled();
  validateIr(data);
  assert.equal(data.tree.children[0].props.fontScale, undefined);
  assert.equal('fontScale' in data.theme, false);
});

test('theme fontScale is inherited by nested nodes', () => {
  const data = ir(
    node(0, 'Column', {}, [
      node(1, 'Column', {}, [node(2, 'Text', { value: 'Nested', size: 16 })]),
    ]),
    themeWith(1.5),
  );
  validateIr(data);
  assert.equal(data.tree.children[0].props.fontScale, 1.5);
  assert.equal(data.tree.children[0].children[0].props.fontScale, 1.5);
});

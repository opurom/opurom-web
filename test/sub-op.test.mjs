/* The "sub" action subtracts an int value or valueFrom from an int target. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateIr } from '../lib/ir.mjs';
import { ir, node } from '../test-helpers/helpers.mjs';

const state = [
  { name: 'total', type: 'int', init: 10 },
  { name: 'step', type: 'int', init: 3 },
];

function subIr(action, decls = state) {
  return ir(node(0, 'Button', { label: 'go' }, [], { tap: action }), { state: decls });
}

test('sub action accepts an int valueFrom and an int value', () => {
  assert.doesNotThrow(() => validateIr(subIr({ op: 'sub', target: 'total', valueFrom: 'step' })));
  assert.doesNotThrow(() => validateIr(subIr({ op: 'sub', target: 'total', value: 3 })));
});

test('sub action requires an int target and an int value or valueFrom', () => {
  const boolState = [{ name: 'total', type: 'bool', init: false }];
  assert.throws(
    () => validateIr(subIr({ op: 'sub', target: 'total', value: 1 }, boolState)),
    /sub target .* must be int/,
  );
  assert.throws(
    () => validateIr(subIr({ op: 'sub', target: 'total' })),
    /sub requires an integer value/,
  );
  const withString = [...state, { name: 'label', type: 'string', init: 'x' }];
  assert.throws(
    () => validateIr(subIr({ op: 'sub', target: 'total', valueFrom: 'label' }, withString)),
    /must be int for sub/,
  );
});

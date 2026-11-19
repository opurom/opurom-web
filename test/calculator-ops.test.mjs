import test from 'node:test';
import assert from 'node:assert/strict';

import { validateIr } from '../lib/ir.mjs';
import { multiPageRouter } from '../lib/page-source.mjs';

function ir(events, type = 'int', init = 5) {
  return {
    ir: '0.1.0',
    app: 'CalcOps',
    state: [{ name: 'n', type, init }],
    tree: { id: 0, kind: 'Button', props: { label: 'op' }, children: [], events },
    theme: { mode: 'light', accent: '#097FEB', radius: 12 },
  };
}

test('web IR validates calculator arithmetic and backspace ops', () => {
  for (const op of ['add', 'sub', 'mul', 'div']) {
    assert.doesNotThrow(() => validateIr(ir({ tap: { op, target: 'n', value: 2 } })));
  }
  assert.doesNotThrow(() => validateIr(ir({ tap: { op: 'backspace', target: 'n' } })));
  assert.doesNotThrow(() => validateIr(ir({ tap: { op: 'backspace', target: 'n' } }, 'string', '12')));
  assert.throws(() => validateIr(ir({ tap: { op: 'div', target: 'n', value: 0 } })), /non-zero/);
  assert.throws(() => validateIr(ir({ tap: { op: 'backspace', target: 'n', value: 1 } })), /takes no value/);
});

test('web dom applies calculator arithmetic and backspace ops', () => {
  const cases = [
    [{ op: 'add', target: 'n', value: 3 }, '8'],
    [{ op: 'sub', target: 'n', value: 3 }, '2'],
    [{ op: 'mul', target: 'n', value: 3 }, '15'],
    [{ op: 'div', target: 'n', value: 3 }, '1'],
    [{ op: 'backspace', target: 'n' }, '0'],
  ];
  for (const [action, expected] of cases) {
    const source = multiPageRouter(ir({ tap: action }));
    const cut = source.slice(0, source.lastIndexOf('})();'));
    const probe = `return ${cut}\nreturn { apply: function () { runAction(${JSON.stringify(action)}); return String(state.n); } };\n})();`;
    const router = new Function('window', 'document', probe)({}, { querySelectorAll: () => [], addEventListener: () => {} });
    const value = router.apply();
    assert.equal(value, expected, JSON.stringify(action));
  }
});

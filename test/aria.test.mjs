/* ARIA roles and accessible labels: emitted DOM matches the accessibility contract,
 * both through the emitter and through the Node-side expectation used by verify. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { effectiveRole, expectedDom, labelOf, textFontSize } from '../lib/a11y.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { expectedAria, expectedDomFacts } from '../lib/verify.mjs';
import { cleanup, ir, node, richIr, tmpDir } from '../test-helpers/helpers.mjs';

function emit(irValue) {
  const dir = tmpDir();
  emitFromIr(irValue, dir);
  return { dir, html: fs.readFileSync(path.join(dir, 'index.html'), 'utf8') };
}

test('golden IR roles follow the contract default table', () => {
  const counter = {
    ir: '0.1',
    app: 'Counter',
    state: [{ name: 'count', type: 'int', init: 0 }],
    tree: node(0, 'Column', { gap: 8 }, [
      node(1, 'Text', { value: 'Count: {count}', size: 24 }),
      node(2, 'Row', {}, [
        node(3, 'Button', { label: '-' }),
        node(4, 'Button', { label: '+' }),
      ]),
    ]),
    theme: { mode: 'system', accent: '#097FEB', radius: 12 },
  };
  assert.deepEqual(expectedDom(counter), [
    { id: 0, tag: 'div', role: 'none' },
    { id: 1, tag: 'h2', role: 'heading' },
    { id: 2, tag: 'div', role: 'none' },
    { id: 3, tag: 'button', role: 'button' },
    { id: 4, tag: 'button', role: 'button' },
  ]);
});

test('explicit props.role wins over defaults, including none', () => {
  assert.equal(effectiveRole(node(0, 'Button', { label: 'x', role: 'none' })), 'none');
  assert.equal(effectiveRole(node(0, 'Text', { value: 'x', size: 96, role: 'text' })), 'text');
  assert.equal(effectiveRole(node(0, 'Container', { role: 'checkbox' })), 'checkbox');
});

test('Text heading threshold uses effective size (size * fontScale)', () => {
  assert.equal(effectiveRole(node(0, 'Text', { value: 'x', size: 24 })), 'heading');
  assert.equal(effectiveRole(node(0, 'Text', { value: 'x', size: 23 })), 'text');
  assert.equal(effectiveRole(node(0, 'Text', { value: 'x', size: 16, fontScale: 1.5 })), 'heading');
  assert.equal(textFontSize(node(0, 'Text', { value: 'x', size: 16, fontScale: 1.5 })), 24);
});

test('labelOf follows the contract label chain', () => {
  assert.equal(labelOf(node(0, 'Badge', { label: 'L', value: 'V', title: 'T', name: 'N' })), 'L');
  assert.equal(labelOf(node(0, 'Icon', { name: 'gear' })), 'gear');
  assert.equal(labelOf(node(0, 'Spacer', {})), '');
});

test('emitted HTML carries contract roles as ARIA attributes in pre-order', () => {
  const value = ir(node(0, 'Column', {}, [
    node(1, 'Text', { value: 'Title', size: 32 }),
    node(2, 'Text', { value: 'Body' }),
    node(3, 'Button', { label: 'Go' }),
    node(4, 'Image', { name: 'logo' }),
    node(5, 'Slider', { bind: 'level', min: 0, max: 10 }),
    node(6, 'Switch', { bind: 'on' }),
    node(7, 'Checkbox', { bind: 'on' }),
  ]), {
    state: [
      { name: 'on', type: 'bool', init: true },
      { name: 'level', type: 'int', init: 4 },
    ],
  });
  const { dir, html } = emit(value);
  try {
    const ids = [...html.matchAll(/data-node-id="(\d+)"[^>]*role="([^"]+)"/g)].map((m) => [Number(m[1]), m[2]]);
    assert.deepEqual(ids, [
      [0, 'none'],
      [1, 'heading'],
      [2, 'text'],
      [3, 'button'],
      [4, 'image'],
      [5, 'slider'],
      [6, 'checkbox'],
      [7, 'checkbox'],
    ]);
    // Heading semantics: explicit level for AT, font size baked in.
    assert.match(html, /<h2 data-node-id="1" role="heading" class="node text" aria-level="2" style="font-size:32px">/);
    // Image gets an accessible name from the label chain.
    assert.match(html, /<img data-node-id="4" role="image"[^>]*aria-label="logo">/);
    // Bound controls expose their initial state.
    assert.match(html, /<input data-node-id="5" role="slider" class="node slider" type="range" min="0" max="10" value="4">/);
    assert.match(html, /<button data-node-id="6" role="checkbox" class="node switch" type="button" aria-checked="true">/);
    assert.match(html, /<button data-node-id="7" role="checkbox" class="node checkbox" type="button" aria-checked="true">/);
  } finally {
    cleanup(dir);
  }
});

test('expectedDom skips when-hidden nodes exactly like the emitter', () => {
  const value = ir(node(0, 'Column', {}, [
    node(1, 'Text', { value: 'shown' }),
    { ...node(2, 'Text', { value: 'hidden' }), when: 'flag' },
  ]), { state: [{ name: 'flag', type: 'bool', init: false }] });
  const { dir, html } = emit(value);
  try {
    assert.deepEqual(expectedDom(value).map((e) => e.id), [0, 1]);
    assert.ok(!html.includes('data-node-id="2"'));
  } finally {
    cleanup(dir);
  }
});

test('expectedAria mirrors the emitter ARIA contract and initial state', () => {
  const value = richIr();
  const aria = expectedAria(value);
  assert.deepEqual([...aria.keys()], [0, 1, 2, 3, 4, 5, 6]);
  // Container: no text, so no aria-label; nothing else applies.
  assert.deepEqual(aria.get(0), { ariaLabel: null, ariaLevel: null, ariaChecked: null, value: null });
  // Heading: level 2, text carried by the element itself.
  assert.deepEqual(aria.get(1), { ariaLabel: null, ariaLevel: '2', ariaChecked: null, value: null });
  // Image: accessible name from the label chain, interpolated.
  assert.deepEqual(aria.get(2), { ariaLabel: 'Zoë icon', ariaLevel: null, ariaChecked: null, value: null });
  // Slider: bound initial value as string, no label.
  assert.deepEqual(aria.get(3), { ariaLabel: null, ariaLevel: null, ariaChecked: null, value: '4' });
  // Switch/Checkbox: aria-checked from initial state.
  assert.deepEqual(aria.get(4), { ariaLabel: null, ariaLevel: null, ariaChecked: 'true', value: null });
  assert.deepEqual(aria.get(5), { ariaLabel: null, ariaLevel: null, ariaChecked: 'false', value: null });
  assert.deepEqual(aria.get(6), { ariaLabel: null, ariaLevel: null, ariaChecked: null, value: null });
  assert.deepEqual(expectedDomFacts(value), {
    lang: 'en',
    title: 'Résumé App',
    h1: 'Résumé App',
    canvasLabel: 'Deterministic theme gradient',
  });
});

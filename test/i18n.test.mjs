/* i18n v1 web-dom consumer: DOM dir/CSS, RTL mirror rules in the paint path,
 * catalog interpolation with its three fallback paths, and byte-identical
 * output for programs declaring none of the additive fields. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { catalogOf, expectedDom, interpolate, interpolateCatalog } from '../lib/a11y.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { I18N_FMT, RTL_MIRROR_SRC } from '../lib/page-source.mjs';
import { cleanup, COUNTER_FIXTURE, ir, multipageIr, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

const localeIr = (overrides = {}) => ir(
  node(0, 'Column', {}, [
    node(1, 'Text', { value: '{@greet} {count} {{literal}}' }),
    node(2, 'Button', { label: '{@missing}' }),
  ]),
  {
    state: [{ name: 'count', type: 'int', init: 7 }],
    locale: { active: 'fr', supported: ['en', 'fr'] },
    messages: {
      greet: { en: 'Hello', fr: 'Bonjour' },
    },
    ...overrides,
  },
);

test('DOM root carries dir=rtl and CSS direction for a rtl program', () => {
  const value = localeIr({ directionality: 'rtl' });
  const { dir, html } = emit(value);
  try {
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en" dir="rtl">/);
    assert.match(html, /font-family: system-ui[^}]*direction: rtl;/);
    assert.ok(!html.includes('data-for="rtl"'));
  } finally {
    cleanup(dir);
  }
});

test('multi-page shell carries dir=rtl and CSS direction', () => {
  const home = node(0, 'Column', {}, [node(1, 'Text', { value: '{@greet}' })]);
  const value = multipageIr({ Home: { title: 'Home', tree: home } }, 'Home', {
    locale: { active: 'fr', supported: ['en', 'fr'] },
    messages: { greet: { en: 'Hello', fr: 'Bonjour' } },
    directionality: 'rtl',
  });
  const { dir, html } = emit(value);
  try {
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en" dir="rtl">/);
    assert.match(html, /direction: rtl;/);
    assert.match(html, /Bonjour/, 'catalog resolves at emit time');
  } finally {
    cleanup(dir);
  }
});

test('catalog interpolation resolves active locale, supported first, then literal key', () => {
  const catalog = catalogOf(localeIr());
  assert.equal(interpolate('{@greet}', new Map(), catalog), 'Bonjour', 'active locale wins');
  const noActive = catalogOf(localeIr({ locale: { active: 'de', supported: ['en', 'fr'] } }));
  assert.equal(interpolate('{@greet}', new Map(), noActive), 'Hello', 'first supported entry');
  assert.equal(interpolate('{@missing}', new Map(), catalog), 'missing', 'missing key is literal');
  const decls = new Map([['count', { init: 7 }]]);
  assert.equal(interpolate('{@greet} {count} {{literal}}', decls, catalog), 'Bonjour 7 {literal}');
  assert.equal(interpolate('{unknown} {count}', decls, catalog), '{unknown} 7');
  assert.equal(interpolateCatalog('{@greet} {count} {{p}}', catalog), 'Bonjour {count} {{p}}');
  const { dir, html } = emit(localeIr());
  try {
    assert.ok(html.includes('Bonjour 7 {literal}'), 'emitted text follows the same rule');
    assert.ok(html.includes('>missing</button>'), 'missing catalog key is literal in the page');
  } finally {
    cleanup(dir);
  }
});

test('runtime fmt keeps literal braces and state references', () => {
  const fmt = new Function('state', `${I18N_FMT}; return fmt;`)({ count: 9 });
  assert.equal(fmt('{{literal}}'), '{literal}');
  assert.equal(fmt('Count: {count}'), 'Count: 9');
  assert.equal(fmt('{@missing}'), 'missing');
});

test('paint path mirrors row order, offsets, text align and a11y visual order', () => {
  const mirror = new Function(`${RTL_MIRROR_SRC}; return {
    opuMirrorAlign, opuMirrorTextAlign, opuRowOrder, opuVisualOrder,
  };`)();
  assert.equal(mirror.opuMirrorAlign('start'), 'end');
  assert.equal(mirror.opuMirrorAlign('end'), 'start');
  assert.equal(mirror.opuMirrorAlign('center'), 'center');
  assert.equal(mirror.opuMirrorTextAlign('start'), 'end');
  assert.deepEqual(mirror.opuRowOrder([1, 2, 3], 'Row'), [3, 2, 1]);
  assert.deepEqual(mirror.opuRowOrder([1, 2, 3], 'Grid'), [3, 2, 1]);
  assert.deepEqual(mirror.opuRowOrder([1, 2, 3], 'Column'), [1, 2, 3]);
  const nodes = [
    { id: 0, kind: 'Column' },
    { id: 1, kind: 'Row', parent: 0 },
    { id: 2, kind: 'Text', parent: 1 },
    { id: 3, kind: 'Text', parent: 1 },
    { id: 4, kind: 'Text', parent: 0 },
  ];
  assert.deepEqual(mirror.opuVisualOrder(nodes), [0, 1, 3, 2, 4], 'row children reverse, vertical stack keeps order');
  const rtlIr = ir(node(0, 'Row', {}, [
    node(1, 'Text', { value: 'a' }),
    node(2, 'Text', { value: 'b' }),
  ]), { directionality: 'rtl' });
  assert.deepEqual(expectedDom(rtlIr).map((entry) => entry.id), [0, 2, 1], 'a11y expectation follows visual order');
  const { dir, html } = emit(localeIr({ directionality: 'rtl' }));
  try {
    assert.match(html, /function opuVisualOrder\(nodes\)/);
    assert.match(html, /function collectVisual\(element\)/);
  } finally {
    cleanup(dir);
  }
});

test('programs without i18n fields emit unchanged bytes and no RTL source', () => {  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    assert.equal(bytes, 6176, 'golden single-page artifact stays byte-identical');
    assert.ok(!html.includes(' dir="rtl"'));
    assert.ok(!html.includes('direction: rtl'));
    assert.ok(!html.includes('opuVisualOrder'));
    assert.ok(!html.includes('function fmt(text, scope) {\n    var input'));
  } finally {
    cleanup(dir);
  }
});

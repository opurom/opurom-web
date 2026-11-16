/* Icon nodes render as inline SVG sourced from the IR `icons` table. The
 * compiler embeds each referenced package icon as {name, viewBox, paths:[d]};
 * the emitter must turn an Icon node into an <svg><path .../></svg> with the
 * package path data, not a text label. Names absent from the table still emit
 * an empty svg shell so layout stays stable (no crash, no fallback glyph). */

import assert from 'node:assert/strict';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

test('Icon node renders inline svg path data from the IR icons table', () => {
  const tree = node(0, 'Row', { gap: 8 }, [
    node(1, 'Icon', { name: 'disc' }),
    node(2, 'Icon', { name: 'play' }),
  ]);
  const icons = [
    { name: 'disc', viewBox: '0 0 24 24', paths: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0 -18'] },
    { name: 'play', viewBox: '0 0 24 24', paths: ['M7 5l12 7l-12 7z'] },
  ];
  const value = ir(tree, { icons });
  const dir = tmpDir('opurom-web-icon-');
  try {
    const { html } = emitFromIr(value, dir);
    assert.equal((html.match(/<svg class="icon"/g) || []).length, 2, 'expected two icon svgs');
    assert.ok(html.includes('viewBox="0 0 24 24"'), 'icon viewBox missing');
    assert.ok(html.includes('d="M7 5l12 7l-12 7z"'), 'play path data missing');
    assert.ok(html.includes('aria-label="disc"'), 'icon aria-label missing');
  } finally {
    cleanup(dir);
  }
});

test('Icon name absent from the icons table emits an empty svg shell', () => {
  const tree = node(0, 'Icon', { name: 'not-in-table' });
  const value = ir(tree, { icons: [] });
  const dir = tmpDir('opurom-web-icon-');
  try {
    const { html } = emitFromIr(value, dir);
    assert.ok(html.includes('<svg class="icon"'), 'icon shell missing');
    assert.ok(!html.includes('<path d='), 'unexpected path for unknown icon');
  } finally {
    cleanup(dir);
  }
});

/* Image nodes lower to real void <img> elements when IR declares a source.
 * Default pages (no source-bearing Image) must stay byte-identical. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, multipageIr, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

function imageIr(props) {
  return ir(node(0, 'Column', {}, [node(1, 'Image', props)]));
}

test('emit lowers a source-bearing Image to a void img with escaped src and alt', () => {
  const { dir, html } = emit(imageIr({
    src: 'a&b"c.png', label: "it's <logo>", width: 120, height: 80, fit: 'cover',
  }));
  try {
    assert.match(html, /<img data-node-id="1" role="image" class="node image" style="object-fit:cover" src="a&amp;b&quot;c.png" alt="it&#39;s &lt;logo&gt;" width="120" height="80" loading="lazy">/);
    assert.ok(!html.includes('</img>'), 'img is a void element');
    assert.ok(!/data-node-id="1"[^>]*aria-label=/.test(html), 'alt is the accessible name');
    assert.ok(html.includes('img.image { width: auto; height: auto; border: 0; }'));
    assert.deepEqual(expectedDom(imageIr({ src: 'a.png' }))[1], { id: 1, tag: 'img', role: 'image' });
  } finally {
    cleanup(dir);
  }
});

test('fit maps to object-fit with contain fallback for missing or unknown values', () => {
  const cases = [['contain', 'contain'], ['cover', 'cover'], ['fill', 'fill'], ['scale-down', 'contain'], [undefined, 'contain']];
  for (const [fit, expected] of cases) {
    const props = { src: 'a.png', ...(fit === undefined ? {} : { fit }) };
    const { dir, html } = emit(imageIr(props));
    try {
      assert.ok(html.includes(`style="object-fit:${expected}"`), `fit=${fit} expected ${expected}`);
    } finally {
      cleanup(dir);
    }
  }
});

test('Image dimensions ignore negative and non-numeric values but keep zero', () => {
  const bad = emit(imageIr({ src: 'a.png', width: -1, height: '80' }));
  const zero = emit(imageIr({ src: 'a.png', width: 0, height: 0 }));
  try {
    assert.ok(!/data-node-id="1"[^>]*\bwidth=/.test(bad.html));
    assert.ok(!/data-node-id="1"[^>]*\bheight=/.test(bad.html));
    assert.match(zero.html, /\bwidth="0" height="0" loading="lazy">/);
  } finally {
    cleanup(bad.dir);
    cleanup(zero.dir);
  }
});

test('Image without a source keeps the deterministic placeholder and default CSS', () => {
  const { dir, html } = emit(imageIr({ label: 'logo' }));
  try {
    assert.match(html, /<div data-node-id="1" role="image" class="node image" aria-label="logo"><\/div>/);
    assert.ok(!html.includes('img.image {'), 'no img rule without a source');
    assert.deepEqual(expectedDom(imageIr({ label: 'logo' }))[1], { id: 1, tag: 'div', role: 'image' });
  } finally {
    cleanup(dir);
  }
});

test('multi-page Image emits img with runtime attributes', () => {
  const tree = (props, when) => node(0, 'Column', {}, [
    when === undefined ? node(1, 'Image', props) : { ...node(1, 'Image', props), when },
  ]);
  const value = multipageIr({ Home: { title: 'Home', tree: tree({ src: 'p.png', label: 'Pic' }) } }, 'Home');
  const { dir, html } = emit(value);
  try {
    assert.match(html, /<img data-node-id="1" role="image" class="node image" style="object-fit:contain" src="p.png" alt="Pic" loading="lazy">/);
    const guarded = multipageIr({ Home: { title: 'Home', tree: tree({ src: 'p.png' }, 'show') } }, 'Home', {
      state: [{ name: 'show', type: 'bool', init: true }],
    });
    const guardedEmit = emit(guarded);
    try {
      assert.match(guardedEmit.html, /<img[^>]*data-when="show"/);
    } finally {
      cleanup(guardedEmit.dir);
    }
  } finally {
    cleanup(dir);
  }
});

test('counter single-page emit stays byte-identical to the pinned baseline', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    const sha = crypto.createHash('sha256').update(html).digest('hex');
    assert.equal(bytes, 6176);
    assert.equal(sha, '3417ce85a0c9050091b38c73a7eddce5c25a2dc5bb2b1e014eb6507772b96dbc');
    assert.ok(!html.includes('img.image {'));
  } finally {
    cleanup(dir);
  }
});

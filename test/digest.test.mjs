/* Deterministic gradient: FNV-1a vectors, the two independent implementations
 * (page painter source vs Node CPU reference) producing byte-identical RGBA,
 * and a pinned golden digest for the counter fixture. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { fnv1a64, paintReference, referenceDigest } from '../lib/cpu-reference.mjs';
import { PAGE_PAINT_SRC } from '../lib/page-source.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { COUNTER_FIXTURE } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

function pageRuntime() {
  // The exact source the emitted page runs, evaluated offline in Node.
  return new Function(`${PAGE_PAINT_SRC}; return { opuPaintPixels, opuFnv1a64 };`)();
}

test('fnv1a64 matches the published 64-bit FNV-1a vectors', () => {
  const enc = new TextEncoder();
  assert.equal(fnv1a64(new Uint8Array(0)), 'cbf29ce484222325');
  assert.equal(fnv1a64(enc.encode('a')), 'af63dc4c8601ec8c');
  assert.equal(fnv1a64(enc.encode('foobar')), '85944171f73967e8');
  assert.match(fnv1a64(new Uint8Array(480 * 270 * 4).fill(7)), /^[0-9a-f]{16}$/);
});

test('counter fixture digest is pinned (recipe regression guard)', () => {
  assert.equal(referenceDigest(gradientSpec(counterIr)), '2013651856b88d65');
});

test('page painter and Node CPU reference produce byte-identical RGBA', () => {
  const runtime = pageRuntime();
  const themes = [
    { mode: 'light', accent: '#4F46E5', radius: 12 },
    { mode: 'dark', accent: '#4F46E5', radius: 12 },
    { mode: 'system', accent: '#000000', radius: 0 },
    { mode: 'light', accent: '#FFFFFF', radius: 200 },
  ];
  for (const theme of themes) {
    const spec = gradientSpec({ ...counterIr, theme });
    const reference = paintReference(spec);
    const page = new Uint8ClampedArray(spec.width * spec.height * 4);
    runtime.opuPaintPixels(spec, page);
    assert.equal(Buffer.compare(Buffer.from(page), Buffer.from(reference)), 0, `bytes differ for ${JSON.stringify(theme)}`);
    assert.equal(runtime.opuFnv1a64(page), referenceDigest(spec), `digest differs for ${JSON.stringify(theme)}`);
  }
});

test('gradient responds to its inputs: digest changes with theme, not silently constant', () => {
  const light = referenceDigest(gradientSpec({ ...counterIr, theme: { mode: 'light', accent: '#4F46E5', radius: 12 } }));
  const dark = referenceDigest(gradientSpec({ ...counterIr, theme: { mode: 'dark', accent: '#4F46E5', radius: 12 } }));
  const otherAccent = referenceDigest(gradientSpec({ ...counterIr, theme: { mode: 'light', accent: '#123456', radius: 12 } }));
  assert.notEqual(light, dark);
  assert.notEqual(light, otherAccent);
  assert.notEqual(dark, otherAccent);
});

test('painting is deterministic: same spec, repeated runs are identical', () => {
  const spec = gradientSpec(counterIr);
  const first = referenceDigest(spec);
  const second = referenceDigest(spec);
  assert.equal(first, second);
  const runtime = pageRuntime();
  const buf = new Uint8ClampedArray(spec.width * spec.height * 4);
  runtime.opuPaintPixels(spec, buf);
  assert.equal(runtime.opuFnv1a64(buf), first);
});

test('spec derives palette from theme: system resolves to light without host queries', () => {
  const system = gradientSpec({ ...counterIr, theme: { mode: 'system', accent: '#4F46E5', radius: 12 } });
  const light = gradientSpec({ ...counterIr, theme: { mode: 'light', accent: '#4F46E5', radius: 12 } });
  const dark = gradientSpec({ ...counterIr, theme: { mode: 'dark', accent: '#4F46E5', radius: 12 } });
  assert.deepEqual(system, light);
  assert.notDeepEqual(light.bottom, dark.bottom);
  assert.equal(system.width, 480);
  assert.equal(system.height, 270);
});

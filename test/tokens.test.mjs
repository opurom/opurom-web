/* Token colors reach both painters only through the shared spec; exercising
 * that path keeps the emitted CSS, the CPU reference and the browser
 * expectations on the same palette. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { paintReference, referenceDigest } from '../lib/cpu-reference.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { PAGE_PAINT_SRC } from '../lib/page-source.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { compareFacts, expectedAria, expectedDomFacts, expectedStyles, verify } from '../lib/verify.mjs';
import { cleanup, COUNTER_FIXTURE, tmpDir, writeJson } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

function tokenIr(tokens, mode = 'light') {
  return { ...counterIr, theme: { ...counterIr.theme, mode, tokens } };
}

function pageRuntime() {
  return new Function(`${PAGE_PAINT_SRC}; return { opuPaintPixels, opuFnv1a64 };`)();
}

test('theme token colors override the mode palette per field', () => {
  const plain = gradientSpec(counterIr);
  const both = gradientSpec(tokenIr({ surface: '#010203', onSurface: '#0A0B0C' }));
  assert.deepEqual(both.bottom, [1, 2, 3]);
  assert.deepEqual(both.border, [10, 11, 12]);
  assert.deepEqual(both.top, plain.top);
  assert.equal(both.radius, plain.radius);

  const surfaceOnly = gradientSpec(tokenIr({ surface: '#010203' }));
  assert.deepEqual(surfaceOnly.bottom, [1, 2, 3]);
  assert.deepEqual(surfaceOnly.border, plain.border);

  const dark = gradientSpec(tokenIr({ onSurface: '#FFFFFF' }, 'dark'));
  assert.deepEqual(dark.border, [255, 255, 255]);
  assert.deepEqual(dark.bottom, [15, 23, 42]);
  assert.equal(referenceDigest(plain), '2013651856b88d65');
});

test('token colors keep the page painter and the CPU reference byte-identical', () => {
  const runtime = pageRuntime();
  const cases = [
    { mode: 'light', tokens: { surface: '#123456', onSurface: '#FFFFFF' } },
    { mode: 'dark', tokens: { surface: '#010203' } },
    { mode: 'system', tokens: { onSurface: '#AABBCC' } },
  ];
  for (const { mode, tokens } of cases) {
    const spec = gradientSpec(tokenIr(tokens, mode));
    const reference = paintReference(spec);
    const page = new Uint8ClampedArray(spec.width * spec.height * 4);
    runtime.opuPaintPixels(spec, page);
    assert.equal(Buffer.compare(Buffer.from(page), Buffer.from(reference)), 0);
    assert.equal(runtime.opuFnv1a64(page), referenceDigest(spec));
  }
  const tokened = tokenIr({ surface: '#123456', onSurface: '#FFFFFF' });
  assert.notEqual(referenceDigest(gradientSpec(tokened)), referenceDigest(gradientSpec(counterIr)));
  assert.equal(
    referenceDigest(gradientSpec(tokened)),
    referenceDigest(gradientSpec(tokenIr({ surface: '#123456', onSurface: '#FFFFFF' }))),
  );
});

test('emitted CSS and verification expectations follow token colors', () => {
  const dir = tmpDir();
  try {
    const value = tokenIr({ surface: '#010203', onSurface: '#0A0B0C' });
    const emitted = emitFromIr(value, dir);
    const html = fs.readFileSync(emitted.indexPath, 'utf8');
    assert.match(html, /--surface: rgb\(1, 2, 3\)/);
    assert.match(html, /--ink: rgb\(10, 11, 12\)/);
    assert.ok(html.includes('"bottom":[1,2,3]'));
    assert.ok(html.includes('"border":[10,11,12]'));

    const spec = gradientSpec(value);
    const cpuDigest = referenceDigest(spec);
    const aria = expectedAria(value);
    const facts = {
      digest: cpuDigest,
      canvas: { width: spec.width, height: spec.height },
      roles: expectedDom(value).map((entry) => ({ ...entry, ...aria.get(entry.id) })),
      dom: expectedDomFacts(value),
      styles: expectedStyles(value, spec),
    };
    assert.equal(facts.styles.bodyBackground, 'rgb(1, 2, 3)');
    assert.deepEqual(compareFacts(facts, value, spec, cpuDigest), []);

    const wrong = { ...facts, styles: { ...facts.styles, bodyBackground: 'rgb(255, 255, 255)' } };
    assert.match(compareFacts(wrong, value, spec, cpuDigest).join('\n'), /computed style mismatch bodyBackground/);
  } finally {
    cleanup(dir);
  }
});

test('browser verification pins token colors to the CPU reference', async () => {
  const dir = tmpDir();
  try {
    const value = tokenIr({ surface: '#123456', onSurface: '#FFFFFF' });
    const irPath = path.join(dir, 'tokens.opuir.json');
    writeJson(irPath, value);
    const lines = [];
    const result = await verify(irPath, path.join(dir, 'out'), { log: (line) => lines.push(line) });
    const expected = referenceDigest(gradientSpec(value));
    assert.equal(result.code, 0, lines.join('\n'));
    assert.ok(lines.includes(`cpu-digest: ${expected}`), lines.join('\n'));
    if (result.status === 'skip') {
      assert.ok(lines.some((line) => line.startsWith('SKIP: headless browser ')), lines.join('\n'));
      return;
    }
    assert.equal(result.status, 'pass', lines.join('\n'));
    assert.equal(result.digest, expected);
  } finally {
    cleanup(dir);
  }
});

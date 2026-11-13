/* IR `props.particles` on the DOM/Canvas hybrid: the field lowers into the
 * shared spec, both independent painters rasterize it byte-identically, a
 * divergent painter fails the parity check, and a real browser readback
 * equals the CPU reference digest. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { paintReference, referenceDigest } from '../lib/cpu-reference.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { PAGE_PAINT_SRC } from '../lib/page-source.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { verify } from '../lib/verify.mjs';
import { cleanup, COUNTER_FIXTURE, PARTICLE_FIXTURE, tmpDir } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
const particleIr = JSON.parse(fs.readFileSync(PARTICLE_FIXTURE, 'utf8'));

function pageRuntime(source = PAGE_PAINT_SRC) {
  return new Function(`${source}; return { opuPaintPixels, opuFnv1a64 };`)();
}

function paintWithPage(spec, source = PAGE_PAINT_SRC) {
  const runtime = pageRuntime(source);
  const pixels = new Uint8ClampedArray(spec.width * spec.height * 4);
  runtime.opuPaintPixels(spec, pixels);
  return pixels;
}

function runtimeDigest(pixels) {
  return pageRuntime().opuFnv1a64(pixels);
}

function irVariant(mutate) {
  const value = JSON.parse(JSON.stringify(particleIr));
  mutate(value);
  return value;
}

test('particle fields lower into the shared spec with byte alpha and accent fallback', () => {
  const spec = gradientSpec(particleIr);
  assert.deepEqual(spec.particles, [
    { count: 48, seed: 7, radius: 2, alpha: 127, color: [255, 59, 48] },
    { count: 0, seed: 3, radius: 2, alpha: 255, color: [9, 127, 235] },
    { count: 12, seed: 99, radius: 0, alpha: 255, color: [9, 127, 235] },
  ]);
  assert.deepEqual(gradientSpec(counterIr).particles, []);
});

test('page painter and CPU reference byte-match the particle fixture', () => {
  const themes = [
    particleIr.theme,
    { ...particleIr.theme, mode: 'dark' },
    { mode: 'light', accent: '#123456', radius: 0 },
  ];
  for (const theme of themes) {
    const spec = gradientSpec({ ...particleIr, theme });
    const reference = paintReference(spec);
    const page = paintWithPage(spec);
    assert.equal(Buffer.compare(Buffer.from(page), Buffer.from(reference)), 0, `bytes differ for ${JSON.stringify(theme)}`);
    assert.equal(runtimeDigest(page), referenceDigest(spec), `digest differs for ${JSON.stringify(theme)}`);
  }
  assert.equal(referenceDigest(gradientSpec(particleIr)), 'd0dfa90e785be65f');
});

test('the parity check fails on a divergent page painter', () => {
  const spec = gradientSpec(particleIr);
  const expected = referenceDigest(spec);
  const mutations = [
    ['0x6c078965', '0x6c078964'],
    ['0x9e3779b9', '0x9e3779b8'],
    ['255 - field.alpha', '254 - field.alpha'],
  ];
  for (const [from, to] of mutations) {
    assert.ok(PAGE_PAINT_SRC.includes(from), `fixture mutation target missing: ${from}`);
    const diverged = PAGE_PAINT_SRC.replace(from, to);
    assert.notEqual(diverged, PAGE_PAINT_SRC, `mutation did not apply: ${from}`);
    const pixels = paintWithPage(spec, diverged);
    assert.notEqual(pageRuntime(diverged).opuFnv1a64(pixels), expected, `digest not caught: ${from}`);
    assert.notEqual(Buffer.compare(Buffer.from(pixels), Buffer.from(paintReference(spec))), 0, `bytes not caught: ${from}`);
  }
});

test('every particle input moves the canvas digest', () => {
  const digests = [
    gradientSpec(particleIr),
    gradientSpec(irVariant((ir) => { ir.tree.props.particles.seed = 8; })),
    gradientSpec(irVariant((ir) => { ir.tree.props.particles.count = 96; })),
    gradientSpec(irVariant((ir) => { ir.tree.props.particles.radius = 4; })),
    gradientSpec(irVariant((ir) => { ir.tree.props.particles.alpha = 1024; })),
    gradientSpec(irVariant((ir) => { ir.tree.props.particles.color = '#00FF00'; })),
    gradientSpec(irVariant((ir) => { ir.tree.children[1].props.particles.count = 40; })),
  ].map(referenceDigest);
  assert.equal(new Set(digests).size, digests.length, `digests: ${digests.join(', ')}`);
  assert.notEqual(digests[0], referenceDigest(gradientSpec(counterIr)));
});

test('particle props outside the renderer bounds are ignored, bytes unchanged', () => {
  const bad = [
    (props) => { props.particles = { count: 513, seed: 7 }; },
    (props) => { props.particles = { count: 4, radius: 33 }; },
    (props) => { props.particles = { count: 4, seed: 0x100000000 }; },
    (props) => { props.particles = { count: 4, alpha: 2000 }; },
    (props) => { props.particles = { count: 4, color: 'red' }; },
    (props) => { props.particles = 7; },
    (props) => { props.particles = { count: 4.5 }; },
  ];
  const golden = referenceDigest(gradientSpec(counterIr));
  assert.equal(golden, '2013651856b88d65');
  for (const mutate of bad) {
    const ir = JSON.parse(JSON.stringify(counterIr));
    mutate(ir.tree.props);
    const spec = gradientSpec(ir);
    assert.deepEqual(spec.particles, [], 'out-of-range field must be dropped');
    assert.equal(referenceDigest(spec), golden);
    assert.equal(runtimeDigest(paintWithPage(spec)), golden);
  }
});

test('emit compiles particle fields into the page constants', () => {
  const dir = tmpDir();
  try {
    const emitted = emitFromIr(particleIr, dir);
    const html = fs.readFileSync(emitted.indexPath, 'utf8');
    assert.ok(
      html.includes('"particles":[{"count":48,"seed":7,"radius":2,"alpha":127,"color":[255,59,48]}'),
      'compiled SPEC must carry the lowered particle recipe',
    );
    const spec = gradientSpec(particleIr);
    assert.equal(runtimeDigest(paintWithPage(spec)), referenceDigest(spec));
  } finally {
    cleanup(dir);
  }
});

test('browser readback of the particle fixture equals the CPU reference', async () => {
  const dir = tmpDir();
  try {
    const irPath = path.join(dir, 'particles.opuir.json');
    fs.writeFileSync(irPath, `${JSON.stringify(particleIr, null, 2)}\n`, 'utf8');
    const lines = [];
    const result = await verify(irPath, path.join(dir, 'out'), { log: (line) => lines.push(line) });
    const expected = referenceDigest(gradientSpec(particleIr));
    assert.notEqual(expected, '2013651856b88d65', 'particle fixture must not share the counter digest');
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

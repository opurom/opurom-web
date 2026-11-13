/* IR `props.particles` on the DOM/Canvas hybrid: the field lowers into the
 * shared spec, both independent painters rasterize it byte-identically, a
 * divergent painter fails the parity check, and a real browser readback
 * equals the CPU reference digest. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { paintReference, referenceDigest } from '../lib/cpu-reference.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { PAGE_PAINT_SRC } from '../lib/page-source.mjs';
import { gradientSpec, particleDots } from '../lib/spec.mjs';
import { compareFacts, expectedAria, expectedDomFacts, expectedParticles, expectedStyles, verify } from '../lib/verify.mjs';
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

/* Reads the emitted DOM particle layer back into the fact shape the page
 * reports, so the emitted markup can be compared with the spec-derived
 * expectation without a browser. */
function parseParticleLayer(html) {
  const fields = [];
  const fieldRe = /<div class="particle-field"([^>]*)>([\s\S]*?)<\/div>/g;
  let match = fieldRe.exec(html);
  while (match !== null) {
    const attrs = match[1];
    const body = match[2];
    const number = (name) => {
      const found = new RegExp(`${name}="(\\d+)"`).exec(attrs);
      return found === null ? null : Number(found[1]);
    };
    const color = /data-color="([\d,]+)"/.exec(attrs)[1].split(',').map(Number);
    const dots = [...body.matchAll(/<i class="particle-dot" data-x="(\d+)" data-y="(\d+)"/g)]
      .map((dot) => ({ x: Number(dot[1]), y: Number(dot[2]) }));
    fields.push({
      field: number('data-field'),
      count: number('data-count'),
      seed: number('data-seed'),
      radius: number('data-radius'),
      alpha: number('data-alpha'),
      color,
      dots,
    });
    match = fieldRe.exec(html);
  }
  return fields;
}

function goldenFacts(irValue, specValue) {
  const aria = expectedAria(irValue);
  return {
    digest: referenceDigest(specValue),
    canvas: { width: specValue.width, height: specValue.height },
    roles: expectedDom(irValue).map((entry) => ({ ...entry, ...aria.get(entry.id) })),
    particles: expectedParticles(specValue),
    dom: expectedDomFacts(irValue),
    styles: expectedStyles(irValue, specValue),
  };
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

test('the DOM particle layer matches the expected DOM and is byte-deterministic', () => {
  const spec = gradientSpec(particleIr);
  const expected = expectedParticles(spec);
  assert.ok(expected.length > 0, 'the particle fixture must paint at least one field');
  const firstDir = tmpDir();
  const secondDir = tmpDir();
  try {
    const first = emitFromIr(particleIr, firstDir);
    const second = emitFromIr(particleIr, secondDir);
    const firstHtml = fs.readFileSync(first.indexPath, 'utf8');
    assert.equal(firstHtml, fs.readFileSync(second.indexPath, 'utf8'), 'identical IR must emit byte-identical HTML');
    assert.deepEqual(parseParticleLayer(firstHtml), expected, 'emitted DOM layer must match the spec-derived DOM');
  } finally {
    cleanup(firstDir);
    cleanup(secondDir);
  }
});

test('the DOM particle layout equals the canvas painter dot placement', () => {
  const spec = gradientSpec(particleIr);
  const runtime = new Function(`${PAGE_PAINT_SRC}; return { opuDotCenter };`)();
  const canvasLayers = [];
  spec.particles.forEach((field, fieldIndex) => {
    if (field.count === 0 || field.alpha === 0) return;
    const dots = [];
    for (let i = 0; i < field.count; i += 1) {
      const [x, y] = runtime.opuDotCenter(field, i, spec.width, spec.height);
      dots.push({ x, y });
    }
    canvasLayers.push({ field: fieldIndex, count: field.count, seed: field.seed, radius: field.radius, alpha: field.alpha, color: field.color, dots });
  });
  assert.deepEqual(canvasLayers, particleDots(spec), 'DOM and canvas must share one deterministic dot layout');
});

test('the DOM verification path catches a mutated particle layer', () => {
  const spec = gradientSpec(particleIr);
  const cpuDigest = referenceDigest(spec);
  const facts = goldenFacts(particleIr, spec);
  assert.deepEqual(compareFacts(facts, particleIr, spec, cpuDigest), [], 'golden facts must pass');

  const movedDot = {
    ...facts,
    particles: facts.particles.map((layer, i) => (i === 0
      ? { ...layer, dots: layer.dots.map((dot, d) => (d === 0 ? { ...dot, x: dot.x + 1 } : dot)) }
      : layer)),
  };
  const dotFailure = compareFacts(movedDot, particleIr, spec, cpuDigest);
  assert.equal(dotFailure.length, 1);
  assert.match(dotFailure[0], /particle field 0 dot 0 mismatch/);

  const movedField = {
    ...facts,
    particles: facts.particles.map((layer, i) => (i === 0 ? { ...layer, count: layer.count + 1 } : layer)),
  };
  const fieldFailure = compareFacts(movedField, particleIr, spec, cpuDigest);
  assert.equal(fieldFailure.length, 1);
  assert.match(fieldFailure[0], /particle field 0 count mismatch/);
});

test('the counter fixture keeps its pinned golden digest and an empty DOM particle layer', () => {
  const spec = gradientSpec(counterIr);
  assert.equal(referenceDigest(spec), '2013651856b88d65');
  assert.deepEqual(expectedParticles(spec), []);
  const dir = tmpDir();
  try {
    const emitted = emitFromIr(counterIr, dir);
    const html = fs.readFileSync(emitted.indexPath, 'utf8');
    assert.ok(html.includes('<div id="fx-particles" class="particle-layer" aria-hidden="true"></div>'));
    assert.ok(!html.includes('<i class="particle-dot"'), 'a fixture without particles must not emit dots');
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
    assert.ok(expectedParticles(gradientSpec(particleIr)).length > 0, 'browser parity must cover the particle layer');
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

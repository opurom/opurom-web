/* HTML structure: the emitter produces one standalone, semantically tagged,
 * deterministic index.html with no IR interpreter at runtime. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, COUNTER_FIXTURE, ir, node, runCli, tmpDir, writeJson } from '../test-helpers/helpers.mjs';

function emitted() {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const dir = tmpDir();
  const result = emitFromIr(counter, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

function emitHtml(data) {
  const dir = tmpDir();
  try {
    return emitFromIr(data, dir).html;
  } finally {
    cleanup(dir);
  }
}

/* Decode the 8-bit RGBA PNG payload so the favicon assertion checks real
 * pixels rather than only the IHDR header. */
function decodeRgbaPng(png) {
  assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'PNG signature');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += length + 12;
    if (type === 'IEND') break;
  }
  assert.equal(bitDepth, 8, 'favicon is 8-bit');
  assert.equal(colorType, 6, 'favicon is RGBA');
  assert.equal(interlace, 0, 'favicon is not interlaced');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height, 'favicon scanlines decode');
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    const prior = y === 0 ? null : rows[y - 1];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= 4 ? prior[x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
      } else {
        assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      }
      row[x] = (row[x] + predictor) & 0xff;
    }
    rows.push(row);
  }
  return { width, height, rows };
}

test('emit writes exactly one standalone index.html into out-dir', () => {
  const { dir, html, bytes } = emitted();
  try {
    assert.deepEqual(fs.readdirSync(dir), ['index.html']);
    assert.ok(bytes > 1000);
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en">/);
    assert.match(html, /<\/html>\n$/);
  } finally {
    cleanup(dir);
  }
});

test('emit produces semantic header/main/button/canvas structure', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /<header class="app-header">/);
    assert.match(html, /<h1>Counter<\/h1>/);
    assert.match(html, /<main id="app">/);
    assert.match(html, /<button data-node-id="3" role="button" class="node button" type="button">-<\/button>/);
    assert.match(html, /<button data-node-id="4" role="button" class="node button" type="button">\+<\/button>/);
    assert.match(html, /<canvas id="fx" width="480" height="270" role="img"/);
    assert.match(html, /<style>/);
  } finally {
    cleanup(dir);
  }
});

test('emit inlines the square official favicon with its palette colors', () => {
  const { dir, html } = emitted();
  try {
    const link = /<link rel="icon"[^>]*>/.exec(html)?.[0];
    assert.ok(link, 'favicon link present');
    assert.match(link, /^<link rel="icon" type="image\/png" href="data:image\/png;base64,[A-Za-z0-9+/]+=*">$/);
    assert.ok(!html.includes('LOGO-Compress.png'), 'official file is not referenced');
    assert.ok(!html.includes('favicon.ico'), 'no external favicon file is referenced');
    const match = /href="data:image\/png;base64,([A-Za-z0-9+/]+=*)">/.exec(link);
    const favicon = decodeRgbaPng(Buffer.from(match[1], 'base64'));
    assert.equal(favicon.width, 64, 'favicon width is 64');
    assert.equal(favicon.height, 64, 'favicon height is 64');
    for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]]) {
      assert.equal(favicon.rows[y][x * 4 + 3], 0, `corner ${x},${y} stays transparent`);
    }
    const colors = new Set();
    let transparent = 0;
    for (const row of favicon.rows) {
      for (let i = 0; i < row.length; i += 4) {
        if (row[i + 3] === 0) transparent += 1;
        else colors.add(`${row[i]},${row[i + 1]},${row[i + 2]}`);
      }
    }
    assert.ok(transparent > 1000, 'official transparent background is retained');
    assert.ok(colors.has('17,142,225'), 'official blue palette color is present');
    assert.ok(colors.has('15,160,225'), 'official cyan palette color is present');
  } finally {
    cleanup(dir);
  }
});

test('emit bakes the theme accent and gradient canvas size into the page', () => {
  const { dir, html } = emitted();
  try {
    assert.match(html, /--accent: #097FEB/);
    assert.match(html, /--radius: 12px/);
    assert.match(html, /#fx \{ display: block; width: 480px; height: 270px/);
    assert.match(html, /var SPEC = \{"width":480,"height":270,/);
  } finally {
    cleanup(dir);
  }
});

test('emit resolves state interpolation at compile time', () => {
  const { dir, html } = emitted();
  try {
    assert.ok(html.includes('Count: 0'), 'expected {count} resolved from initial state');
    assert.ok(!html.includes('{count}'), 'raw placeholder must not reach the page');
  } finally {
    cleanup(dir);
  }
});

test('emit contains no runtime IR: no IR JSON, events or interpreter markers', () => {
  const { dir, html } = emitted();
  try {
    for (const marker of ['"tree"', '"events"', '"state"', 'counter.opuir', '"ir":']) {
      assert.ok(!html.includes(marker), `page must not embed ${marker}`);
    }
    // Only the single real script tag; the IR text must never be re-parsed.
    assert.equal(html.match(/<script/g)?.length ?? 0, 1);
  } finally {
    cleanup(dir);
  }
});

test('emit HTML-escapes IR text and attributes', () => {
  const dir = tmpDir();
  try {
    const hostile = ir(
      node(0, 'Column', {}, [
        node(1, 'Text', { value: '<script>alert("x")</script> & more' }),
        node(2, 'Button', { label: "it's <b>bold</b>" }),
      ]),
      { app: 'A<b>&"App"' },
    );
    emitFromIr(hostile, dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal(html.match(/<script/g)?.length ?? 0, 1, 'hostile text must not add script tags');
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more'));
    assert.ok(html.includes('it&#39;s &lt;b&gt;bold&lt;/b&gt;'));
    assert.match(html, /<title>A&lt;b&gt;&amp;&quot;App&quot;<\/title>/);
  } finally {
    cleanup(dir);
  }
});

test('emit omits subtrees guarded by a false initial `when`', () => {
  const dir = tmpDir();
  try {
    const guarded = ir(
      node(0, 'Column', {}, [
        node(1, 'Text', { value: 'always' }),
        { ...node(2, 'Text', { value: 'secret' }), when: 'show' },
      ]),
      { state: [{ name: 'show', type: 'bool', init: false }] },
    );
    emitFromIr(guarded, dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('always'));
    assert.ok(!html.includes('secret'));
    assert.ok(!html.includes('data-node-id="2"'));
  } finally {
    cleanup(dir);
  }
});

test('emit is deterministic: identical IR yields byte-identical HTML', () => {
  const a = emitted();
  const b = emitted();
  try {
    assert.equal(a.html, b.html);
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

test('CLI emit reports the output path and exits 0', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['emit', COUNTER_FIXTURE, dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout.trim(),
      new RegExp(`^emit: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/index\\.html \\(\\d+ bytes\\)$`),
    );
  } finally {
    cleanup(dir);
  }
});

test('emit accepts an input event bound to an int state', () => {
  // A Slider bound to an int state carries a raw input event whose value is a
  // string at runtime; the emitter must accept it and coerce to int.
  const tree = node(0, 'Column', {}, [
    node(1, 'Slider', { bind: 'load', min: 0, max: 100 }, [], { input: { op: 'set', target: 'load' } }),
  ]);
  const data = ir(tree, { state: [{ name: 'load', type: 'int', init: 64 }] });
  const dir = tmpDir();
  try {
    const result = emitFromIr(data, dir);
    const html = fs.readFileSync(result.indexPath, 'utf8');
    assert.match(html, /type="range"/);
    assert.match(html, /parseInt/);
  } finally {
    cleanup(dir);
  }
});

function imageIr() {
  return ir(node(0, 'Column', {}, [
    node(1, 'Image', { src: 'contain.png', width: 120, height: 80, fit: 'contain', label: 'A & "quote"' }),
    node(2, 'Image', { src: 'cover.png', width: 120, height: 80, fit: 'cover', label: 'Covered' }),
    node(3, 'Image', { src: 'fill.png', width: 120, height: 80, fit: 'fill', label: 'Filled' }),
  ]));
}

test('emit renders lazy img tags with dimensions, label alt and all fit modes', () => {
  const html = emitHtml(imageIr());
  const tags = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(tags.length, 3, 'one img tag per Image node');
  assert.deepEqual(tags.map((tag) => /data-node-id="(\d+)"/.exec(tag)[1]), ['1', '2', '3']);
  assert.match(tags[0], /src="contain\.png"/);
  assert.match(tags[0], /alt="A &amp; &quot;quote&quot;"/);
  assert.match(tags[1], /alt="Covered"/);
  assert.match(tags[2], /alt="Filled"/);
  assert.deepEqual(tags.map((tag) => /object-fit:([a-z]+)/.exec(tag)[1]), ['contain', 'cover', 'fill']);
  for (const tag of tags) {
    assert.match(tag, /width="120"/);
    assert.match(tag, /height="80"/);
    assert.match(tag, /loading="lazy"/);
    assert.match(tag, /role="image"/);
  }
  assert.ok(!html.includes('</img>'), 'img stays a void element');
});

test('Image emission is byte-identical and follows IR pre-order', () => {
  const first = emitHtml(imageIr());
  const second = emitHtml(imageIr());
  assert.equal(first, second);
  const ids = [...first.matchAll(/<img\b[^>]*>/g)]
    .map((match) => /data-node-id="(\d+)"/.exec(match[0])[1]);
  assert.deepEqual(ids, ['1', '2', '3']);
});

test('a missing Image src falls back to an inline neutral placeholder', () => {
  const html = emitHtml(ir(node(0, 'Column', {}, [
    node(1, 'Image', { label: 'Missing', width: 80, height: 60, fit: 'cover' }),
  ])));
  const tags = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(tags.length, 1);
  const tag = tags[0];
  const src = /src="([^"]+)"/.exec(tag)[1];
  assert.match(src, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  assert.match(tag, /alt="Missing"/);
  assert.match(tag, /loading="lazy"/);
  assert.match(tag, /width="80"/);
  assert.match(tag, /height="60"/);
  assert.match(tag, /object-fit:cover/);
  const placeholder = decodeRgbaPng(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
  assert.equal(placeholder.width, 1);
  assert.equal(placeholder.height, 1);
  assert.deepEqual([...placeholder.rows[0]], [120, 132, 156, 255], 'neutral gray tile');
  assert.ok(!html.includes('placeholder.png'), 'fallback has no external file reference');
});

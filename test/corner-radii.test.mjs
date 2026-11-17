/* Per-corner radii: CSS ordering, elliptical slash syntax, default byte
 * stability, and a zero-threshold pixel oracle against opurom-render. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { insideCorners, scaleCorners } from '../lib/cpu-reference.mjs';
import { cleanup, COUNTER_FIXTURE, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

const RENDER_ROOT = path.resolve('../opurom-render');
const RENDER_BIN = path.join(RENDER_ROOT, 'target/release/opurom-render');
const FIXTURES = path.join(RENDER_ROOT, 'tests/fixtures');

function emit(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

function styleOf(html, id) {
  const tag = new RegExp(`<[^>]*data-node-id="${id}"[^>]*>`).exec(html);
  assert.ok(tag !== undefined, `node ${id} missing`);
  return /style="([^"]*)"/.exec(tag[0])?.[1] ?? '';
}

function boxIr(props) {
  return ir(node(0, 'Container', props, []));
}

test('four named corners emit CSS order TL TR BR BL by key name', () => {
  const value = boxIr({
    radius: 2,
    cornerRadii: { bottomLeft: 16, topRight: 8, bottomRight: 12, topLeft: 4 },
  });
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0), 'border-radius:4px 8px 12px 16px');
  } finally {
    cleanup(dir);
  }
});

test('elliptical corner emits two equal-length slash groups', () => {
  const value = boxIr({ radius: 4, cornerRadii: { topLeft: [16, 8] } });
  const { dir, html } = emit(value);
  try {
    const style = styleOf(html, 0);
    assert.equal(style, 'border-radius:16px 4px 4px 4px / 8px 4px 4px 4px');
    const radius = /border-radius:([^;"]*)/.exec(style)[1];
    const groups = radius.split('/').map((g) => g.trim().split(' '));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 4);
    assert.equal(groups[1].length, 4);
  } finally {
    cleanup(dir);
  }
});

test('absent cornerRadii keeps the scalar output byte-identical', () => {
  const value = boxIr({ radius: 9, border: '#AABBCC' });
  const { dir, html } = emit(value);
  try {
    assert.equal(styleOf(html, 0), 'border-radius:9px; border:1px solid #AABBCC');
  } finally {
    cleanup(dir);
  }
});

test('counter fixture stays byte-identical with no cornerRadii', () => {
  const counter = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
  const { dir, html, bytes } = emit(counter);
  try {
    assert.equal(bytes, 6202);
    assert.equal(crypto.createHash('sha256').update(html).digest('hex'),
      '7d8bcc75432cc6392163ef3d96c7afc466941babf2eb7969f319d75e913bec2f');
  } finally {
    cleanup(dir);
  }
});

function parsePpm(file) {
  const buffer = fs.readFileSync(file);
  const match = /P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buffer.toString('latin1'));
  const offset = match.index + match[0].length;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    pixels: buffer.subarray(offset),
  };
}

function renderPpm(irFile, outFile) {
  const binary = fs.existsSync(RENDER_BIN)
    ? RENDER_BIN
    : path.join(RENDER_ROOT, 'target/debug/opurom-render');
  if (!fs.existsSync(binary)) return null;
  const run = spawnSync(binary, [irFile, '120', '120', outFile], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return parsePpm(outFile);
}

function compareWithOracle(irFile, rawCorners, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-corner-oracle-'));
  try {
    const ppm = renderPpm(irFile, path.join(dir, 'out.ppm'));
    if (ppm === null) return null;
    assert.equal(ppm.width, 120);
    assert.equal(ppm.height, 120);
    const corners = scaleCorners(rawCorners, 80, 80);
    let diff = 0;
    let maxErr = 0;
    let compared = 0;
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        const expected = insideCorners(x - 20, y - 20, 80, 80, corners);
        const actual = ppm.pixels[(y * 120 + x) * 3] === 0;
        const err = expected === actual ? 0 : 1;
        if (err !== 0) diff += 1;
        if (err > maxErr) maxErr = err;
        compared += 1;
      }
    }
    assert.equal(diff, 0, `${label}: ${diff} differing pixels vs opurom-render`);
    assert.equal(maxErr, 0, `${label}: max_err ${maxErr}`);
    return { label, compared, diff, maxErr, digest: ppm.pixels.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('per-corner containment equals opurom-render software raster', { skip: !fs.existsSync(RENDER_BIN) }, () => {
  const four = compareWithOracle(
    path.join(FIXTURES, 'corner-radii-four.json'),
    {
      topLeft: { x: 10, y: 10 }, topRight: { x: 20, y: 20 },
      bottomRight: { x: 30, y: 30 }, bottomLeft: { x: 40, y: 40 },
    },
    'four',
  );
  const elliptical = compareWithOracle(
    path.join(FIXTURES, 'corner-radii-elliptical.json'),
    {
      topLeft: { x: 40, y: 10 }, topRight: { x: 4, y: 4 },
      bottomRight: { x: 8, y: 24 }, bottomLeft: { x: 4, y: 4 },
    },
    'elliptical',
  );
  for (const result of [four, elliptical]) {
    assert.ok(result !== null, 'render oracle must be available for this test');
    assert.equal(result.diff, 0);
  }
});

test('border inset shrinks each corner by borderSize', () => {
  const corners = scaleCorners({
    topLeft: { x: 10, y: 10 }, topRight: { x: 20, y: 20 },
    bottomRight: { x: 30, y: 30 }, bottomLeft: { x: 40, y: 40 },
  }, 80, 80);
  const inner = scaleCorners({
    topLeft: { x: corners.topLeft.x - 1, y: corners.topLeft.y - 1 },
    topRight: { x: corners.topRight.x - 1, y: corners.topRight.y - 1 },
    bottomRight: { x: corners.bottomRight.x - 1, y: corners.bottomRight.y - 1 },
    bottomLeft: { x: corners.bottomLeft.x - 1, y: corners.bottomLeft.y - 1 },
  }, 78, 78);
  assert.deepEqual(inner, {
    topLeft: { x: 9, y: 9 }, topRight: { x: 19, y: 19 },
    bottomRight: { x: 29, y: 29 }, bottomLeft: { x: 39, y: 39 },
  });
});

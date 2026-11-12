/* Headless browser verification: SKIP gracefully when no browser exists (Linux
 * CI), otherwise run the real page in headless Chromium and assert the canvas
 * getImageData digest against the independent Node CPU reference plus DOM
 * roles and computed styles. Also unit-checks fact parsing and fact mismatch
 * reporting so the non-browser parts run everywhere. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { findBrowser } from '../lib/browser.mjs';
import { referenceDigest } from '../lib/cpu-reference.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { expectedStyles, compareFacts, parseFacts, verify } from '../lib/verify.mjs';
import { COUNTER_FIXTURE, runCli, tmpDir, cleanup } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

test('parseFacts decodes the base64 facts blob the page writes into the DOM', () => {
  const payload = { digest: 'abcdef0123456789', roles: [], styles: {}, canvas: { width: 480, height: 270 } };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const dump = `<html><head><meta id="opurom-verify" name="opurom-verify" data-result="${b64}" data-ready="1"></head><body></body></html>`;
  assert.deepEqual(parseFacts(dump), payload);
  assert.throws(() => parseFacts('<html></html>'), /meta tag missing/);
  assert.throws(
    () => parseFacts('<meta id="opurom-verify" name="opurom-verify">'),
    /data-result missing/,
  );
});

test('expectedStyles derives asserted computed styles from the IR', () => {
  const spec = gradientSpec(counterIr);
  assert.deepEqual(expectedStyles(counterIr, spec), {
    headerDisplay: 'block',
    mainDisplay: 'block',
    canvasDisplay: 'block',
    buttonDisplay: 'inline-flex',
    buttonBackground: 'rgb(79, 70, 229)',
    headingFontSize: '24px',
  });
});

test('compareFacts flags digest, role and style mismatches', () => {
  const spec = gradientSpec(counterIr);
  const cpuDigest = referenceDigest(spec);
  const facts = {
    digest: cpuDigest,
    canvas: { width: spec.width, height: spec.height },
    roles: [
      { id: 0, tag: 'div', role: 'none' },
      { id: 1, tag: 'h2', role: 'heading' },
      { id: 2, tag: 'div', role: 'none' },
      { id: 3, tag: 'button', role: 'button' },
      { id: 4, tag: 'button', role: 'button' },
    ],
    styles: expectedStyles(counterIr, spec),
  };
  assert.deepEqual(compareFacts(facts, counterIr, spec, cpuDigest), [], 'golden facts must pass');

  const wrongDigest = compareFacts({ ...facts, digest: '0000000000000000' }, counterIr, spec, cpuDigest);
  assert.equal(wrongDigest.length, 1);
  assert.match(wrongDigest[0], /canvas digest mismatch/);

  const wrongRole = compareFacts(
    { ...facts, roles: facts.roles.map((r, i) => (i === 3 ? { ...r, role: 'link' } : r)) },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongRole.length, 1);
  assert.match(wrongRole[0], /role mismatch at index 3/);

  const wrongStyle = compareFacts(
    { ...facts, styles: { ...facts.styles, headingFontSize: '99px' } },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongStyle.length, 1);
  assert.match(wrongStyle[0], /headingFontSize/);

  const wrongSize = compareFacts(
    { ...facts, canvas: { width: 100, height: 100 } },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongSize.length, 1);
  assert.match(wrongSize[0], /canvas size mismatch/);
});

test('verify emits a PASS or documented SKIP with exit code 0', async () => {
  const dir = tmpDir();
  try {
    const lines = [];
    const result = await verify(COUNTER_FIXTURE, dir, {
      log: (line) => lines.push(line),
    });
    // With a browser present this is PASS; without one it is a documented SKIP.
    // Either way it must not fail, and the CPU digest line must be emitted.
    assert.ok([0].includes(result.code), `unexpected exit code ${result.code}: ${lines.join('\n')}`);
    assert.ok(lines.some((l) => /^cpu-digest: [0-9a-f]{16}$/.test(l)), lines.join('\n'));
    assert.ok(
      lines.some((l) => l.startsWith('PASS:')) || lines.some((l) => l.startsWith('SKIP: headless browser unavailable')),
      lines.join('\n'),
    );
    if (result.status === 'pass') {
      assert.equal(result.digest, referenceDigest(gradientSpec(counterIr)));
    }
  } finally {
    cleanup(dir);
  }
});

test('CLI verify asserts digest/roles/styles when a browser is available', (t) => {
  const found = findBrowser();
  if (found.path === null) {
    t.skip(`headless browser unavailable: ${found.reason}`);
    return;
  }
  const dir = tmpDir();
  try {
    const run = runCli(['verify', COUNTER_FIXTURE, dir], { timeout: 120_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /canvas-digest: ([0-9a-f]{16})/);
    const printed = /canvas-digest: ([0-9a-f]{16})/.exec(run.stdout)[1];
    assert.equal(printed, referenceDigest(gradientSpec(counterIr)), 'browser digest must equal CPU reference');
    assert.match(run.stdout, /^PASS: verified canvas digest/m);
    assert.ok(!run.stdout.includes('SKIP:'), 'browser exists, so no skip is allowed');
  } finally {
    cleanup(dir);
  }
});

test('verify SKIPs with exit 0 when the configured browser is unavailable', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['verify', COUNTER_FIXTURE, dir], {
      env: { OPUROM_BROWSER: '/nonexistent/headless-chromium' },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^SKIP: headless browser unavailable \(.+\)$/m);
    assert.ok(!run.stdout.includes('PASS:'), 'skip must not claim a pass');
    // The page is still emitted before skipping, so callers can inspect it.
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  } finally {
    cleanup(dir);
  }
});

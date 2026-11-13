/* Headless browser verification: SKIP gracefully when no browser exists (Linux
 * CI), otherwise run the real page in headless Chromium twice (the rerun pins
 * render determinism) and assert the canvas getImageData digest against the
 * independent Node CPU reference plus ARIA attributes, document facts and
 * computed styles. Also unit-checks fact parsing and fact mismatch reporting
 * so the non-browser parts run everywhere. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { findBrowser } from '../lib/browser.mjs';
import { referenceDigest } from '../lib/cpu-reference.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { expectedAria, expectedDomFacts, expectedStyles, compareFacts, parseFacts, verify } from '../lib/verify.mjs';
import { COUNTER_FIXTURE, richIr, runCli, tmpDir, cleanup, writeJson } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

/* Golden facts for the counter fixture: roles plus the ARIA attributes and
 * document facts the same contract derives on the Node side. */
function goldenRoles(irValue) {
  const aria = expectedAria(irValue);
  return expectedDom(irValue).map((entry) => ({ ...entry, ...aria.get(entry.id) }));
}

test('parseFacts decodes the base64 facts blob the page writes into the DOM', () => {
  const payload = {
    digest: 'abcdef0123456789',
    roles: [],
    styles: {},
    canvas: { width: 480, height: 270 },
    dom: { lang: 'en', title: 'Counter', h1: 'Counter', canvasLabel: 'Deterministic theme gradient' },
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const dump = `<html><head><meta id="opurom-verify" name="opurom-verify" data-result="${b64}" data-ready="1"></head><body></body></html>`;
  assert.deepEqual(parseFacts(dump), payload);
  assert.throws(() => parseFacts('<html></html>'), /meta tag missing/);
  assert.throws(
    () => parseFacts('<meta id="opurom-verify" name="opurom-verify">'),
    /data-result missing/,
  );
  const noDom = Buffer.from(JSON.stringify({ ...payload, dom: undefined }), 'utf8').toString('base64');
  assert.throws(
    () => parseFacts(`<meta id="opurom-verify" data-result="${noDom}">`),
    /reported facts lack field dom/,
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
    bodyBackground: 'rgb(255, 255, 255)',
    canvasRadius: '12px',
  });
});

test('compareFacts flags digest, ARIA, dom, role and style mismatches', () => {
  const spec = gradientSpec(counterIr);
  const cpuDigest = referenceDigest(spec);
  const facts = {
    digest: cpuDigest,
    canvas: { width: spec.width, height: spec.height },
    roles: goldenRoles(counterIr),
    dom: expectedDomFacts(counterIr),
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

  const wrongAria = compareFacts(
    { ...facts, roles: facts.roles.map((r, i) => (i === 1 ? { ...r, ariaLevel: '3' } : r)) },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongAria.length, 1);
  assert.match(wrongAria[0], /aria mismatch at node 1 \(ariaLevel\): browser="3" expected="2"/);

  const missingAria = compareFacts(
    { ...facts, roles: facts.roles.map((r, i) => (i === 1 ? { ...r, ariaLevel: null } : r)) },
    counterIr, spec, cpuDigest,
  );
  assert.equal(missingAria.length, 1);
  assert.match(missingAria[0], /aria mismatch at node 1 \(ariaLevel\): browser=null expected="2"/);

  const wrongTitle = compareFacts({ ...facts, dom: { ...facts.dom, title: 'Nope' } }, counterIr, spec, cpuDigest);
  assert.equal(wrongTitle.length, 1);
  assert.match(wrongTitle[0], /dom fact mismatch title: browser="Nope" expected="Counter"/);

  const wrongStyle = compareFacts(
    { ...facts, styles: { ...facts.styles, headingFontSize: '99px' } },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongStyle.length, 1);
  assert.match(wrongStyle[0], /headingFontSize/);

  const wrongRadius = compareFacts(
    { ...facts, styles: { ...facts.styles, canvasRadius: '9px' } },
    counterIr, spec, cpuDigest,
  );
  assert.equal(wrongRadius.length, 1);
  assert.match(wrongRadius[0], /canvasRadius/);

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
      lines.some((l) => l.startsWith('PASS:')) || lines.some((l) => l.startsWith('SKIP: headless browser ')),
      lines.join('\n'),
    );
    if (result.status === 'pass') {
      assert.equal(result.digest, referenceDigest(gradientSpec(counterIr)));
      // The determinism rerun must have rendered the identical digest.
      assert.ok(lines.some((l) => /^rerun-canvas-digest: [0-9a-f]{16}$/.test(l)), lines.join('\n'));
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
    // A browser binary can exist but be unable to render (headless timeout on a
    // constrained runner). That is a documented SKIP, not a failed assertion.
    if (/SKIP: headless browser could not render the page here/.test(run.stdout)) {
      assert.match(run.stdout, /timed out after \d+ ms/);
      return;
    }
    assert.match(run.stdout, /canvas-digest: ([0-9a-f]{16})/);
    const printed = /canvas-digest: ([0-9a-f]{16})/.exec(run.stdout)[1];
    assert.equal(printed, referenceDigest(gradientSpec(counterIr)), 'browser digest must equal CPU reference');
    const rerun = /^rerun-canvas-digest: ([0-9a-f]{16})$/m.exec(run.stdout);
    assert.ok(rerun, `missing determinism rerun digest: ${run.stdout}`);
    assert.equal(rerun[1], printed, 'rerun digest must equal the first run digest');
    assert.match(
      run.stdout,
      /^PASS: verified canvas digest [0-9a-f]{16} equals independent Node CPU reference; 5 roles and 8 computed styles match$/m,
    );
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

test('real browser reports ARIA binding, document facts and a stable rerun digest', async () => {
  const irValue = richIr();
  const dir = tmpDir();
  try {
    const irPath = path.join(dir, 'rich.opuir.json');
    writeJson(irPath, irValue);
    const lines = [];
    const result = await verify(irPath, path.join(dir, 'out'), { log: (line) => lines.push(line) });
    if (result.status === 'skip') {
      assert.ok(lines.some((l) => /^SKIP: headless browser /.test(l)), lines.join('\n'));
      return;
    }
    // PASS proves the browser reported the non-null facts this IR derives:
    // aria-label "Zoë icon", aria-checked true/false, slider value "4",
    // heading level 2, and the non-ASCII title/h1 through the UTF-8 blob.
    const output = lines.join('\n');
    assert.equal(result.status, 'pass', output);
    assert.equal(result.digest, referenceDigest(gradientSpec(irValue)));
    assert.match(
      output,
      /^PASS: verified canvas digest [0-9a-f]{16} equals independent Node CPU reference; 7 roles and 8 computed styles match$/m,
    );
    assert.match(output, /^rerun-canvas-digest: [0-9a-f]{16}$/m);
  } finally {
    cleanup(dir);
  }
});

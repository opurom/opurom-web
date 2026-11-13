/* Browser matrix tests: pure report semantics including cross-engine digest
 * agreement, a real two-engine CLI run, single-engine failure, WebKit SKIPs,
 * bounded helper timeout and cleanup. Browser-dependent tests self-skip with a
 * concrete reason. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { DEFAULT_TIMEOUT_MS, findBrowser } from '../lib/browser.mjs';
import { referenceDigest } from '../lib/cpu-reference.mjs';
import { buildMatrixReport, verifyMatrix } from '../lib/matrix.mjs';
import { gradientSpec } from '../lib/spec.mjs';
import { expectedAria, expectedDomFacts, expectedParticles, expectedStyles } from '../lib/verify.mjs';
import { findWebKit, runWebKit } from '../lib/webkit.mjs';
import { COUNTER_FIXTURE, ROOT, runCli, tmpDir, cleanup } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));
const spec = gradientSpec(counterIr);
const cpuDigest = referenceDigest(spec);

function engine(overrides = {}) {
  return {
    status: 'pass',
    location: 'fixture',
    digest: cpuDigest,
    equalsReference: true,
    roles: 5,
    styles: 8,
    failures: [],
    reason: null,
    ...overrides,
  };
}

function facts(digest = cpuDigest) {
  const aria = expectedAria(counterIr);
  return {
    digest,
    canvas: { width: spec.width, height: spec.height },
    roles: expectedDom(counterIr).map((entry) => ({ ...entry, ...aria.get(entry.id) })),
    particles: expectedParticles(spec),
    dom: expectedDomFacts(counterIr),
    styles: expectedStyles(counterIr, spec),
  };
}

test('matrix report preserves both engine digests and equality flags', () => {
  const report = buildMatrixReport({
    chromium: engine({ location: 'Microsoft Edge' }),
    webkit: engine({ location: 'WKWebView' }),
  }, cpuDigest);
  assert.equal(report.code, 0);
  assert.equal(report.status, 'pass');
  assert.equal(report.cpuDigest, cpuDigest);
  assert.deepEqual(Object.keys(report.engines), ['chromium', 'webkit']);
  for (const name of ['chromium', 'webkit']) {
    assert.equal(report.engines[name].digest, cpuDigest);
    assert.equal(report.engines[name].equalsReference, true);
    assert.deepEqual(report.engines[name].failures, []);
  }
  assert.deepEqual(report.passed, ['chromium', 'webkit']);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.crossEngine, { checked: true, agree: true });
});

test('a single-engine digest mismatch fails the whole matrix', () => {
  const mismatch = engine({
    status: 'fail',
    digest: '0000000000000000',
    equalsReference: false,
    failures: [`canvas digest mismatch: browser=0000000000000000 node-reference=${cpuDigest}`],
  });
  const report = buildMatrixReport({ chromium: engine(), webkit: mismatch }, cpuDigest);
  assert.equal(report.code, 1);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.passed, ['chromium']);
  assert.match(report.failures.join('\n'), /^webkit: canvas digest mismatch/m);
});

test('cross-engine digest disagreement fails and names the diverging engine', () => {
  const other = '1111111111111111';
  const report = buildMatrixReport({
    chromium: engine(),
    webkit: engine({ digest: other, failures: [] }),
  }, cpuDigest);
  assert.equal(report.code, 1);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.crossEngine, { checked: true, agree: false });
  // Both engines must be pinned to the CPU reference, so the engine whose
  // digest is not the reference one is the one that diverged.
  assert.deepEqual(report.passed, ['chromium']);
  assert.ok(
    report.failures.some((f) => f === `webkit: digest=${other} equals-cpu-reference=true`),
    report.failures.join('\n'),
  );
  assert.ok(
    report.failures.some(
      (f) => f === `cross-engine digest mismatch: chromium=${cpuDigest} webkit=${other}; diverged from Node reference: webkit`,
    ),
    report.failures.join('\n'),
  );
});

test('WebKit SKIP keeps the Chromium result without faking a second pass', async () => {
  const macReason = findWebKit({ platform: 'linux' }).reason;
  assert.match(macReason, /^WKWebView requires macOS \(host is linux\)$/);
  assert.match(
    findWebKit({ platform: 'darwin', xcrunPath: '/nonexistent/xcrun', frameworkPath: ROOT }).reason,
    /xcrun is not an executable file/,
  );

  const dir = tmpDir();
  const lines = [];
  try {
    const report = await verifyMatrix(COUNTER_FIXTURE, dir, {
      runners: {
        chromium: async () => ({ status: 'measured', facts: facts(), location: 'fixture' }),
        webkit: async () => ({ status: 'skip', reason: macReason }),
      },
      log: (line) => lines.push(line),
    });
    assert.equal(report.code, 0);
    assert.equal(report.status, 'partial');
    assert.equal(report.engines.chromium.digest, cpuDigest);
    assert.equal(report.engines.chromium.equalsReference, true);
    assert.equal(report.engines.webkit.status, 'skip');
    assert.equal(report.engines.webkit.digest, null);
    assert.equal(report.engines.webkit.equalsReference, null);
    assert.deepEqual(report.crossEngine, { checked: false, agree: null });
    assert.match(lines.join('\n'), /^SKIP webkit: WKWebView requires macOS \(host is linux\)$/m);
    assert.match(lines.join('\n'), /^webkit: digest=unmeasured equals-cpu-reference=n\/a$/m);
    assert.ok(!lines.some((line) => /^PASS: Chromium and WebKit/m.test(line)));
  } finally {
    cleanup(dir);
  }
});

test('a matrix with no available engines exits 0 with documented SKIPs', async () => {
  const dir = tmpDir();
  const lines = [];
  try {
    const report = await verifyMatrix(COUNTER_FIXTURE, dir, {
      runners: {
        chromium: async () => ({ status: 'skip', reason: 'no Chromium executable found' }),
        webkit: async () => ({ status: 'skip', reason: 'WKWebView requires macOS (host is linux)' }),
      },
      log: (line) => lines.push(line),
    });
    assert.equal(report.code, 0);
    assert.equal(report.status, 'skip');
    assert.deepEqual(report.passed, []);
    assert.deepEqual(report.skipped, ['chromium', 'webkit']);
    const output = lines.join('\n');
    assert.match(output, /^SKIP chromium: no Chromium executable found$/m);
    assert.match(output, /^SKIP webkit: WKWebView requires macOS \(host is linux\)$/m);
    assert.match(output, /^SKIP: no browser engine available; no digest was measured$/m);
    assert.ok(!/^PASS:/m.test(output), 'no engine result may be claimed as a pass');
  } finally {
    cleanup(dir);
  }
});

test('CLI verify --matrix measures both real engines against the CPU reference', (t) => {
  const chromium = findBrowser();
  const webkit = findWebKit();
  if (chromium.path === null || webkit.path === null) {
    t.skip(`real two-engine matrix unavailable: chromium=${chromium.reason ?? 'found'}, webkit=${webkit.reason ?? 'found'}`);
    return;
  }
  const dir = tmpDir();
  try {
    const run = runCli(['verify', '--matrix', COUNTER_FIXTURE, dir], { timeout: 120_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, new RegExp(`^cpu-digest: ${cpuDigest}$`, 'm'));
    for (const name of ['chromium', 'webkit']) {
      const line = new RegExp(`^${name}: digest=([0-9a-f]{16}) equals-cpu-reference=true roles=5 styles=8$`, 'm');
      const match = line.exec(run.stdout);
      assert.ok(match, `missing measured ${name} line: ${run.stdout}`);
      assert.equal(match[1], cpuDigest, `${name} digest must equal the independent Node CPU reference`);
    }
    assert.match(
      run.stdout,
      /^cross-engine: chromium digest [0-9a-f]{16} equals webkit digest [0-9a-f]{16}$/m,
    );
    assert.match(run.stdout, /^PASS: Chromium and WebKit measured digests both equal independent Node CPU reference/m);
    assert.ok(!run.stdout.includes('SKIP'), 'both engines are available, so no skip is expected');
  } finally {
    cleanup(dir);
  }
});

test('CLI verify --matrix exits 1 when one measured engine mismatches', () => {
  const dir = tmpDir();
  try {
    const encoded = Buffer.from(JSON.stringify(facts('0000000000000000')), 'utf8').toString('base64');
    const fakeBrowser = path.join(dir, 'fake-chromium');
    fs.writeFileSync(fakeBrowser, `#!/bin/sh
printf '<html><head><meta id="opurom-verify" data-result="%s" data-ready="1"></head><body></body></html>\\n' "$OPR_FAKE_B64"
`);
    fs.chmodSync(fakeBrowser, 0o755);
    const run = runCli(['verify', '--matrix', COUNTER_FIXTURE, path.join(dir, 'out')], {
      env: { OPUROM_BROWSER: fakeBrowser, OPR_FAKE_B64: encoded },
      timeout: 120_000,
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^chromium: digest=0000000000000000 equals-cpu-reference=false roles=5 styles=8$/m);
    assert.match(run.stdout, /^error: chromium: canvas digest mismatch/m);
    assert.match(run.stdout, /^FAIL: at least one engine does not satisfy independent Node CPU reference/m);
    assert.ok(!/^PASS:/m.test(run.stdout), 'one mismatch must not produce a PASS');
  } finally {
    cleanup(dir);
  }
});

test('WebKit helper timeout kills its process group and removes the temp profile', async () => {
  assert.ok(DEFAULT_TIMEOUT_MS <= 30_000);
  const dir = tmpDir();
  const profiles = path.join(dir, 'profiles');
  const fakeXcrun = path.join(dir, 'slow-xcrun');
  const pidFile = path.join(dir, 'helper.pid');
  fs.mkdirSync(profiles);
  fs.writeFileSync(fakeXcrun, `#!/bin/sh
printf '%s' "$$" > "$OPR_PID_FILE"
sleep 30
`);
  fs.chmodSync(fakeXcrun, 0o755);
  try {
    const started = Date.now();
    const result = await runWebKit(COUNTER_FIXTURE, {
      timeoutMs: 1_000,
      platform: 'darwin',
      xcrunPath: fakeXcrun,
      frameworkPath: path.join(ROOT, 'package.json'),
      tempBase: profiles,
      env: { ...process.env, OPR_PID_FILE: pidFile },
    });
    assert.equal(result.status, 'skip');
    assert.match(result.reason, /WebKit helper compilation timed out after 1000 ms/);
    assert.ok(Date.now() - started < 7_000, 'a hung helper must not outlive its bounded deadline');
    assert.deepEqual(fs.readdirSync(profiles), [], 'temporary WebKit profile must be removed');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), 'helper process must be killed');
    if (process.platform !== 'win32') {
      assert.throws(() => process.kill(-pid, 0), 'helper process group must be killed');
    }
  } finally {
    cleanup(dir);
  }
});

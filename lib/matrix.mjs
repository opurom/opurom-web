/* Two-engine matrix: emit one page, measure it independently in Chromium and
 * real WebKit, then compare every measured digest (and DOM facts) against one
 * independent Node CPU reference. A skip is never counted as a pass, and any
 * measured mismatch makes the whole matrix fail. */

import { pathToFileURL } from 'node:url';

import { DEFAULT_TIMEOUT_MS, findBrowser, runBrowser } from './browser.mjs';
import { referenceDigest } from './cpu-reference.mjs';
import { emitFromIr } from './emit.mjs';
import { loadIr } from './ir.mjs';
import { gradientSpec } from './spec.mjs';
import { compareFacts, parseFacts } from './verify.mjs';
import { runWebKit } from './webkit.mjs';

export const ENGINE_NAMES = ['chromium', 'webkit'];

function boundedTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(1, Math.min(Math.floor(numeric), DEFAULT_TIMEOUT_MS));
}

function diagnostic(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(' | ') || 'no diagnostic';
}

async function chromiumRunner({ indexPath, timeoutMs }) {
  const browser = findBrowser();
  if (browser.path === null) return { status: 'skip', reason: browser.reason };

  const run = await runBrowser(browser.path, pathToFileURL(indexPath).href, { timeoutMs });
  if (run.spawnError !== null) {
    return { status: 'skip', reason: `failed to launch ${browser.path}: ${run.spawnError}` };
  }
  if (run.timedOut) {
    return { status: 'skip', reason: `Chromium timed out after ${run.timeoutMs} ms` };
  }
  if (run.code !== 0) {
    return { status: 'error', reason: `Chromium exited with code ${run.code}: ${diagnostic(run.stderr)}` };
  }
  try {
    return { status: 'measured', facts: parseFacts(run.stdout), location: browser.path };
  } catch (error) {
    return { status: 'error', reason: `Chromium facts parse failed: ${error.message}` };
  }
}

function webkitRunner({ indexPath, timeoutMs }) {
  return runWebKit(indexPath, { timeoutMs });
}

const DEFAULT_RUNNERS = { chromium: chromiumRunner, webkit: webkitRunner };

function emptyEngine(status, reason) {
  return {
    status,
    location: null,
    digest: null,
    equalsReference: null,
    roles: 0,
    styles: 0,
    failures: [],
    reason,
  };
}

function measuredEngine(outcome, ir, spec, cpuDigest) {
  const facts = outcome.facts;
  if (
    facts === null || typeof facts !== 'object' ||
    typeof facts.digest !== 'string' || !Array.isArray(facts.roles) ||
    facts.styles === null || typeof facts.styles !== 'object' ||
    facts.canvas === null || typeof facts.canvas !== 'object'
  ) {
    throw new Error('measured facts are incomplete');
  }
  const failures = compareFacts(facts, ir, spec, cpuDigest);
  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    location: outcome.location ?? null,
    digest: facts.digest,
    equalsReference: facts.digest === cpuDigest,
    roles: facts.roles.length,
    styles: Object.keys(facts.styles).length,
    failures,
    reason: null,
  };
}

function engineFromOutcome(name, outcome, ir, spec, cpuDigest) {
  if (outcome?.status === 'skip') {
    return emptyEngine('skip', outcome.reason || `${name} is unavailable`);
  }
  if (outcome?.status === 'error') {
    return emptyEngine('error', outcome.reason || `${name} could not measure the page`);
  }
  if (outcome?.status !== 'measured') {
    return emptyEngine('error', `${name} returned no measured facts`);
  }
  try {
    return measuredEngine(outcome, ir, spec, cpuDigest);
  } catch (error) {
    return emptyEngine('error', `${name} reported invalid facts: ${error.message}`);
  }
}

/* Pure report builder, so tests can check partial/mismatch semantics without
 * launching browsers. Every engine remains visible in engines[]. */
export function buildMatrixReport(engines, cpuDigest) {
  const normalized = {};
  const failures = [];
  const passed = [];
  const skipped = [];

  for (const name of ENGINE_NAMES) {
    const engine = engines[name] ?? emptyEngine('error', `${name} report is missing`);
    normalized[name] = engine;
    if (engine.status === 'skip') {
      skipped.push(name);
      continue;
    }
    if (engine.status === 'pass' && engine.equalsReference === true && engine.failures.length === 0) {
      passed.push(name);
      continue;
    }
    const detail = engine.status === 'error'
      ? engine.reason
      : engine.failures.join('; ') ||
        `digest=${engine.digest ?? 'unmeasured'} equals-cpu-reference=${String(engine.equalsReference)}`;
    failures.push(`${name}: ${detail}`);
  }

  let status = 'pass';
  let code = 0;
  if (failures.length > 0) {
    status = 'fail';
    code = 1;
  } else if (skipped.length === ENGINE_NAMES.length) {
    status = 'skip';
  } else if (skipped.length > 0) {
    status = 'partial';
  }
  return { code, status, cpuDigest, engines: normalized, failures, passed, skipped };
}

function logEngine(name, engine, log) {
  if (engine.status === 'skip') {
    log(`SKIP ${name}: ${engine.reason}`);
    log(`${name}: digest=unmeasured equals-cpu-reference=n/a`);
    return;
  }
  if (engine.status === 'error') {
    log(`ERROR ${name}: ${engine.reason}`);
    log(`${name}: digest=unmeasured equals-cpu-reference=n/a`);
    return;
  }
  log(
    `${name}: digest=${engine.digest} equals-cpu-reference=${engine.equalsReference ? 'true' : 'false'} ` +
      `roles=${engine.roles} styles=${engine.styles}`,
  );
}

function logSummary(report, log) {
  if (report.status === 'fail') {
    for (const failure of report.failures) log(`error: ${failure}`);
    log(`FAIL: at least one engine does not satisfy independent Node CPU reference ${report.cpuDigest}`);
    return;
  }
  if (report.status === 'skip') {
    log('SKIP: no browser engine available; no digest was measured');
    return;
  }
  if (report.status === 'partial') {
    log(
      `PASS: ${report.passed.join(', ')} equals independent Node CPU reference ${report.cpuDigest}; ` +
        `${report.skipped.join(', ')} engine skipped (not a pass)`,
    );
    return;
  }
  log(`PASS: Chromium and WebKit measured digests both equal independent Node CPU reference ${report.cpuDigest}`);
}

export async function verifyMatrix(irPath, outDir, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
  runners = {},
} = {}) {
  const ir = loadIr(irPath);
  const spec = gradientSpec(ir);
  const cpuDigest = referenceDigest(spec);
  const emitted = emitFromIr(ir, outDir);
  const budget = boundedTimeout(timeoutMs);
  log(`emit: ${emitted.indexPath} (${emitted.bytes} bytes)`);
  log(`cpu-digest: ${cpuDigest}`);

  const selected = { ...DEFAULT_RUNNERS, ...runners };
  const outcomes = await Promise.all(ENGINE_NAMES.map(async (name) => {
    try {
      return await selected[name]({ indexPath: emitted.indexPath, timeoutMs: budget, ir, spec, cpuDigest });
    } catch (error) {
      return { status: 'error', reason: `${name} runner failed: ${error.message}` };
    }
  }));

  const engines = {};
  for (let i = 0; i < ENGINE_NAMES.length; i += 1) {
    const name = ENGINE_NAMES[i];
    engines[name] = engineFromOutcome(name, outcomes[i], ir, spec, cpuDigest);
    logEngine(name, engines[name], log);
  }
  const report = buildMatrixReport(engines, cpuDigest);
  logSummary(report, log);
  return report;
}

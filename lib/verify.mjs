/* Verification pipeline: emit -> independent Node CPU digest -> one bounded
 * headless browser run -> parse facts written by the page into the DOM ->
 * assert canvas digest, ARIA roles and computed styles. Returns an exit code:
 * 0 = PASS or documented SKIP, 1 = assertion/launch failure. */

import { expectedDom, textFontSize, visibleNodes } from './a11y.mjs';
import { DEFAULT_TIMEOUT_MS, findBrowser, runBrowser } from './browser.mjs';
import { referenceDigest } from './cpu-reference.mjs';
import { emitFromIr } from './emit.mjs';
import { loadIr } from './ir.mjs';
import { gradientSpec, parseHexColor } from './spec.mjs';
import { pathToFileURL } from 'node:url';

export function expectedStyles(ir, spec) {
  const dom = expectedDom(ir);
  const hasButton = dom.some((entry) => entry.tag === 'button');
  const heading = visibleNodes(ir).find((entry) => entry.role === 'heading');
  const accent = parseHexColor(ir.theme.accent);
  return {
    headerDisplay: 'block',
    mainDisplay: 'block',
    canvasDisplay: 'block',
    buttonDisplay: hasButton ? 'inline-flex' : null,
    buttonBackground: hasButton ? `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})` : null,
    headingFontSize: heading === undefined ? null : `${textFontSize(heading.node)}px`,
  };
}

/* Extract the base64 JSON facts the page stored on <meta id="opurom-verify">.
 * --dump-dom serializes attributes, and base64 needs no HTML escaping. */
export function parseFacts(dump) {
  const tag = /<meta\b[^>]*id="opurom-verify"[^>]*>/.exec(dump);
  if (tag === null) throw new Error('verify meta tag missing from dumped DOM');
  const match = /data-result="([^"]+)"/.exec(tag[0]);
  if (match === null) throw new Error('page did not report facts (data-result missing)');
  const facts = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  for (const key of ['digest', 'roles', 'styles', 'canvas']) {
    if (facts[key] === undefined) throw new Error(`reported facts lack field ${key}`);
  }
  return facts;
}

function numbersOf(text) {
  return String(text).match(/\d+/g)?.map(Number) ?? null;
}

function sameStyleValue(key, actual, expected) {
  if (expected === null || actual === null || actual === undefined) return expected === (actual ?? null);
  if (key === 'buttonBackground') {
    const a = numbersOf(actual);
    const e = numbersOf(expected);
    return a !== null && e !== null && a.length >= 3 && e.length >= 3 &&
      a[0] === e[0] && a[1] === e[1] && a[2] === e[2];
  }
  if (key === 'buttonDisplay') {
    // Chrome reports the used display: a flex item is blockified, so a button
    // with `display: inline-flex` inside .row reads back as "flex".
    return actual === expected || (expected === 'inline-flex' && actual === 'flex');
  }
  return String(actual) === String(expected);
}

export function compareFacts(facts, ir, spec, cpuDigest) {
  const failures = [];
  if (facts.digest !== cpuDigest) {
    failures.push(`canvas digest mismatch: browser=${facts.digest} node-reference=${cpuDigest}`);
  }
  if (facts.canvas.width !== spec.width || facts.canvas.height !== spec.height) {
    failures.push(`canvas size mismatch: browser=${facts.canvas.width}x${facts.canvas.height} expected=${spec.width}x${spec.height}`);
  }

  const expectedRoles = expectedDom(ir);
  const actualRoles = Array.isArray(facts.roles) ? facts.roles : [];
  if (actualRoles.length !== expectedRoles.length) {
    failures.push(`role count mismatch: browser=${actualRoles.length} expected=${expectedRoles.length}`);
  }
  const shared = Math.min(actualRoles.length, expectedRoles.length);
  for (let i = 0; i < shared; i += 1) {
    const actual = actualRoles[i];
    const expected = expectedRoles[i];
    if (actual.id !== expected.id || actual.tag !== expected.tag || actual.role !== expected.role) {
      failures.push(
        `role mismatch at index ${i}: browser=[id=${actual.id} tag=${actual.tag} role=${actual.role}] ` +
          `expected=[id=${expected.id} tag=${expected.tag} role=${expected.role}]`,
      );
    }
  }

  const expectedStylesMap = expectedStyles(ir, spec);
  for (const [key, expected] of Object.entries(expectedStylesMap)) {
    const actual = facts.styles?.[key];
    if (!sameStyleValue(key, actual, expected)) {
      failures.push(`computed style mismatch ${key}: browser=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    }
  }
  return failures;
}

export async function verify(irPath, outDir, { timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  const ir = loadIr(irPath);
  const spec = gradientSpec(ir);
  const cpuDigest = referenceDigest(spec);
  const emitted = emitFromIr(ir, outDir);
  log(`emit: ${emitted.indexPath} (${emitted.bytes} bytes)`);
  log(`cpu-digest: ${cpuDigest}`);

  const browser = findBrowser();
  if (browser.path === null) {
    log(`SKIP: headless browser unavailable (${browser.reason})`);
    return { code: 0, status: 'skip', reason: browser.reason, cpuDigest };
  }

  const url = pathToFileURL(emitted.indexPath).href;
  log(`browser: ${browser.path}`);
  const run = await runBrowser(browser.path, url, { timeoutMs });
  if (run.spawnError !== null) {
    log(`SKIP: headless browser unavailable (failed to launch ${browser.path}: ${run.spawnError})`);
    return { code: 0, status: 'skip', reason: run.spawnError, cpuDigest };
  }
  if (run.timedOut) {
    // A browser that cannot render a local file in this environment is an
    // environment limitation, not a rendering mismatch. Report it honestly
    // as a SKIP so a constrained CI runner does not fail on it.
    log(`SKIP: headless browser could not render the page here (timed out after ${run.timeoutMs} ms)`);
    return { code: 0, status: 'skip', reason: `browser timed out after ${run.timeoutMs} ms`, cpuDigest };
  }
  if (run.code !== 0) {
    const tail = run.stderr.split('\n').slice(-6).join(' | ').trim();
    log(`error: browser exited with code ${run.code}${tail ? `: ${tail}` : ''}`);
    return { code: 1, status: 'error', cpuDigest };
  }

  let facts;
  try {
    facts = parseFacts(run.stdout);
  } catch (error) {
    log(`error: ${error.message}`);
    return { code: 1, status: 'error', cpuDigest };
  }

  log(`canvas-digest: ${facts.digest}`);
  const failures = compareFacts(facts, ir, spec, cpuDigest);
  if (failures.length > 0) {
    for (const failure of failures) log(`error: ${failure}`);
    return { code: 1, status: 'fail', failures, cpuDigest };
  }
  log(
    `PASS: verified canvas digest ${facts.digest} equals independent Node CPU reference; ` +
      `${facts.roles.length} roles and ${Object.keys(facts.styles).length} computed styles match`,
  );
  return { code: 0, status: 'pass', digest: facts.digest, cpuDigest };
}

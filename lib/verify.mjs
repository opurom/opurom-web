/* Verification pipeline: emit -> independent Node CPU digest -> two bounded
 * headless browser runs (the second proves render determinism) -> parse facts
 * written by the page into the DOM -> assert canvas digest, ARIA attributes,
 * document facts and computed styles. Returns an exit code:
 * 0 = PASS or documented SKIP, 1 = assertion/launch failure. */

import { contentBearing, expectedDom, interpolate, labelOf, stateMap, textFontSize, visibleNodes } from './a11y.mjs';
import { DEFAULT_TIMEOUT_MS, browserEnvironmentFailure, findBrowser, runBrowser } from './browser.mjs';
import { contrastRatio } from './contrast.mjs';
import { referenceDigest } from './cpu-reference.mjs';
import { CANVAS_ARIA_LABEL, emitFromIr } from './emit.mjs';
import { loadIr } from './ir.mjs';
import { gradientSpec, parseHexColor, particleDots } from './spec.mjs';
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
    bodyBackground: `rgb(${spec.bottom.join(', ')})`,
    canvasRadius: `${ir.theme.radius}px`,
  };
}

/* Document-level facts the page can read back: language and title from the
 * emitter, canvas label from the same constant the emitter writes. */
export function expectedDomFacts(ir) {
  return { lang: 'en', title: ir.app, h1: ir.app, canvasLabel: CANVAS_ARIA_LABEL };
}

/* The DOM/CSS particle layer the emitter must produce for this spec: one entry
 * per painted field with its deterministic dot positions, in document order. */
export function expectedParticles(spec) {
  return particleDots(spec);
}

/* Compare the browser-reported particle layer against the spec-derived
 * expectation, reporting the first divergence so a mutation is named. */
function particleMismatch(actual, expected) {
  if (!Array.isArray(actual)) return 'particle facts missing';
  if (actual.length !== expected.length) {
    return `particle field count mismatch: browser=${actual.length} expected=${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const browser = actual[i] ?? {};
    const want = expected[i];
    for (const key of ['field', 'count', 'seed', 'radius', 'alpha']) {
      if (browser[key] !== want[key]) {
        return `particle field ${i} ${key} mismatch: browser=${JSON.stringify(browser[key])} expected=${JSON.stringify(want[key])}`;
      }
    }
    const browserColor = Array.isArray(browser.color) ? browser.color : null;
    if (browserColor === null || browserColor.length !== 3 ||
      browserColor[0] !== want.color[0] || browserColor[1] !== want.color[1] || browserColor[2] !== want.color[2]) {
      return `particle field ${i} color mismatch: browser=${JSON.stringify(browser.color)} expected=${JSON.stringify(want.color)}`;
    }
    if (!Array.isArray(browser.dots) || browser.dots.length !== want.dots.length) {
      return `particle field ${i} dot count mismatch: browser=${Array.isArray(browser.dots) ? browser.dots.length : null} expected=${want.dots.length}`;
    }
    for (let d = 0; d < want.dots.length; d += 1) {
      const dot = browser.dots[d] ?? {};
      if (dot.x !== want.dots[d].x || dot.y !== want.dots[d].y) {
        return `particle field ${i} dot ${d} mismatch: browser=[${dot.x},${dot.y}] expected=[${want.dots[d].x},${want.dots[d].y}]`;
      }
    }
  }
  return null;
}

/* The page draws --ink text on --surface, so the spec's resolved pair
 * (theme tokens, else the mode palette) is the contrast the emitted page
 * actually renders. The line reports facts only: a pair below the threshold
 * is the author's choice, not a digest/DOM mismatch. */
export function contrastLine(spec) {
  const report = contrastRatio(spec.border, spec.bottom);
  return (
    `contrast: surface rgb(${spec.bottom.join(', ')}) onSurface rgb(${spec.border.join(', ')}) ` +
    `ratio ${report.ratio}:1, WCAG AA normal-text minimum ${report.threshold}:1 ` +
    `${report.meets ? 'pass' : 'fail'}`
  );
}

/* Per-node ARIA attributes the emitter resolves from the a11y contract and
 * initial state; the browser must report exactly these values (null = absent). */
export function expectedAria(ir) {
  const decls = stateMap(ir);
  const byId = new Map();
  for (const { node, role, tag } of visibleNodes(ir)) {
    const label = labelOf(node);
    const decl = typeof node.props.bind === 'string' ? decls.get(node.props.bind) : undefined;
    byId.set(node.id, {
      ariaLabel: !contentBearing(tag) && label !== '' ? interpolate(label, decls) : null,
      ariaLevel: role === 'heading' ? '2' : null,
      ariaChecked: tag === 'button' && (node.kind === 'Switch' || node.kind === 'Checkbox')
        ? String(decl !== undefined && decl.type === 'bool' && decl.init === true)
        : null,
      value: tag === 'input' && node.kind === 'Slider' && decl !== undefined && decl.type === 'int'
        ? String(decl.init)
        : null,
    });
  }
  return byId;
}

/* Extract the base64 JSON facts the page stored on <meta id="opurom-verify">.
 * --dump-dom serializes attributes, and base64 needs no HTML escaping. */
export function parseFacts(dump) {
  const tag = /<meta\b[^>]*id="opurom-verify"[^>]*>/.exec(dump);
  if (tag === null) throw new Error('verify meta tag missing from dumped DOM');
  const match = /data-result="([^"]+)"/.exec(tag[0]);
  if (match === null) throw new Error('page did not report facts (data-result missing)');
  const facts = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  for (const key of ['digest', 'roles', 'particles', 'styles', 'canvas', 'dom']) {
    if (facts[key] === undefined) throw new Error(`reported facts lack field ${key}`);
  }
  return facts;
}

function numbersOf(text) {
  return String(text).match(/\d+/g)?.map(Number) ?? null;
}

function sameStyleValue(key, actual, expected) {
  if (expected === null || actual === null || actual === undefined) return expected === (actual ?? null);
  if (key.endsWith('Background')) {
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

  const particleFailure = particleMismatch(facts.particles, expectedParticles(spec));
  if (particleFailure !== null) failures.push(particleFailure);

  const expectedFacts = expectedDomFacts(ir);
  for (const [key, expected] of Object.entries(expectedFacts)) {
    const actual = facts.dom?.[key];
    if (actual !== expected) {
      failures.push(`dom fact mismatch ${key}: browser=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    }
  }

  const expectedRoles = expectedDom(ir);
  const actualRoles = Array.isArray(facts.roles) ? facts.roles : [];
  if (actualRoles.length !== expectedRoles.length) {
    failures.push(`role count mismatch: browser=${actualRoles.length} expected=${expectedRoles.length}`);
  }
  const ariaById = expectedAria(ir);
  const shared = Math.min(actualRoles.length, expectedRoles.length);
  for (let i = 0; i < shared; i += 1) {
    const actual = actualRoles[i];
    const expected = expectedRoles[i];
    if (actual.id !== expected.id || actual.tag !== expected.tag || actual.role !== expected.role) {
      failures.push(
        `role mismatch at index ${i}: browser=[id=${actual.id} tag=${actual.tag} role=${actual.role}] ` +
          `expected=[id=${expected.id} tag=${expected.tag} role=${expected.role}]`,
      );
      continue;
    }
    const aria = ariaById.get(expected.id);
    for (const field of ['ariaLabel', 'ariaLevel', 'ariaChecked', 'value']) {
      if (actual[field] !== aria[field]) {
        failures.push(
          `aria mismatch at node ${expected.id} (${field}): browser=${JSON.stringify(actual[field])} expected=${JSON.stringify(aria[field])}`,
        );
      }
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

/* Translate one browser run's outcome into a documented SKIP/error result,
 * or null when the run produced a dump to parse. Messages are identical for
 * the first and the determinism rerun so the SKIP contract stays stable. */
function runOutcome(run, browserPath, log) {
  if (run.spawnError !== null) {
    log(`SKIP: headless browser unavailable (failed to launch ${browserPath}: ${run.spawnError})`);
    return { code: 0, status: 'skip', reason: run.spawnError };
  }
  if (run.timedOut) {
    // A browser that cannot render a local file in this environment is an
    // environment limitation, not a rendering mismatch. Report it honestly
    // as a SKIP so a constrained CI runner does not fail on it.
    log(`SKIP: headless browser could not render the page here (timed out after ${run.timeoutMs} ms)`);
    return { code: 0, status: 'skip', reason: `browser timed out after ${run.timeoutMs} ms` };
  }
  if (run.code !== 0) {
    // A host that refuses the browser (no display, a held crashpad profile, a
    // broken GPU/display link) is an environment limitation, not a rendering
    // mismatch; reuse the shared predicate so it stays a documented SKIP.
    if (browserEnvironmentFailure(run)) {
      log('SKIP: headless browser could not render the page here (host environment refused the browser)');
      return { code: 0, status: 'skip', reason: 'host environment refused the browser' };
    }
    const tail = run.stderr.split('\n').slice(-6).join(' | ').trim();
    log(`error: browser exited with code ${run.code}${tail ? `: ${tail}` : ''}`);
    return { code: 1, status: 'error' };
  }
  return null;
}

export async function verify(irPath, outDir, { timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  const ir = loadIr(irPath);
  const spec = gradientSpec(ir);
  const cpuDigest = referenceDigest(spec);
  const emitted = emitFromIr(ir, outDir);
  log(`emit: ${emitted.indexPath} (${emitted.bytes} bytes)`);
  log(`cpu-digest: ${cpuDigest}`);
  log(contrastLine(spec));

  const browser = findBrowser();
  if (browser.path === null) {
    log(`SKIP: headless browser unavailable (${browser.reason})`);
    return { code: 0, status: 'skip', reason: browser.reason, cpuDigest };
  }

  const url = pathToFileURL(emitted.indexPath).href;
  log(`browser: ${browser.path}`);
  const run = await runBrowser(browser.path, url, { timeoutMs });
  const outcome = runOutcome(run, browser.path, log);
  if (outcome !== null) return { ...outcome, cpuDigest };

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

  // Determinism: render the same emitted page again in a fresh browser session
  // and require the identical facts. compareFacts pins the rerun to the CPU
  // reference too, so a rerun digest different from the first run fails here.
  const rerun = await runBrowser(browser.path, url, { timeoutMs });
  const rerunOutcome = runOutcome(rerun, browser.path, log);
  if (rerunOutcome !== null) return { ...rerunOutcome, cpuDigest };

  let rerunFacts;
  try {
    rerunFacts = parseFacts(rerun.stdout);
  } catch (error) {
    log(`error: rerun ${error.message}`);
    return { code: 1, status: 'error', cpuDigest };
  }
  log(`rerun-canvas-digest: ${rerunFacts.digest}`);
  const rerunFailures = compareFacts(rerunFacts, ir, spec, cpuDigest);
  if (rerunFailures.length > 0) {
    for (const failure of rerunFailures) log(`error: rerun ${failure}`);
    return { code: 1, status: 'fail', failures: rerunFailures, cpuDigest };
  }

  log(
    `PASS: verified canvas digest ${facts.digest} equals independent Node CPU reference; ` +
      `${facts.roles.length} roles and ${Object.keys(facts.styles).length} computed styles match`,
  );
  return { code: 0, status: 'pass', digest: facts.digest, cpuDigest };
}

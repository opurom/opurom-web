/* Real WebKit driver: compile a tiny native WKWebView runner, load the emitted
 * page with loadHTMLString, evaluate the canvas/DOM readback, and return the
 * same fact shape that Chromium's --dump-dom path produces. xcrun and the
 * helper are separate detached process groups with one overall <=30 s budget;
 * both are SIGKILLed at the deadline and the temporary profile is removed. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIMEOUT_MS } from './browser.mjs';
import { parseFacts } from './verify.mjs';

const XCRUN = '/usr/bin/xcrun';
const FRAMEWORK = '/System/Library/Frameworks/WebKit.framework';
const SWIFT_SOURCE = fileURLToPath(new URL('./WebKitRunner.swift', import.meta.url));
const READBACK_JS = fileURLToPath(new URL('./webkit-readback.js', import.meta.url));
const RESULT_PREFIX = 'OPUROM_RESULT=';
const MAX_CAPTURE = 1024 * 1024;

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/* Returns { path, reason }: exactly one of the two is set. */
export function findWebKit({
  platform = process.platform,
  xcrunPath = XCRUN,
  frameworkPath = FRAMEWORK,
  sourcePath = SWIFT_SOURCE,
  readbackPath = READBACK_JS,
} = {}) {
  if (platform !== 'darwin') {
    return { path: null, reason: `WKWebView requires macOS (host is ${platform})` };
  }
  if (!isExecutable(xcrunPath)) {
    return { path: null, reason: `xcrun is not an executable file at ${xcrunPath}` };
  }
  if (!fs.existsSync(frameworkPath)) {
    return { path: null, reason: `WebKit.framework is missing at ${frameworkPath}` };
  }
  if (!isFile(sourcePath)) {
    return { path: null, reason: `WKWebView Swift runner is missing at ${sourcePath}` };
  }
  if (!isFile(readbackPath)) {
    return { path: null, reason: `WKWebView readback script is missing at ${readbackPath}` };
  }
  return { path: xcrunPath, reason: null };
}

function killGroup(child) {
  if (!child || typeof child.pid !== 'number') return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* the process is already gone */
    }
  }
}

/* A detached process group makes WebKit's helper processes killable too. The
 * group is killed on timeout, spawn error and normal close; nothing survives
 * the returned promise. */
function runBoundedProcess(command, args, { timeoutMs, env }) {
  const bounded = Math.max(1, Math.min(Math.floor(timeoutMs), DEFAULT_TIMEOUT_MS));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let done = false;
    let timer = null;
    let child;

    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      killGroup(child);
      resolve({ code, stdout, stderr, timedOut, spawnError, timeoutMs: bounded });
    };

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      spawnError = error.message;
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, bounded);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      spawnError = error.message;
      killGroup(child);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function diagnostic(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(' | ') || 'no diagnostic';
}

function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(RESULT_PREFIX));
  if (lines.length === 0) throw new Error('WKWebView helper did not report a result line');
  const encoded = lines[lines.length - 1].slice(RESULT_PREFIX.length);
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('WKWebView helper reported malformed base64');
  const facts = parseFacts(`<meta id="opurom-verify" data-result="${encoded}">`);
  if (
    typeof facts.digest !== 'string' || !/^[0-9a-f]{16}$/.test(facts.digest) ||
    !Array.isArray(facts.roles) ||
    facts.styles === null || typeof facts.styles !== 'object' ||
    facts.canvas === null || typeof facts.canvas !== 'object'
  ) {
    throw new Error('WKWebView helper reported incomplete facts');
  }
  return facts;
}

function boundedTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(1, Math.min(Math.floor(numeric), DEFAULT_TIMEOUT_MS));
}

/* Returns { status: 'measured', facts } or a documented skip/error. The temp
 * profile holds the compiled helper and an isolated HOME/TMPDIR for WebKit. */
export async function runWebKit(indexPath, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  platform = process.platform,
  xcrunPath = XCRUN,
  frameworkPath = FRAMEWORK,
  sourcePath = SWIFT_SOURCE,
  readbackPath = READBACK_JS,
  tempBase = os.tmpdir(),
} = {}) {
  const available = findWebKit({ platform, xcrunPath, frameworkPath, sourcePath, readbackPath });
  if (available.path === null) return { status: 'skip', reason: available.reason };

  const budget = boundedTimeout(timeoutMs);
  const started = Date.now();
  const remaining = () => Math.max(1, budget - (Date.now() - started));
  // The SKIP reason reports the budget the caller asked for, not the shrinking
  // slice the current step got, so the message is stable across runs.
  const budgetLabel = budget;
  let profile = null;
  try {
    fs.mkdirSync(tempBase, { recursive: true });
    profile = fs.mkdtempSync(path.join(tempBase, 'opurom-web-webkit-'));
    const home = path.join(profile, 'profile');
    fs.mkdirSync(home);
    const helper = path.join(profile, 'WebKitRunner');

    const compileBudget = remaining();
    const compile = await runBoundedProcess(
      available.path,
      ['swiftc', '-swift-version', '5', sourcePath, '-o', helper],
      { timeoutMs: compileBudget, env: { ...env } },
    );
    if (compile.spawnError !== null) {
      return { status: 'skip', reason: `failed to launch ${available.path}: ${compile.spawnError}` };
    }
    if (compile.timedOut) {
      return { status: 'skip', reason: `WebKit helper compilation timed out after ${budgetLabel} ms` };
    }
    if (compile.code !== 0) {
      return { status: 'skip', reason: `WebKit helper compilation failed: ${diagnostic(compile.stderr)}` };
    }

    const runBudget = remaining();
    const run = await runBoundedProcess(
      helper,
      [path.resolve(indexPath), readbackPath, String(runBudget)],
      { timeoutMs: runBudget, env: { ...env, HOME: home, TMPDIR: home } },
    );
    if (run.spawnError !== null) {
      return { status: 'skip', reason: `failed to launch WKWebView helper: ${run.spawnError}` };
    }
    if (run.timedOut) {
      return { status: 'skip', reason: `WKWebView timed out after ${budgetLabel} ms` };
    }
    if (run.code !== 0) {
      return { status: 'error', reason: `WKWebView helper exited with code ${run.code}: ${diagnostic(run.stderr)}` };
    }
    let facts;
    try {
      facts = parseResult(run.stdout);
    } catch (error) {
      return { status: 'error', reason: `WebKit readback failed: ${error.message}` };
    }
    return { status: 'measured', facts, location: 'WKWebView' };
  } catch (error) {
    return { status: 'error', reason: `WebKit driver setup failed: ${error.message}` };
  } finally {
    if (profile !== null) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort; the process group is already gone */
      }
    }
  }
}

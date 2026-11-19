/* Headless Chromium-family browser detection and a bounded single run.
 * Detection order: Opurom_BROWSER override, well-known macOS app paths, then
 * a PATH scan. Every run uses a fresh profile under /tmp, is killed after a
 * hard timeout, and cleans the profile afterwards — the CLI can never hang. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAC_CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const PATH_NAMES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'chrome-headless-shell',
  'microsoft-edge',
  'microsoft-edge-stable',
];

const MAX_CAPTURE = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
/* How long to wait for the captured streams to flush after the browser
 * process exits before the run is settled anyway. */
const STREAM_FLUSH_MS = 500;

/* Kills the browser launcher and every helper process it started. The
 * launcher runs in its own process group, so the group kill reaches the
 * helpers that would otherwise keep the output pipes open. */
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* the process is already gone */
    }
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/* Returns { path, reason }: exactly one of the two is set. */
export function findBrowser(env = process.env) {
  const override = env.Opurom_BROWSER;
  if (override) {
    if (isExecutable(override)) return { path: override, reason: null };
    return { path: null, reason: `Opurom_BROWSER=${override} is not an executable file` };
  }
  for (const candidate of MAC_CANDIDATES) {
    if (isExecutable(candidate)) return { path: candidate, reason: null };
  }
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of PATH_NAMES) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return { path: candidate, reason: null };
    }
  }
  return {
    path: null,
    reason:
      'no Chromium-based executable found (checked Opurom_BROWSER, macOS app paths for Edge/Chrome/Chromium, and PATH names: ' +
      PATH_NAMES.join(', ') +
      ')',
  };
}

function makeProfileDir() {
  for (const base of ['/tmp', os.tmpdir()]) {
    try {
      return fs.mkdtempSync(path.join(base, 'opurom-web-verify-'));
    } catch {
      /* try the next base */
    }
  }
  throw new Error('cannot create a temporary browser profile directory');
}

/* One bounded headless run. Never throws: spawn failures are reported in the
 * resolved result so the verifier can decide between SKIP and failure. */
export function runBrowser(browserPath, url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const profile = makeProfileDir();
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      // Container hosts (GitHub runners) have a small /dev/shm and a shared
      // network stack; without these the browser hangs instead of exiting.
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-crash-reporter',
      '--disable-features=Translate,MediaRouter',
      '--no-proxy-server',
      `--user-data-dir=${profile}`,
      '--dump-dom',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let done = false;
    let timer = null;
    let flushTimer = null;

    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* profile cleanup is best effort */
      }
      resolve({ code, stdout, stderr, timedOut, spawnError, timeoutMs });
    };

    /* The browser re-execs itself into helper processes that inherit the
     * stdout and stderr pipes. Killing only the launcher leaves those helpers
     * holding the pipes open, so the 'close' event never fires and the caller
     * waits forever. Run the browser in its own process group and take the
     * whole group down on timeout. */
    const child = spawn(browserPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
    });
    child.on('error', (error) => {
      spawnError = error.message;
      killGroup(child);
      finish(null);
    });
    child.on('exit', (code) => {
      /* Settle on 'exit' rather than 'close': the helper processes can keep
       * the pipes open after the launcher is gone. Give the streams a short
       * grace period to flush the captured output first. */
      flushTimer = setTimeout(() => finish(code), STREAM_FLUSH_MS);
    });
    child.on('close', (code) => finish(code));
  });
}

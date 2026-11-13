/* Shared helpers for the test suite: CLI spawning, temp dirs, small IR builders. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = path.join(ROOT, 'bin', 'opurom-web.mjs');
export const COUNTER_FIXTURE = path.join(ROOT, 'fixtures', 'counter.opuir.json');

/* Runs the real CLI in a child process. A spawnSync timeout guarantees the
 * suite can never hang even if the CLI itself misbehaves. */
export function runCli(args, { env, timeout = 90_000, cwd = ROOT } = {}) {
  const merged = { ...process.env };
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: merged,
  });
  if (result.error) throw result.error;
  return result;
}

export function tmpDir(prefix = 'opurom-web-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function node(id, kind, props = {}, children = [], events = {}) {
  return { id, kind, props, children, events };
}

/* Minimal valid IR with sequential pre-order ids supplied by the caller. */
export function ir(tree, overrides = {}) {
  return {
    ir: '0.1',
    app: 'Fixture',
    state: [],
    tree,
    theme: { mode: 'light', accent: '#4F46E5', radius: 12 },
    ...overrides,
  };
}

/* Fixture exercising the whole ARIA readback: non-ASCII title/labels (the
 * facts blob must round-trip UTF-8), a heading, an image label, a bound
 * slider value and initial-state checkboxes — none of which the counter
 * fixture covers. */
export function richIr() {
  return ir(
    node(0, 'Column', {}, [
      node(1, 'Text', { value: 'Naïve count: {count}', size: 32 }),
      node(2, 'Image', { name: 'Zoë icon' }),
      node(3, 'Slider', { bind: 'level', min: 0, max: 10 }),
      node(4, 'Switch', { bind: 'on' }),
      node(5, 'Checkbox', { bind: 'off' }),
      node(6, 'Button', { label: 'Go' }),
    ]),
    {
      app: 'Résumé App',
      state: [
        { name: 'count', type: 'int', init: 7 },
        { name: 'level', type: 'int', init: 4 },
        { name: 'on', type: 'bool', init: true },
        { name: 'off', type: 'bool', init: false },
      ],
    },
  );
}

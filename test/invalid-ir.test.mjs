/* Invalid IR must fail fast with a readable diagnostic and exit code 1,
 * and out-dir/path validation must prevent traversal or stray writes. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cleanup, COUNTER_FIXTURE, ir, node, runCli, tmpDir, writeJson } from '../test-helpers/helpers.mjs';

function emitExpectingFailure(name, badIr, expected) {
  test(`emit rejects ${name}`, () => {
    const dir = tmpDir();
    try {
      const irFile = path.join(dir, 'bad.opuir.json');
      writeJson(irFile, badIr);
      const out = path.join(dir, 'out');
      const run = runCli(['emit', irFile, out]);
      assert.equal(run.status, 1, `expected failure, got: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /^error: /m);
      assert.match(run.stderr, expected);
      assert.ok(!fs.existsSync(path.join(out, 'index.html')), 'failed emit must not produce output');
    } finally {
      cleanup(dir);
    }
  });
}

emitExpectingFailure('a non-object root', [], /root must be a JSON object/);
emitExpectingFailure('an unsupported IR version', { ...ir(node(0, 'Column')), ir: '9.9' }, /unsupported ir version "9\.9"/);
emitExpectingFailure('a missing tree', { ...ir(node(0, 'Column')), tree: undefined }, /tree must be an object/);
emitExpectingFailure('non pre-order node ids', ir(node(7, 'Column')), /breaks pre-order sequence \(expected 0\)/);
emitExpectingFailure('a duplicate pre-order id', ir(node(0, 'Column', {}, [node(0, 'Text', { value: 'x' })])), /breaks pre-order sequence/);
emitExpectingFailure('an unknown state type', { ...ir(node(0, 'Column')), state: [{ name: 'x', type: 'float', init: 1 }] }, /unknown type "float"/);
emitExpectingFailure('an init that does not match its type', { ...ir(node(0, 'Column')), state: [{ name: 'x', type: 'int', init: 1.5 }] }, /does not match type int/);
emitExpectingFailure('a bad accent color', { ...ir(node(0, 'Column')), theme: { mode: 'light', accent: 'red', radius: 1 } }, /must be #RRGGBB/);
emitExpectingFailure('an unknown a11y role', ir(node(0, 'Column', { role: 'banner' })), /unknown a11y role "banner"/);
emitExpectingFailure('an out-of-range fontScale', ir(node(0, 'Text', { value: 'x', fontScale: 9 })), /fontScale .* 0\.5\.\.3\.0/);
emitExpectingFailure('an event targeting undeclared state', ir(node(0, 'Button', { label: 'x' }, [], { tap: { op: 'add', target: 'ghost', value: 1 } })), /unknown state target "ghost"/);
emitExpectingFailure('a toggle on non-bool state', {
  ...ir(node(0, 'Button', { label: 'x' }, [], { tap: { op: 'toggle', target: 'n' } })),
  state: [{ name: 'n', type: 'int', init: 0 }],
}, /toggle target "n" must be bool/);
emitExpectingFailure('an when guard on non-bool state', {
  ...ir(node(0, 'Column')),
  tree: { ...node(0, 'Column'), when: 'n' },
  state: [{ name: 'n', type: 'int', init: 0 }],
}, /when state "n" must be bool/);
emitExpectingFailure('a set action with a type mismatch', {
  ...ir(node(0, 'Button', { label: 'x' }, [], { tap: { op: 'set', target: 's', value: 3 } })),
  state: [{ name: 's', type: 'string', init: 'v' }],
}, /value 3 does not match target type string/);

test('emit rejects malformed JSON', () => {
  const dir = tmpDir();
  try {
    const irFile = path.join(dir, 'bad.opuir.json');
    fs.writeFileSync(irFile, 'not json at all', 'utf8');
    const run = runCli(['emit', irFile, path.join(dir, 'out')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^error: /m);
    assert.match(run.stderr, /invalid JSON/);
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'index.html')));
  } finally {
    cleanup(dir);
  }
});

test('verify also rejects invalid IR before launching a browser', () => {
  const dir = tmpDir();
  try {
    const irFile = path.join(dir, 'bad.opuir.json');
    writeJson(irFile, { ...ir(node(0, 'Column')), ir: '0.2' });
    const run = runCli(['verify', irFile, path.join(dir, 'out')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^error: /m);
    assert.ok(!run.stdout.includes('SKIP'), 'invalid IR is an error, not a skip');
  } finally {
    cleanup(dir);
  }
});

test('missing IR file is a readable error', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['emit', path.join(dir, 'absent.opuir.json'), path.join(dir, 'out')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /cannot read IR file/);
  } finally {
    cleanup(dir);
  }
});

test('out-dir must not be an existing file', () => {
  const dir = tmpDir();
  try {
    const notADir = path.join(dir, 'file.txt');
    fs.writeFileSync(notADir, 'x');
    const run = runCli(['emit', COUNTER_FIXTURE, notADir]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /out-dir exists and is not a directory/);
    assert.equal(fs.readFileSync(notADir, 'utf8'), 'x', 'existing file must be untouched');
  } finally {
    cleanup(dir);
  }
});

test('out-dir is created recursively when absent', () => {
  const dir = tmpDir();
  try {
    const nested = path.join(dir, 'a', 'b', 'c');
    const run = runCli(['emit', COUNTER_FIXTURE, nested]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(nested, 'index.html')));
  } finally {
    cleanup(dir);
  }
});

test('hostile IR text cannot traverse out of out-dir', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'out');
    const hostile = ir(
      node(0, 'Column', {}, [
        node(1, 'Text', { value: '../../escaped' }),
        node(2, 'Button', { label: '../../../escaped-button' }),
      ]),
      { app: '../../escaped-app' },
    );
    const irFile = path.join(dir, 'hostile.opuir.json');
    writeJson(irFile, hostile);
    const run = runCli(['emit', irFile, out]);
    assert.equal(run.status, 0, run.stderr);
    // Exactly one artifact inside out-dir, nothing created next to or above it.
    assert.deepEqual(fs.readdirSync(out), ['index.html']);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['hostile.opuir.json', 'out'],
      'emit must not write anything outside out-dir',
    );
    assert.ok(!fs.existsSync(path.join(dir, 'escaped')), 'traversal target must not exist');
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.includes('../../escaped'), 'hostile text stays literal escaped text');
    assert.ok(html.includes('<title>../../escaped-app</title>'));
  } finally {
    cleanup(dir);
  }
});

test('CLI usage errors exit 2 with usage text', () => {
  const missing = runCli([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: opurom-web emit <ir\.json> <out-dir>/);
  const unknown = runCli(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: opurom-web/);
  const extra = runCli(['emit', COUNTER_FIXTURE, '/tmp/unused-out', 'extra']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /unexpected argument: extra/);
});

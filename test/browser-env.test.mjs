'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEnvironmentFailure } from '../lib/browser.mjs';

/* A host that refuses the browser is a documented SKIP, never a product FAIL. */
test('browserEnvironmentFailure recognizes host refusals', () => {
  const refusals = [
    'dbus[1]: Failed to connect to the bus',
    'Gtk: cannot open display',
    'error while loading shared libraries: libnss3.so',
    '[ERROR:crashpad] open .../Crashpad/throttle_store.dat: Operation not permitted (1)',
    'CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670',
    'SharedImageManager::ProduceMemory: non-existent mailbox',
  ];
  for (const stderr of refusals) {
    assert.equal(browserEnvironmentFailure({ stderr, code: 1, timedOut: false }), true, stderr);
  }
  assert.equal(browserEnvironmentFailure({ spawnError: 'ENOENT', stderr: '' }), true);
});

test('browserEnvironmentFailure does not mask a real failure', () => {
  assert.equal(
    browserEnvironmentFailure({ stderr: 'digest mismatch: expected a, got b', code: 1, timedOut: false }),
    false,
  );
  assert.equal(
    browserEnvironmentFailure({ stderr: '', code: 0, timedOut: false }),
    false,
  );
});

//! An emitted page is self-contained: static image references are copied into
//! the output directory, while path traversal is refused and effect-free IR
//! stays a single index.html.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { tmpDir, cleanup } from '../test-helpers/helpers.mjs';

function irNode(extra = {}) {
  return {
    ir: '0.1', app: 'Assets', state: [], theme: { mode: 'light', accent: '#097FEB', radius: 8 },
    tree: {
      id: 0, kind: 'Column', props: {},
      children: [
        { id: 1, kind: 'Image', props: { value: 'pic', ...extra }, children: [], events: {} },
      ],
      events: {},
    },
  };
}

/** A project with an assets/ directory at its root and an IR in a nested app. */
function project() {
  const root = tmpDir();
  const app = path.join(root, 'apps', 'demo');
  const assets = path.join(root, 'assets');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'pic.png'), Buffer.from('fake-png'));
  const irPath = path.join(app, 'app.opuir.json');
  fs.writeFileSync(irPath, JSON.stringify(irNode({ src: 'assets/pic.png' })));
  return { root, app, irPath };
}

test('referenced assets are copied into the output directory', () => {
  const p = project();
  const out = path.join(p.root, 'out');
  try {
    const result = emitFromIr(irNode({ src: 'assets/pic.png' }), out, { assetBase: p.app });
    assert.ok(result.assets.includes('assets/pic.png'));
    assert.equal(fs.readFileSync(path.join(out, 'assets', 'pic.png')).toString(), 'fake-png');
  } finally {
    cleanup(p.root);
  }
});

test('an asset in a project-level assets dir resolves from a nested IR', () => {
  const p = project();
  const out = tmpDir();
  try {
    // The IR sits two levels below the root; the asset is found by walking up.
    const nested = path.join(p.app, 'views');
    fs.mkdirSync(nested, { recursive: true });
    const result = emitFromIr(irNode({ src: 'assets/pic.png' }), out, { assetBase: nested });
    assert.ok(result.assets.includes('assets/pic.png'));
  } finally {
    cleanup(p.root);
    cleanup(out);
  }
});

test('path traversal and absolute sources are refused', () => {
  const p = project();
  const out = path.join(p.root, 'out');
  try {
    const evil = irNode({ src: '../../../../etc/passwd' });
    const result = emitFromIr(evil, out, { assetBase: p.app });
    assert.deepEqual(result.assets, []);
    assert.deepEqual(fs.readdirSync(out), ['index.html']);
    const abs = emitFromIr(irNode({ src: '/etc/passwd' }), out, { assetBase: p.app });
    assert.deepEqual(abs.assets, []);
  } finally {
    cleanup(p.root);
  }
});

test('state list assets are collected and effect-free IR stays a single file', () => {
  const p = project();
  const out = tmpDir();
  try {
    const withState = irNode({ src: '{cover}' });
    withState.state = [{ name: 'cover', type: 'string', init: 'assets/pic.png' }];
    const result = emitFromIr(withState, out, { assetBase: p.app });
    assert.ok(result.assets.includes('assets/pic.png'));

    const plain = irNode(); // no src, no state
    const plainOut = tmpDir();
    try {
      emitFromIr(plain, plainOut, { assetBase: p.app });
      assert.deepEqual(fs.readdirSync(plainOut), ['index.html']);
    } finally {
      cleanup(plainOut);
    }
  } finally {
    cleanup(p.root);
    cleanup(out);
  }
});

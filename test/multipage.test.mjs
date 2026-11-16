/* Multi-page IR: the emitter lowers every route to its own section, marks the
 * initial route visible and the rest hidden, and ships a client router that
 * handles push/pop navigation plus state-driven text and guards. Single-page
 * output is unchanged (asserted byte-for-byte elsewhere). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { expectedDom } from '../lib/a11y.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { validateIr } from '../lib/ir.mjs';
import { multiPageRouter } from '../lib/page-source.mjs';
import { cleanup, multipageIr, node, tmpDir } from '../test-helpers/helpers.mjs';

function twoRouteIr() {
  const home = node(0, 'Column', { gap: 8 }, [
    node(1, 'Text', { value: 'Home' }),
    node(2, 'Button', { label: 'Open' }, [], { tap: { op: 'push', target: 'Detail' } }),
  ]);
  const detail = node(3, 'Column', { gap: 8 }, [
    node(4, 'Text', { value: 'Detail' }),
    node(5, 'Button', { label: 'Back' }, [], { tap: { op: 'pop' } }),
  ]);
  return multipageIr(
    { Home: { title: 'Home', tree: home }, Detail: { title: 'Detail', tree: detail } },
    'Home',
  );
}

function emit(irValue) {
  const dir = tmpDir();
  const result = emitFromIr(irValue, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8'), bytes: result.bytes };
}

test('multi-page IR validates and emits one section per route', () => {
  const { dir, html } = emit(twoRouteIr());
  try {
    assert.match(html, /<section class="route" data-route="Home"/);
    assert.match(html, /<section class="route" data-route="Detail"/);
    // The initial route is visible; the others carry `hidden`.
    assert.ok(!/data-route="Home" aria-label="Home" hidden/.test(html), 'initial route must be visible');
    assert.match(html, /data-route="Detail" aria-label="Detail" hidden/);
    // Node ids from both routes are present in the DOM.
    assert.match(html, /data-node-id="1"/);
    assert.match(html, /data-node-id="4"/);
  } finally {
    cleanup(dir);
  }
});

test('multi-page emit ships a router that handles push and pop', () => {
  const { dir, html } = emit(twoRouteIr());
  try {
    assert.match(html, /function routeTo\(\)/);
    assert.match(html, /action\.op === 'push'/);
    assert.match(html, /action\.op === 'pop'/);
    assert.match(html, /stack\.push\(action\.target\)/);
    // Actions are carried on the nodes as JSON, HTML-escaped inside the attr
    // (the browser decodes entities, so getAttribute yields valid JSON).
    assert.match(html, /data-actions='\[\{&quot;op&quot;:&quot;push&quot;,&quot;target&quot;:&quot;Detail&quot;\}\]'/);
    assert.match(html, /data-actions='\[\{&quot;op&quot;:&quot;pop&quot;\}\]'/);
  } finally {
    cleanup(dir);
  }
});

test('expectedDom covers every route node in key order', () => {
  const dom = expectedDom(twoRouteIr());
  assert.deepEqual(dom.map((entry) => entry.id), [0, 1, 2, 3, 4, 5]);
  assert.equal(dom.find((e) => e.id === 2).tag, 'button');
  assert.equal(dom.find((e) => e.id === 1).tag, 'p');
});

test('multi-page rejects an initialRoute naming no declared route', () => {
  const ir = twoRouteIr();
  ir.initialRoute = 'Missing';
  assert.throws(() => validateIr(ir), /names no declared route/);
});

test('multi-page rejects duplicate node ids across routes', () => {
  const ir = twoRouteIr();
  ir.routes.Detail.tree.id = 0; // collide with Home's root id
  assert.throws(() => validateIr(ir), /pre-order sequence|duplicate node id/);
});

test('multi-page rejects non-contiguous node id space', () => {
  const ir = twoRouteIr();
  ir.routes.Detail.tree.id = 10; // gap from 6..9
  ir.routes.Detail.tree.children[0].id = 11;
  ir.routes.Detail.tree.children[1].id = 12;
  assert.throws(() => validateIr(ir), /not contiguous/);
});

function restoreIr() {
  const secret = node(2, 'Text', { value: 'Secret' });
  secret.when = 'show';
  const home = node(0, 'Column', { gap: 8 }, [
    node(1, 'Text', { value: 'Hi {name}' }),
    secret,
    node(3, 'Button', { label: 'Open' }, [], { tap: { op: 'push', target: 'Detail' } }),
  ]);
  const detail = node(4, 'Column', { gap: 8 }, [
    node(5, 'Button', { label: 'Back' }, [], { tap: { op: 'pop' } }),
  ]);
  return multipageIr(
    { Home: { title: 'Home', tree: home }, Detail: { title: 'Detail', tree: detail } },
    'Home',
    {
      state: [
        { name: 'show', type: 'bool', init: false },
        { name: 'name', type: 'string', init: 'World' },
      ],
    },
  );
}

test('multi-page emit keeps raw state templates and the restore hook', () => {
  const { dir, html } = emit(restoreIr());
  try {
    // Baked text still holds the compile-time value; the raw template rides
    // along so the router can re-render after a state restore.
    assert.match(html, />Hi World</);
    assert.match(html, /data-label="Hi \{name\}"/);
    assert.match(html, /__Opurom_STATE_RESTORE__/);
    // The dev client rewrites the state declaration in place; keep the line.
    assert.match(html, /var state = \{"show":false,"name":"World"\};/);
  } finally {
    cleanup(dir);
  }
});

function bootRouter(restore) {
  const element = (attrs, extra = {}) => ({
    attrs,
    hidden: false,
    textContent: '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    ...extra,
  });
  const sections = [element({ 'data-route': 'Home' }), element({ 'data-route': 'Detail' })];
  sections[1].hidden = true; // emitter ships non-initial routes hidden
  const greeting = element(
    { 'data-node-id': '1', 'data-label': 'Hi {name}' },
    { textContent: 'Hi World' }, // compile-time bake
  );
  const secret = element({ 'data-node-id': '2', 'data-when': 'show' }, { hidden: true });
  const document = {
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector.indexOf('section[data-route]') !== -1) return sections;
      if (selector === '[data-when]') return [secret];
      if (selector === '[data-node-id]') return [greeting, secret];
      return [];
    },
  };
  const window = restore === undefined ? {} : { __Opurom_STATE_RESTORE__: restore };
  new Function('window', 'document', multiPageRouter(restoreIr()))(window, document);
  return { sections, greeting, secret };
}

test('router applies __Opurom_STATE_RESTORE__ at boot', () => {
  const { sections, greeting, secret } = bootRouter({ show: true, name: 'Dev' });
  assert.equal(secret.hidden, false, 'restored guard must reveal the node');
  assert.equal(greeting.textContent, 'Hi Dev', 'restored state must re-render text');
  assert.equal(sections[0].hidden, false, 'initial route stays visible');
  assert.equal(sections[1].hidden, true, 'other routes stay hidden');
});

test('router boot stays at initial render without a restore snapshot', () => {
  const { greeting, secret } = bootRouter();
  assert.equal(secret.hidden, true, 'guard keeps its compile-time hidden state');
  assert.equal(greeting.textContent, 'Hi World', 'text keeps the baked initial value');
});

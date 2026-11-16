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

function stubElement(attrs, extra = {}) {
  const element = {
    attrs,
    hidden: false,
    textContent: '',
    parentNode: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    closest(selector) {
      const key = selector.slice(1, -1); // [attribute]
      let node = element;
      while (node !== null) {
        if (Object.prototype.hasOwnProperty.call(node.attrs, key)) return node;
        node = node.parentNode;
      }
      return null;
    },
    ...extra,
  };
  return element;
}

function bootRouter(restore) {
  const sections = [stubElement({ 'data-route': 'Home' }), stubElement({ 'data-route': 'Detail' })];
  sections[1].hidden = true; // emitter ships non-initial routes hidden
  const greeting = stubElement(
    { 'data-node-id': '1', 'data-label': 'Hi {name}' },
    { textContent: 'Hi World' }, // compile-time bake
  );
  const secret = stubElement({ 'data-node-id': '2', 'data-when': 'show' }, { hidden: true });
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

function forIr() {
  const loop = node(1, 'For', { source: 'items', item: 'p' }, [node(2, 'Text', { value: 'Row {p}' })]);
  const home = node(0, 'Column', { gap: 8 }, [
    loop,
    node(3, 'Column', { gap: 4 }, [
      node(4, 'Button', { label: 'Add' }, [], { tap: { op: 'append', target: 'items', value: 'x' } }),
      node(5, 'Button', { label: 'Trim' }, [], { tap: { op: 'removeAt', target: 'items', value: 0 } }),
      node(6, 'Button', { label: 'Replace' }, [], { tap: { op: 'assign', target: 'items', value: ['x', 'y'] } }),
      node(7, 'Button', { label: 'Merge' }, [], { tap: { op: 'assign', target: 'items', valueFrom: 'backup' } }),
      node(8, 'Button', { label: 'Load list' }, [], { tap: { async: true, effects: [{ kind: 'fetch', path: '/api/items', into: 'items' }] } }),
      node(9, 'Button', { label: 'Load title' }, [], { tap: { async: true, effects: [{ kind: 'fetch', path: '/api/title', into: 'title' }] } }),
      node(10, 'Text', { value: '{title}' }),
    ]),
  ]);
  return multipageIr({ Home: { title: 'Home', tree: home } }, 'Home', {
    state: [
      { name: 'items', type: 'list', init: ['a', 'b'] },
      { name: 'backup', type: 'list', init: ['s'] },
      { name: 'title', type: 'string', init: 'T' },
    ],
  });
}

test('multi-page emit lowers For to a data-for template', () => {
  const { dir, html } = emit(forIr());
  try {
    assert.match(html, /<template data-node-id="1" role="none" class="node for" data-for="items" data-item="p" data-for-region="1">/);
    assert.match(html, /data-label="Row \{p\}"/);
    assert.match(html, /&quot;op&quot;:&quot;append&quot;/);
    assert.match(html, /&quot;op&quot;:&quot;removeAt&quot;/);
    // Both assign spellings validate and reach the page as actions.
    assert.match(html, /&quot;op&quot;:&quot;assign&quot;/);
    assert.match(html, /&quot;valueFrom&quot;:&quot;backup&quot;/);
    // Async effects ship as a separate attribute for the effects pipeline.
    assert.match(html, /data-effects='\[\{&quot;kind&quot;:&quot;fetch&quot;,&quot;path&quot;:&quot;\/api\/items&quot;,&quot;into&quot;:&quot;items&quot;\}\]'/);
    // The dev client rewrites this declaration in place; keep it intact.
    assert.match(html, /var state = \{"items":\["a","b"\],"backup":\["s"\],"title":"T"\};/);
  } finally {
    cleanup(dir);
  }
});

function forEnv(restore, fetchStub) {
  const listeners = {};
  const column = {
    children: [],
    insertBefore(element, anchor) {
      const at = anchor === null ? column.children.length : column.children.indexOf(anchor);
      column.children.splice(at, 0, element);
      element.parentNode = column;
    },
    removeChild(element) {
      const at = column.children.indexOf(element);
      if (at !== -1) column.children.splice(at, 1);
      element.parentNode = null;
    },
  };
  const freshRow = () => {
    const text = stubElement({ 'data-node-id': '2', 'data-label': 'Row {p}' }, { textContent: 'Row {p}' });
    const root = stubElement({});
    text.parentNode = root;
    root.childNodes = [text];
    return root;
  };
  const template = stubElement(
    { 'data-for': 'items', 'data-item': 'p', 'data-for-region': '1' },
    { content: { cloneNode: () => ({ childNodes: [freshRow()] }) } },
  );
  Object.defineProperty(template, 'nextSibling', {
    get: () => {
      const at = column.children.indexOf(template);
      return at === -1 ? null : column.children[at + 1] ?? null;
    },
  });
  column.children.push(template);
  template.parentNode = column;
  const rows = () => column.children.filter((child) => child.attrs['data-for-row'] === '1');
  const rowTexts = () => rows().flatMap((row) => row.childNodes);
  const titleText = stubElement({ 'data-node-id': '10', 'data-label': '{title}' }, { textContent: 'T' });
  const document = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    querySelectorAll(selector) {
      if (selector === 'template[data-for]') return [template];
      if (selector === '[data-for-row="1"]') return rows();
      if (selector === '[data-node-id]') return [titleText, ...rowTexts()];
      if (selector.indexOf('section[data-route]') !== -1) return [];
      return [];
    },
  };
  const window = restore === undefined ? {} : { __Opurom_STATE_RESTORE__: restore };
  new Function('window', 'document', 'fetch', multiPageRouter(forIr()))(window, document, fetchStub);
  const click = (payload) => {
    const shape = Array.isArray(payload) ? { actions: payload } : payload;
    listeners.click({
      target: {
        closest: (selector) => (
          selector.indexOf('data-actions') !== -1 || selector.indexOf('data-effects') !== -1
            ? {
                getAttribute: (name) => (name === 'data-actions'
                  ? JSON.stringify(shape.actions ?? [])
                  : JSON.stringify(shape.effects ?? [])),
              }
            : null
        ),
      },
    });
  };
  return { rows, rowTexts, title: () => titleText, click };
}

test('router renders rows from the list length and follows list ops', () => {
  const env = forEnv();
  assert.equal(env.rows().length, 2, 'boot materializes one row per init element');
  assert.deepEqual(env.rowTexts().map((entry) => entry.textContent), ['Row a', 'Row b']);
  env.click([{ op: 'append', target: 'items', value: 'c' }]);
  assert.equal(env.rows().length, 3, 'append adds a row');
  assert.equal(env.rowTexts()[2].textContent, 'Row c');
  env.click([{ op: 'removeAt', target: 'items', value: 0 }]);
  assert.deepEqual(
    env.rowTexts().map((entry) => entry.textContent),
    ['Row b', 'Row c'],
    'removeAt drops the row',
  );
  env.click([{ op: 'assign', target: 'items', value: ['x', 'y', 'z'] }]);
  assert.equal(env.rows().length, 3, 'assign replaces the rows');
  env.click([{ op: 'removeAt', target: 'items', value: 9 }]);
  assert.equal(env.rows().length, 3, 'out-of-range removeAt is a no-op');
});

test('router materializes restored list rows at boot', () => {
  const env = forEnv({ items: ['s'] });
  assert.equal(env.rows().length, 1, 'restore snapshot decides the row count');
  assert.equal(env.rowTexts()[0].textContent, 'Row s');
});

const drain = () =>
  new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((resolve) => setImmediate(resolve)));

test('router runs async fetch effects and re-renders from the response', async () => {
  let ok = true;
  const env = forEnv(undefined, async (path) => ({
    ok: ok && path !== '/api/never',
    json: async () => ['q', 'r', 's'],
    text: async () => 'hello',
  }));
  assert.equal(env.title().textContent, 'T', 'title keeps its compile-time bake');
  env.click({ effects: [{ kind: 'fetch', path: '/api/items', into: 'items' }] });
  await drain();
  assert.equal(env.rows().length, 3, 'a list response replaces the rows whole');
  assert.deepEqual(env.rowTexts().map((entry) => entry.textContent), ['Row q', 'Row r', 'Row s']);
  env.click({ effects: [{ kind: 'fetch', path: '/api/title', into: 'title' }] });
  await drain();
  assert.equal(env.title().textContent, 'hello', 'a text response lands in the string state');
  ok = false;
  env.click({ effects: [{ kind: 'fetch', path: '/api/items', into: 'items' }] });
  await drain();
  assert.equal(env.rows().length, 3, 'a failed fetch keeps the previous state');
});

/* State preservation across a hot reload of the responsive DOM page.
 *
 * The emitted page owns a live state runtime: it restores a sessionStorage
 * snapshot over the IR's initial state, re-renders the bound nodes from the
 * live state, persists edits, and re-applies the snapshot after a reload. The
 * runtime is exercised here against a small DOM/storage shim, and the plan is
 * read back out of the real emitted page so the emitter and runtime stay in
 * agreement. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { STATE_RUNTIME_SRC } from '../lib/page-source.mjs';
import { cleanup, COUNTER_FIXTURE, ir, node, richIr, tmpDir } from '../test-helpers/helpers.mjs';

const opuStateRuntime = new Function(`${STATE_RUNTIME_SRC}; return opuStateRuntime;`)();

/* The state plan is embedded as JSON in the page's inline script; reading it
 * back keeps the runtime test honest about what the emitter actually emits. */
function planFromHtml(html) {
  const match = /var STATE_RUNTIME = opuStateRuntime\(([\s\S]*?), INITIAL,/.exec(html);
  assert.ok(match, 'the emitted page must embed the state plan');
  return JSON.parse(match[1]);
}

function fakeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
  };
}

function fakeDoc(ids) {
  const elements = new Map(ids.map((id) => [String(id), fakeElement(id)]));
  return {
    querySelector(selector) {
      const match = /^\[data-node-id="(\d+)"\]$/.exec(selector);
      return match ? (elements.get(match[1]) ?? null) : null;
    },
  };
}

function fakeStorage() {
  const store = new Map();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
}

function emitted(data) {
  const dir = tmpDir();
  const { html } = emitFromIr(data, dir);
  return { dir, html, plan: planFromHtml(html) };
}

test('emitted page embeds the state runtime, plan and restore hook without a raw placeholder', () => {
  const { dir, html, plan } = emitted(JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8')));
  try {
    assert.match(html, /opuStateRuntime/);
    assert.match(html, /__OPUROM_STATE_RESTORE__/);
    assert.match(html, /window\.opurom\.state/);
    assert.match(html, /opurom\.state/);
    assert.ok(!html.includes('{count}'), 'raw placeholder must not reach the page');
    assert.ok(plan.length > 0, 'the counter fixture must produce a state plan');
  } finally {
    cleanup(dir);
  }
});

test('restore snapshot overrides the IR initial state and re-renders before first use', () => {
  const { dir, plan } = emitted(richIr());
  try {
    const initial = { count: 7, level: 4, on: true, off: false };
    const restore = { count: 42, level: 9, on: false, off: true, ghost: 1 };
    const doc = fakeDoc(plan.map((item) => item.id));
    const runtime = opuStateRuntime(plan, initial, restore, doc, fakeStorage());
    assert.deepEqual(runtime.state, { count: 42, level: 9, on: false, off: true }, 'stale names are dropped');
    runtime.apply();
    assert.equal(doc.querySelector('[data-node-id="1"]').textContent, 'Naïve count: 42');
    assert.equal(doc.querySelector('[data-node-id="3"]').value, '9');
    assert.equal(doc.querySelector('[data-node-id="4"]').attributes['aria-checked'], 'false');
    assert.equal(doc.querySelector('[data-node-id="5"]').attributes['aria-checked'], 'true');
  } finally {
    cleanup(dir);
  }
});

test('editing an input persists state and survives a simulated reload with input kept', () => {
  const { dir, plan } = emitted(richIr());
  try {
    const initial = { count: 7, level: 4, on: true, off: false };
    const storage = fakeStorage();
    const doc = fakeDoc(plan.map((item) => item.id));
    const runtime = opuStateRuntime(plan, initial, null, doc, storage);
    runtime.apply();
    const slider = doc.querySelector('[data-node-id="3"]');
    slider.value = '6';
    slider.listeners.input.forEach((handler) => handler());
    assert.equal(runtime.state.level, 6);
    const persisted = JSON.parse(storage.getItem('opurom.state'));
    assert.equal(persisted.level, 6);

    // A save reloads the page: a fresh runtime restores the persisted snapshot.
    const doc2 = fakeDoc(plan.map((item) => item.id));
    const reloaded = opuStateRuntime(plan, initial, persisted, doc2, storage);
    reloaded.apply();
    assert.equal(reloaded.state.level, 6, 'the edited value is kept, not reset to init');
    assert.equal(doc2.querySelector('[data-node-id="3"]').value, '6');
    assert.equal(doc2.querySelector('[data-node-id="1"]').textContent, 'Naïve count: 7');
  } finally {
    cleanup(dir);
  }
});

test('a bound non-content node re-renders its accessible label from live state', () => {
  const data = ir(
    node(0, 'Column', {}, [
      node(1, 'Image', { name: 'level {level}' }),
      node(2, 'Slider', { bind: 'level', min: 0, max: 10 }),
    ]),
    { state: [{ name: 'level', type: 'int', init: 2 }] },
  );
  const { dir, plan } = emitted(data);
  try {
    const doc = fakeDoc(plan.map((item) => item.id));
    const runtime = opuStateRuntime(plan, { level: 2 }, { level: 8 }, doc, fakeStorage());
    runtime.apply();
    assert.equal(doc.querySelector('[data-node-id="1"]').attributes['aria-label'], 'level 8');
  } finally {
    cleanup(dir);
  }
});

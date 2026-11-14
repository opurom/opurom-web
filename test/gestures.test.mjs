/* Native gesture bindings and page transitions.
 *
 * The gesture recognizers are exercised against a small DOM/timer stub that
 * records listeners and drives pointer events, so the exact runtime source the
 * browser runs is verified: handlers are attached, tap/double-tap/long-press and
 * thresholded drag dispatch their IR actions, and `nav` plays the transition.
 * The transition CSS classes/keyframes and the byte-identical emission contract
 * are asserted on the real emitted page, and the theme-token derivation is
 * re-checked so the gesture additions cannot drift it. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { emitFromIr } from '../lib/emit.mjs';
import { GESTURE_SRC, TRANSITION_SRC } from '../lib/page-source.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

/* Compile the gesture and transition runtime sources exactly as the page does. */
const gestures = new Function(`${GESTURE_SRC}; return { opuGestureEnv, opuInstallGestures, opuBindGestures };`)();
const playTransition = new Function(`${TRANSITION_SRC}; return opuPlayTransition;`)();

/* A deterministic fake clock plus a timer queue, so the recognizers' setTimeout
 * delays are driven explicitly rather than by the host clock. */
function fakeClock() {
  const state = { now: 0, timers: [] };
  const win = {
    setTimeout(fn, ms) {
      const id = state.timers.length;
      state.timers.push({ fn, at: state.now + ms });
      return id;
    },
    clearTimeout(id) {
      if (state.timers[id]) state.timers[id] = null;
    },
  };
  function tick(ms) {
    state.now += ms;
    let fired = true;
    while (fired) {
      fired = false;
      for (let i = 0; i < state.timers.length; i += 1) {
        const timer = state.timers[i];
        if (timer && timer.at <= state.now) {
          state.timers[i] = null;
          timer.fn();
          fired = true;
        }
      }
    }
  }
  return { win, tick, now: () => state.now };
}

function fakeNode() {
  const listeners = {};
  return {
    listeners,
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 40, height: 20, left: 0, top: 0 }),
    appendChild: () => {},
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    fire(type, event = {}) {
      (listeners[type] ?? []).forEach((handler) => handler(event));
    },
  };
}

function bindNode(id) {
  const el = fakeNode();
  const doc = { querySelector: (selector) => (selector === `[data-node-id="${id}"]` ? el : null) };
  const clock = fakeClock();
  const calls = [];
  gestures.opuInstallGestures(doc, clock.win, [{ id }], (boundId, name, detail) => calls.push({ boundId, name, detail }));
  return { el, clock, calls };
}

function emitted(value) {
  const dir = tmpDir();
  const result = emitFromIr(value, dir);
  return { dir, html: fs.readFileSync(result.indexPath, 'utf8') };
}

test('every interactive node gets the four native gesture listeners', () => {
  const { el } = bindNode(1);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(el.listeners[type], `expected a ${type} listener`);
  }
});

test('a plain tap fires the event actions after the double-tap window', () => {
  const { el, clock, calls } = bindNode(1);
  el.fire('pointerdown', { clientX: 10, clientY: 10 });
  el.fire('pointerup', { clientX: 10, clientY: 10 });
  assert.deepEqual(calls, [], 'a single tap must wait for the double-tap window');
  clock.tick(300);
  assert.deepEqual(calls.map((c) => c.name), ['tap']);
});

test('two taps inside the window fire a double-tap and suppress the first tap', () => {
  const { el, clock, calls } = bindNode(1);
  el.fire('pointerdown', { clientX: 10, clientY: 10 });
  el.fire('pointerup', { clientX: 10, clientY: 10 });
  el.fire('pointerdown', { clientX: 12, clientY: 11 });
  el.fire('pointerup', { clientX: 12, clientY: 11 });
  assert.deepEqual(calls.map((c) => c.name), ['doubleTap'], 'double tap wins over a lone tap');
  clock.tick(300);
  assert.deepEqual(calls.map((c) => c.name), ['doubleTap'], 'no late tap after the double tap');
});

test('holding past the long-press delay fires long-press once', () => {
  const { el, clock, calls } = bindNode(1);
  el.fire('pointerdown', { clientX: 5, clientY: 5 });
  clock.tick(200);
  assert.deepEqual(calls, []);
  clock.tick(400);
  assert.deepEqual(calls.map((c) => c.name), ['longPress']);
  // Release: no tap may follow a completed long press.
  el.fire('pointerup', { clientX: 5, clientY: 5 });
  clock.tick(300);
  assert.deepEqual(calls.map((c) => c.name), ['longPress']);
});

test('a drag past the tap slop fires drag then dragEnd, not a tap', () => {
  const { el, clock, calls } = bindNode(1);
  el.fire('pointerdown', { clientX: 0, clientY: 0 });
  el.fire('pointermove', { clientX: 5, clientY: 0 });
  assert.deepEqual(calls, [], 'below the slop a move is not a drag');
  el.fire('pointermove', { clientX: 40, clientY: 0 });
  assert.deepEqual(calls.map((c) => c.name), ['drag']);
  el.fire('pointerup', { clientX: 40, clientY: 0 });
  assert.deepEqual(calls.map((c) => c.name), ['drag', 'dragEnd']);
  clock.tick(300);
  assert.deepEqual(calls.map((c) => c.name), ['drag', 'dragEnd'], 'a drag suppresses the tap');
});

test('pointercancel clears pending long-press and drag state', () => {
  const { el, clock, calls } = bindNode(1);
  el.fire('pointerdown', { clientX: 0, clientY: 0 });
  el.fire('pointermove', { clientX: 60, clientY: 0 });
  assert.deepEqual(calls.map((c) => c.name), ['drag'], 'a drag past slop fires before the cancel');
  el.fire('pointercancel');
  clock.tick(1000);
  assert.deepEqual(calls.map((c) => c.name), ['drag'], 'no long press or tap follows the cancel');
});

test('the emitted page installs gestures at runtime, not in the markup', () => {
  const { dir, html } = emitted(ir(
    node(0, 'Column', {}, [
      node(1, 'Button', { label: 'Go' }, [], { tap: { op: 'add', target: 'n', value: 1 } }),
    ]),
    { state: [{ name: 'n', type: 'int', init: 0 }] },
  ));
  try {
    assert.match(html, /opuInstallGestures\(document, window,/);
    assert.match(html, /opuInstallRipples\(document\)/);
    assert.match(html, /opuBindGestures/);
    assert.match(html, /pointerdown/);
    assert.match(html, /pointermove/);
    assert.match(html, /pointerup/);
    assert.match(html, /opuPlayTransition/);
    // Listeners are installed by handlers only: the static markup has none.
    const markup = html.slice(0, html.indexOf('<script>'));
    assert.doesNotMatch(markup, /addEventListener/);
    // The gesture bindings for the tap event are embedded as compiled constants.
    const bindings = /var GESTURES = (\{.*?\});\n/s.exec(html)[1];
    assert.ok(JSON.parse(bindings)['1'].tap.some((a) => a.op === 'add'));
  } finally {
    cleanup(dir);
  }
});

test('a Button with no event still receives gesture handlers', () => {
  const { dir, html } = emitted(ir(node(0, 'Column', {}, [node(1, 'Button', { label: 'Go' }, [])])));
  try {
    const bindings = /var GESTURES = (\{.*?\});\n/s.exec(html)[1];
    assert.deepEqual(JSON.parse(bindings), { 1: {} }, 'a Button is bound even with no event');
    assert.match(html, /opuInstallGestures\(document, window, \[\{"id":1\}\],/);
  } finally {
    cleanup(dir);
  }
});

test('the transition hook adds the class and clears it when the animation ends', () => {
  const clock = fakeClock();
  const classes = new Set();
  const main = {
    offsetWidth: 0,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
    },
  };
  const doc = { getElementById: (id) => (id === 'app' ? main : null) };
  playTransition(clock.win, doc, 'slide');
  assert.ok(classes.has('opurom-transition-slide'), 'the matching class is added');
  clock.tick(400);
  assert.equal(classes.has('opurom-transition-slide'), false, 'the class is removed after the duration');
});

test('the transition hook ignores an unknown kind and honours reduced motion', () => {
  const clock = fakeClock();
  const classes = new Set();
  const main = { offsetWidth: 0, classList: { add: (...n) => n.forEach((x) => classes.add(x)), remove: (...n) => n.forEach((x) => classes.delete(x)) } };
  const doc = { getElementById: () => main };
  playTransition(clock.win, doc, 'nonsense');
  assert.equal(classes.size, 0, 'an unknown transition plays nothing');

  const reduced = fakeClock();
  reduced.win.matchMedia = () => ({ matches: true });
  playTransition(reduced.win, doc, 'fade');
  assert.equal(classes.size, 0, 'reduced motion suppresses the animation');
});

test('each supported transition emits its keyframes and class rule only', () => {
  for (const kind of ['slide', 'fade', 'scale']) {
    const { dir, html } = emitted(ir(node(0, 'Button', { label: 'Go' }, []), { transition: kind }));
    try {
      const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
      assert.match(css, new RegExp(`@keyframes opurom-transition-${kind} \\{`), `${kind} keyframes missing`);
      assert.match(css, new RegExp(`\\.opurom-transition-${kind} \\{ animation: opurom-transition-${kind} 320ms`));
      assert.match(html, /opuPlayTransition/);
    } finally {
      cleanup(dir);
    }
  }
});

test('IR without a transition emits no page-transition CSS', () => {
  const { dir, html } = emitted(ir(node(0, 'Button', { label: 'Go' }, [])));
  try {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.doesNotMatch(css, /opurom-transition-(slide|fade|scale)/);
  } finally {
    cleanup(dir);
  }
});

test('an invalid transition is rejected at validation', () => {
  assert.throws(
    () => emitFromIr(ir(node(0, 'Button', { label: 'Go' }, []), { transition: 'bounce' }), tmpDir()),
    /transition .* must be slide\|fade\|scale/,
  );
});

test('a nav action is accepted and wires the tap transition', () => {
  const { dir, html } = emitted(ir(
    node(0, 'Column', {}, [
      node(1, 'Button', { label: 'Go' }, [], { tap: { op: 'nav' }, doubleTap: { op: 'nav' } }),
    ]),
    { transition: 'scale' },
  ));
  try {
    const bindings = /var GESTURES = (\{.*?\});\n/s.exec(html)[1];
    const binding = JSON.parse(bindings)['1'];
    assert.equal(binding.nav, true);
    assert.deepEqual(binding.tap, [], 'the nav action is not a state change');
    assert.match(html, /opuromNavigate/);
  } finally {
    cleanup(dir);
  }
});

test('a push action is accepted and wires the tap transition', () => {
  const { dir, html } = emitted(ir(
    node(0, 'Column', {}, [
      node(1, 'Button', { label: 'Go' }, [], { tap: { op: 'push', target: 'Settings' } }),
    ]),
    { transition: 'scale', pages: ['Home', 'Settings'] },
  ));
  try {
    const bindings = /var GESTURES = (\{.*?\});\n/s.exec(html)[1];
    const binding = JSON.parse(bindings)['1'];
    assert.equal(binding.nav, true);
    assert.deepEqual(binding.tap, [], 'the push action is not a state change');
    assert.match(html, /opuromNavigate/);
  } finally {
    cleanup(dir);
  }
});

test('a push without a page name or with a value is rejected', () => {
  assert.throws(
    () => emitFromIr(ir(node(0, 'Button', { label: 'Go' }, [], { tap: { op: 'push', value: 1 } })), tmpDir()),
    /push takes no value|push requires a page name/,
  );
  assert.throws(
    () => emitFromIr(ir(node(0, 'Button', { label: 'Go' }, [], { tap: { op: 'push', target: 7 } })), tmpDir()),
    /push target must be a string/,
  );
});

test('an invalid nav action is rejected at validation', () => {
  assert.throws(
    () => emitFromIr(ir(node(0, 'Button', { label: 'Go' }, [], { tap: { op: 'nav', value: 1 } })), tmpDir()),
    /nav takes no value/,
  );
});

test('identical gesture/transition IR yields byte-identical HTML', () => {
  const value = ir(
    node(0, 'Column', {}, [
      node(1, 'Button', { label: 'Go' }, [], { tap: { op: 'add', target: 'n', value: 1 }, doubleTap: { op: 'nav' } }),
      node(2, 'Container', { animate: 'spring' }, []),
    ]),
    { state: [{ name: 'n', type: 'int', init: 0 }], transition: 'slide' },
  );
  const a = emitted(value);
  const b = emitted(value);
  try {
    assert.equal(a.html, b.html);
  } finally {
    cleanup(a.dir);
    cleanup(b.dir);
  }
});

test('gesture and transition emission keep theme tokens derived from the IR', () => {
  const value = ir(node(0, 'Button', { label: 'Go' }, []), {
    theme: { mode: 'dark', accent: '#097FEB', radius: 8, tokens: { surface: '#010203', onSurface: '#0A0B0C' } },
    transition: 'fade',
  });
  const { dir, html } = emitted(value);
  try {
    assert.match(html, /--opurom-mode: dark/);
    assert.match(html, /--opurom-surface: rgb\(1, 2, 3\)/);
    assert.match(html, /--opurom-on-surface: rgb\(10, 11, 12\)/);
    assert.match(html, /--surface: rgb\(1, 2, 3\)/);
    assert.match(html, /--ink: rgb\(10, 11, 12\)/);
    assert.match(html, /@keyframes opurom-transition-fade/);
  } finally {
    cleanup(dir);
  }
});

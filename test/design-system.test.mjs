/* Material 3 design tokens: the emitted stylesheet must carry a system font
 * stack, theme-derived colors, elevation/radius/spacing scales, state-layer
 * rules, dark-mode switching, ripple feedback and byte-identical emission. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SYSTEM_FONT_STACK } from '../lib/design.mjs';
import { emitFromIr } from '../lib/emit.mjs';
import { cleanup, ir, node, tmpDir } from '../test-helpers/helpers.mjs';

function emit(themeOverrides = {}) {
  const dir = tmpDir();
  try {
    const value = ir(node(0, 'Column', {}, [
      node(1, 'Button', { label: 'Go' }, []),
      node(2, 'Text', { value: 'Hi' }, []),
    ]), {
      theme: { mode: 'light', accent: '#097FEB', radius: 12, ...themeOverrides },
    });
    const result = emitFromIr(value, dir);
    return fs.readFileSync(result.indexPath, 'utf8');
  } finally {
    cleanup(dir);
  }
}

function css(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)[1];
}

test('the emitted stylesheet carries the required system font stack', () => {
  const html = emit();
  assert.ok(html.includes(`--opurom-font-system: ${SYSTEM_FONT_STACK};`), 'system font stack token missing');
  assert.match(css(html), /font-family: var\(--font-ui, var\(--opurom-font-system\)\)/);
});

test('the emitted stylesheet has no bitmap or monospace font fallback', () => {
  const html = emit();
  assert.doesNotMatch(css(html), /monospace|bitmap|Courier/i, 'bitmap/monospace fallback must not be emitted');
});

test('design tokens derive from the IR theme', () => {
  const html = emit();
  const styles = css(html);
  assert.match(styles, /--opurom-primary: #097FEB/);
  assert.match(styles, /--opurom-surface: rgb\(255, 255, 255\)/);
  assert.match(styles, /--opurom-on-surface: rgb\(17, 24, 39\)/);
  assert.match(styles, /--opurom-elevation-1:/);
  assert.match(styles, /--opurom-elevation-2:/);
  assert.match(styles, /--opurom-elevation-3:/);
});

test('the emitted stylesheet carries the 8px radius and 4px spacing scales', () => {
  const styles = css(emit());
  assert.match(styles, /--opurom-radius-1: 8px/);
  assert.match(styles, /--opurom-radius-2: 16px/);
  assert.match(styles, /--opurom-radius-3: 24px/);
  assert.match(styles, /--opurom-radius-4: 32px/);
  assert.match(styles, /--opurom-space-1: 4px/);
  assert.match(styles, /--opurom-space-2: 8px/);
  assert.match(styles, /--opurom-space-3: 12px/);
  assert.match(styles, /--opurom-space-4: 16px/);
});

test('dark mode switches the design tokens', () => {
  const light = css(emit({ mode: 'light' }));
  const dark = css(emit({ mode: 'dark' }));
  assert.match(dark, /--opurom-mode: dark/);
  assert.match(dark, /--opurom-surface: rgb\(15, 23, 42\)/);
  assert.match(dark, /--opurom-on-surface: rgb\(248, 250, 252\)/);
  assert.doesNotMatch(light, /--opurom-surface: rgb\(15, 23, 42\)/);
  assert.notEqual(light, dark);
});

test('focus, hover, pressed and disabled state-layer rules exist', () => {
  const styles = css(emit());
  assert.match(styles, /--opurom-state-hover:/);
  assert.match(styles, /--opurom-state-press:/);
  assert.match(styles, /--opurom-state-focus:/);
  assert.match(styles, /--opurom-state-disabled:/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /:hover/);
  assert.match(styles, /:active/);
  assert.match(styles, /:disabled/);
});

test('ripple-like press feedback is emitted for interactive nodes', () => {
  const html = emit();
  const styles = css(html);
  assert.match(styles, /@keyframes opurom-ripple/);
  assert.match(styles, /\.opurom-ripple \{/);
  assert.match(html, /opuInstallRipples\(document\)/);
  assert.match(html, /opuRippleAt/);
});

test('identical IR yields byte-identical HTML', () => {
  const first = emit();
  const second = emit();
  assert.equal(first, second);
});

test('a theme color change changes the design tokens', () => {
  const before = css(emit({ accent: '#097FEB' }));
  const after = css(emit({ accent: '#123456' }));
  assert.match(before, /--opurom-primary: #097FEB/);
  assert.match(after, /--opurom-primary: #123456/);
  assert.notEqual(before, after);
});

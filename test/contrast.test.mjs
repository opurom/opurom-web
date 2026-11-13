/* WCAG contrast over the theme's declared surface/onSurface pair: exact ratio
 * vectors, parity of the BigInt fixed-point implementation against an
 * independent floating-point translation of the same published formula, and
 * the contrast line printed by verify. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { contrastRatio } from '../lib/contrast.mjs';
import { gradientSpec, parseHexColor } from '../lib/spec.mjs';
import { contrastLine, verify } from '../lib/verify.mjs';
import { cleanup, COUNTER_FIXTURE, runCli, tmpDir } from '../test-helpers/helpers.mjs';

const counterIr = JSON.parse(fs.readFileSync(COUNTER_FIXTURE, 'utf8'));

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/* Independent float reference of the published WCAG 2.x formula, for the
 * parity sweep only; the implementation under test shares no code with it. */
function floatRatio(fg, bg) {
  const linear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) =>
    0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return ((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

test('contrastRatio reports exact ratios and flags a failing pair', () => {
  // Published vectors: pure black on white is exactly 21, and #767676 on
  // white is the standard 4.54 example of the lightest AA-passing gray.
  assert.deepEqual(contrastRatio(BLACK, WHITE), {
    ratio: '21.00',
    threshold: '4.5',
    meets: true,
  });
  assert.equal(contrastRatio(WHITE, BLACK).ratio, '21.00');
  assert.equal(contrastRatio(parseHexColor('#767676'), WHITE).ratio, '4.54');

  // Mode palettes from the spec, as resolved for light and dark themes.
  assert.equal(contrastRatio(parseHexColor('#111827'), WHITE).ratio, '17.74');
  assert.equal(contrastRatio(parseHexColor('#F8FAFC'), parseHexColor('#0F172A')).ratio, '17.06');

  // Failing pair: identical colors contrast 1:1, far below the threshold.
  const same = contrastRatio(parseHexColor('#767676'), parseHexColor('#767676'));
  assert.equal(same.ratio, '1.00');
  assert.equal(same.meets, false);
  // The ratio is symmetric in argument order.
  assert.deepEqual(contrastRatio(WHITE, parseHexColor('#111827')), {
    ratio: '17.74',
    threshold: '4.5',
    meets: true,
  });
});

test('fixed-point ratios match a float reference across the whole gray range', () => {
  for (let g = 0; g <= 255; g += 1) {
    const gray = [g, g, g];
    assert.equal(contrastRatio(gray, WHITE).ratio, floatRatio(gray, WHITE), `gray ${g} on white`);
    assert.equal(contrastRatio(gray, BLACK).ratio, floatRatio(gray, BLACK), `gray ${g} on black`);
  }
  // A colored sweep too: the gray range never exercises asymmetric channels.
  for (let c = 1; c < 256; c += 7) {
    const rgb = [c, 255 - c, (c * 13) % 256];
    assert.equal(contrastRatio(rgb, WHITE).ratio, floatRatio(rgb, WHITE), `rgb ${rgb} on white`);
    assert.equal(contrastRatio(rgb, parseHexColor('#0F172A')).ratio, floatRatio(rgb, parseHexColor('#0F172A')), `rgb ${rgb} on dark surface`);
  }
});

test('contrastLine names the resolved pair, ratio, threshold and verdict', () => {
  // Token-free counter IR falls back to the light palette.
  assert.equal(
    contrastLine(gradientSpec(counterIr)),
    'contrast: surface rgb(255, 255, 255) onSurface rgb(17, 24, 39) ratio 17.74:1, WCAG AA normal-text minimum 4.5:1 pass',
  );

  const failing = {
    ...counterIr,
    theme: { ...counterIr.theme, tokens: { surface: '#FFFFFF', onSurface: '#9CA3AF' } },
  };
  assert.equal(
    contrastLine(gradientSpec(failing)),
    'contrast: surface rgb(255, 255, 255) onSurface rgb(156, 163, 175) ratio 2.54:1, WCAG AA normal-text minimum 4.5:1 fail',
  );
});

test('verify prints the contrast line on every run, skip included', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['verify', COUNTER_FIXTURE, dir], {
      env: { OPUROM_BROWSER: '/nonexistent/headless-chromium' },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^contrast: surface rgb\(255, 255, 255\) onSurface rgb\(17, 24, 39\) ratio 17\.74:1, WCAG AA normal-text minimum 4\.5:1 pass$/m);
  } finally {
    cleanup(dir);
  }
});

/* Material 3 design-token layer for the emitted page.
 *
 * The tokens are derived deterministically from the IR theme: surface and
 * on-surface come from the shared gradient spec, primary from the accent, and
 * state overlays from those resolved colors. The same IR therefore produces
 * byte-identical CSS, while a different theme produces different tokens.
 */

import { parseHexColor } from './spec.mjs';

/* The required platform system stack. It leads with the host system faces and
 * keeps CJK fallbacks, with no bitmap or monospace fallback. */
export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif';

const ELEVATION = {
  light: [
    '0 1px 2px rgba(17, 24, 39, 0.10), 0 1px 3px rgba(17, 24, 39, 0.08)',
    '0 2px 6px rgba(17, 24, 39, 0.12), 0 1px 4px rgba(17, 24, 39, 0.10)',
    '0 8px 16px rgba(17, 24, 39, 0.14), 0 2px 6px rgba(17, 24, 39, 0.12)',
  ],
  dark: [
    '0 1px 2px rgba(0, 0, 0, 0.40), 0 1px 3px rgba(0, 0, 0, 0.32)',
    '0 2px 8px rgba(0, 0, 0, 0.44), 0 1px 4px rgba(0, 0, 0, 0.36)',
    '0 10px 20px rgba(0, 0, 0, 0.50), 0 3px 8px rgba(0, 0, 0, 0.40)',
  ],
};

function rgba(values, alpha) {
  return `rgba(${values.join(', ')}, ${alpha})`;
}

function rgb(values) {
  return `rgb(${values.join(', ')})`;
}

function onPrimaryColor(hex) {
  const [r, g, b] = parseHexColor(hex);
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  return luminance < 128 ? '#ffffff' : '#000000';
}

/* Mix `foreground` into `background` at `amount`, for theme-derived tints. */
function mix(background, foreground, amount) {
  return background.map((channel, index) => Math.round(channel * (1 - amount) + foreground[index] * amount));
}

export function designCss(ir, spec) {
  const dark = ir.theme.mode === 'dark';
  const surface = spec.bottom;
  const onSurface = spec.border;
  const primary = ir.theme.accent;
  const elevation = ELEVATION[dark ? 'dark' : 'light'];

  const container = mix(surface, onSurface, dark ? 0.06 : 0.04);
  const variant = onSurface.map((channel) => Math.round(channel * 0.72));

  return `
:root {
  --opurom-mode: ${dark ? 'dark' : 'light'};
  --opurom-primary: ${primary};
  --opurom-on-primary: ${onPrimaryColor(primary)};
  --opurom-surface: ${rgb(surface)};
  --opurom-on-surface: ${rgb(onSurface)};
  --opurom-surface-container: ${rgb(container)};
  --opurom-on-surface-variant: ${rgb(variant)};
  --opurom-outline: ${rgba(onSurface, 0.12)};
  --opurom-state-hover: ${rgba(onSurface, dark ? 0.08 : 0.04)};
  --opurom-state-press: ${rgba(onSurface, dark ? 0.16 : 0.10)};
  --opurom-state-focus: ${rgba(parseHexColor(primary), dark ? 0.40 : 0.24)};
  --opurom-state-disabled: ${rgba(onSurface, 0.12)};
  --opurom-elevation-1: ${elevation[0]};
  --opurom-elevation-2: ${elevation[1]};
  --opurom-elevation-3: ${elevation[2]};
  --opurom-radius-1: 8px;
  --opurom-radius-2: 16px;
  --opurom-radius-3: 24px;
  --opurom-radius-4: 32px;
  --opurom-space-1: 4px;
  --opurom-space-2: 8px;
  --opurom-space-3: 12px;
  --opurom-space-4: 16px;
  --opurom-space-6: 24px;
  --opurom-space-8: 32px;
  --opurom-font-system: ${SYSTEM_FONT_STACK};
}
body { font-family: var(--font-ui, var(--opurom-font-system)); }
button, input, [role="button"], [role="checkbox"], [role="slider"] {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, outline-color 150ms ease;
}
button::after, [role="button"]::after, [role="checkbox"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  background: var(--opurom-state-hover);
  transition: opacity 150ms ease, background-color 150ms ease;
}
button:hover:not(:disabled):not([aria-disabled="true"])::after,
[role="button"]:hover:not([aria-disabled="true"])::after,
[role="checkbox"]:hover:not([aria-disabled="true"])::after {
  background: var(--opurom-state-hover);
  opacity: 1;
}
button:active:not(:disabled):not([aria-disabled="true"])::after,
[role="button"]:active:not([aria-disabled="true"])::after,
[role="checkbox"]:active:not([aria-disabled="true"])::after {
  background: var(--opurom-state-press);
  opacity: 1;
}
button:focus-visible,
input:focus-visible,
[role="button"]:focus-visible,
[role="checkbox"]:focus-visible,
[role="slider"]:focus-visible {
  outline: 2px solid var(--opurom-primary);
  outline-offset: 2px;
}
button:focus-visible::after,
[role="button"]:focus-visible::after,
[role="checkbox"]:focus-visible::after {
  background: var(--opurom-state-focus);
  opacity: 1;
}
button:disabled,
button[aria-disabled="true"],
input:disabled,
input[aria-disabled="true"],
[role="button"][aria-disabled="true"],
[role="checkbox"][aria-disabled="true"],
[role="slider"][aria-disabled="true"] {
  background: var(--opurom-state-disabled);
  color: var(--opurom-on-surface-variant);
  cursor: not-allowed;
}
input {
  background-color: var(--opurom-surface);
}
input:hover:not(:disabled):not([aria-disabled="true"]) {
  background-color: var(--opurom-surface-container);
}
.opurom-ripple {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  background: var(--opurom-primary);
  opacity: 0.35;
  transform: scale(0);
  animation: opurom-ripple 420ms ease-out forwards;
}
@keyframes opurom-ripple {
  from { transform: scale(0); opacity: 0.35; }
  to { transform: scale(1); opacity: 0; }
}`.trim();
}

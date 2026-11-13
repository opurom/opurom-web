/* The deterministic gradient spec: IR theme -> a plain integer pixel recipe.
 * Shared contract between the emitted page painter (lib/page-source.mjs) and
 * the independent Node CPU reference (lib/cpu-reference.mjs). Both implement
 * the recipe below in separate code and must produce byte-identical RGBA8. */

export const CANVAS_SIZE = { width: 480, height: 270 };
const BORDER_SIZE = 2;
const BAND = { y0: 90, y1: 130, alpha: 160 };

const PALETTES = {
  light: { surface: [255, 255, 255], onSurface: [17, 24, 39] },
  dark: { surface: [15, 23, 42], onSurface: [248, 250, 252] },
};

export function parseHexColor(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/* theme.mode "system" resolves to light (no host query, like opurom-render).
 * Token colors override the mode palette per field here, so both painters
 * consume one recipe instead of re-reading the theme. */
export function gradientSpec(ir) {
  const palette = PALETTES[ir.theme.mode === 'dark' ? 'dark' : 'light'];
  const tokens = ir.theme.tokens ?? {};
  return {
    width: CANVAS_SIZE.width,
    height: CANVAS_SIZE.height,
    top: parseHexColor(ir.theme.accent),
    bottom: tokens.surface === undefined ? palette.surface : parseHexColor(tokens.surface),
    border: tokens.onSurface === undefined ? palette.onSurface : parseHexColor(tokens.onSurface),
    borderSize: BORDER_SIZE,
    radius: Math.max(0, Math.round(ir.theme.radius)),
    band: { ...BAND },
  };
}

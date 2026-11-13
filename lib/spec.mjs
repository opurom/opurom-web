/* The deterministic gradient spec: IR theme -> a plain integer pixel recipe.
 * Shared contract between the emitted page painter (lib/page-source.mjs) and
 * the independent Node CPU reference (lib/cpu-reference.mjs). Both implement
 * the recipe below in separate code and must produce byte-identical RGBA8.
 * The spec also lowers the opt-in `props.particles` fields of the tree: the
 * panel has no IR geometry (see design decisions), so every field scatters
 * over the whole 480x270 panel in document order, and a field that breaks the
 * renderer's parse-time bounds is dropped like any unsupported prop. */

export const CANVAS_SIZE = { width: 480, height: 270 };
const BORDER_SIZE = 2;
const BAND = { y0: 90, y1: 130, alpha: 160 };

/* Particle bounds and defaults mirror opurom-render's `particles_prop`. */
const PARTICLE_MAX_COUNT = 512;
const PARTICLE_MAX_RADIUS = 32;
const PARTICLE_MAX_SEED = 0xffffffff;
const PARTICLE_ALPHA_UNIT = 1024;

function inRange(value, lo, hi) {
  return Number.isInteger(value) && value >= lo && value <= hi;
}

/* One node's particle field as painters consume it: `alpha` is already the
 * blend byte (`fixed point * 255 / 1024`), `color` is an RGB triple falling
 * back to the theme accent. Null means the renderer would reject the field at
 * parse time, so this backend ignores it instead of painting a different one. */
function particleField(props, accent) {
  const field = props.particles;
  if (field === undefined) return null;
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return null;
  if (!inRange(field.count, 0, PARTICLE_MAX_COUNT)) return null;
  const seed = field.seed === undefined ? 1 : field.seed;
  if (!inRange(seed, 0, PARTICLE_MAX_SEED)) return null;
  const radius = field.radius === undefined ? 2 : field.radius;
  if (!inRange(radius, 0, PARTICLE_MAX_RADIUS)) return null;
  const alpha = field.alpha === undefined ? PARTICLE_ALPHA_UNIT : field.alpha;
  if (!inRange(alpha, 0, PARTICLE_ALPHA_UNIT)) return null;
  let color = accent;
  if (field.color !== undefined) {
    if (typeof field.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(field.color)) return null;
    color = parseHexColor(field.color);
  }
  return { count: field.count, seed, radius, alpha: Math.floor((alpha * 255) / PARTICLE_ALPHA_UNIT), color };
}

/* Pre-order walk: document order is the renderer's draw order, so overlapping
 * dots blend in the same sequence on both painters. */
function particleFields(ir, accent) {
  const fields = [];
  const walk = (node) => {
    const field = particleField(node.props, accent);
    if (field !== null) fields.push(field);
    node.children.forEach(walk);
  };
  walk(ir.tree);
  return fields;
}

/* Integer avalanche mix of one 32-bit word: the only randomness source, so the
 * DOM dot layout is a pure function of the field and the dot index. */
function particleMix(x) {
  let v = x >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

/* Deterministic dot placement for the DOM/CSS particle layer. It mirrors the
 * canvas painter's `opuDotCenter` exactly (same two hashes of seed and index,
 * reduced modulo the panel) so the DOM layer and the painted pixels share one
 * layout. Fields the painter skips (zero count or zero alpha) are skipped here
 * too, keeping the DOM layer and the raster in step. */
export function particleDots(spec) {
  const layers = [];
  spec.particles.forEach((field, fieldIndex) => {
    if (field.count === 0 || field.alpha === 0) return;
    const seed = field.seed >>> 0;
    const dots = [];
    for (let i = 0; i < field.count; i += 1) {
      const golden = Math.imul(i, 0x9e3779b9);
      const hx = particleMix(seed ^ ((golden + 0x6c078965) >>> 0));
      const hy = particleMix(seed ^ ((golden + 0x85ebca6b) >>> 0));
      dots.push({ x: hx % spec.width, y: hy % spec.height });
    }
    layers.push({ field: fieldIndex, count: field.count, seed: field.seed, radius: field.radius, alpha: field.alpha, color: field.color, dots });
  });
  return layers;
}

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
  const accent = parseHexColor(ir.theme.accent);
  return {
    width: CANVAS_SIZE.width,
    height: CANVAS_SIZE.height,
    top: accent,
    bottom: tokens.surface === undefined ? palette.surface : parseHexColor(tokens.surface),
    border: tokens.onSurface === undefined ? palette.onSurface : parseHexColor(tokens.onSurface),
    borderSize: BORDER_SIZE,
    radius: Math.max(0, Math.round(ir.theme.radius)),
    band: { ...BAND },
    particles: particleFields(ir, accent),
  };
}

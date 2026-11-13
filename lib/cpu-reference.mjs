/* Independent Node CPU reference for the deterministic canvas painting:
 * the vertical gradient plus the opt-in particle fields of the same spec.
 *
 * This is a SEPARATE implementation of the recipe documented in lib/spec.mjs
 * and README.md: the browser-side painter lives in lib/page-source.mjs as JS
 * source that is inlined into index.html. Structural differences (row-wise
 * precomputation, Uint8Array, pixel-first dot coverage vs dot-first scatter)
 * are deliberate so that digest equality between the two is a real
 * cross-implementation check.
 */

export function fnv1a64(bytes) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i += 1) {
    hash = BigInt.asUintN(64, hash ^ BigInt(bytes[i]));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

/* Rounded-rect containment in pixel coordinates; R <= 0 means a plain rect. */
function insideShape(x, y, width, height, radius) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if (radius <= 0) return true;
  const dx = x < radius ? radius - x : x >= width - radius ? x - (width - 1 - radius) : 0;
  const dy = y < radius ? radius - y : y >= height - radius ? y - (height - 1 - radius) : 0;
  return dx * dx + dy * dy <= radius * radius;
}

function rowBaseColors(spec) {
  const rows = new Int32Array(spec.height * 3);
  const span = spec.height - 1;
  for (let y = 0; y < spec.height; y += 1) {
    const t = Math.floor((y * 1024) / span);
    for (let channel = 0; channel < 3; channel += 1) {
      let value = spec.top[channel] + Math.floor(((spec.bottom[channel] - spec.top[channel]) * t) / 1024);
      if (y >= spec.band.y0 && y < spec.band.y1) {
        value += Math.floor(((255 - value) * spec.band.alpha) / 1024);
      }
      rows[y * 3 + channel] = value;
    }
  }
  return rows;
}

export function paintReference(spec) {
  const width = spec.width;
  const height = spec.height;
  const inset = Math.max(spec.radius - spec.borderSize, 0);
  const out = new Uint8Array(width * height * 4);
  const base = rowBaseColors(spec);
  for (let y = 0; y < height; y += 1) {
    const red = base[y * 3];
    const green = base[y * 3 + 1];
    const blue = base[y * 3 + 2];
    for (let x = 0; x < width; x += 1) {
      if (!insideShape(x, y, width, height, spec.radius)) continue;
      const index = (y * width + x) * 4;
      const onBorder = !insideShape(
        x - spec.borderSize,
        y - spec.borderSize,
        width - 2 * spec.borderSize,
        height - 2 * spec.borderSize,
        inset,
      );
      const source = onBorder ? spec.border : [red, green, blue];
      out[index] = source[0];
      out[index + 1] = source[1];
      out[index + 2] = source[2];
      out[index + 3] = 255;
    }
  }
  for (const field of spec.particles) paintFieldReference(out, field, width, height);
  return out;
}

/* Particle dot placement, ported from opurom-render's integer avalanche hash:
 * two independent 32-bit mixes of (seed, index) reduced modulo the panel. The
 * reference evaluates coverage pixel-first (the GPU backend's traversal); the
 * page painter scatters dot-first (the raster's traversal), so a placement or
 * blend disagreement shows up as byte divergence between the two. */
function mix(x) {
  let v = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

function dotCenters(field, width, height) {
  const seed = field.seed >>> 0;
  const centers = new Int32Array(field.count * 2);
  for (let i = 0; i < field.count; i += 1) {
    const golden = Math.imul(i, 0x9e3779b9);
    centers[i * 2] = mix(seed ^ ((golden + 0x6c078965) >>> 0)) % width;
    centers[i * 2 + 1] = mix(seed ^ ((golden + 0x85ebca6b) >>> 0)) % height;
  }
  return centers;
}

/* Source-over blend by byte alpha; alpha 0 writes nothing and any write
 * leaves the pixel opaque, matching the framebuffer rule. */
function blendPixel(out, index, color, alpha) {
  if (alpha === 255) {
    out[index] = color[0];
    out[index + 1] = color[1];
    out[index + 2] = color[2];
    out[index + 3] = 255;
    return;
  }
  const inv = 255 - alpha;
  for (let channel = 0; channel < 3; channel += 1) {
    out[index + channel] = Math.floor((color[channel] * alpha + out[index + channel] * inv) / 255);
  }
  out[index + 3] = 255;
}

function paintFieldReference(out, field, width, height) {
  if (field.count === 0 || field.alpha === 0) return;
  const centers = dotCenters(field, width, height);
  const limit = field.radius * field.radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      for (let i = 0; i < centers.length; i += 2) {
        const dx = x - centers[i];
        const dy = y - centers[i + 1];
        if (dx * dx + dy * dy <= limit) blendPixel(out, index, field.color, field.alpha);
      }
    }
  }
}

export function referenceDigest(spec) {
  return fnv1a64(paintReference(spec));
}

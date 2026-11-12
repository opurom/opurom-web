/* Independent Node CPU reference for the deterministic canvas gradient.
 *
 * This is a SEPARATE implementation of the recipe documented in lib/spec.mjs
 * and README.md: the browser-side painter lives in lib/page-source.mjs as JS
 * source that is inlined into index.html. Structural differences (row-wise
 * precomputation, Uint8Array, helper-style rounding) are deliberate so that
 * digest equality between the two is a real cross-implementation check.
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
  return out;
}

export function referenceDigest(spec) {
  return fnv1a64(paintReference(spec));
}

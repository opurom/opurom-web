/* Independent Node CPU reference for the deterministic canvas gradient.
 *
 * This is a SEPARATE implementation of the recipe documented in lib/contract.mjs
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

function rowBaseColors(contract) {
  const rows = new Int32Array(contract.height * 3);
  const span = contract.height - 1;
  for (let y = 0; y < contract.height; y += 1) {
    const t = Math.floor((y * 1024) / span);
    for (let channel = 0; channel < 3; channel += 1) {
      let value = contract.top[channel] + Math.floor(((contract.bottom[channel] - contract.top[channel]) * t) / 1024);
      if (y >= contract.band.y0 && y < contract.band.y1) {
        value += Math.floor(((255 - value) * contract.band.alpha) / 1024);
      }
      rows[y * 3 + channel] = value;
    }
  }
  return rows;
}

export function paintReference(contract) {
  const width = contract.width;
  const height = contract.height;
  const inset = Math.max(contract.radius - contract.borderSize, 0);
  const out = new Uint8Array(width * height * 4);
  const base = rowBaseColors(contract);
  for (let y = 0; y < height; y += 1) {
    const red = base[y * 3];
    const green = base[y * 3 + 1];
    const blue = base[y * 3 + 2];
    for (let x = 0; x < width; x += 1) {
      if (!insideShape(x, y, width, height, contract.radius)) continue;
      const index = (y * width + x) * 4;
      const onBorder = !insideShape(
        x - contract.borderSize,
        y - contract.borderSize,
        width - 2 * contract.borderSize,
        height - 2 * contract.borderSize,
        inset,
      );
      const source = onBorder ? contract.border : [red, green, blue];
      out[index] = source[0];
      out[index + 1] = source[1];
      out[index + 2] = source[2];
      out[index + 3] = 255;
    }
  }
  return out;
}

export function referenceDigest(contract) {
  return fnv1a64(paintReference(contract));
}

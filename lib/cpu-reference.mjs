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

/* Per-corner containment, integer port of Impeller `CornerContains`
 * (round_rect.cc:30-64) as in opurom-render/src/geometry.rs:125-155.
 * `corners` is {topLeft, topRight, bottomRight, bottomLeft}, each {x, y}.
 * Radii are already normalized; the caller runs scaleCorners once. */
function cornerContains(px, py, cornerX, cornerY, dirX, dirY, radii) {
  const rx = radii.x;
  const ry = radii.y;
  if (rx === 0 || ry === 0) return true;
  const crx = (cornerX - px) * dirX;
  const cry = (cornerY - py) * dirY;
  const qx = rx - crx;
  const qy = ry - cry;
  if (qx <= 0 || qy <= 0) return true;
  // Cross-multiplied arc test; BigInt keeps the i128 range of the render port.
  const a = BigInt(qx) * BigInt(ry);
  const b = BigInt(qy) * BigInt(rx);
  const rr = BigInt(rx) * BigInt(ry);
  return a * a + b * b <= rr * rr;
}

/* Integer-port of `RoundingRadii::scaled` (opurom-render/src/geometry.rs:70-115,
 * impeller/geometry/rounding_radii.cc:26). One global floor-scaled factor keeps
 * adjacent radii within their edges; the scalar path does not call this. */
export function scaleCorners(corners, width, height) {
  if (width <= 0 || height <= 0) return {
    topLeft: { x: 0, y: 0 }, topRight: { x: 0, y: 0 },
    bottomRight: { x: 0, y: 0 }, bottomLeft: { x: 0, y: 0 },
  };
  const keys = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  const out = {};
  let allEmpty = true;
  for (const key of keys) {
    const c = corners[key];
    const empty = !(c.x > 0 && c.y > 0);
    if (!empty) allEmpty = false;
    out[key] = empty ? { x: 0, y: 0 } : { x: c.x, y: c.y };
  }
  if (allEmpty) return out;
  const SCALE = 1 << 16;
  let factor = Number.MAX_SAFE_INTEGER;
  const constrain = (a, b, dim) => {
    const sum = a + b;
    if (sum > dim) factor = Math.min(factor, Math.floor((dim * SCALE) / sum));
  };
  constrain(out.topLeft.x, out.topRight.x, width);
  constrain(out.bottomLeft.x, out.bottomRight.x, width);
  constrain(out.topLeft.y, out.bottomLeft.y, height);
  constrain(out.topRight.y, out.bottomRight.y, height);
  if (factor === Number.MAX_SAFE_INTEGER) return out;
  for (const key of keys) {
    out[key] = {
      x: Math.floor((out[key].x * factor) / SCALE),
      y: Math.floor((out[key].y * factor) / SCALE),
    };
  }
  return out;
}

export function insetCorners(corners, amount) {
  const shrink = (c) => ({ x: Math.max(c.x - amount, 0), y: Math.max(c.y - amount, 0) });
  return {
    topLeft: shrink(corners.topLeft),
    topRight: shrink(corners.topRight),
    bottomRight: shrink(corners.bottomRight),
    bottomLeft: shrink(corners.bottomLeft),
  };
}

export function insideCorners(x, y, width, height, corners) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return cornerContains(x, y, 0, 0, -1, -1, corners.topLeft)
    && cornerContains(x, y, width, 0, 1, -1, corners.topRight)
    && cornerContains(x, y, width, height, 1, 1, corners.bottomRight)
    && cornerContains(x, y, 0, height, -1, 1, corners.bottomLeft);
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
  const corners = contract.corners;
  const borderSize = contract.borderSize;
  const innerCorners = corners === undefined
    ? null
    : scaleCorners(insetCorners(corners, borderSize), width - 2 * borderSize, height - 2 * borderSize);
  const out = new Uint8Array(width * height * 4);
  const base = rowBaseColors(contract);
  for (let y = 0; y < height; y += 1) {
    const red = base[y * 3];
    const green = base[y * 3 + 1];
    const blue = base[y * 3 + 2];
    for (let x = 0; x < width; x += 1) {
      const inside = corners === undefined
        ? insideShape(x, y, width, height, contract.radius)
        : insideCorners(x, y, width, height, corners);
      if (!inside) continue;
      const index = (y * width + x) * 4;
      const onBorder = corners === undefined
        ? !insideShape(
          x - borderSize,
          y - borderSize,
          width - 2 * borderSize,
          height - 2 * borderSize,
          Math.max(contract.radius - borderSize, 0),
        )
        : !insideCorners(
          x - borderSize,
          y - borderSize,
          width - 2 * borderSize,
          height - 2 * borderSize,
          innerCorners,
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

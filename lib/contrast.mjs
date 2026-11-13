/* WCAG 2.x contrast ratio for one foreground/background pair, in pure BigInt
 * fixed point. Floats would make the reported digits depend on the host math
 * library; here every step is an exact integer operation, so the same colors
 * always yield the same ratio text. */

const SCALE = 10n ** 12n;
const OFFSET = SCALE / 20n; // the formula's 0.05 offset in fixed point
const WEIGHT_DEN = 10000n; // luminance weights 2126/7152/722 over this denominator
// sRGB linearization branch: c/255 <= 0.04045 <=> 100000*c <= 4045*255. The
// older WCAG 2.0 constant 0.03928 splits the 8-bit range at the same channel,
// so both conventions agree for integer channels.
const LINEAR_LIMIT = 4045n * 255n;
const POW_DEN = 269025n; // (c/255 + 0.055) / 1.055 = (1000c + 14025) / 269025
const POW_NUM_BASE = 14025n; // 0.055 * 255 * 1000
// WCAG AA minimum for normal text, scaled by 100 like the reported ratio.
const AA_MIN_100 = 450n;

/* floor(SCALE * c/255/12.92) for the linear branch (exact, one floor). */
function linearFixed(c) {
  return (SCALE * 100n * c) / (255n * 1292n);
}

/* floor(SCALE * (a/POW_DEN)^(12/5)): the largest r with
 * r^5 * POW_DEN^12 <= SCALE^5 * a^12, so the 2.4 exponent never touches a
 * float; the binary search compares exact integer powers only. */
function powFixed(a) {
  const target = SCALE ** 5n * a ** 12n;
  const den = POW_DEN ** 12n;
  let lo = 0n;
  let hi = SCALE;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid ** 5n * den <= target) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

function channelFixed(c) {
  const v = BigInt(c);
  if (100000n * v <= LINEAR_LIMIT) return linearFixed(v);
  return powFixed(1000n * v + POW_NUM_BASE);
}

function luminance(rgb) {
  const [r, g, b] = rgb;
  return (
    (2126n * channelFixed(r) + 7152n * channelFixed(g) + 722n * channelFixed(b)) / WEIGHT_DEN
  );
}

/* Ratio of the lighter over the darker luminance, reported to two decimals
 * with round-half-up, plus whether it meets the AA normal-text minimum. */
export function contrastRatio(fg, bg) {
  const lf = luminance(fg);
  const lb = luminance(bg);
  const hi = lf >= lb ? lf : lb;
  const lo = lf >= lb ? lb : lf;
  const num = hi + OFFSET;
  const den = lo + OFFSET;
  const ratio100 = (num * 200n + den) / (den * 2n);
  return {
    ratio: `${ratio100 / 100n}.${(ratio100 % 100n).toString().padStart(2, '0')}`,
    threshold: '4.5',
    meets: ratio100 >= AA_MIN_100,
  };
}

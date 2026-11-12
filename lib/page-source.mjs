/* Browser-side painter + facts collection, emitted as inline JS in index.html.
 *
 * PAGE_PAINT_SRC is a pure-function source string (no DOM): the tests eval it
 * in Node and byte-compare it against lib/cpu-reference.mjs, so the offline
 * suite on Linux CI cross-checks both implementations without a browser.
 * The recipe is the one documented in lib/spec.mjs and README.md; the code is
 * deliberately written in a different style than the Node reference.
 */

export const PAGE_PAINT_SRC = `
function opuRoundedInside(x, y, width, height, radius) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if (radius <= 0) return true;
  var dx = 0;
  var dy = 0;
  if (x < radius) { dx = radius - x; } else if (x >= width - radius) { dx = x - (width - 1 - radius); }
  if (y < radius) { dy = radius - y; } else if (y >= height - radius) { dy = y - (height - 1 - radius); }
  return dx * dx + dy * dy <= radius * radius;
}
function opuLerp(a, b, t) {
  return a + Math.floor(((b - a) * t) / 1024);
}
function opuPaintPixels(spec, data) {
  var index = 0;
  var span = spec.height - 1;
  for (var y = 0; y < spec.height; y += 1) {
    var t = Math.floor((y * 1024) / span);
    var row = [
      opuLerp(spec.top[0], spec.bottom[0], t),
      opuLerp(spec.top[1], spec.bottom[1], t),
      opuLerp(spec.top[2], spec.bottom[2], t)
    ];
    if (y >= spec.band.y0 && y < spec.band.y1) {
      for (var c = 0; c < 3; c += 1) {
        row[c] += Math.floor(((255 - row[c]) * spec.band.alpha) / 1024);
      }
    }
    for (var x = 0; x < spec.width; x += 1) {
      if (!opuRoundedInside(x, y, spec.width, spec.height, spec.radius)) { index += 4; continue; }
      var inset = Math.max(spec.radius - spec.borderSize, 0);
      var insideInset = opuRoundedInside(
        x - spec.borderSize,
        y - spec.borderSize,
        spec.width - 2 * spec.borderSize,
        spec.height - 2 * spec.borderSize,
        inset
      );
      var source = insideInset ? row : spec.border;
      data[index] = source[0];
      data[index + 1] = source[1];
      data[index + 2] = source[2];
      data[index + 3] = 255;
      index += 4;
    }
  }
}
function opuFnv1a64(bytes) {
  var hash = 0xcbf29ce484222325n;
  var prime = 0x100000001b3n;
  for (var i = 0; i < bytes.length; i += 1) {
    hash = BigInt.asUintN(64, hash ^ BigInt(bytes[i]));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}
`;

/* Full inline script for the emitted page: paint the spec into the canvas,
 * read it back with getImageData, FNV-1a 64 digest it, then collect DOM role
 * and computed-style facts. Facts are stored base64-encoded in an attribute
 * of <meta id="opurom-verify"> so --dump-dom can round-trip them without any
 * HTML escaping ambiguity. No IR reaches the page: only compiled constants. */
export function pageScript(spec) {
  return `(function () {
  'use strict';
  var SPEC = ${JSON.stringify(spec)};
${PAGE_PAINT_SRC}
  var canvas = document.getElementById('fx');
  var context = canvas.getContext('2d');
  var image = context.createImageData(SPEC.width, SPEC.height);
  opuPaintPixels(SPEC, image.data);
  context.putImageData(image, 0, 0);
  var readback = context.getImageData(0, 0, SPEC.width, SPEC.height);

  function computed(selector, property) {
    var element = document.querySelector(selector);
    if (!element) return null;
    return window.getComputedStyle(element).getPropertyValue(property);
  }

  var roles = [];
  var nodes = document.querySelectorAll('[data-node-id]');
  for (var i = 0; i < nodes.length; i += 1) {
    roles.push({
      id: Number(nodes[i].getAttribute('data-node-id')),
      tag: nodes[i].tagName.toLowerCase(),
      role: nodes[i].getAttribute('role')
    });
  }
  var button = document.querySelector('button');
  var heading = document.querySelector('[role="heading"]');
  var facts = {
    digest: opuFnv1a64(readback.data),
    canvas: { width: canvas.width, height: canvas.height },
    roles: roles,
    styles: {
      headerDisplay: computed('header', 'display'),
      mainDisplay: computed('main', 'display'),
      canvasDisplay: computed('#fx', 'display'),
      buttonDisplay: button ? window.getComputedStyle(button).display : null,
      buttonBackground: button ? window.getComputedStyle(button).backgroundColor : null,
      headingFontSize: heading ? window.getComputedStyle(heading).fontSize : null
    }
  };
  var meta = document.getElementById('opurom-verify');
  meta.setAttribute('data-result', btoa(JSON.stringify(facts)));
  meta.setAttribute('data-ready', '1');
})();
`;
}

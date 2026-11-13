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
function opuParticleMix(x) {
  var v = x >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 0x7feb352d) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  v = Math.imul(v, 0x846ca68b) >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  return v;
}
function opuDotCenter(field, index, width, height) {
  var seed = field.seed >>> 0;
  var golden = Math.imul(index, 0x9e3779b9);
  var hx = opuParticleMix(seed ^ ((golden + 0x6c078965) >>> 0));
  var hy = opuParticleMix(seed ^ ((golden + 0x85ebca6b) >>> 0));
  return [hx % width, hy % height];
}
function opuPaintParticles(spec, data) {
  var fields = spec.particles;
  for (var f = 0; f < fields.length; f += 1) {
    var field = fields[f];
    if (field.count === 0 || field.alpha === 0) { continue; }
    var limit = field.radius * field.radius;
    for (var i = 0; i < field.count; i += 1) {
      var center = opuDotCenter(field, i, spec.width, spec.height);
      var cx = center[0];
      var cy = center[1];
      var x0 = Math.max(cx - field.radius, 0);
      var x1 = Math.min(cx + field.radius, spec.width - 1);
      var y0 = Math.max(cy - field.radius, 0);
      var y1 = Math.min(cy + field.radius, spec.height - 1);
      for (var y = y0; y <= y1; y += 1) {
        for (var x = x0; x <= x1; x += 1) {
          var dx = x - cx;
          var dy = y - cy;
          if (dx * dx + dy * dy > limit) { continue; }
          var dot = (y * spec.width + x) * 4;
          if (field.alpha === 255) {
            data[dot] = field.color[0];
            data[dot + 1] = field.color[1];
            data[dot + 2] = field.color[2];
            data[dot + 3] = 255;
            continue;
          }
          var inv = 255 - field.alpha;
          data[dot] = Math.floor((field.color[0] * field.alpha + data[dot] * inv) / 255);
          data[dot + 1] = Math.floor((field.color[1] * field.alpha + data[dot + 1] * inv) / 255);
          data[dot + 2] = Math.floor((field.color[2] * field.alpha + data[dot + 2] * inv) / 255);
          data[dot + 3] = 255;
        }
      }
    }
  }
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
  opuPaintParticles(spec, data);
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

/* Pure announcement policy, emitted verbatim into the page and exercised
 * verbatim by the offline tests. `write` receives plain text only: the page
 * assigns it with textContent, so user text can never become markup. A value
 * already reported for a name is not a change and produces no announcement. */
export const ANNOUNCER_SRC = `
function opuAnnouncementText(name, value) {
  return String(name) + ': ' + String(value);
}
function opuCreateAnnouncer(initial, write) {
  var last = Object.create(null);
  Object.keys(initial).forEach(function (key) { last[key] = initial[key]; });
  return function announce(name, value) {
    var key = String(name);
    if (key in last && last[key] === value) return false;
    last[key] = value;
    write(opuAnnouncementText(key, value));
    return true;
  };
}
`;

/* Live state runtime for the responsive DOM page: restore a sessionStorage
 * snapshot over the IR's initial state, re-render the bound nodes from the
 * live state, and persist state back to the same sessionStorage key when the
 * user edits an input. The plan is built at emit time (see lib/emit.mjs) so
 * the page never carries an unresolved `{name}` placeholder in its markup. */
export const STATE_RUNTIME_SRC = `
var STATE_KEY = 'opurom.state';
function opuStateInit(initial, restore) {
  var state = {};
  var keys = Object.keys(initial || {});
  for (var i = 0; i < keys.length; i += 1) state[keys[i]] = initial[keys[i]];
  if (restore && typeof restore === 'object') {
    for (var j = 0; j < keys.length; j += 1) {
      if (Object.prototype.hasOwnProperty.call(restore, keys[j])) state[keys[j]] = restore[keys[j]];
    }
  }
  return state;
}
function opuStateRender(parts, state) {
  var out = '';
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (part !== null && typeof part === 'object' && typeof part.n === 'string') {
      out += (state[part.n] === undefined ? part.n : String(state[part.n]));
    } else {
      out += String(part);
    }
  }
  return out;
}
function opuStateRuntime(plan, initial, restore, doc, storage) {
  var state = opuStateInit(initial, restore);
  var elements = {};
  for (var i = 0; i < plan.length; i += 1) {
    var el = doc.querySelector('[data-node-id="' + plan[i].id + '"]');
    if (el) elements[plan[i].id] = el;
  }
  function apply() {
    for (var j = 0; j < plan.length; j += 1) {
      var item = plan[j];
      var node = elements[item.id];
      if (!node) continue;
      if (item.field === 'value') {
        node.value = String(state[item.name]);
      } else if (item.field === 'checked') {
        node.setAttribute('aria-checked', state[item.name] ? 'true' : 'false');
      } else if (item.field === 'label') {
        node.setAttribute('aria-label', opuStateRender(item.parts, state));
      } else {
        node.textContent = opuStateRender(item.parts, state);
      }
    }
  }
  function persist() {
    try { storage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  for (var k = 0; k < plan.length; k += 1) {
    var bound = plan[k];
    if (bound.field !== 'value') continue;
    var input = elements[bound.id];
    if (!input) continue;
    (function (item) {
      input.addEventListener('input', function () {
        var node = elements[item.id];
        state[item.name] = item.type === 'int' ? parseInt(node.value, 10) : node.value;
        persist();
        apply();
      });
    })(bound);
  }
  return { state: state, apply: apply, persist: persist };
}
`;

/* JSON embedded in <script> must not be able to close the element: every '<'
 * from IR text becomes a JS escape, so hostile values stay data. */
function embedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/* Full inline script for the emitted page: paint the spec into the canvas,
 * read it back with getImageData, FNV-1a 64 digest it, then collect DOM roles
 * with their ARIA attributes, document-level facts and computed styles. Facts
 * are stored base64-encoded in an attribute of <meta id="opurom-verify"> so
 * --dump-dom can round-trip them without any HTML escaping ambiguity. No IR
 * reaches the page: only compiled constants. */
export function pageScript(spec, initial = {}, plan = []) {
  return `(function () {
  'use strict';
  var SPEC = ${JSON.stringify(spec)};
  var INITIAL = ${embedJson(initial)};
${PAGE_PAINT_SRC}
${ANNOUNCER_SRC}
 ${STATE_RUNTIME_SRC}
   var STATE_RUNTIME = opuStateRuntime(${embedJson(plan)}, INITIAL, window.__OPUROM_STATE_RESTORE__, document, sessionStorage);
   window.opurom = window.opurom || {};
   window.opurom.state = STATE_RUNTIME.state;
   window.opuromState = STATE_RUNTIME.state;
   STATE_RUNTIME.apply();
  // Facts embed IR text (title, labels), and btoa only accepts Latin-1, so the
  // JSON is encoded as UTF-8 bytes first; Node decodes the base64 as UTF-8.
  function encodeFacts(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }
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
      role: nodes[i].getAttribute('role'),
      ariaLabel: nodes[i].getAttribute('aria-label'),
      ariaLevel: nodes[i].getAttribute('aria-level'),
      ariaChecked: nodes[i].getAttribute('aria-checked'),
      value: nodes[i].getAttribute('value')
    });
  }
  // The particle layer is decorative DOM/CSS, so its facts are read straight
  // from the emitted attributes rather than from computed layout.
  var particles = [];
  var layers = document.querySelectorAll('.particle-field');
  for (var f = 0; f < layers.length; f += 1) {
    var layer = layers[f];
    var colorParts = String(layer.getAttribute('data-color')).split(',');
    var dots = [];
    var dotNodes = layer.querySelectorAll('.particle-dot');
    for (var d = 0; d < dotNodes.length; d += 1) {
      dots.push({ x: Number(dotNodes[d].getAttribute('data-x')), y: Number(dotNodes[d].getAttribute('data-y')) });
    }
    particles.push({
      field: Number(layer.getAttribute('data-field')),
      count: Number(layer.getAttribute('data-count')),
      seed: Number(layer.getAttribute('data-seed')),
      radius: Number(layer.getAttribute('data-radius')),
      alpha: Number(layer.getAttribute('data-alpha')),
      color: [Number(colorParts[0]), Number(colorParts[1]), Number(colorParts[2])],
      dots: dots
    });
  }
  var button = document.querySelector('button');
  var heading = document.querySelector('[role="heading"]');
  var h1 = document.querySelector('header h1');
  var facts = {
    digest: opuFnv1a64(readback.data),
    canvas: { width: canvas.width, height: canvas.height },
    roles: roles,
    particles: particles,
    dom: {
      lang: document.documentElement.lang,
      title: document.title,
      h1: h1 ? h1.textContent : null,
      canvasLabel: canvas.getAttribute('aria-label')
    },
    styles: {
      headerDisplay: computed('header', 'display'),
      mainDisplay: computed('main', 'display'),
      canvasDisplay: computed('#fx', 'display'),
      buttonDisplay: button ? window.getComputedStyle(button).display : null,
      buttonBackground: button ? window.getComputedStyle(button).backgroundColor : null,
      headingFontSize: heading ? window.getComputedStyle(heading).fontSize : null,
      bodyBackground: computed('body', 'background-color'),
      canvasRadius: computed('#fx', 'border-radius')
    }
  };
  var meta = document.getElementById('opurom-verify');
  meta.setAttribute('data-result', encodeFacts(JSON.stringify(facts)));
  meta.setAttribute('data-ready', '1');
  // shortcut: IR event actions are not executed; callers push state changes,
  // upgrade when a runtime state machine is added.
  var live = document.getElementById('opurom-live');
  window.opuromAnnounceState = opuCreateAnnouncer(INITIAL, function (text) {
    live.textContent = text;
  });
})();
`;
}

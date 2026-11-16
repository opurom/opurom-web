/* Browser-side painter + facts collection, emitted as inline JS in index.html.
 *
 * PAGE_PAINT_SRC is a pure-function source string (no DOM): the tests eval it
 * in Node and byte-compare it against lib/cpu-reference.mjs, so the offline
 * suite on Linux CI cross-checks both implementations without a browser.
 * The recipe is the one documented in lib/contract.mjs and README.md; the code is
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
function opuPaintPixels(contract, data) {
  var index = 0;
  var span = contract.height - 1;
  for (var y = 0; y < contract.height; y += 1) {
    var t = Math.floor((y * 1024) / span);
    var row = [
      opuLerp(contract.top[0], contract.bottom[0], t),
      opuLerp(contract.top[1], contract.bottom[1], t),
      opuLerp(contract.top[2], contract.bottom[2], t)
    ];
    if (y >= contract.band.y0 && y < contract.band.y1) {
      for (var c = 0; c < 3; c += 1) {
        row[c] += Math.floor(((255 - row[c]) * contract.band.alpha) / 1024);
      }
    }
    for (var x = 0; x < contract.width; x += 1) {
      if (!opuRoundedInside(x, y, contract.width, contract.height, contract.radius)) { index += 4; continue; }
      var inset = Math.max(contract.radius - contract.borderSize, 0);
      var insideInset = opuRoundedInside(
        x - contract.borderSize,
        y - contract.borderSize,
        contract.width - 2 * contract.borderSize,
        contract.height - 2 * contract.borderSize,
        inset
      );
      var source = insideInset ? row : contract.border;
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

/* Client-side router for multi-page IR. The compiled page ships every route as
 * a <section data-route>, and each interactive node carries a JSON `data-actions`
 * list. A navigation stack drives which section is visible; `push`/`pop` move in
 * it and state mutations (`set`/`toggle`) update a shared store that re-applies
 * `{state}` text and `data-when` visibility. No IR crosses the wire: only the
 * initial state values and route names arrive as constants. */
/* Async event effects, shipped only when an event carries the markers: each
 * awaits in order, a failed or malformed fetch keeps the previous state, and a
 * string-array response replaces the list whole (assign) so For regions
 * re-render at the new row count. */
const EFFECTS_SOURCE = `
  async function runEffects(effects) {
    for (var i = 0; i < effects.length; i += 1) {
      var effect = effects[i];
      if (effect.kind === 'delay') {
        await new Promise(function (resolve) { setTimeout(resolve, effect.ms); });
      } else if (effect.kind === 'fetch') {
        try {
          var response = await fetch(effect.path);
          if (!response.ok) continue;
          if (Array.isArray(state[effect.into])) {
            var data = await response.json();
            if (Array.isArray(data) && data.every(function (item) { return typeof item === 'string'; })) {
              state[effect.into] = data;
              renderFor(effect.into);
            }
          } else {
            state[effect.into] = await response.text();
            applyText();
          }
        } catch {
          // A failed fetch keeps the previous state.
        }
      }
    }
  }

  function effectsOf(element) {
    var raw = element.closest('[data-effects]');
    if (raw === null) return [];
    try { return JSON.parse(raw.getAttribute('data-effects')) || []; } catch (e) { return []; }
  }
`;

const CLICK_PLAIN = `
  document.addEventListener('click', function (event) {
    var actionList = actionsOf(event.target);
    if (actionList.length === 0) return;
    for (var i = 0; i < actionList.length; i += 1) runAction(actionList[i]);
  });
`;

const CLICK_EFFECTS = `
  document.addEventListener('click', function (event) {
    var source = event.target.closest('[data-actions],[data-effects]');
    if (source === null) return;
    var actionList = actionsOf(event.target);
    for (var i = 0; i < actionList.length; i += 1) runAction(actionList[i]);
    var effectList = effectsOf(event.target);
    if (effectList.length > 0) runEffects(effectList);
  });
`;

/* True when any event contract carries the async/effects markers. */
function hasEventEffects(ir) {
  const marked = (node) => {
    for (const contract of Object.values(node.events)) {
      if (contract.effects !== undefined || contract.async !== undefined) return true;
    }
    return node.children.some(marked);
  };
  const trees = ir.routes !== undefined ? Object.values(ir.routes).map((route) => route.tree) : [ir.tree];
  return trees.some(marked);
}

export function multiPageRouter(ir) {
  const initial = {};
  for (const decl of ir.state) initial[decl.name] = decl.init;
  const initialRoute = ir.initialRoute;
  const withEffects = hasEventEffects(ir);
  return `(function () {
  'use strict';
  var state = ${JSON.stringify(initial)};
  // Dev client publishes the snapshot taken before the last reload here.
  Object.assign(state, window.__Opurom_STATE_RESTORE__ || {});
  var stack = [${JSON.stringify(initialRoute)}];
  var sections = document.querySelectorAll('main#app section[data-route]');

  function fmt(text, scope) {
    return String(text).replace(/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, function (all, name) {
      var bag = scope === undefined ? state : scope;
      return Object.prototype.hasOwnProperty.call(bag, name) ? String(bag[name]) : all;
    });
  }

  /* Row content formats against state plus the row's own item binding. */
  function scopeFor(element) {
    var row = element.closest('[data-for-row]');
    if (row === null) return state;
    var scope = Object.assign({}, state);
    scope[row.getAttribute('data-for-item')] = row.getAttribute('data-for-value');
    return scope;
  }

  function applyGuards() {
    var guarded = document.querySelectorAll('[data-when]');
    for (var i = 0; i < guarded.length; i += 1) {
      var visible = state[guarded[i].getAttribute('data-when')] === true;
      guarded[i].hidden = !visible;
    }
  }

  function applyText() {
    var nodes = document.querySelectorAll('[data-node-id]');
    for (var i = 0; i < nodes.length; i += 1) {
      // data-label keeps the raw {state} template; aria-label and baked text
      // hold the compile-time values, so re-render from the template.
      var raw = nodes[i].getAttribute('data-label');
      if (raw === null) continue;
      var rendered = fmt(raw, scopeFor(nodes[i]));
      if (nodes[i].getAttribute('aria-label') === null) nodes[i].textContent = rendered;
      else nodes[i].setAttribute('aria-label', rendered);
    }
  }

  function routeTo() {
    var current = stack[stack.length - 1];
    for (var i = 0; i < sections.length; i += 1) {
      sections[i].hidden = sections[i].getAttribute('data-route') !== current;
    }
  }

  /* Materialize one row per list element: clone the region's <template>,
   * tag each root with the region id, and drop rows the list no longer has. */
  function renderFor(source) {
    var templates = document.querySelectorAll('template[data-for]');
    for (var t = 0; t < templates.length; t += 1) {
      var name = templates[t].getAttribute('data-for');
      if (source !== null && name !== source) continue;
      var region = templates[t].getAttribute('data-for-region');
      var item = templates[t].getAttribute('data-item');
      var stale = document.querySelectorAll('[data-for-row="' + region + '"]');
      for (var i = 0; i < stale.length; i += 1) stale[i].parentNode.removeChild(stale[i]);
      var list = state[name];
      if (!Array.isArray(list)) continue;
      var anchor = templates[t].nextSibling;
      var parent = templates[t].parentNode;
      for (var r = 0; r < list.length; r += 1) {
        var clone = templates[t].content.cloneNode(true);
        var roots = Array.prototype.slice.call(clone.childNodes);
        for (var k = 0; k < roots.length; k += 1) {
          roots[k].setAttribute('data-for-row', region);
          roots[k].setAttribute('data-for-item', item);
          roots[k].setAttribute('data-for-value', String(list[r]));
          parent.insertBefore(roots[k], anchor);
        }
      }
    }
    applyText();
  }

  function runAction(action) {
    if (!action || typeof action.op !== 'string') return;
    if (action.op === 'push') {
      stack.push(action.target);
      routeTo();
    } else if (action.op === 'pop') {
      if (stack.length > 1) stack.pop();
      routeTo();
    } else if (action.op === 'toggle') {
      state[action.target] = !state[action.target];
      applyGuards();
      applyText();
    } else if (action.op === 'set') {
      var source = action.valueFrom;
      var value = source !== undefined ? state[source] : action.value;
      state[action.target] = value;
      applyGuards();
      applyText();
    } else if (action.op === 'add') {
      state[action.target] = (state[action.target] || 0) + (action.value || 0);
      applyText();
    } else if (action.op === 'append') {
      var target = state[action.target];
      if (!Array.isArray(target)) return;
      var pushed = action.valueFrom !== undefined ? state[action.valueFrom] : action.value;
      target.push(pushed);
      renderFor(action.target);
    } else if (action.op === 'removeAt') {
      var current = state[action.target];
      var index = Number(action.value);
      // shortcut: out-of-range index is a no-op; core owns the error report.
      if (Array.isArray(current) && index >= 0 && index < current.length) {
        current.splice(index, 1);
        renderFor(action.target);
      }
    } else if (action.op === 'assign') {
      var next = action.valueFrom !== undefined ? state[action.valueFrom] : action.value;
      if (!Array.isArray(next)) return;
      state[action.target] = next.slice();
      renderFor(action.target);
    }
  }

  function actionsOf(element) {
    var raw = element.closest('[data-actions]');
    if (raw === null) return [];
    try { return JSON.parse(raw.getAttribute('data-actions')) || []; } catch (e) { return []; }
  }
${withEffects ? EFFECTS_SOURCE : ''}${withEffects ? CLICK_EFFECTS : CLICK_PLAIN}
  document.addEventListener('input', function (event) {
    var bound = event.target.closest('[data-bind]');
    if (bound === null) return;
    var name = bound.getAttribute('data-bind');
    if (!Object.prototype.hasOwnProperty.call(state, name)) return;
    state[name] = bound.value;
    applyText();
  });

  renderFor(null);
  routeTo();
  // Re-render once at boot so a restored snapshot hits the DOM.
  applyGuards();
  applyText();
})();
`;
}

/* Full inline script for the emitted page: paint the framework rules into the canvas,
 * read it back with getImageData, FNV-1a 64 digest it, then collect DOM role
 * and computed-style facts. Facts are stored base64-encoded in an attribute
 * of <meta id="opurom-verify"> so --dump-dom can round-trip them without any
 * HTML escaping ambiguity. No IR reaches the page: only compiled constants. */
export function pageScript(contract) {
  return `(function () {
  'use strict';
  var CONTRACT = ${JSON.stringify(contract)};
${PAGE_PAINT_SRC}
  var canvas = document.getElementById('fx');
  var context = canvas.getContext('2d');
  var image = context.createImageData(CONTRACT.width, CONTRACT.height);
  opuPaintPixels(CONTRACT, image.data);
  context.putImageData(image, 0, 0);
  var readback = context.getImageData(0, 0, CONTRACT.width, CONTRACT.height);

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

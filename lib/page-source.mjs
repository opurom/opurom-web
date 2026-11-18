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

/* Per-corner painter, emitted only when the contract carries corner radii.
 * Integer port of Impeller `CornerContains` (round_rect.cc:30-64), the same
 * rule as opurom-render/src/geometry.rs:125-155. */
export const PAGE_CORNERS_SRC = `
function opuCornerContains(px, py, cornerX, cornerY, dirX, dirY, radii) {
  var rx = radii.x;
  var ry = radii.y;
  if (rx === 0 || ry === 0) { return true; }
  var crx = (cornerX - px) * dirX;
  var cry = (cornerY - py) * dirY;
  var qx = rx - crx;
  var qy = ry - cry;
  if (qx <= 0 || qy <= 0) { return true; }
  var a = BigInt(qx) * BigInt(ry);
  var b = BigInt(qy) * BigInt(rx);
  var rr = BigInt(rx) * BigInt(ry);
  return a * a + b * b <= rr * rr;
}
function opuCornersInside(x, y, width, height, corners) {
  if (x < 0 || y < 0 || x >= width || y >= height) { return false; }
  return opuCornerContains(x, y, 0, 0, -1, -1, corners.topLeft)
    && opuCornerContains(x, y, width, 0, 1, -1, corners.topRight)
    && opuCornerContains(x, y, width, height, 1, 1, corners.bottomRight)
    && opuCornerContains(x, y, 0, height, -1, 1, corners.bottomLeft);
}
function opuInsetCorners(corners, amount) {
  var shrink = function (c) {
    return { x: Math.max(c.x - amount, 0), y: Math.max(c.y - amount, 0) };
  };
  return {
    topLeft: shrink(corners.topLeft),
    topRight: shrink(corners.topRight),
    bottomRight: shrink(corners.bottomRight),
    bottomLeft: shrink(corners.bottomLeft)
  };
}
`;

/* Corner-aware painter, shipped only for contracts with per-corner radii.
 * The scalar path above stays byte-identical for every other page. */
export const PAGE_CORNERS_PAINT_SRC = `
function opuPaintPixelsCorners(contract, data) {
  var index = 0;
  var span = contract.height - 1;
  var corners = contract.corners;
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
      if (!opuCornersInside(x, y, contract.width, contract.height, corners)) { index += 4; continue; }
      var inset = Math.max(contract.radius - contract.borderSize, 0);
      var insideInset = opuCornersInside(
        x - contract.borderSize,
        y - contract.borderSize,
        contract.width - 2 * contract.borderSize,
        contract.height - 2 * contract.borderSize,
        opuInsetCorners(corners, inset)
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

/* i18n v1 runtime source, injected only when the IR declares locale/messages/
 * directionality. Catalog references are resolved at compile time; the runtime
 * pass keeps the literal-brace and state-reference half of the shared rule. */
export const I18N_FMT = `
  function fmt(text, scope) {
    var input = String(text);
    var out = '';
    for (var i = 0; i < input.length;) {
      var pair = input.slice(i, i + 2);
      if (pair === '{{' || pair === '}}') { out += pair[0]; i += 2; continue; }
      if (pair === '{@') {
        var end = input.indexOf('}', i + 2);
        if (end !== -1) { out += input.slice(i + 2, end); i = end + 1; continue; }
      }
      var match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(input.slice(i));
      if (match !== null) {
        var bag = scope === undefined ? state : scope;
        out += Object.prototype.hasOwnProperty.call(bag, match[1]) ? String(bag[match[1]]) : match[0];
        i += match[0].length;
        continue;
      }
      out += input[i];
      i += 1;
    }
    return out;
  }
`;

/* Pure RTL mirror rules (PLATFORM_DELIVERY §8): row/grid child order reverses,
 * start/end offsets and text alignment swap, vertical stacks stay untouched,
 * and a11y traversal follows visual order. Injected into the paint path only
 * for rtl programs; the gradient pixels themselves carry no layout. */
export const RTL_MIRROR_SRC = `
function opuMirrorAlign(value) {
  return value === 'start' ? 'end' : value === 'end' ? 'start' : value;
}
function opuMirrorTextAlign(value) { return opuMirrorAlign(value); }
function opuRowOrder(nodes, kind) {
  return kind === 'Row' || kind === 'Grid' ? nodes.slice().reverse() : nodes.slice();
}
function opuVisualOrder(nodes) {
  var byParent = {};
  for (var i = 0; i < nodes.length; i += 1) {
    var parent = nodes[i].parent === undefined || nodes[i].parent === null ? '' : String(nodes[i].parent);
    if (byParent[parent] === undefined) byParent[parent] = [];
    byParent[parent].push(nodes[i]);
  }
  var out = [];
  function walk(parent, flipped) {
    var list = (byParent[parent] || []).slice();
    if (flipped) list.reverse();
    for (var j = 0; j < list.length; j += 1) {
      out.push(list[j].id);
      walk(String(list[j].id), list[j].kind === 'Row' || list[j].kind === 'Grid');
    }
  }
  walk('', false);
  return out;
}
`;

export function multiPageRouter(ir) {
  const initial = {};
  for (const decl of ir.state) initial[decl.name] = decl.init;
  const initialRoute = ir.initialRoute;
  const withEffects = hasEventEffects(ir);
  const withI18n = ir.locale !== undefined || ir.messages !== undefined || ir.directionality !== undefined;
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
${withI18n ? I18N_FMT : ''}
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
    } else if (action.op === 'add' || action.op === 'sub' || action.op === 'mul' || action.op === 'div') {
      var delta = action.valueFrom !== undefined ? state[action.valueFrom] : action.value;
      delta = Number(delta) || 0;
      if (action.op === 'add') state[action.target] = (state[action.target] || 0) + delta;
      if (action.op === 'sub') state[action.target] = (state[action.target] || 0) - delta;
      if (action.op === 'mul') state[action.target] = (state[action.target] || 0) * delta;
      if (action.op === 'div' && delta !== 0) state[action.target] = Math.trunc((state[action.target] || 0) / delta);
      applyText();
    } else if (action.op === 'backspace') {
      var current = state[action.target];
      if (typeof current === 'string') state[action.target] = current.slice(0, -1);
      if (typeof current === 'number') state[action.target] = Math.trunc(current / 10);
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

  /* Host-side node-state map, mirroring opurom-render's read-only
   * (hit node id, state) slot: a pointer or focus event names the inner
   * node, data-ink-host resolves the Material ink host that owns the paint,
   * and the DOM attribute mirrors the state for CSS. The map is exported on
   * window.__OPUROM_NODE_STATES__ for the next render call. */
  var nodeStates = {};
  function hostElementOf(element) {
    var host = element.closest('[data-ink-host]');
    if (host === null) return null;
    if (!host.hasAttribute('data-node-id')) host = host.closest('[data-node-id]') || host;
    return host;
  }
  function applyNodeState(element, stateName) {
    var host = hostElementOf(element);
    if (host === null) return;
    var id = Number(host.getAttribute('data-node-id'));
    if (!Number.isFinite(id)) return;
    nodeStates[id] = stateName;
    host.setAttribute('data-state', stateName);
    window.__OPUROM_NODE_STATES__ = nodeStates;
  }
  function clearNodeState(element, stateName) {
    var host = hostElementOf(element);
    if (host === null) return;
    var id = Number(host.getAttribute('data-node-id'));
    if (!Number.isFinite(id)) return;
    if (nodeStates[id] !== stateName) return;
    delete nodeStates[id];
    host.removeAttribute('data-state');
    window.__OPUROM_NODE_STATES__ = nodeStates;
  }
  document.addEventListener('pointerdown', function (event) { applyNodeState(event.target, 'active'); });
  document.addEventListener('pointerup', function (event) { clearNodeState(event.target, 'active'); });
  document.addEventListener('pointercancel', function (event) { clearNodeState(event.target, 'active'); });
  document.addEventListener('pointerover', function (event) { applyNodeState(event.target, 'hover'); });
  document.addEventListener('pointerout', function (event) { clearNodeState(event.target, 'hover'); });
  document.addEventListener('focusin', function (event) { applyNodeState(event.target, 'focus'); });
  document.addEventListener('focusout', function (event) { clearNodeState(event.target, 'focus'); });
  window.__OPUROM_NODE_STATES__ = nodeStates;
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
const ROLES_PLAIN = `  var roles = [];
  var nodes = document.querySelectorAll('[data-node-id]');
  for (var i = 0; i < nodes.length; i += 1) {
    roles.push({
      id: Number(nodes[i].getAttribute('data-node-id')),
      tag: nodes[i].tagName.toLowerCase(),
      role: nodes[i].getAttribute('role')
    });
  }
`;
const VISUAL_ROLES = `  var roles = [];
  function collectVisual(element) {
    var children = Array.prototype.slice.call(element.children);
    var cls = typeof element.className === 'string' ? element.className : '';
    var kind = /\brow\b/.test(cls) ? 'Row' : /\bgrid\b/.test(cls) ? 'Grid' : 'Column';
    children = opuRowOrder(children, kind);
    for (var i = 0; i < children.length; i += 1) {
      if (!children[i].hasAttribute('data-node-id')) continue;
      roles.push({
        id: Number(children[i].getAttribute('data-node-id')),
        tag: children[i].tagName.toLowerCase(),
        role: children[i].getAttribute('role')
      });
      collectVisual(children[i]);
    }
  }
  collectVisual(document.getElementById('app'));
`;

export function pageScript(contract, ir) {
  const rtl = ir !== undefined && ir.directionality === 'rtl';
  return `(function () {
  'use strict';
  var CONTRACT = ${JSON.stringify(contract)};
${PAGE_PAINT_SRC}${contract.corners === undefined ? '' : PAGE_CORNERS_SRC + PAGE_CORNERS_PAINT_SRC}${rtl ? RTL_MIRROR_SRC : ''}
  var canvas = document.getElementById('fx');
  var context = canvas.getContext('2d');
  var image = context.createImageData(CONTRACT.width, CONTRACT.height);
  ${contract.corners === undefined ? 'opuPaintPixels(CONTRACT, image.data);' : 'opuPaintPixelsCorners(CONTRACT, image.data);'}
  context.putImageData(image, 0, 0);
  var readback = context.getImageData(0, 0, CONTRACT.width, CONTRACT.height);

  function computed(selector, property) {
    var element = document.querySelector(selector);
    if (!element) return null;
    return window.getComputedStyle(element).getPropertyValue(property);
  }

${rtl ? VISUAL_ROLES : ROLES_PLAIN}  var button = document.querySelector('button');
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

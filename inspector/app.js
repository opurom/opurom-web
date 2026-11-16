/* Inspector page wiring: pull the three channels, subscribe to the dev server
 * SSE stream, and re-render. All rendering lives in views.js so Node tests can
 * assert the markup without a DOM; this module only glues transport to view. */

import { renderInspector } from './views.js';

/* The dev server's existing SSE stream (same one the hot reload client uses)
 * gains the frame|memory|network event frames. Pull endpoints are the
 * fallback; a hot reload resets the rings and republishes baselines, so every
 * reconnect re-pulls. */
const SSE_URL = '/__opurom/events';
const PULL_URLS = {
  frames: '/api/inspect/frames',
  memory: '/api/inspect/memory',
  network: '/api/inspect/network',
};

const channels = {
  frames: { availability: 'absent', reason: 'not pulled yet', frames: [], report: null },
  memory: { availability: 'absent', reason: 'not pulled yet', memory: null },
  network: { availability: 'absent', reason: 'not pulled yet' },
};

function render() {
  document.getElementById('inspector').innerHTML = renderInspector(channels);
}

/* Every SSE frame carries a full channel payload (the relay owns the rings),
 * so the handler mirrors pull: overwrite the channel wholesale. */
function apply(name, data) {
  try {
    channels[name] = { ...channels[name], ...JSON.parse(data) };
    render();
  } catch {
    // A malformed frame keeps the previous channel state.
  }
}

async function pull(name) {
  try {
    const response = await fetch(`${PULL_URLS[name]}?since=0`);
    const payload = await response.json();
    channels[name] = { ...channels[name], ...payload };
    render();
  } catch {
    // Keep the degraded badge; the next reconnect re-pulls.
  }
}

function subscribe() {
  const stream = new EventSource(SSE_URL);
  stream.addEventListener('frame', (event) => apply('frames', event.data));
  stream.addEventListener('memory', (event) => apply('memory', event.data));
  stream.addEventListener('network', (event) => apply('network', event.data));
  stream.onopen = () => {
    for (const name of Object.keys(PULL_URLS)) pull(name);
  };
  // EventSource reconnects on its own; each reconnect re-pulls via onopen.
}

for (const name of Object.keys(PULL_URLS)) pull(name);
subscribe();

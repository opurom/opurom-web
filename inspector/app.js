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

const RING_CAP = 200;

const channels = {
  frames: { availability: 'absent', reason: 'not pulled yet', frames: [], report: null },
  memory: { availability: 'absent', reason: 'not pulled yet', memory: null },
  network: { availability: 'absent', reason: 'not pulled yet', records: [] },
};

function render() {
  document.getElementById('inspector').innerHTML = renderInspector(channels);
}

function push(name, key, record) {
  const list = channels[name][key];
  list.push(record);
  if (list.length > RING_CAP) list.splice(0, list.length - RING_CAP);
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
  stream.addEventListener('frame', (event) => {
    push('frames', 'frames', JSON.parse(event.data));
    render();
  });
  stream.addEventListener('memory', (event) => {
    channels.memory = { ...channels.memory, memory: JSON.parse(event.data) };
    render();
  });
  stream.addEventListener('network', (event) => {
    push('network', 'records', JSON.parse(event.data));
    render();
  });
  stream.onopen = () => {
    for (const name of Object.keys(PULL_URLS)) pull(name);
  };
  // EventSource reconnects on its own; each reconnect re-pulls via onopen.
}

for (const name of Object.keys(PULL_URLS)) pull(name);
subscribe();

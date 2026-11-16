/* Pure render functions for the inspector page: fixture-driven and testable
 * in Node without a DOM. Record shapes follow INSPECTOR_DATA_PLANE.md —
 * fields are never invented, and absent data renders as a degraded badge or
 * an em dash, never as a fabricated 0. This module is browser-shippable and
 * must not reference Node builtins. */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/* Absent data renders as an em dash; a null field is never printed as 0. */
function field(value) {
  return value === null || value === undefined ? '&mdash;' : escapeHtml(value);
}

function badge(channel) {
  const availability = channel.availability === 'full' || channel.availability === 'partial'
    ? channel.availability
    : 'absent';
  const reason = typeof channel.reason === 'string' && channel.reason !== ''
    ? `<span class="reason">${escapeHtml(channel.reason)}</span>`
    : '';
  return `<span class="badge badge-${availability}" data-availability="${availability}">${availability}</span>${reason}`;
}

function channel(title, id, channel_, body) {
  return `<section class="channel" id="${id}"><h2>${title} ${badge(channel_)}</h2>${body}</section>`;
}

function phase(phaseMs) {
  if (phaseMs === null || phaseMs === undefined) return '&mdash;';
  return `layout ${field(phaseMs.layout)} / raster ${field(phaseMs.raster)}`;
}

export function renderFrames(frames) {
  let body;
  if (frames.availability === 'absent') {
    body = `<p class="empty">${escapeHtml(frames.reason ?? '')}</p>`;
  } else {
    const report = frames.report ?? {};
    const rows = (frames.frames ?? []).map((frame) =>
      `<tr><td>${field(frame.seq)}</td><td>${field(frame.startMs)}</td><td>${field(frame.frameMs)}</td>` +
      `<td>${field(frame.budgetMs)}</td><td>${field(frame.tier)}</td><td>${field(frame.nodes)}</td>` +
      `<td>${field(frame.effects)}</td><td>${phase(frame.phaseMs)}</td></tr>`).join('');
    // fpsX10 arrives as tenths of a frame per second; only the display is scaled.
    const fps = report.fpsX10 === null || report.fpsX10 === undefined
      ? '&mdash;'
      : escapeHtml((report.fpsX10 / 10).toFixed(1));
    body =
      `<div class="metrics">` +
      `<span class="metric">p50 <b>${field(report.p50Ms)}</b> ms</span>` +
      `<span class="metric">p95 <b>${field(report.p95Ms)}</b> ms</span>` +
      `<span class="metric">fps <b>${fps}</b></span>` +
      `<span class="metric">tier <b>${field(report.tier)}</b></span>` +
      `</div>` +
      `<table><thead><tr><th>seq</th><th>startMs</th><th>frameMs</th><th>budgetMs</th>` +
      `<th>tier</th><th>nodes</th><th>effects</th><th>phaseMs</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }
  return channel('Frames', 'frames', frames, body);
}

export function renderMemory(memory) {
  let body;
  if (memory.availability === 'absent') {
    body = `<p class="empty">${escapeHtml(memory.reason ?? '')}</p>`;
  } else {
    const snapshot = memory.memory ?? {};
    const cache = snapshot.cache ?? {};
    const images = snapshot.images;
    const rows = (snapshot.history ?? []).map((entry) =>
      `<tr><td>${field(entry.version)}</td><td>${field(entry.totalBytes)}</td></tr>`).join('');
    body =
      `<div class="metrics">` +
      `<span class="metric">cache <b>${field(cache.usedBytes)}</b>/${field(cache.budget)} B</span>` +
      `<span class="metric">state <b>${field(snapshot.stateBytes)}</b> B</span>` +
      `<span class="metric">layers <b>${field(snapshot.layersBytes)}</b> B</span>` +
      `<span class="metric">images <b>${images === null || images === undefined ? '&mdash;' : field(images.bytes)}</b> B</span>` +
      `</div>` +
      `<table><thead><tr><th>history version</th><th>totalBytes</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }
  return channel('Memory', 'memory', memory, body);
}

export function renderNetwork(network) {
  let body;
  if (network.availability === 'absent') {
    body = `<p class="empty">${escapeHtml(network.reason ?? '')}</p>`;
  } else {
    const rows = (network.records ?? []).map((record) =>
      `<tr><td>${field(record.id)}</td><td>${field(record.method)}</td><td>${field(record.url)}</td>` +
      `<td>${field(record.status)}</td><td>${field(record.requestBytes)}</td>` +
      `<td>${field(record.responseBytes)}</td><td>${field(record.startMs)}</td>` +
      `<td>${field(record.durationMs)}</td></tr>`).join('');
    body =
      `<table><thead><tr><th>id</th><th>method</th><th>url</th><th>status</th>` +
      `<th>requestBytes</th><th>responseBytes</th><th>startMs</th><th>durationMs</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }
  return channel('Network', 'network', network, body);
}

export function renderInspector(channels) {
  return [
    renderFrames(channels.frames ?? {}),
    renderMemory(channels.memory ?? {}),
    renderNetwork(channels.network ?? {}),
  ].join('');
}

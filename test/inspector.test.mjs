/* Inspector bundle: pure render functions produce the three channel views from
 * fixture records shaped strictly by INSPECTOR_DATA_PLANE.md, availability
 * badges degrade without fabricating 0, and the assembled bundle stays pure
 * browser JS (no Node builtin references). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { findNodeReference, assembleInspector } from '../lib/inspector.mjs';
import { renderFrames, renderInspector, renderMemory, renderNetwork } from '../inspector/views.js';
import { runCli, tmpDir, cleanup, ROOT } from '../test-helpers/helpers.mjs';
import path from 'node:path';

const framesChannel = {
  availability: 'full',
  reason: '',
  frames: [
    { seq: 0, startMs: 0, frameMs: 16, budgetMs: 16, phaseMs: { layout: 3, raster: 9 }, tier: 'full', nodes: 42, effects: 3 },
    { seq: 1, startMs: 16, frameMs: 33, budgetMs: 16, phaseMs: null, tier: 'reduced', nodes: 42, effects: 0 },
  ],
  report: { p50Ms: 16, p95Ms: 33, fpsX10: 303, tier: 'reduced' },
  version: 1,
};

const memoryChannel = {
  availability: 'partial',
  reason: 'dev-server-computed state and layer bytes',
  version: 2,
  memory: {
    cache: { budget: 1024, usedBytes: 512, entries: 3 },
    stateBytes: 128,
    layersBytes: 256,
    images: null,
    history: [{ version: 0, totalBytes: 384 }, { version: 1, totalBytes: 384 }],
  },
};

const networkChannel = {
  availability: 'full',
  reason: '',
  version: 3,
  records: [
    { id: 0, method: 'GET', url: '/api/items', status: 200, requestBytes: 0, responseBytes: 21, startMs: 5, durationMs: 12 },
  ],
};

test('frames view renders the timeline list and the report metrics', () => {
  const html = renderFrames(framesChannel);
  assert.ok(html.includes('p50 <b>16</b> ms'));
  assert.ok(html.includes('p95 <b>33</b> ms'));
  assert.ok(html.includes('fps <b>30.3</b>'), 'fpsX10 displays scaled');
  assert.ok(html.includes('tier <b>reduced</b>'));
  assert.ok(html.includes('<td>0</td>'), 'seq 0 row present');
  assert.ok(html.includes('layout 3 / raster 9'), 'phase split renders');
  assert.match(html, /<td>&mdash;<\/td>/, 'null phaseMs never prints as 0');
  assert.match(html, /data-availability="full"/);
});

test('memory view renders the snapshot with absent data as dashes', () => {
  const html = renderMemory(memoryChannel);
  assert.ok(html.includes('512</b>/1024 B'), 'cache used over budget');
  assert.ok(html.includes('state <b>128</b> B'));
  assert.ok(html.includes('layers <b>256</b> B'));
  assert.match(html, /images <b>&mdash;<\/b>/, 'null images is a dash, never 0');
  assert.match(html, /<td>1<\/td><td>384<\/td>/, 'history row renders');
  assert.match(html, /data-availability="partial"/);
  assert.ok(html.includes('dev-server-computed state and layer bytes'), 'partial reason shown');
});

test('network view renders the record table', () => {
  const html = renderNetwork(networkChannel);
  assert.ok(html.includes('<td>GET</td>'));
  assert.ok(html.includes('<td>/api/items</td>'));
  assert.ok(html.includes('<td>200</td>'));
  assert.ok(html.includes('<td>21</td>'));
  assert.ok(html.includes('<td>12</td>'), 'durationMs renders');
});

test('an absent channel renders only the degraded badge and its reason', () => {
  const html = renderFrames({ availability: 'absent', reason: 'no frame loop on this host' });
  assert.match(html, /badge-absent[^>]*>absent</);
  assert.ok(html.includes('no frame loop on this host'));
  assert.ok(!html.includes('<table'), 'absent channel fabricates no data table');
  assert.ok(!html.includes('p50'), 'absent channel fabricates no metrics');
  assert.ok(!html.includes('>0<'), 'absent channel never fabricates 0');
});

test('the channel version renders so a hot-reload ring reset is visible', () => {
  assert.match(renderFrames(framesChannel), /ver <b>1<\/b>/);
  assert.match(renderMemory(memoryChannel), /ver <b>2<\/b>/);
  assert.match(renderNetwork(networkChannel), /ver <b>3<\/b>/);
  const absent = renderNetwork({ availability: 'absent', reason: 'no request proxy', version: 4 });
  assert.match(absent, /ver <b>4<\/b>/, 'version shows even on an absent channel');
  const bare = renderFrames({ availability: 'full', reason: '' });
  assert.ok(!bare.includes('ver <b>'), 'no version field means no version claim');
});

test('record values are HTML-escaped', () => {  const html = renderNetwork({
    availability: 'full',
    reason: '',
    records: [{ id: 0, method: 'GET', url: '/x?next=<script>', status: 200, requestBytes: 0, responseBytes: 0, startMs: 0, durationMs: 1 }],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderInspector lays out all three channels in order', () => {
  const html = renderInspector({ frames: framesChannel, memory: memoryChannel, network: networkChannel });
  const order = ['id="frames"', 'id="memory"', 'id="network"'].map((marker) => html.indexOf(marker));
  assert.ok(order.every((at) => at >= 0), 'all three sections render');
  assert.ok(order[0] < order[1] && order[1] < order[2], 'channel order is frames, memory, network');
});

test('shipped sources contain no Node builtin references', () => {
  assert.equal(findNodeReference('const fs = require("node:fs");'), 'require(');
  assert.equal(findNodeReference("import fs from 'node:fs';"), "from 'node:");
  for (const name of ['index.html', 'app.js', 'views.js', 'style.css']) {
    const text = fs.readFileSync(path.join(ROOT, 'inspector', name), 'utf8');
    assert.equal(findNodeReference(text), null, `${name} must be pure browser JS`);
  }
});

test('CLI inspector assembles the bundle into out-dir', () => {
  const dir = tmpDir();
  try {
    const run = runCli(['inspector', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^inspector: .+ \(4 files\)$/m);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['app.js', 'index.html', 'style.css', 'views.js']);
    const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(page, /<script type="module" src="app\.js">/);
    assert.match(page, /<link rel="stylesheet" href="style\.css">/);
    for (const name of ['app.js', 'views.js', 'style.css']) {
      assert.equal(
        findNodeReference(fs.readFileSync(path.join(dir, name), 'utf8')),
        null,
        `${name} ships without Node references`,
      );
    }
  } finally {
    cleanup(dir);
  }
});

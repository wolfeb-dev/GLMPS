import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedShipGraph } from '../lib/observability/graph-ship-seed.js';

const BUNDLED_AT = '2026-10-26T00:00:00.000Z';

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fixture({ record = true, sha = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ship-seed-'));
  const bundleDir = path.join(tmp, 'kernel');
  const stateDir = path.join(tmp, 'state');
  const graph = JSON.stringify({ nodes: [{ id: 'k::a' }], links: [] });
  put(path.join(bundleDir, 'graphs/ship/graph.json'), graph);
  put(path.join(bundleDir, 'graphs/ship/ship-manifest.json'), JSON.stringify({ builtAt: BUNDLED_AT, nodes: 1 }));
  const shipGraph = { builtAt: BUNDLED_AT, sha256: sha ?? crypto.createHash('sha256').update(graph).digest('hex') };
  put(path.join(bundleDir, 'bundle.json'), JSON.stringify({ commit: 'abc', ...(record ? { shipGraph } : {}) }));
  return { tmp, bundleDir, stateDir, graph, dst: path.join(stateDir, 'graphs/ship') };
}

const local = (f, builtAt, graph = '{"nodes":[],"links":[]}') => {
  put(path.join(f.dst, 'graph.json'), graph);
  put(path.join(f.dst, 'ship-manifest.json'), builtAt === null ? 'not json' : JSON.stringify({ builtAt }));
};

test('seeds an absent ship graph from the bundle, graph and manifest both, with no staging dir left behind', () => {
  const f = fixture();
  try {
    assert.deepEqual(seedShipGraph(f), { seeded: true, reason: 'absent' });
    assert.equal(fs.readFileSync(path.join(f.dst, 'graph.json'), 'utf8'), f.graph);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dst, 'ship-manifest.json'), 'utf8')).builtAt, BUNDLED_AT);
    assert.deepEqual(fs.readdirSync(f.dst).sort(), ['graph.json', 'ship-manifest.json']);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('replaces a local ship graph built before the bundled one', () => {
  const f = fixture();
  try {
    local(f, '2026-10-01T00:00:00.000Z');
    assert.deepEqual(seedShipGraph(f), { seeded: true, reason: 'older' });
    assert.equal(fs.readFileSync(path.join(f.dst, 'graph.json'), 'utf8'), f.graph);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('replaces a local ship graph whose manifest is unreadable', () => {
  const f = fixture();
  try {
    local(f, null);
    assert.equal(seedShipGraph(f).seeded, true);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('leaves a local ship graph built at or after the bundled one alone (the app refreshed it)', () => {
  for (const builtAt of [BUNDLED_AT, '2026-10-27T00:00:00.000Z']) {
    const f = fixture();
    try {
      local(f, builtAt, 'LOCAL');
      assert.deepEqual(seedShipGraph(f), { seeded: false, reason: 'local ship graph is current' });
      assert.equal(fs.readFileSync(path.join(f.dst, 'graph.json'), 'utf8'), 'LOCAL');
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('a kernel with no bundle.json ship graph record (a source checkout) never seeds', () => {
  const f = fixture({ record: false });
  try {
    assert.deepEqual(seedShipGraph(f), { seeded: false, reason: 'no bundled ship graph' });
    assert.equal(fs.existsSync(f.dst), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('refuses a bundled graph that does not match its bundle.json checksum', () => {
  const f = fixture({ sha: '0'.repeat(64) });
  try {
    assert.deepEqual(seedShipGraph(f), { seeded: false, reason: 'bundled ship graph fails its bundle.json checksum' });
    assert.equal(fs.existsSync(path.join(f.dst, 'graph.json')), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a bundle.json record with the graph files missing reports it instead of throwing', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.bundleDir, 'graphs'), { recursive: true });
    assert.deepEqual(seedShipGraph(f), { seeded: false, reason: 'bundled ship graph is missing' });
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

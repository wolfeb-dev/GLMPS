import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphFingerprint, createGraphFingerprintReader, GRAPH_FINGERPRINT_PREFIX } from '../lib/observability/graph-fingerprint.js';

const graph = () => ({
  built_at_commit: 'abc',
  nodes: [
    { id: 'a', label: 'A', source_file: 'server/a.js', source_location: 'L1', community: 1, confidence_score: 0.5 },
    { id: 'b', label: 'B', source_file: 'server/b.js', source_location: 'L2', community: 2 },
  ],
  links: [{ source: 'a', target: 'b', relation: 'calls', confidence_score: 0.9, weight: 1 }],
});

test('fingerprint carries the version prefix and is stable for the same graph', () => {
  const fp = graphFingerprint(graph());
  assert.ok(fp.startsWith(GRAPH_FINGERPRINT_PREFIX));
  assert.equal(GRAPH_FINGERPRINT_PREFIX, 'g1:');
  assert.equal(graphFingerprint(graph()), fp);
});

test('node and link order does not change the fingerprint', () => {
  const g = graph();
  g.nodes.reverse();
  g.links.push({ source: 'b', target: 'a' });
  const h = graph();
  h.links.unshift({ source: 'b', target: 'a' });
  assert.equal(graphFingerprint(g), graphFingerprint(h));
});

test('a change to a field the wiki reads changes the fingerprint', () => {
  const base = graphFingerprint(graph());
  for (const mutate of [
    (g) => { g.nodes[0].label = 'A2'; },
    (g) => { g.nodes[0].id = 'a2'; },
    (g) => { g.nodes[1].source_file = 'server/c.js'; },
    (g) => { g.nodes[1].source_location = 'L9'; },
    (g) => { g.links[0].target = 'a'; },
    (g) => { g.nodes.push({ id: 'c', label: 'C', source_file: 'x.js' }); },
    (g) => { g.links.pop(); },
  ]) {
    const g = graph();
    mutate(g);
    assert.notEqual(graphFingerprint(g), base);
  }
});

test('a change to a field the wiki does not read leaves the fingerprint alone', () => {
  const base = graphFingerprint(graph());
  const g = graph();
  g.nodes[0].community = 99;
  g.nodes[0].confidence_score = 0.1;
  g.links[0].relation = 'imports';
  g.links[0].weight = 7;
  g.built_at_commit = 'def';
  g.graph = { graphify_version: '9.9.9' };
  assert.equal(graphFingerprint(g), base);
});

test('field boundaries are unambiguous: moving text between fields changes the fingerprint', () => {
  const a = { nodes: [{ id: 'ab', label: 'c' }], links: [] };
  const b = { nodes: [{ id: 'a', label: 'bc' }], links: [] };
  assert.notEqual(graphFingerprint(a), graphFingerprint(b));
});

test('a graph with no node or link arrays still fingerprints, and a non-object is null', () => {
  assert.ok(graphFingerprint({}).startsWith('g1:'));
  assert.equal(graphFingerprint(null), null);
  assert.equal(graphFingerprint('x'), null);
});

const norm = (p) => p.replaceAll(String.fromCharCode(92), '/');

test('the cached reader re-parses a graph only when its mtime or size changed, and reads a missing or corrupt graph as null', async () => {
  const files = new Map([['/r/graphify-out/graph.json', { body: JSON.stringify(graph()), mtimeMs: 1 }]]);
  let reads = 0;
  const read = createGraphFingerprintReader({
    stat: async (p) => { const f = files.get(norm(p)); if (!f) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return { mtimeMs: f.mtimeMs, size: f.body.length }; },
    readFile: async (p) => { reads += 1; return files.get(norm(p)).body; },
  });
  const first = await read('/r');
  assert.equal(first, graphFingerprint(graph()));
  assert.equal(await read('/r'), first);
  assert.equal(reads, 1, 'second read is a cache hit');
  const g = graph(); g.nodes[0].label = 'A-renamed';
  files.set('/r/graphify-out/graph.json', { body: JSON.stringify(g), mtimeMs: 2 });
  assert.equal(await read('/r'), graphFingerprint(g));
  assert.equal(reads, 2);
  assert.equal(await read('/missing'), null);
  files.set('/bad/graphify-out/graph.json', { body: '{ not json', mtimeMs: 1 });
  assert.equal(await read('/bad'), null);
});

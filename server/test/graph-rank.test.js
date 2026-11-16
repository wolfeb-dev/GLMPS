import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRank, identifierTokens, seedsFromText, rankGraph, focusFromEvents } from '../lib/observability/graph-rank.js';

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('scores sum to 1 and an empty graph ranks nothing', () => {
  assert.equal(pageRank([], []).size, 0);
  const r = pageRank([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
  assert.ok(near(sum(r), 1));
});

test('a node pointed at by an important node outranks one pointed at by many unimportant ones', () => {
  // hub is called by 6 callers and calls core; leaf is called by 3 isolated stubs.
  // By degree leaf (3) and core (1) differ the other way round.
  const nodes = [{ id: 'hub' }, { id: 'core' }, { id: 'leaf' }];
  const links = [{ source: 'hub', target: 'core' }];
  for (let i = 0; i < 6; i++) { nodes.push({ id: `c${i}` }); links.push({ source: `c${i}`, target: 'hub' }); }
  for (let i = 0; i < 3; i++) { nodes.push({ id: `s${i}` }); links.push({ source: `s${i}`, target: 'leaf' }); }
  const r = pageRank(nodes, links);
  assert.ok(r.get('core') > r.get('leaf'), `core ${r.get('core')} vs leaf ${r.get('leaf')}`);
});

test('personalization moves rank toward the seeded node', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const links = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }];
  const plain = pageRank(nodes, links);
  const seeded = pageRank(nodes, links, { personalization: new Map([['c', 1]]) });
  assert.ok(seeded.get('d') > plain.get('d'));
  assert.ok(seeded.get('b') < plain.get('b'));
  assert.ok(near(sum(seeded), 1));
});

test('identifierTokens keeps identifier-like words and splits paths', () => {
  const t = identifierTokens('fix computeGraphStatus() in server/lib/graph-status.js, the a b');
  assert.ok(t.includes('computegraphstatus'));
  assert.ok(t.includes('graph-status.js'));
  assert.ok(!t.includes('the'));
});

test('seedsFromText matches symbol labels and file stems, and drops ambiguous tokens', () => {
  const nodes = [
    { id: 'f', label: 'graph-status.js' },
    { id: 's', label: 'computeGraphStatus()' },
    { id: 'o', label: 'other()' },
  ];
  for (let i = 0; i < 30; i++) nodes.push({ id: `i${i}`, label: 'index.js' });
  const seeds = seedsFromText(nodes, 'graph-status computeGraphStatus index');
  assert.deepEqual([...seeds.keys()].sort(), ['f', 's']);
});

test('plain words do not seed; identifier-shaped names do', () => {
  const nodes = [{ id: 'p', label: 'plan()' }, { id: 'g', label: 'graphShape()' }];
  assert.equal(seedsFromText(nodes, 'the plan is fine').size, 0);
  assert.deepEqual([...seedsFromText(nodes, 'look at graphShape').keys()], ['g']);
});

test('rankGraph is undirected: without focus it follows degree order, with focus it moves to the named node', () => {
  const nodes = [{ id: 'hub', label: 'hubFn()' }, { id: 'a', label: 'alphaFn()' }, { id: 'b', label: 'betaFn()' }, { id: 'c', label: 'gammaFn()' }];
  const links = [{ source: 'a', target: 'hub' }, { source: 'b', target: 'hub' }, { source: 'c', target: 'hub' }];
  const { rank, seeds } = rankGraph(nodes, links);
  assert.equal(seeds.size, 0);
  assert.ok(rank.get('hub') > rank.get('a'));
  const focused = rankGraph(nodes, links, { focus: 'fix alphaFn please' });
  assert.equal(focused.seeds.size, 1);
  assert.ok(focused.rank.get('a') > focused.rank.get('b'));
});

test('focusFromEvents keeps prompts and touched paths, normalizing backslashes', () => {
  const f = focusFromEvents([
    { kind: 'prompt', label: 'fix graphShape' },
    { kind: 'tool', tool: 'Edit', path: 'D:\\repo\\server\\graph-status.js', label: 'Edit' },
    { kind: 'tool', tool: 'Bash', label: 'npm test' },
  ]);
  assert.match(f, /fix graphShape/);
  assert.match(f, /server\/graph-status\.js/);
  assert.ok(!/npm test/.test(f));
});

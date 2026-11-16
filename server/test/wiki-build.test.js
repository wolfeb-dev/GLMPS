// server/test/wiki-build.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections, groupKeyForDirs } from '../lib/observability/wiki-build.js';

// The fixtures are tiny; the default minFiles (5) is proved in its own tests below.
const build = (g, o = {}) => buildSections(g, { minFiles: 1, ...o });

// Sections group by the first MEANINGFUL directory segment, not by graphify
// community id. So server/lib/observability/* -> "observability" and
// web/governance/* -> "governance", regardless of community numbers.
// s1/w1 are hubs (higher degree); s1<->w1 links the two subsystems.
function makeGraphTwo() {
  return {
    built_at_commit: 'abc1234',
    nodes: [
      // hub path sorts LAST alphabetically ('zzz') despite highest degree, so a
      // files-sort bug (sorting by path not degree) is caught, not masked.
      { id: 's1', label: 'S One', community: 0, source_file: 'server/lib/observability/zzz-hub.js', source_location: 'L1' },
      { id: 's2', label: 'S Two', community: 0, source_file: 'server/lib/observability/two.js', source_location: 'L2' },
      { id: 's3', label: 'S Three', community: 5, source_file: 'server/lib/observability/three.js', source_location: 'L3' },
      { id: 'w1', label: 'W One', community: 1, source_file: 'web/governance/app.js', source_location: 'L1' },
      { id: 'w2', label: 'W Two', community: 1, source_file: 'web/governance/styles.js', source_location: 'L2' },
      { id: 'w3', label: 'W Three', community: 9, source_file: 'web/governance/index.js', source_location: 'L3' },
    ],
    links: [
      { source: 's1', target: 's2' },
      { source: 's1', target: 's3' },
      { source: 's1', target: 'w1' }, // cross-subsystem
      { source: 'w1', target: 'w2' },
      { source: 'w1', target: 'w3' },
    ],
  };
}

// GRAPH_TWO plus a tiny third subsystem ('orchestration', 1 file), cross-linked.
function makeGraphThree() {
  const g = makeGraphTwo();
  g.nodes.push({ id: 'o1', label: 'O One', community: 2, source_file: 'server/lib/orchestration/notes.js', source_location: 'L1' });
  g.links.push({ source: 's1', target: 'o1' });
  return g;
}

// Two subsystem keys that Title-case identically ('foo-bar' and 'foo_bar' ->
// 'Foo Bar'), forcing a slug collision.
function makeGraphCollide() {
  return {
    built_at_commit: 'def5678',
    nodes: [
      { id: 'x1', label: 'X One', community: 10, source_file: 'app/foo-bar/x1.js', source_location: 'L1' },
      { id: 'x2', label: 'X Two', community: 10, source_file: 'app/foo-bar/x2.js', source_location: 'L2' },
      { id: 'y1', label: 'Y One', community: 20, source_file: 'app/foo_bar/y1.js', source_location: 'L1' },
      { id: 'y2', label: 'Y Two', community: 20, source_file: 'app/foo_bar/y2.js', source_location: 'L2' },
    ],
    links: [
      { source: 'x1', target: 'x2' },
      { source: 'y1', target: 'y2' },
    ],
  };
}

const bySub = (sections, key) => sections.find(s => s.community === key);

test('two subsystems -> 2 sections titled by directory', () => {
  const { sections, builtAtCommit } = build(makeGraphTwo());
  assert.equal(sections.length, 2);
  assert.ok(sections.every(s => s.community !== 'other'));
  const titles = sections.map(s => s.title).sort();
  assert.deepEqual(titles, ['Governance', 'Observability']);
  assert.equal(builtAtCommit, 'abc1234');
});

test('evaluation subsystem is relabeled but keeps slug + a stable, parser-safe diagram label', () => {
  const g = {
    built_at_commit: 'abc1234',
    nodes: [
      { id: 'e1', label: 'E One', community: 0, source_file: 'server/lib/evaluation/system-changes.js', source_location: 'L1' },
      { id: 'e2', label: 'E Two', community: 0, source_file: 'web/evaluation/substrate-loop.js', source_location: 'L2' },
      { id: 'g1', label: 'G One', community: 1, source_file: 'server/lib/governance/poison-scan.js', source_location: 'L1' },
      { id: 'g2', label: 'G Two', community: 1, source_file: 'server/lib/governance/egress.js', source_location: 'L2' },
    ],
    links: [{ source: 'g1', target: 'e1' }], // governance -> evaluation edge
  };
  const { sections } = build(g);
  const evo = bySub(sections, 'evaluation');
  assert.ok(evo, 'expected an evaluation subsystem section');
  assert.equal(evo.title, 'Evolution (internals)'); // display relabel (header + nav)
  assert.equal(evo.slug, 'code-evaluation');         // URL/cross-links unchanged
  // the override must NOT leak into any Mermaid arch diagram: parser-safety +
  // stable contentHash (so relabeling never busts a neighbor's narrative cache).
  const gov = bySub(sections, 'governance');
  assert.ok(gov.mermaid.includes('S_evaluation["Evaluation"]'), 'diagram node uses the plain stable label');
  assert.ok(!gov.mermaid.includes('Evolution (internals)'), 'override kept out of diagrams');
});

test('maxSections caps the page count and the tail is dropped, never folded into Other', () => {
  const { sections } = build(makeGraphThree(), { maxSections: 2 });
  assert.equal(sections.length, 2);
  assert.ok(sections.every(s => s.community !== 'other'));
  assert.ok(!sections.some(s => s.files.some(f => f.path === 'server/lib/orchestration/notes.js')));
});

test('there is no section cap by default', () => {
  const nodes = []; const links = [];
  for (let d = 0; d < 40; d++) for (let f = 0; f < 5; f++) nodes.push({ id: `n${d}_${f}`, label: `N${d}_${f}`, source_file: `server/lib/area${d}/f${f}.js` });
  const { sections } = buildSections({ nodes, links });
  assert.equal(sections.length, 40);
});

test('default threshold: a 4-file subsystem gets no page, a 5-file one does', () => {
  const mk = (dir, n) => Array.from({ length: n }, (_, i) => ({ id: `${dir}${i}`, label: `${dir}${i}`, source_file: `server/lib/${dir}/f${i}.js` }));
  const graph = { nodes: [...mk('small', 4), ...mk('big', 5)], links: [] };
  const { sections } = buildSections(graph);
  assert.deepEqual(sections.map(s => s.community), ['big']);
});

test('code pages: code- slug prefix, code group and kind, no Other/Root/docs pages', () => {
  const nodes = [];
  for (const [dir, n] of [['server/lib/alpha', 5], ['docs/guides', 6], ['', 6]]) {
    for (let i = 0; i < n; i++) nodes.push({ id: `${dir}${i}`, label: `L${i}`, source_file: `${dir ? dir + '/' : ''}f${i}.js` });
  }
  const { sections } = buildSections({ nodes, links: [] });
  assert.equal(sections.length, 1);
  const [s] = sections;
  assert.equal(s.slug, 'code-alpha');
  assert.equal(s.group, 'code');
  assert.equal(s.kind, 'code');
  assert.ok(!sections.some(x => ['other', '(root)', 'docs'].includes(x.community)));
});

test('tests and fixtures are not grouped into a subsystem', () => {
  const nodes = [];
  for (let i = 0; i < 8; i++) nodes.push({ id: `t${i}`, label: `T${i}`, source_file: `server/test/t${i}.test.js` });
  for (let i = 0; i < 8; i++) nodes.push({ id: `x${i}`, label: `X${i}`, source_file: `server/lib/thing/fixtures/x${i}.js` });
  for (let i = 0; i < 8; i++) nodes.push({ id: `c${i}`, label: `C${i}`, source_file: `server/lib/thing/c${i}.js` });
  const { sections } = buildSections({ nodes, links: [] });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].files.length, 8);
  assert.ok(sections[0].files.every(f => !/test|fixtures/.test(f.path)));
});

test('graph.built_at_commit missing -> builtAtCommit is null', () => {
  const g = makeGraphTwo();
  delete g.built_at_commit;
  assert.equal(build(g).builtAtCommit, null);
});

test('files sorted by degree desc; godNodes lead with the highest-degree member', () => {
  const { sections } = build(makeGraphTwo());
  const obs = bySub(sections, 'observability');
  assert.equal(obs.title, 'Observability');
  assert.equal(obs.godNodes[0], 'S One'); // s1 degree 3
  assert.equal(obs.files[0].path, 'server/lib/observability/zzz-hub.js');
  assert.equal(obs.files[0].degree, 3);
  for (let i = 1; i < obs.files.length; i++) {
    assert.ok(obs.files[i - 1].degree >= obs.files[i].degree, 'files sorted by degree desc');
  }
});

test('mermaid starts with graph LR and every node-id token is sanitized', () => {
  const { sections } = build(makeGraphThree());
  const obs = bySub(sections, 'observability');
  assert.ok(obs.mermaid.startsWith('graph LR'));

  const idTokenRe = /^[A-Za-z0-9_]+$/;
  // The subsystem is a labelled subgraph holding its files.
  assert.match(obs.mermaid, /^ {2}subgraph S_observability\["Observability"\]$/m);
  const fileDecls = [...obs.mermaid.matchAll(/^ {4}(\S+)\["([^"]*)"\]$/gm)];
  assert.ok(fileDecls.length > 0, 'expected declared file nodes inside the subgraph');
  for (const m of fileDecls) assert.match(m[1], idTokenRe);
  // Every edge end is either this subsystem's id or a declared, quoted-label node,
  // so no raw id is ever shown.
  const edges = [...obs.mermaid.matchAll(/^ {2}(\S+?)(?:\["[^"]*"\])? --> (\S+?)(?:\["[^"]*"\])?$/gm)];
  assert.ok(edges.length > 0, 'expected cross-subsystem edges');
  for (const m of edges) { assert.match(m[1], idTokenRe); assert.match(m[2], idTokenRe); }
  for (const line of obs.mermaid.split('\n').filter(l => l.includes('-->'))) {
    const ends = line.trim().split(' --> ');
    assert.ok(ends.some(e => e === 'S_observability'), `edge touches this subsystem: ${line}`);
    assert.ok(ends.every(e => e === 'S_observability' || /\["[^"]+"\]$/.test(e)), `the other end has a label: ${line}`);
  }
  assert.ok(!/\|/.test(obs.mermaid), 'no edge labels repeating node names');
});

test('slugs are stable across repeated calls on the same graph', () => {
  const a = build(makeGraphTwo());
  const b = build(makeGraphTwo());
  assert.deepEqual(a.sections.map(s => s.slug), b.sections.map(s => s.slug));
});

test('two subsystems that Title-case identically get distinct slugs', () => {
  const { sections } = build(makeGraphCollide());
  assert.equal(sections.length, 2);
  assert.ok(sections.every(s => s.title === 'Foo Bar'));
  const slugs = sections.map(s => s.slug).sort();
  assert.deepEqual(slugs, ['code-foo-bar', 'code-foo-bar-2']);
});

test('sections expose related + backlinks (cross-subsystem) and extension tags', () => {
  const { sections } = build(makeGraphTwo());
  const obs = bySub(sections, 'observability');
  const gov = bySub(sections, 'governance');
  assert.ok(obs.related.some(r => r.title === 'Governance'), 'observability links to governance');
  assert.ok(gov.backlinks.some(b => b.title === 'Observability'), 'governance referenced by observability');
  assert.ok(obs.related[0].slug, 'related entries carry a slug for navigation');
  assert.deepEqual(obs.tags, ['js']);
});

test('contentHash is stable for identical input and changes when a file is added', () => {
  const first = build(makeGraphTwo());
  const second = build(makeGraphTwo());
  assert.equal(bySub(first.sections, 'observability').contentHash,
    bySub(second.sections, 'observability').contentHash);

  const modified = makeGraphTwo();
  modified.nodes.push({ id: 's4', label: 'S Four', community: 0, source_file: 'server/lib/observability/four.js', source_location: 'L4' });
  const third = build(modified);
  assert.notEqual(bySub(first.sections, 'observability').contentHash,
    bySub(third.sections, 'observability').contentHash);
});

test('buildSections: each section declares the group keys it covers', () => {
  const { sections } = build(makeGraphTwo());
  const obs = sections.find(s => s.community === 'observability');
  assert.deepEqual(obs.keys, ['observability']);
});

test('buildSections: reservedSlugs are never claimed by a subsystem page', () => {
  const { sections } = build(makeGraphTwo(), { reservedSlugs: ['code-observability'] });
  const obs = sections.find(s => s.community === 'observability');
  assert.notEqual(obs.slug, 'code-observability', 'must not claim a reserved slug');
  assert.match(obs.slug, /^code-observability-\d+$/);
});

test('buildSections: web/overview code page is named Stage Board, not Overview', () => {
  const graph = {
    nodes: [
      { id: 'o1', label: 'O', community: 0, source_file: 'web/overview/stage-board.js' },
      { id: 'o2', label: 'P', community: 0, source_file: 'web/overview/dashboard.js' },
    ],
    links: [],
  };
  const { sections } = build(graph, { reservedSlugs: ['code-overview'] });
  const s = sections.find(x => x.community === 'overview');
  assert.equal(s.slug, 'code-stage-board');
  assert.equal(s.title, 'Stage Board');
});

// mc-17 fixed wiki-topics.js's contentHash to cover the gathered source TEXT,
// not just file paths. buildOneSection's contentHash here still hashed only
// {files, godNodes, mermaid} -- all STRUCTURAL -- so an in-body edit to a
// section's own file that doesn't move the file list, god-node degree ranking,
// or mermaid diagram never busted the cache and the narrative silently stayed
// stale. readFile is injected (default no-op), same pattern as sectionGitDates'
// runGitLog, so this stays pure/offline for the unit test.
test('contentHash folds in section source TEXT so a body-only edit (same files/godNodes/mermaid) busts the cache', () => {
  const graph = makeGraphTwo();
  const bodyA = (p) => `ORIGINAL body for ${p}`;
  const bodyB = (p) => `EDITED body for ${p}`;

  const a = build(graph, { readFile: bodyA });
  const b = build(graph, { readFile: bodyB });
  const same = build(graph, { readFile: bodyA });

  const obsA = bySub(a.sections, 'observability');
  const obsB = bySub(b.sections, 'observability');
  const obsSame = bySub(same.sections, 'observability');

  // Structural fields are untouched by the body edit -- proves the OLD hash
  // (files/godNodes/mermaid only) would have missed this change.
  assert.deepEqual(obsA.files, obsB.files);
  assert.deepEqual(obsA.godNodes, obsB.godNodes);
  assert.equal(obsA.mermaid, obsB.mermaid);

  assert.notEqual(obsA.contentHash, obsB.contentHash, 'a body-only edit must bust the freshness cache');
  assert.equal(obsA.contentHash, obsSame.contentHash, 'identical inputs -> identical hash (stable, no spurious rebuilds)');
});

test('contentHash computation is backward compatible when no readFile is injected', () => {
  const { sections } = build(makeGraphTwo()); // no readFile option passed
  const obs = bySub(sections, 'observability');
  assert.ok(obs.contentHash && typeof obs.contentHash === 'string');
});

test('groupKeyForDirs: first non-generic segment wins', () => {
  assert.equal(groupKeyForDirs(['server', 'lib', 'adapters']), 'adapters');
  assert.equal(groupKeyForDirs(['web', 'governance']), 'governance');
});

test('groupKeyForDirs: all-generic falls back to the top dir', () => {
  assert.equal(groupKeyForDirs(['server']), 'server');
  assert.equal(groupKeyForDirs(['server', 'lib']), 'server');
});

test('groupKeyForDirs: no dirs means repo root', () => {
  assert.equal(groupKeyForDirs([]), '(root)');
});

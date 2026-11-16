import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedWikiSnapshot } from '../../../server/lib/observability/wiki-ship-seed.js';
import { stageKernel, stageWikiSnapshot, stageCompanion, parseStageArgs, nodeVersionOk, publicScanHits, publicScanPatterns } from '../scripts/kernel-stage-lib.mjs';
import { runWikiBuild } from '../../../scripts/wiki-build-lib.mjs';
import { verifyWikiBuild } from '../../../server/lib/observability/wiki-verify.js';
import { buildIdFor, publishWikiBuild, wikiPaths } from '../../../server/lib/observability/wiki-publish.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function put(root, rel, body = 'x') {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

// A committed repo: a release is built from a commit, never the working tree.
function fixture({ without = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stage-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const rel of [
    'server/server.js', 'server/lib/paths.js', 'web/index.html', 'taps/tap.js', 'hooks/h.js',
    'plugins/host.js', 'plugins/embed/vendor/model.bin', 'scripts/wiki-build-cli.mjs',
    'scripts/setup/glmps-setup.sh', 'scripts/setup/glmps-setup.ps1', 'scripts/setup/deps-plan.mjs',
    'docs/offering/guardrail-policy-library.json', 'package.json', 'config.example.json',
    // everything below must stay out of the bundle
    'assets/CLAUDE.global.md', 'assets/agents/a.md', 'AGENTS.md', 'CLAUDE.md',
    'config.json', 'test.env', '.env', '.env.local', 'server/test/x.test.js', 'server/lib/y.test.js',
    'plugins/embed/test/fixture.json', 'plugins/test/host.test.js', 'server/graphify-out/graph.json',
    'server/node_modules/dep/index.js', 'assets/keys/id_rsa.pem', 'docs/specs/s.md', 'apps/shell/src/main.js',
    'scripts/service/x.key', 'web/assets/.token', 'scripts/export-public.mjs',
  ]) if (!without.includes(rel)) put(repo, rel);
  put(repo, 'assets/CLAUDE.global.md', '- private hot list\n\n## Approach\n<!-- ship -->\nPRODUCT\n\n## This machine\n<!-- dev-only -->\nOPERATOR\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const nodeExe = path.join(tmp, 'node.exe');
  fs.writeFileSync(nodeExe, 'NODE');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const green = { source: 'main-suite', sha, treeSha: git(repo, 'rev-parse', 'HEAD^{tree}'), verdict: 'pass' };
  return { tmp, repo, nodeExe, out: path.join(tmp, 'out'), sha, green };
}

const stage = (f, over = {}) => stageKernel({ repoRoot: f.repo, outDir: f.out, nodeExe: f.nodeExe, nodeVersion: 'v24.1.0', commit: 'HEAD', testedTree: f.green, ...over });

const list = (dir) => {
  const acc = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : acc.push(path.relative(dir, p).replaceAll('\\', '/')); } };
  walk(dir);
  return acc.sort();
};

test('stages the kernel runtime and node.exe, and nothing that is a secret, a test or tooling', () => {
  const f = fixture();
  try {
    const manifest = stage(f, { now: () => 1_700_000_000_000 });
    assert.deepEqual(list(f.out), [
      'assets/CLAUDE.global.md', 'assets/agents/a.md', 'bundle.json', 'config.example.json', 'docs/offering/guardrail-policy-library.json',
      'hooks/h.js', 'node.exe', 'package.json', 'plugins/embed/vendor/model.bin', 'plugins/host.js', 'release-manifest.json',
      'scripts/setup/deps-plan.mjs', 'scripts/setup/glmps-setup.ps1', 'scripts/setup/glmps-setup.sh',
      'scripts/wiki-build-cli.mjs', 'server/lib/paths.js', 'server/server.js', 'taps/tap.js', 'web/index.html',
    ]);
    assert.deepEqual(manifest, { node: 'v24.1.0', commit: f.sha.slice(0, 7), builtAt: new Date(1_700_000_000_000).toISOString(), release: { treeSha: f.green.treeSha, untested: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out, 'bundle.json'), 'utf8')), manifest);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('the operator global instructions never ship raw, his agents ship, and only the ship-marked sections stand in for the instructions', () => {
  const f = fixture();
  try {
    stage(f);
    assert.equal(fs.readFileSync(path.join(f.out, 'assets/CLAUDE.global.md'), 'utf8'), '## Approach\nPRODUCT\n');
    assert.equal(fs.existsSync(path.join(f.out, 'assets/agents/a.md')), true);
    assert.equal(fs.existsSync(path.join(f.out, 'assets/keys')), false);
    assert.equal(fs.existsSync(path.join(f.out, 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(f.out, 'scripts/export-public.mjs')), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('the stage ships the committed tree: a working-tree edit does not reach the bundle', () => {
  const f = fixture();
  try {
    put(f.repo, 'server/server.js', 'EDITED');
    stage(f);
    assert.equal(fs.readFileSync(path.join(f.out, 'server/server.js'), 'utf8'), 'x');
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('an untested commit is refused unless the stage is marked untested, which a public stage cannot be', () => {
  const f = fixture();
  try {
    assert.throws(() => stage(f, { testedTree: null }), /no green full-suite record/);
    assert.equal(fs.existsSync(f.out), false);
    const m = stage(f, { testedTree: null, untested: true });
    assert.deepEqual(m.release, { treeSha: f.green.treeSha, untested: true });
    assert.throws(() => stage(f, { testedTree: null, untested: true, shipGraph: { shipDir: path.join(f.tmp, 'x'), publicBuild: true } }), /public build may not skip/);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('restaging clears the previous bundle first, so a file removed from the repo does not linger', () => {
  const f = fixture();
  try {
    put(f.out, 'server/stale.js');
    stage(f);
    assert.equal(fs.existsSync(path.join(f.out, 'server', 'stale.js')), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('refuses a Node older than the kernel needs (node:sqlite, 22.5), before writing anything', () => {
  const f = fixture();
  try {
    assert.throws(() => stage(f, { nodeVersion: 'v22.4.1' }), /22\.5/);
    assert.equal(fs.existsSync(f.out), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('refuses a commit that is not a kernel checkout, leaving no bundle', () => {
  const f = fixture({ without: ['server/server.js'] });
  try {
    assert.throws(() => stage(f), /server\.js/);
    assert.equal(fs.existsSync(f.out), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('nodeVersionOk', () => {
  assert.equal(nodeVersionOk('v22.5.0'), true);
  assert.equal(nodeVersionOk('v22.4.9'), false);
  assert.equal(nodeVersionOk('v21.9.0'), false);
  assert.equal(nodeVersionOk('v26.10.0'), true);
  assert.equal(nodeVersionOk('garbage'), false);
});

function shipFixture(root, { corpusLabel = 'Corpus heading', kernelLabel = 'kernel fn' } = {}) {
  const dir = path.join(root, 'state', 'graphs', 'ship');
  const graph = {
    directed: false, graph: { graphify_version: '0.9.95' }, hyperedges: [],
    nodes: [
      { id: 'k::a', repo: 'k', label: kernelLabel, source_file: 'server/a.js' },
      { id: 'k::b', repo: 'k', label: 'b', source_file: 'server/b.js' },
      { id: 'c::doc', repo: 'c', label: corpusLabel, source_file: 'decisions.md' },
      { id: 'ref_fs', external: true, label: 'fs', source_file: '' },
      { id: 'ref_corpus_only', external: true, label: 'yaml', source_file: '' },
    ],
    links: [
      { source: 'k::a', target: 'k::b' },
      { source: 'k::a', target: 'ref_fs' },
      { source: 'c::doc', target: 'ref_corpus_only' },
      { source: 'k::b', target: 'c::doc' },
    ],
  };
  const manifest = {
    schemaVersion: 1, builtAt: '2026-10-26T00:00:00.000Z', graphifyVersion: '0.9.95',
    roots: [
      { root: 'D:/kernel', tag: 'k', commit: 'aaa', graphCommit: 'aaa', nodes: 3, edges: 2 },
      { root: 'D:/corpus', tag: 'c', commit: 'ccc', graphCommit: 'ccc', nodes: 2, edges: 1 },
    ],
    nodes: 5, edges: 4, backupsPruned: { 'D:/kernel': [] },
  };
  put(dir, 'graph.json', JSON.stringify(graph));
  put(dir, 'ship-manifest.json', JSON.stringify(manifest));
  return dir;
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('a private stage carries the code + corpus ship graph verbatim and records it in bundle.json', () => {
  const f = fixture();
  try {
    const shipDir = shipFixture(f.tmp);
    const manifest = stage(f, { shipGraph: { shipDir } });
    assert.equal(fs.readFileSync(path.join(f.out, 'graphs/ship/graph.json'), 'utf8'), fs.readFileSync(path.join(shipDir, 'graph.json'), 'utf8'));
    assert.deepEqual(manifest.shipGraph, {
      scope: 'code+corpus', builtAt: '2026-10-26T00:00:00.000Z', graphifyVersion: '0.9.95',
      roots: [{ tag: 'k', commit: 'aaa', graphCommit: 'aaa' }, { tag: 'c', commit: 'ccc', graphCommit: 'ccc' }],
      nodes: 5, edges: 4, sha256: sha(path.join(f.out, 'graphs/ship/graph.json')),
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out, 'bundle.json'), 'utf8')).shipGraph, manifest.shipGraph);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a public stage carries the code graph only: no corpus node, no corpus-only stub, no absolute root', () => {
  const f = fixture();
  try {
    const shipDir = shipFixture(f.tmp);
    const manifest = stage(f, { shipGraph: { shipDir, publicBuild: true, privateNames: ['opname'] } });
    const g = JSON.parse(fs.readFileSync(path.join(f.out, 'graphs/ship/graph.json'), 'utf8'));
    assert.deepEqual(g.nodes.map((n) => n.id), ['k::a', 'k::b', 'ref_fs']);
    assert.deepEqual(g.links, [{ source: 'k::a', target: 'k::b' }, { source: 'k::a', target: 'ref_fs' }]);
    const m = JSON.parse(fs.readFileSync(path.join(f.out, 'graphs/ship/ship-manifest.json'), 'utf8'));
    assert.deepEqual(m.roots, [{ tag: 'k', commit: 'aaa', graphCommit: 'aaa', nodes: 3, edges: 2 }]);
    assert.equal('backupsPruned' in m, false);
    assert.equal(m.nodes, 3);
    assert.equal(manifest.shipGraph.scope, 'code');
    assert.deepEqual(manifest.shipGraph.roots, [{ tag: 'k', commit: 'aaa', graphCommit: 'aaa' }]);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a public stage fails the public-flip scan on a drive path, a home path or the operator name in the code graph', () => {
  for (const kernelLabel of ['worktree `D:/glmps/x`', 'see /Users/someone/notes', 'owned by OpName']) {
    const f = fixture();
    try {
      const shipDir = shipFixture(f.tmp, { kernelLabel });
      assert.throws(() => stage(f, { shipGraph: { shipDir, publicBuild: true, privateNames: ['opname'] } }), /public-flip scan/);
      assert.equal(fs.existsSync(path.join(f.out, 'bundle.json')), false);
      assert.equal(fs.existsSync(f.out), false);
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('the public scan ignores what only the corpus half carried, and module specifiers', () => {
  const f = fixture();
  try {
    const shipDir = shipFixture(f.tmp, { corpusLabel: 'C:\\Users\\opname\\.claude', kernelLabel: 'imports node:fs and https://x.dev/a' });
    assert.doesNotThrow(() => stage(f, { shipGraph: { shipDir, publicBuild: true, privateNames: ['opname'] } }));
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a public stage drops kernel nodes from files the public mirror strips, so their private paths never reach the scan', () => {
  const f = fixture();
  try {
    const shipDir = shipFixture(f.tmp);
    const gf = path.join(shipDir, 'graph.json');
    const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
    g.nodes.push({ id: 'k::plan', repo: 'k', label: 'worktree `D:/glmps/wt`', source_file: 'docs\\superpowers\\plans\\p.md' });
    g.links.push({ source: 'k::a', target: 'k::plan' });
    fs.writeFileSync(gf, JSON.stringify(g));
    const mf = path.join(shipDir, 'ship-manifest.json');
    const built = JSON.parse(fs.readFileSync(mf, 'utf8'));
    Object.assign(built.roots[0], { nodes: 4, edges: 3 });
    fs.writeFileSync(mf, JSON.stringify(built));
    stage(f, { shipGraph: { shipDir, publicBuild: true } });
    const out = JSON.parse(fs.readFileSync(path.join(f.out, 'graphs/ship/graph.json'), 'utf8'));
    assert.deepEqual(out.nodes.map((n) => n.id), ['k::a', 'k::b', 'ref_fs']);
    assert.equal(out.links.some((e) => e.target === 'k::plan'), false);
    const m = JSON.parse(fs.readFileSync(path.join(f.out, 'graphs/ship/ship-manifest.json'), 'utf8'));
    assert.deepEqual([m.roots[0].nodes, m.roots[0].edges, m.nodes, m.edges], [3, 2, 3, 2]);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

// Card glmps-2-0-206: a research note off the short deny list still carried a
// personal path into the public graph, and every public rebuild failed the scan.
test('a public stage keeps only nodes from files the public mirror ships, not just those off the deny list', () => {
  const f = fixture();
  try {
    const shipDir = shipFixture(f.tmp);
    const gf = path.join(shipDir, 'graph.json');
    const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
    g.nodes.push({ id: 'k::research', repo: 'k', label: 'block in `C:\\Users\\someone\\.claude\\settings.json`', source_file: 'docs/research/notes.md' });
    g.nodes.push({ id: 'k::wiki', repo: 'k', label: 'wiki page plan', source_file: 'docs/wiki/plan.md' });
    g.links.push({ source: 'k::a', target: 'k::research' }, { source: 'k::a', target: 'k::wiki' });
    fs.writeFileSync(gf, JSON.stringify(g));
    stage(f, { shipGraph: { shipDir, publicBuild: true, privateNames: ['someone'] } });
    const out = JSON.parse(fs.readFileSync(path.join(f.out, 'graphs/ship/graph.json'), 'utf8'));
    assert.deepEqual(out.nodes.map((n) => n.id).sort(), ['k::a', 'k::b', 'k::wiki', 'ref_fs']);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a stage asked for a ship graph refuses when there is none, rather than shipping an installer without it', () => {
  const f = fixture();
  try {
    assert.throws(() => stage(f, { shipGraph: { shipDir: path.join(f.tmp, 'nope') } }), /no ship graph.*--no-ship-graph/);
    assert.equal(fs.existsSync(f.out), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('parseStageArgs: a plain stage asks for the ship graph; the flag or GLMPS_NO_SHIP_GRAPH=1 opts out', () => {
  assert.deepEqual(parseStageArgs([], {}), { publicBuild: true, shipDir: null, noShipGraph: false, untested: false, noWiki: false });
  assert.deepEqual(parseStageArgs(['--private'], {}), { publicBuild: false, shipDir: null, noShipGraph: false, untested: false, noWiki: false });
  assert.deepEqual(parseStageArgs(['--ship-graph', 'x'], {}), { publicBuild: true, shipDir: 'x', noShipGraph: false, untested: false, noWiki: false });
  assert.equal(parseStageArgs(['--private', '--no-ship-graph'], {}).noShipGraph, true);
  assert.equal(parseStageArgs([], { GLMPS_PRIVATE: '1', GLMPS_NO_SHIP_GRAPH: '1' }).noShipGraph, true);
  assert.equal(parseStageArgs([], { GLMPS_PRIVATE: '1', GLMPS_NO_SHIP_GRAPH: '0' }).noShipGraph, false);
  assert.throws(() => parseStageArgs(['--ship-graph'], {}), /unknown argument --ship-graph/);
  assert.throws(() => parseStageArgs(['--bogus'], {}), /unknown argument --bogus/);
  assert.throws(() => parseStageArgs([], { GLMPS_NO_SHIP_GRAPH: '1' }), /cannot be combined/);
  assert.throws(() => parseStageArgs(['--private', '--ship-graph', 'x', '--no-ship-graph'], {}), /cannot be combined/);
});

test('parseStageArgs: the installer is public by default, --private is the opt-in, and --public stays accepted as a no-op', () => {
  assert.equal(parseStageArgs([], {}).publicBuild, true);
  assert.equal(parseStageArgs(['--public'], {}).publicBuild, true);
  assert.equal(parseStageArgs(['--private'], {}).publicBuild, false);
  assert.equal(parseStageArgs([], { GLMPS_PRIVATE: '1' }).publicBuild, false);
  assert.equal(parseStageArgs([], { GLMPS_PRIVATE: '0' }).publicBuild, true);
  assert.throws(() => parseStageArgs(['--public', '--private'], {}), /--public and --private cannot be combined/);
});

test('parseStageArgs: --untested or GLMPS_UNTESTED=1 asks for a dev-only untested stage, which needs --private', () => {
  assert.equal(parseStageArgs(['--private', '--untested'], {}).untested, true);
  assert.equal(parseStageArgs([], { GLMPS_PRIVATE: '1', GLMPS_UNTESTED: '1' }).untested, true);
  assert.equal(parseStageArgs([], { GLMPS_UNTESTED: '0' }).untested, false);
  assert.throws(() => parseStageArgs(['--untested'], {}), /--untested needs --private/);
  assert.throws(() => parseStageArgs(['--public'], { GLMPS_UNTESTED: '1' }), /--untested needs --private/);
});

test.skip('the Shell CI unpacked build opts out of the ship graph and the tested-commit rule, since its fresh runner has neither', () => {
  const wf = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'shell.yml'), 'utf8');
  const step = wf.slice(wf.indexOf('name: Unpacked build'));
  assert.match(step, /GLMPS_NO_SHIP_GRAPH: '1'[\s\S]*run: npm run dist:dir/);
  assert.match(step, /GLMPS_UNTESTED: '1'[\s\S]*run: npm run dist:dir/);
  assert.match(step, /GLMPS_PRIVATE: '1'[\s\S]*run: npm run dist:dir/);
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['stage-kernel'], 'node scripts/stage-kernel.mjs');
  assert.match(pkg.scripts['dist:dir'], /^npm run stage-kernel &&/);
});

// A published wiki build in a throwaway state dir, the way wiki-publish.js lays it out.
function wikiFixture(root, { pages = { 'a.html': '<p>Hello</p>', 'b.html': '<p>World</p>' }, build = 'abc123def456-1760000000000' } = {}) {
  const stateDir = path.join(root, 'state');
  const dir = path.join(stateDir, 'wiki', 'builds', build);
  put(dir, 'manifest.json', JSON.stringify({ sections: Object.keys(pages).map((p) => ({ slug: p.replace('.html', '') })) }));
  put(dir, 'voice.json', '{}');
  for (const [name, body] of Object.entries(pages)) put(dir, name, body);
  put(path.join(stateDir, 'wiki'), 'current.json', JSON.stringify({ build, builtAtCommit: 'abc123def456', builtTs: 1760000000000, sections: 2, llmSections: 2 }));
  return { stateDir, dir };
}

test('a stage carries the published wiki build and records it in bundle.json', () => {
  const f = fixture();
  try {
    const { stateDir, dir } = wikiFixture(f.tmp);
    const manifest = stage(f, { wiki: { stateDir } });
    assert.deepEqual(Object.keys(manifest.wiki).sort(), ['build', 'builtAt', 'pages', 'sha256']);
    assert.equal(manifest.wiki.build, 'abc123def456-1760000000000');
    assert.equal(manifest.wiki.builtAt, new Date(1760000000000).toISOString());
    assert.equal(manifest.wiki.pages, 2);
    assert.match(manifest.wiki.sha256, /^[0-9a-f]{64}$/);
    const staged = path.join(f.out, 'wiki', manifest.wiki.build);
    assert.deepEqual(list(staged), list(dir));
    assert.equal(fs.readFileSync(path.join(staged, 'a.html'), 'utf8'), '<p>Hello</p>');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'wiki', 'current.json'), 'utf8')).builtAtCommit, 'abc123def456');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out, 'bundle.json'), 'utf8')).wiki, manifest.wiki);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('the staged wiki is exactly what the first-run seed accepts', () => {
  const f = fixture();
  try {
    const { stateDir } = wikiFixture(f.tmp);
    stage(f, { wiki: { stateDir } });
    const fresh = path.join(f.tmp, 'fresh-state');
    assert.deepEqual(seedWikiSnapshot({ bundleDir: f.out, stateDir: fresh }), { seeded: true, reason: 'absent' });
    assert.equal(fs.readFileSync(path.join(fresh, 'wiki', 'builds', 'abc123def456-1760000000000', 'a.html'), 'utf8'), '<p>Hello</p>');
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('the staged wiki checksum changes when a page changes', () => {
  const a = fixture();
  const b = fixture();
  try {
    const ma = stage(a, { wiki: { stateDir: wikiFixture(a.tmp).stateDir } });
    const mb = stage(b, { wiki: { stateDir: wikiFixture(b.tmp, { pages: { 'a.html': '<p>Hello</p>', 'b.html': '<p>Other</p>' } }).stateDir } });
    assert.notEqual(ma.wiki.sha256, mb.wiki.sha256);
  } finally { fs.rmSync(a.tmp, { recursive: true, force: true }); fs.rmSync(b.tmp, { recursive: true, force: true }); }
});

test('a wiki page with private text blocks the stage, naming the page and the sample, and leaves no bundle', () => {
  const leaks = {
    'drive path': '<p>Saved to C:\\Users\\someone\\wiki.</p>',
    'home path': '<p>Saved to /home/someone/wiki.</p>',
    '.gemini dir': '<p>Brain in .gemini/antigravity/x.</p>',
    'ticket id': '<p>Fixed under glmps-2-0-193.</p>',
    'name zed': '<p>Written by zed.</p>',
    'memory block': '<p>## Cross-Agent Memory</p>',
  };
  for (const [pattern, body] of Object.entries(leaks)) {
    const f = fixture();
    try {
      const { stateDir } = wikiFixture(f.tmp, { pages: { 'a.html': '<p>fine</p>', 'leaky.html': body.replace('<p>## ', '<p>\n## ') } });
      assert.throws(() => stage(f, { wiki: { stateDir, privateNames: ['zed'] } }), (e) => e.message.includes('leaky.html') && e.message.includes(pattern), pattern);
      assert.equal(fs.existsSync(f.out), false, pattern);
    } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
  }
});

test('a stage asked for the wiki refuses when none is published, rather than shipping an installer without it', () => {
  const f = fixture();
  try {
    assert.throws(() => stage(f, { wiki: { stateDir: path.join(f.tmp, 'nope') } }), /no published wiki.*--no-wiki/);
    assert.equal(fs.existsSync(f.out), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('a stage without a wiki request carries no wiki and records none', () => {
  const f = fixture();
  try {
    const manifest = stage(f);
    assert.equal(manifest.wiki, undefined);
    assert.equal(fs.existsSync(path.join(f.out, 'wiki')), false);
  } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
});

test('parseStageArgs: --no-wiki or GLMPS_NO_WIKI=1 opts out of the wiki snapshot', () => {
  assert.equal(parseStageArgs([], {}).noWiki, false);
  assert.equal(parseStageArgs(['--no-wiki'], {}).noWiki, true);
  assert.equal(parseStageArgs([], { GLMPS_NO_WIKI: '1' }).noWiki, true);
  assert.equal(parseStageArgs([], { GLMPS_NO_WIKI: '0' }).noWiki, false);
});

test.skip('the Shell CI unpacked build also opts out of the wiki, since its fresh runner has none', () => {
  const wf = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'shell.yml'), 'utf8');
  assert.match(wf.slice(wf.indexOf('name: Unpacked build')), /GLMPS_NO_WIKI: '1'[\s\S]*run: npm run dist:dir/);
});

test('publicScanHits names each pattern that fired', () => {
  const hits = publicScanHits('a D:\\x and .gemini/brain', publicScanPatterns(['ab']));
  assert.deepEqual(hits.map((h) => h.pattern), ['drive path', '.gemini dir']);
});

// Card glmps-2-0-199: the reviewer found the stage refused every real wiki,
// because the deterministic code map listed planning docs named for their
// ticket. This runs the real builder on a repo shaped like ours, the checker
// the wiki loop runs, the publish step and the stage, in that order.
test('a wiki the builder writes for a repo with ticket-named planning docs passes the checker and stages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-wiki-e2e-'));
  try {
    const root = path.join(tmp, 'repo');
    const nodes = [];
    for (const d of ['widgets', 'gadgets']) {
      for (let i = 1; i <= 5; i++) {
        put(path.join(root, 'src', d), `f${i}.js`, `export const ${d}${i} = ${i};\n`);
        nodes.push({ id: `${d}${i}`, label: `${d} ${i}`, community: d === 'widgets' ? 0 : 1, source_file: `src/${d}/f${i}.js`, source_location: 'L1' });
      }
    }
    put(path.join(root, 'graphify-out'), 'graph.json', JSON.stringify({ built_at_commit: 'g0', nodes, links: [] }));
    put(path.join(root, 'docs', 'specs'), '2026-01-01-glmps-2-0-84-thing.md', '# A plan\n');
    put(path.join(root, '.gemini'), 'settings.json', '{}\n');
    put(root, '.gitignore', 'graphify-out/\n');
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
    g('init', '-q'); g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    const head = g('rev-parse', 'HEAD');

    const stateDir = path.join(tmp, 'state');
    const buildDir = path.join(wikiPaths(stateDir).builds, buildIdFor(head, 1760000000000));
    let heads = [];
    const model = async (prompt) => {
      const asked = [...(prompt.match(/each written exactly: (.*)\./)?.[1] ?? '').matchAll(/"## ([^"]+)"/g)].map((m) => m[1]);
      if (asked.length) heads = asked;
      return `Summary: A plain summary of this area.\n\n${heads.map((h) => `## ${h}\n\nIt is plain and short.`).join('\n\n')}\n`;
    };
    const privateNames = ['zed'];
    const built = await runWikiBuild({ root, outDir: buildDir, cacheFile: path.join(tmp, 'cache.json'), stateDir, useLlm: true, callModel: model, expectHead: head, privateNames });
    assert.deepEqual(built.modelErrors, []);
    const v = verifyWikiBuild({ buildDir, headSha: head, privateNames });
    assert.deepEqual(v.failures, []);
    publishWikiBuild({ stateDir, buildDir, meta: { builtAtCommit: head, sections: built.sections, llmSections: built.llmSections }, now: () => 1760000000000 });

    const out = path.join(tmp, 'out');
    const staged = stageWikiSnapshot({ stateDir, outDir: out, privateNames });
    assert.equal(staged.pages, built.sections);
    const map = fs.readFileSync(path.join(out, 'wiki', staged.build, 'code-map.html'), 'utf8');
    assert.doesNotMatch(map, /glmps-2-0-84|\.gemini/);
    assert.match(map, /2 whose names carry private or planning text are not listed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Card glmps-2-0-218: the wizard installs the companion from a package staged
// with the kernel; a checkout that never installed the companion tooling ships
// without one and the wizard says so.
function companionFixture({ withModules = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stage-comp-'));
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'companion', withModules ? 'node_modules' : 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'companion', 'package.json'), JSON.stringify({ name: 'glmps-companion', version: '0.1.3' }));
  return { tmp, repoRoot, outDir: path.join(tmp, 'out') };
}

test('stageCompanion builds, packages into the stage folder and records the file', () => {
  const f = companionFixture();
  const calls = [];
  const run = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('package')) fs.writeFileSync(path.join(f.outDir, 'companion', 'glmps-companion-0.1.3.vsix'), 'PK');
  };
  const r = stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run });
  assert.deepEqual(calls.map((c) => c.args), [['run', 'build'], ['run', 'package', '--', '--out', path.join(f.outDir, 'companion', 'glmps-companion-0.1.3.vsix')]]);
  assert.equal(calls[0].cwd, path.join(f.repoRoot, 'companion'));
  assert.equal(r.file, 'companion/glmps-companion-0.1.3.vsix');
  assert.equal(r.sha256, crypto.createHash('sha256').update('PK').digest('hex'));
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

// Card glmps-2-0-217: a fresh checkout once shipped an installer whose IDE
// picker had nothing to install; the stage now installs the tooling itself.
test('stageCompanion installs the companion tooling from its lockfile when a fresh checkout lacks it', () => {
  const f = companionFixture({ withModules: false });
  const calls = [];
  const run = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('package')) fs.writeFileSync(path.join(f.outDir, 'companion', 'glmps-companion-0.1.3.vsix'), 'PK');
  };
  const r = stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run });
  assert.deepEqual(calls.map((c) => c.args[0] === 'ci' ? 'ci' : c.args[1]), ['ci', 'build', 'package']);
  assert.equal(calls[0].cwd, path.join(f.repoRoot, 'companion'));
  assert.equal(r.file, 'companion/glmps-companion-0.1.3.vsix');
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('stageCompanion stops the stage when installing the companion tooling fails', () => {
  const f = companionFixture({ withModules: false });
  const run = (args) => { if (args[0] === 'ci') throw new Error('companion: npm ci exited 1'); };
  assert.throws(() => stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run }), /npm ci exited 1/);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('stageCompanion does not reinstall tooling a checkout already has', () => {
  const f = companionFixture();
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('package')) fs.writeFileSync(path.join(f.outDir, 'companion', 'glmps-companion-0.1.3.vsix'), 'PK');
  };
  stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run });
  assert.equal(calls.some((a) => a[0] === 'ci'), false);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('stageCompanion stops the stage when the build or the package step breaks', () => {
  const f = companionFixture();
  assert.throws(() => stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run: () => { throw new Error('tsc failed'); } }), /tsc failed/);
  assert.throws(() => stageCompanion({ repoRoot: f.repoRoot, outDir: f.outDir, run: () => {} }), /produced no package/);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

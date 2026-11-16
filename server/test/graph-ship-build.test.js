// Ship graph build (server/lib/observability/graph-ship-build.js, scripts/graphify-ship-build.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  repoTags, outsideRoot, assertShipScope, checkLabelsCarried, pruneBackups, buildShipGraph, ShipBuildError,
} from '../lib/observability/graph-ship-build.js';
import { resolveGraphifyBin, spawnGraphifyUpdateWith } from '../lib/orchestration/graphify-spawn.js';
import { main } from '../../scripts/graphify-ship-build.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ship-build-'));
const node = (id, community, name, source_file, extra = {}) => ({ id, label: id, community, community_name: name, source_file, file_type: 'code', ...extra });
const graphOf = (nodes, links = []) => ({ directed: false, multigraph: false, graph: { schema_version: 1 }, nodes, links, hyperedges: [], built_at_commit: 'abc123' });

function makeRoot(base, name, nodes, links) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(graphOf(nodes, links)));
  return root;
}

// What graphify merge-graphs does to node ids, repo tags and community ids.
function fakeMerge(tags, { mutate = (n) => n } = {}) {
  return async (inputs, out) => {
    const nodes = []; const links = []; let offset = 0;
    inputs.forEach((f, i) => {
      const g = JSON.parse(fs.readFileSync(f, 'utf-8'));
      let max = -1;
      for (const n of g.nodes) {
        if (n.external) { if (!nodes.some((m) => m.id === n.id)) nodes.push({ ...n }); continue; }
        max = Math.max(max, n.community);
        nodes.push(mutate({ ...n, id: `${tags[i]}::${n.id}`, repo: tags[i], local_id: n.id, community: n.community + offset }));
      }
      for (const l of g.links) links.push({ source: `${tags[i]}::${l.source}`, target: `${tags[i]}::${l.target}` });
      offset = Math.max(offset, max + 1);
    });
    fs.writeFileSync(out, JSON.stringify(graphOf(nodes, links)));
    return { code: 0, stdout: '', stderr: '' };
  };
}

function fixture() {
  const base = tmp();
  const kernel = makeRoot(base, 'kernel', [
    node('a', 0, 'Server core', 'server/a.js'),
    node('b', 1, 'Web view', 'web/b.js'),
    node('fs', 2, 'imports', 'node:fs'),
    node('ref_node_fs', 3, 'ref', '', { external: true }),
  ], [{ source: 'a', target: 'b' }]);
  const corpus = makeRoot(base, 'corpus', [
    node('d', 0, 'Decisions', 'docs/decisions.md'),
    node('ref_node_fs', 1, 'ref', '', { external: true }),
  ], []);
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) fs.mkdirSync(path.join(kernel, 'graphify-out', d));
  return { base, kernel, corpus, shipDir: path.join(base, 'state', 'graphs', 'ship') };
}

const deps = (f, over = {}) => ({
  kernelRoot: f.kernel, corpusRoot: f.corpus, shipDir: f.shipDir,
  update: async () => ({ code: 0, stdout: '', stderr: '' }),
  merge: fakeMerge(['kernel', 'corpus']),
  version: async () => '0.9.95',
  commitOf: async (r) => (r === f.kernel ? 'k1' : 'c1'),
  now: () => new Date('2026-10-26T12:00:00Z'),
  ...over,
});

test('repo tags follow graphify: dir name, widened by parent on a collision, then index-suffixed', () => {
  assert.deepEqual(repoTags(['D:\\glmps-2.0-runtime', 'D:/glmps-2.0/']), ['glmps-2.0-runtime', 'glmps-2.0']);
  assert.deepEqual(repoTags(['/a/src', '/b/src']), ['a_src', 'b_src']);
  assert.deepEqual(repoTags(['/a/src', '/a/src']), ['a_src', 'a_src-2']);
});

test('outsideRoot: relative paths stay inside, climbs and foreign absolute paths do not', () => {
  const root = 'D:\\glmps-2.0-runtime';
  assert.equal(outsideRoot('server/a.js', root), null);
  assert.equal(outsideRoot('', root), null);
  assert.equal(outsideRoot('node:fs', root), null);
  assert.equal(outsideRoot('a/../b.js', root), null);
  assert.equal(outsideRoot('D:/glmps-2.0-runtime/server/a.js', root), null);
  assert.equal(outsideRoot('d:\\GLMPS-2.0-RUNTIME\\x.js', root), null);
  assert.match(outsideRoot('../Harbor-App/x.py', root), /climbs out/);
  assert.match(outsideRoot('a/../../x.py', root), /climbs out/);
  assert.match(outsideRoot('D:/Harbor-App/x.py', root), /outside/);
  assert.match(outsideRoot('D:/glmps-2.0-runtime-old/x.js', root), /outside/);
  assert.match(outsideRoot('/home/u/x.py', root), /outside/);
  assert.match(outsideRoot('file:///D:/Harbor-App/x.py', root), /outside/);
  assert.equal(outsideRoot('file:///D:/glmps-2.0-runtime/x.js', root), null);
  assert.match(outsideRoot('~/notes.md', root), /outside/);
});

test('scope assertion flags an unknown repo tag and an escaping path, and skips external stubs', () => {
  const merged = graphOf([
    { id: 'k::a', repo: 'k', source_file: 'server/a.js' },
    { id: 'x::b', repo: 'x', source_file: 'b.py' },
    { id: 'c::d', repo: 'c', source_file: '../trading/d.py' },
    { id: 'ref_node_fs', external: true, source_file: '' },
  ]);
  const r = assertShipScope(merged, { k: 'D:/k', c: 'D:/c' });
  assert.equal(r.checked, 3);
  assert.deepEqual(r.violations.map((v) => [v.id, v.why]), [
    ['x::b', 'repo tag is not a ship root'],
    ['c::d', 'relative path climbs out of its ship root'],
  ]);
});

test('label check reports a node whose community_name changed or vanished', () => {
  const inputs = [{ tag: 'k', graph: graphOf([node('a', 0, 'Core', 'a.js'), node('b', 1, 'View', 'b.js'), node('e', 2, 'ext', '', { external: true })]) }];
  const merged = graphOf([{ id: 'k::a', community_name: 'Core' }, { id: 'k::b', community_name: 'Community 1' }]);
  const r = checkLabelsCarried(inputs, merged);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.lost, [{ id: 'k::b', expected: 'View', got: 'Community 1' }]);
  assert.equal(checkLabelsCarried(inputs, graphOf([{ id: 'k::a', community_name: 'Core' }])).lost[0].got, null);
});

test('backup retention keeps the newest 3 dated folders and touches nothing else', () => {
  const dir = tmp();
  for (const d of ['2026-10-24', '2026-10-02', '2026-10-26', '2026-10-13', '2026-10-25', 'cache', 'wiki']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, '2026-10-01'), 'a file, not a backup');
  assert.deepEqual(pruneBackups(dir, { keep: 3 }), ['2026-10-02', '2026-10-13']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-01', '2026-10-24', '2026-10-25', '2026-10-26', 'cache', 'wiki']);
  assert.deepEqual(pruneBackups(dir, { keep: 3 }), []);
  assert.deepEqual(pruneBackups(path.join(dir, 'missing')), []);
});

test('build updates both roots, merges, publishes graph and manifest, and prunes backups', async () => {
  const f = fixture();
  const updated = [];
  const m = await buildShipGraph(deps(f, { update: async (r) => { updated.push(r); return { code: 0 }; } }));
  assert.deepEqual(updated, [f.kernel, f.corpus]);
  const published = JSON.parse(fs.readFileSync(path.join(f.shipDir, 'graph.json'), 'utf-8'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.shipDir, 'ship-manifest.json'), 'utf-8'));
  assert.deepEqual(onDisk, m);
  assert.equal(m.graphifyVersion, '0.9.95');
  assert.equal(m.builtAt, '2026-10-26T12:00:00.000Z');
  assert.deepEqual(m.roots.map((r) => [r.tag, r.commit, r.graphCommit, r.nodes, r.edges]), [
    ['kernel', 'k1', 'abc123', 4, 1],
    ['corpus', 'c1', 'abc123', 2, 0],
  ]);
  assert.equal(m.nodes, published.nodes.length);
  assert.equal(m.edges, 1);
  assert.equal(m.scopeChecked, 4);
  assert.equal(m.labelsChecked, 4);
  assert.deepEqual(m.backupsPruned[f.kernel.replace(/\\/g, '/')], ['2026-10-01', '2026-10-02']);
  assert.deepEqual(fs.readdirSync(path.join(f.kernel, 'graphify-out')).filter((d) => /^\d/.test(d)).sort(), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(fs.readdirSync(f.shipDir).sort(), ['graph.json', 'ship-manifest.json']);
});

test('a node outside the ship roots fails the build and leaves the published graph in place', async () => {
  const f = fixture();
  await buildShipGraph(deps(f));
  const before = fs.readFileSync(path.join(f.shipDir, 'graph.json'), 'utf-8');
  const leak = fakeMerge(['kernel', 'corpus'], { mutate: (n) => (n.local_id === 'd' ? { ...n, source_file: 'D:/Harbor-App/strategy.py' } : n) });
  await assert.rejects(buildShipGraph(deps(f, { merge: leak })), (e) => e instanceof ShipBuildError && e.stage === 'scope' && e.detail[0].id === 'corpus::d');
  assert.equal(fs.readFileSync(path.join(f.shipDir, 'graph.json'), 'utf-8'), before);
  assert.deepEqual(fs.readdirSync(f.shipDir).sort(), ['graph.json', 'ship-manifest.json']);
});

test('a merge that drops curated labels fails the build', async () => {
  const f = fixture();
  const drop = fakeMerge(['kernel', 'corpus'], { mutate: (n) => ({ ...n, community_name: `Community ${n.community}` }) });
  await assert.rejects(buildShipGraph(deps(f, { merge: drop })), (e) => e.stage === 'labels' && e.detail.length === 4);
  assert.equal(fs.existsSync(path.join(f.shipDir, 'graph.json')), false);
});

test('a failed update stops the build before merge and before pruning', async () => {
  const f = fixture();
  let merged = false;
  await assert.rejects(
    buildShipGraph(deps(f, { update: async () => ({ code: 1, stderr: 'os error 32' }), merge: async () => { merged = true; return { code: 0 }; } })),
    (e) => e.stage === 'update' && /os error 32/.test(e.message),
  );
  assert.equal(merged, false);
  assert.equal(fs.readdirSync(path.join(f.kernel, 'graphify-out')).filter((d) => /^\d/.test(d)).length, 5);
});

test('the two ship roots must be distinct', async () => {
  const f = fixture();
  await assert.rejects(buildShipGraph(deps(f, { corpusRoot: f.kernel.toUpperCase() })), (e) => e.stage === 'setup');
});

test('CLI writes the ship graph under the state dir with --corpus and --no-update', async () => {
  const f = fixture();
  const stateDir = path.join(f.base, 'cli-state');
  const lines = [];
  const m = await main(['--repo', f.kernel, '--corpus', f.corpus, '--no-update', '--keep', '4'], {
    env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CONFIG_FILE: path.join(f.base, 'none.json') },
    log: (l) => lines.push(l),
    deps: { merge: fakeMerge(['kernel', 'corpus']), version: async () => '0.9.95', commitOf: async () => 'sha', update: async () => { throw new Error('must not update'); } },
  });
  assert.ok(fs.existsSync(path.join(stateDir, 'graphs', 'ship', 'graph.json')));
  assert.equal(m.roots.length, 2);
  assert.deepEqual(Object.values(m.backupsPruned).flat(), ['2026-10-01']);
  assert.ok(lines.some((l) => /scope checked 4 nodes/.test(l)));
});

test('graphify update is spawned with the env it is given, and with the inherited env when none is', async () => {
  const seen = [];
  const spawnImpl = (b, a, opts) => {
    seen.push(opts);
    return { stdout: null, stderr: null, on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(0)); } };
  };
  const resolveBin = async () => 'graphify.exe';
  await spawnGraphifyUpdateWith({ resolveBin, spawnImpl }, 'D:/r', { env: { PYTHONHASHSEED: '0' } });
  await spawnGraphifyUpdateWith({ resolveBin, spawnImpl }, 'D:/r');
  assert.deepEqual(seen[0].env, { PYTHONHASHSEED: '0' });
  assert.equal('env' in seen[1], false);
});

// The plan's open assumption: does graphify merge-graphs itself keep each
// node's curated community_name? Runs the real binary when it is installed.
const bin = await resolveGraphifyBin();
test('real graphify merge-graphs keeps community_name on every node', { skip: !bin && 'graphify not on PATH', timeout: 120000 }, async () => {
  const f = fixture();
  const real = (inputs, out) => new Promise((res) => {
    execFile(bin, ['merge-graphs', ...inputs, '--out', out], { encoding: 'utf-8', windowsHide: true, env: { ...process.env, PYTHONHASHSEED: '0' } },
      (err, stdout, stderr) => res({ code: err ? 1 : 0, stdout, stderr }));
  });
  const m = await buildShipGraph(deps(f, { merge: real, update: async () => ({ code: 0 }) }));
  assert.equal(m.labelsChecked, 4);
  const published = JSON.parse(fs.readFileSync(path.join(f.shipDir, 'graph.json'), 'utf-8'));
  assert.equal(published.nodes.find((n) => n.id === 'corpus::d').community_name, 'Decisions');
});

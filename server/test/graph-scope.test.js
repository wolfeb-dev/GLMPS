// Graph scope classifier (server/lib/observability/graph-scope.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_DEFAULTS, mergeGraphConfig, normalizeRemote, matchesExclude,
  listScanRootRepos, gitProbe, classifyGraphRoots, classifyGraphRootsAsync, gitProbeAsync, inScopeRoots,
  cachedProbeAsync,
} from '../lib/observability/graph-scope.js';

const KERNEL = 'D:\\glmps-2.0-runtime';
const CORPUS = 'D:\\glmps-2.0';

const repo = (main, remote = null) => ({
  isRepo: true, toplevel: main, gitDir: main + '/.git', commonDir: main + '/.git', remote,
});
const worktree = (wt, main, remote = null) => ({
  isRepo: true, toplevel: wt, gitDir: main + '/.git/worktrees/x', commonDir: main + '/.git', remote,
});

function run(over = {}) {
  const probed = [];
  const table = over.table || {};
  const key = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const map = new Map(Object.entries(table).map(([k, v]) => [key(k), v]));
  const probe = (root) => { probed.push(root); return map.get(key(root)) || { isRepo: false }; };
  const out = classifyGraphRoots({
    kernelRoot: KERNEL, graph: mergeGraphConfig(over.graph), probe,
    listScanRoot: () => [], ...over.args,
  });
  const by = (r) => out.roots.find((e) => e.root.toLowerCase() === r.replace(/\\/g, '/').toLowerCase());
  return { out, by, probed };
}

test('mergeGraphConfig: defaults, partial override, fresh arrays', () => {
  assert.deepEqual(mergeGraphConfig(), GRAPH_DEFAULTS);
  assert.deepEqual(mergeGraphConfig('nope'), GRAPH_DEFAULTS);
  const m = mergeGraphConfig({ machine: { exclude: ['x'] } });
  assert.deepEqual(m.machine, { enabled: false, scanRoots: [], include: [], exclude: ['x'] });
  assert.deepEqual(m.ship, GRAPH_DEFAULTS.ship);
  const a = mergeGraphConfig();
  a.machine.exclude.push('mut');
  a.machine.scanRoots.push('mut');
  assert.deepEqual(GRAPH_DEFAULTS.machine.exclude, []);
  assert.deepEqual(mergeGraphConfig().machine.scanRoots, []);
});

test('normalizeRemote handles the common forms', () => {
  for (const u of [
    'https://github.com/Wolfeb-Dev/GLMPS-2.0.git', 'https://github.com/wolfeb-dev/glmps-2.0',
    'git@github.com:wolfeb-dev/glmps-2.0.git', 'ssh://git@github.com/wolfeb-dev/glmps-2.0.git',
    'https://github.com/wolfeb-dev/glmps-2.0/',
  ]) assert.equal(normalizeRemote(u), 'wolfeb-dev/glmps-2.0', u);
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(''), null);
});

test('matchesExclude: basename substring and path prefix', () => {
  assert.equal(matchesExclude('D:/Widget-Ninja', ['ninja']), 'ninja');
  assert.equal(matchesExclude('D:/Chart Builder', ['chart build']), 'chart build');
  assert.equal(matchesExclude('D:/Vaults', ['D:\\Vault']), null);
  assert.equal(matchesExclude('D:/Vault/sub', ['D:\\Vault']), 'D:\\Vault');
  assert.equal(matchesExclude('D:/Vault', ['d:/vault']), 'd:/vault');
  assert.equal(matchesExclude('D:/anything', ['', '  ']), null);
  assert.equal(matchesExclude('D:/ninja-parent/plain', ['ninja']), null);
});

test('listScanRootRepos: one level, repos only, errors tolerated', () => {
  const dirs = { 'D:/scan': ['a', 'b', 'c'] };
  const got = listScanRootRepos(['D:\\scan', 'D:\\gone'], {
    readdir: (d) => { if (!dirs[d]) throw new Error('ENOENT'); return dirs[d]; },
    isRepo: (p) => p !== 'D:/scan/b',
  });
  assert.deepEqual(got, ['D:/scan/a', 'D:/scan/c']);
});

test('gitProbe smoke: this checkout is a repo, a bogus path is not', () => {
  const p = gitProbe(process.cwd());
  assert.equal(p.isRepo, true);
  assert.ok(p.commonDir);
  assert.deepEqual(gitProbe('Z:/definitely/not/here'), { isRepo: false });
});

test('kernel root is ship', () => {
  const { by, out } = run({ table: { [KERNEL]: repo('D:/glmps-2.0-runtime') } });
  assert.equal(by(KERNEL).scope, 'ship');
  assert.equal(by(KERNEL).reason, 'kernel repo');
  assert.deepEqual(by(KERNEL).sources, ['kernel']);
  assert.equal(out.corpusRoot, null);
});

test('corpus matched by https and ssh remote when corpusRoot is null', () => {
  for (const remote of ['https://github.com/wolfeb-dev/glmps-2.0.git', 'git@github.com:wolfeb-dev/glmps-2.0.git']) {
    const { by, out } = run({
      table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), [CORPUS]: repo('D:/glmps-2.0', remote) },
      args: { sessionCwds: [CORPUS] },
    });
    assert.equal(by(CORPUS).scope, 'ship');
    assert.equal(by(CORPUS).reason, 'corpus repo (matched by remote)');
    assert.equal(out.corpusRoot, 'D:/glmps-2.0');
  }
});

test('configured corpusRoot is respected and is a candidate itself', () => {
  const { by, out } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), [CORPUS]: repo('D:/glmps-2.0') },
    graph: { ship: { corpusRoot: CORPUS } },
  });
  assert.equal(by(CORPUS).scope, 'ship');
  assert.equal(by(CORPUS).reason, 'corpus repo');
  assert.ok(by(CORPUS).sources.includes('corpus'));
  assert.equal(out.corpusRoot, 'D:/glmps-2.0');
});

test('a kernel that is a worktree stays ship; its main and sibling checkouts are excluded, never folded', () => {
  // This machine's layout: the 2.0 runtime checkout shares its git store with the 1.0 checkout.
  const OLD = 'D:\\glmps';
  const SIB = 'D:\\scut-build';
  const { by, out } = run({
    table: {
      [KERNEL]: worktree('D:/glmps-2.0-runtime', 'D:/glmps'),
      [OLD]: repo('D:/glmps'),
      [SIB]: worktree('D:/scut-build', 'D:/glmps'),
    },
    args: { additionalDirectories: [OLD, SIB] },
  });
  assert.equal(by(KERNEL).scope, 'ship');
  assert.equal(by(KERNEL).reason, 'kernel repo');
  assert.equal(by(OLD).reason, 'other checkout of kernel repo D:/glmps-2.0-runtime');
  assert.equal(by(SIB).reason, 'other checkout of kernel repo D:/glmps-2.0-runtime');
  assert.equal(out.roots.filter((r) => r.scope === 'ship').length, 1);
  assert.equal(out.roots.length, 3);
});

test('a configured corpusRoot is ship as given; other checkouts of it are excluded', () => {
  const WT = 'C:\\runner\\worktrees\\glmps-2.0\\c1';
  const { by, out } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), [WT]: worktree('C:/runner/worktrees/glmps-2.0/c1', 'D:/glmps-2.0'), [CORPUS]: repo('D:/glmps-2.0') },
    graph: { ship: { corpusRoot: WT } },
    args: { additionalDirectories: [CORPUS] },
  });
  assert.equal(by(WT).scope, 'ship');
  assert.equal(by(CORPUS).reason, 'other checkout of corpus repo C:/runner/worktrees/glmps-2.0/c1');
  assert.equal(out.corpusRoot, 'C:/runner/worktrees/glmps-2.0/c1');
});

test('a second clone of the corpus remote is excluded as a duplicate', () => {
  const remote = 'https://github.com/wolfeb-dev/glmps-2.0';
  const { by } = run({
    table: {
      [KERNEL]: repo('D:/glmps-2.0-runtime'), [CORPUS]: repo('D:/glmps-2.0', remote),
      'D:\\other-clone': repo('D:/other-clone', remote),
    },
    args: { sessionCwds: [CORPUS, 'D:\\other-clone'] },
  });
  assert.equal(by(CORPUS).scope, 'ship');
  assert.equal(by('D:/other-clone').scope, 'excluded');
  assert.equal(by('D:/other-clone').reason, 'duplicate clone of corpus repo');
});

test('corpus worktree seen before its main folds into it; the main becomes ship', () => {
  const wt = 'D:\\glmps-2.0-wt-66';
  const { by, out } = run({
    table: {
      [KERNEL]: repo('D:/glmps-2.0-runtime'),
      [CORPUS]: repo('D:/glmps-2.0', 'git@github.com:wolfeb-dev/glmps-2.0.git'),
      [wt]: worktree('D:/glmps-2.0-wt-66', 'D:/glmps-2.0', 'git@github.com:wolfeb-dev/glmps-2.0.git'),
    },
    args: { sessionCwds: [wt] },
  });
  assert.equal(by(wt).scope, 'excluded');
  assert.equal(by(wt).reason, 'worktree of D:/glmps-2.0');
  assert.deepEqual(by(CORPUS).sources, ['fold']);
  assert.equal(by(CORPUS).scope, 'ship');
  assert.equal(out.corpusRoot, 'D:/glmps-2.0');
});

test('runtime worktree under .claude/worktrees is excluded', () => {
  const wt = 'D:\\glmps-2.0-runtime\\.claude\\worktrees\\g92';
  const { by } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), [wt]: worktree('D:/glmps-2.0-runtime/.claude/worktrees/g92', 'D:/glmps-2.0-runtime') },
    args: { sessionCwds: [wt] },
  });
  assert.equal(by(wt).scope, 'excluded');
  assert.equal(by(wt).reason, 'other checkout of kernel repo D:/glmps-2.0-runtime');
  assert.equal(by(KERNEL).scope, 'ship');
});

test('worktree whose main was never discovered adds the main via fold', () => {
  const wt = 'D:\\proj-wt';
  const { by, out } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), [wt]: worktree('D:/proj-wt', 'D:/proj'), 'D:/proj': repo('D:/proj') },
    args: { sessionCwds: [wt] },
  });
  assert.equal(by('D:/proj').scope, 'machine');
  assert.ok(by('D:/proj').sources.includes('fold'));
  assert.equal(out.roots.filter((e) => e.root === 'D:/proj').length, 1);
});

test('subdirectory cwd folds into the repo root', () => {
  const sub = 'D:\\proj\\packages\\a';
  const { by } = run({
    table: {
      [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/proj': repo('D:/proj'),
      [sub]: { isRepo: true, toplevel: 'D:/proj', gitDir: 'D:/proj/.git', commonDir: 'D:/proj/.git', remote: null },
    },
    args: { sessionCwds: [sub] },
  });
  assert.equal(by(sub).scope, 'excluded');
  assert.equal(by(sub).reason, 'subdirectory of D:/proj');
  assert.equal(by('D:/proj').scope, 'machine');
});

test('private dir is excluded and never probed', () => {
  const { by, probed } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/Vault': repo('D:/Vault') },
    args: { sessionCwds: ['D:\\Vault', 'D:\\Vault\\sub'], privateDirs: ['D:/Vault'] },
  });
  assert.equal(by('D:/Vault').scope, 'excluded');
  assert.equal(by('D:/Vault').reason, 'private dir');
  assert.equal(by('D:/Vault/sub').reason, 'private dir');
  assert.equal(probed.some((p) => /vault/i.test(p)), false);
});

test('non-repo is excluded', () => {
  const { by } = run({ args: { sessionCwds: ['D:\\notes'] } });
  assert.equal(by('D:/notes').scope, 'excluded');
  assert.equal(by('D:/notes').reason, 'not a git repo');
});

test('config exclude by basename substring and by path; Vaults not matched by path Vault', () => {
  const { by } = run({
    table: {
      [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/Widget-Ninja': repo('D:/Widget-Ninja'),
      'D:/Vaults': repo('D:/Vaults'), 'D:/Vault': repo('D:/Vault'),
    },
    graph: { machine: { exclude: ['ninja', 'D:\\Vault'] } },
    args: { sessionCwds: ['D:\\Widget-Ninja', 'D:\\Vaults', 'D:\\Vault'] },
  });
  assert.equal(by('D:/Widget-Ninja').reason, 'config exclude: ninja');
  assert.equal(by('D:/Vault').reason, 'config exclude: D:\\Vault');
  assert.equal(by('D:/Vaults').scope, 'machine');
});

test('exclude beats include; include adds unknown repo, optedIn only when enabled', () => {
  const table = {
    [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/extra': repo('D:/extra'), 'D:/bad': repo('D:/bad'),
  };
  let r = run({ table, graph: { machine: { include: ['D:\\extra', 'D:\\bad'], exclude: ['bad'] } } });
  assert.equal(r.by('D:/extra').scope, 'machine');
  assert.equal(r.by('D:/extra').reason, 'include');
  assert.equal(r.by('D:/extra').optedIn, false);
  assert.equal(r.by('D:/bad').scope, 'excluded');
  r = run({ table, graph: { machine: { enabled: true, include: ['D:\\extra'] } } });
  assert.equal(r.by('D:/extra').optedIn, true);
});

test('two checkouts sharing a commonDir dedupe to the first', () => {
  const a = { isRepo: true, toplevel: 'D:/shared', gitDir: 'D:/store/s.git', commonDir: 'D:/store/s.git', remote: null };
  const { by } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/shared': a, 'D:/alias': { ...a, toplevel: 'D:/alias' } },
    args: { sessionCwds: ['D:/shared', 'D:/alias'] },
  });
  assert.equal(by('D:/shared').scope, 'machine');
  assert.equal(by('D:/alias').scope, 'excluded');
  assert.equal(by('D:/alias').reason, 'duplicate of D:/shared');
});

test('scan roots feed candidates; sources merge and case-insensitive dedupe keeps first spelling', () => {
  const { by, out } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/scan/a': repo('D:/scan/a') },
    args: {
      sessionCwds: ['D:\\Scan\\A'], scanRoots: ['D:\\scan'],
      listScanRoot: (roots) => { assert.deepEqual(roots, ['D:\\scan']); return ['D:/scan/a']; },
    },
  });
  const e = by('D:/scan/a');
  assert.equal(e.root, 'D:/Scan/A');
  assert.deepEqual(e.sources, ['session', 'scanRoot']);
  assert.equal(e.reason, 'session cwd');
  assert.equal(out.roots.filter((x) => x.root.toLowerCase() === 'd:/scan/a').length, 1);
});

test('additionalDirectories reason', () => {
  const { by } = run({
    table: { [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/add': repo('D:/add') },
    args: { additionalDirectories: ['D:\\add\\'] },
  });
  assert.equal(by('D:/add').reason, 'additionalDirectories');
});

test('classifyGraphRootsAsync matches the sync classifier and probes folded mains up front', async () => {
  const table = {
    [KERNEL]: repo('D:/glmps-2.0-runtime'),
    'D:/glmps-2.0': repo('D:/glmps-2.0', 'https://github.com/wolfeb-dev/glmps-2.0.git'),
    'C:/wt/scratch': worktree('C:/wt/scratch', 'D:/tool'),
    'D:/tool': repo('D:/tool'),
    'D:/trader': repo('D:/trader'),
  };
  const key = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const map = new Map(Object.entries(table).map(([k, v]) => [key(k), v]));
  const probed = [];
  const args = {
    kernelRoot: KERNEL, sessionCwds: ['D:\\glmps-2.0', 'C:/wt/scratch', 'D:/trader'],
    graph: { machine: { enabled: true, include: ['D:/tool'], exclude: ['trader'] } }, listScanRoot: () => [],
  };
  const out = await classifyGraphRootsAsync({
    ...args, existsAsync: async () => true,
    probeAsync: async (r) => { probed.push(r); return map.get(key(r)) || { isRepo: false }; },
  });
  const sync = classifyGraphRoots({ ...args, probe: (r) => map.get(key(r)) || { isRepo: false } });
  assert.deepEqual(out, sync);
  assert.equal(new Set(probed.map(key)).size, probed.length, 'each path probed once');
  assert.deepEqual(inScopeRoots(out.roots).map((r) => r.root).sort(), ['D:/glmps-2.0', 'D:/glmps-2.0-runtime', 'D:/tool']);
});

// Card glmps-2-0-runtime-73: 774 of the live box's 1,350 session cwds no
// longer exist, and each one still cost up to 2 git spawns per tick.
test('classifyGraphRootsAsync never probes a candidate that is missing on disk', async () => {
  const here = process.cwd();
  const gone = here + '/no-such-dir-xyz';
  const probed = [];
  const out = await classifyGraphRootsAsync({
    kernelRoot: here, sessionCwds: [gone], listScanRoot: () => [],
    probeAsync: async (r) => { probed.push(r); return gitProbeAsync(r); },
  });
  assert.ok(!probed.some((p) => p.toLowerCase().includes('no-such-dir-xyz')), 'missing path was probed');
  assert.equal(out.roots.find((r) => r.root.endsWith('no-such-dir-xyz')).scope, 'excluded');
});

test('classifyGraphRootsAsync stops probing once its signal is aborted', async () => {
  const ac = new AbortController();
  const probed = [];
  const cwds = Array.from({ length: 20 }, (_, i) => `D:/cwd${i}`);
  await assert.rejects(classifyGraphRootsAsync({
    kernelRoot: KERNEL, sessionCwds: cwds, listScanRoot: () => [], concurrency: 1, signal: ac.signal,
    existsAsync: async () => true,
    probeAsync: async (r) => { probed.push(r); if (probed.length === 3) ac.abort(); return { isRepo: false }; },
  }));
  assert.equal(probed.length, 3);
});

test('cachedProbeAsync reuses a result across classifier runs and re-probes on a git config change or expiry', async () => {
  const table = { [KERNEL]: repo('D:/glmps-2.0-runtime'), 'D:/tool': repo('D:/tool'), 'D:/plain': { isRepo: false } };
  const key = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const map = new Map(Object.entries(table).map(([k, v]) => [key(k), v]));
  const probed = [];
  const mtimes = new Map([['d:/glmps-2.0-runtime/.git/config', 1], ['d:/tool/.git/config', 1]]);
  let clock = 0;
  const probeAsync = cachedProbeAsync({
    probeAsync: async (r) => { probed.push(key(r)); return map.get(key(r)) || { isRepo: false }; },
    mtimeAsync: async (p) => mtimes.get(key(p)) ?? null,
    ttlMs: 1000, now: () => clock,
  });
  const tick = () => classifyGraphRootsAsync({
    kernelRoot: KERNEL, sessionCwds: ['D:/tool', 'D:/plain'], listScanRoot: () => [],
    existsAsync: async () => true, probeAsync,
  });
  const first = await tick();
  assert.deepEqual(probed.sort(), ['d:/glmps-2.0-runtime', 'd:/plain', 'd:/tool']);

  probed.length = 0;
  assert.deepEqual(await tick(), first);
  assert.deepEqual(probed, [], 'an unchanged cwd set spawns no git on the second tick');

  mtimes.set('d:/tool/.git/config', 2);
  await tick();
  assert.deepEqual(probed, ['d:/tool'], 'a changed git config re-probes only that root');

  probed.length = 0;
  clock = 1000;
  await tick();
  assert.deepEqual(probed.sort(), ['d:/glmps-2.0-runtime', 'd:/plain', 'd:/tool'], 'expired entries re-probe');
});

test('inScopeRoots: ship and opted-in machine only', () => {
  const roots = [
    { root: 'a', scope: 'ship' }, { root: 'b', scope: 'machine', optedIn: true },
    { root: 'c', scope: 'machine', optedIn: false }, { root: 'd', scope: 'excluded' },
  ];
  assert.deepEqual(inScopeRoots(roots).map((r) => r.root), ['a', 'b']);
  assert.deepEqual(inScopeRoots(), []);
});

test('gitProbeAsync reads a real worktree the same way gitProbe does', async () => {
  const here = process.cwd();
  assert.deepEqual(await gitProbeAsync(here), gitProbe(here));
  assert.deepEqual(await gitProbeAsync(here + '/no-such-dir-xyz'), { isRepo: false });
});

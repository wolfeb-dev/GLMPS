// Tests for the finished-but-unmerged-branch guard (glmps-66): pure git
// recipes/parsers, the pure detector, the injected-exec repo scanner, and the
// collectAlerts wiring. Guards the recurring miss where sessions commit
// finished work to a feature branch and nobody merges it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forEachRefRecipe,
  cherryRecipe,
  defaultBranchRecipe,
  parseRefList,
  parseCherry,
  detectUnmergedBranches,
  scanRepos,
  saveCherryCache,
  loadCherryCache,
} from '../lib/observability/unmerged-branches.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed clock; detector takes `now` explicitly


test('forEachRefRecipe lists local heads with name + committer date', () => {
  const r = forEachRefRecipe({ repo: 'D:/some repo' });
  assert.equal(r.file, 'git');
  assert.deepEqual(r.args.slice(0, 2), ['-C', 'D:/some repo']);
  assert.ok(r.args.includes('for-each-ref'));
  assert.ok(r.args.some(a => a.includes('%(refname:short)') && a.includes('%(committerdate:unix)')));
  assert.ok(r.args.includes('refs/heads'));
});

test('cherryRecipe compares a branch against the base by patch-equivalence', () => {
  const r = cherryRecipe({ repo: '/r', base: 'main', branch: 'feat/x' });
  assert.equal(r.file, 'git');
  assert.deepEqual(r.args, ['-C', '/r', 'cherry', 'main', 'feat/x']);
});

test('defaultBranchRecipe reads origin/HEAD', () => {
  const r = defaultBranchRecipe({ repo: '/r' });
  assert.equal(r.file, 'git');
  assert.deepEqual(r.args, ['-C', '/r', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
});


test('parseRefList parses name + unix committer date into ms', () => {
  const out = 'main\t1751000000\nfeat/x\t1750000000\n';
  assert.deepEqual(parseRefList(out), [
    { name: 'main', lastCommitMs: 1751000000000 },
    { name: 'feat/x', lastCommitMs: 1750000000000 },
  ]);
});

test('parseRefList tolerates blank lines and junk', () => {
  assert.deepEqual(parseRefList('\n\nnot-a-ref-line\n'), []);
  assert.deepEqual(parseRefList(''), []);
  assert.deepEqual(parseRefList(null), []);
});

test('parseCherry counts unmerged (+) commits and patch-equivalent (-) ones', () => {
  const out = '+ aaa111\n- bbb222\n+ ccc333\n';
  assert.deepEqual(parseCherry(out), { unmerged: 2, equivalent: 1 });
  assert.deepEqual(parseCherry(''), { unmerged: 0, equivalent: 0 });
});


function repo(overrides = {}) {
  return {
    project: 'glmps',
    defaultBranch: 'main',
    branches: [
      { name: 'feat/finished', lastCommitMs: NOW - 5 * DAY, unmerged: 3 },
    ],
    ...overrides,
  };
}

test('flags a stale unmerged branch with no open ticket referencing it', () => {
  const findings = detectUnmergedBranches({ repos: [repo()], tickets: [], now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].project, 'glmps');
  assert.equal(findings[0].branch, 'feat/finished');
  assert.equal(findings[0].unmerged, 3);
  assert.equal(findings[0].lastCommitMs, NOW - 5 * DAY);
});

test('skips the default branch and branches with zero unmerged commits', () => {
  const r = repo({
    branches: [
      { name: 'main', lastCommitMs: NOW - 30 * DAY, unmerged: 0 },
      { name: 'feat/all-equivalent', lastCommitMs: NOW - 30 * DAY, unmerged: 0 },
    ],
  });
  assert.deepEqual(detectUnmergedBranches({ repos: [r], tickets: [], now: NOW }), []);
});

test('skips branches still fresh (recent last commit = active work)', () => {
  const r = repo({ branches: [{ name: 'feat/wip', lastCommitMs: NOW - DAY, unmerged: 2 }] });
  assert.deepEqual(detectUnmergedBranches({ repos: [r], tickets: [], now: NOW, staleMs: 3 * DAY }), []);
});

test('skips branches an open ticket references via its branch field', () => {
  const tickets = [{ id: 't1', state: 'queued', branch: 'feat/finished', title: '', prompt: '' }];
  assert.deepEqual(detectUnmergedBranches({ repos: [repo()], tickets, now: NOW }), []);
});

test('skips branches an open ticket references in its title or prompt text', () => {
  const tickets = [{ id: 't2', state: 'queued', branch: null, title: 'redo cleanup', prompt: 'stale branch feat/finished superseded' }];
  assert.deepEqual(detectUnmergedBranches({ repos: [repo()], tickets, now: NOW }), []);
});

test('a done/cancelled/archived ticket does not suppress the alert', () => {
  for (const state of ['done', 'cancelled', 'archived']) {
    const tickets = [{ id: 't3', state, branch: 'feat/finished', title: '', prompt: '' }];
    const findings = detectUnmergedBranches({ repos: [repo()], tickets, now: NOW });
    assert.equal(findings.length, 1, `state=${state} should not suppress`);
  }
});

// idle is deliberately NOT closed
// (backlog-store.js CLOSED_STATES), so an idle ticket still counts as open
// here and its branch still counts as referenced -- a released, reopenable
// ticket must not have its branch flagged as abandoned out from under it.
test('an idle ticket (D27 release) still suppresses the alert, same as an open ticket', () => {
  const tickets = [{ id: 't4', state: 'idle', branch: 'feat/finished', title: '', prompt: '' }];
  assert.deepEqual(detectUnmergedBranches({ repos: [repo()], tickets, now: NOW }), []);
});


test('detectUnmergedBranches adds sessionId for session/<project>/<shortid> branches', () => {
  const r = repo({ branches: [{ name: 'session/glmps/abc123', lastCommitMs: NOW - 5 * DAY, unmerged: 2 }] });
  const findings = detectUnmergedBranches({ repos: [r], tickets: [], now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sessionId, 'abc123');
});

test('detectUnmergedBranches does not add sessionId for a non-session branch', () => {
  const findings = detectUnmergedBranches({ repos: [repo()], tickets: [], now: NOW });
  assert.equal(findings.length, 1);
  assert.equal('sessionId' in findings[0], false);
});

test('detectUnmergedBranches does not add sessionId for a malformed session-like branch (missing shortid segment)', () => {
  const r = repo({ branches: [{ name: 'session/glmps', lastCommitMs: NOW - 5 * DAY, unmerged: 1 }] });
  const findings = detectUnmergedBranches({ repos: [r], tickets: [], now: NOW });
  assert.equal(findings.length, 1);
  assert.equal('sessionId' in findings[0], false);
});

test('detectUnmergedBranches extracts sessionId even for a project name containing dashes/dots', () => {
  const r = repo({ branches: [{ name: 'session/data-research.v2/xyz789', lastCommitMs: NOW - 5 * DAY, unmerged: 1 }] });
  const findings = detectUnmergedBranches({ repos: [r], tickets: [], now: NOW });
  assert.equal(findings[0].sessionId, 'xyz789');
});


test('scanRepos turns git output into detector-ready repo shapes', async () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return 'origin/main\n';
    if (joined.includes('for-each-ref')) return `main\t${Math.floor((NOW - DAY) / 1000)}\nfeat/old\t${Math.floor((NOW - 10 * DAY) / 1000)}\n`;
    if (joined.includes('cherry')) return '+ abc\n- def\n';
    throw new Error(`unexpected git call: ${joined}`);
  };
  const repos = await scanRepos({ roots: [{ project: 'glmps', path: '/mc' }], exec });
  assert.equal(repos.length, 1);
  assert.equal(repos[0].project, 'glmps');
  assert.equal(repos[0].defaultBranch, 'main');
  // cherry is only run for non-default branches
  assert.deepEqual(repos[0].branches, [
    { name: 'feat/old', lastCommitMs: NOW - 10 * DAY, unmerged: 1 },
  ]);
  assert.ok(!calls.some(c => c.join(' ').includes('cherry main main')));
});

test('scanRepos survives a repo whose git calls fail', async () => {
  const exec = () => { throw new Error('not a repo'); };
  assert.deepEqual(await scanRepos({ roots: [{ project: 'broken', path: '/x' }], exec }), []);
});

test('scanRepos falls back to main/master when origin/HEAD is unset', async () => {
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
    if (joined.includes('for-each-ref')) return `master\t${Math.floor(NOW / 1000)}\n`;
    if (joined.includes('cherry')) return '';
    throw new Error(`unexpected: ${joined}`);
  };
  const repos = await scanRepos({ roots: [{ project: 'p', path: '/p' }], exec });
  assert.equal(repos[0].defaultBranch, 'master');
});


// glmps-2-0-runtime-86: a boot ran 660 `git cherry` launches in 90 s. Cherry's
// answer depends only on the two tips, so a shared cache keyed on them skips
// every repeat until a branch (or the base) moves.
test('forEachRefRecipe and parseRefList carry each branch tip', () => {
  assert.ok(forEachRefRecipe({ repo: '/r' }).args.some((a) => a.includes('%(objectname)')));
  assert.deepEqual(parseRefList('main\t1751000000\taaa\n'), [{ name: 'main', lastCommitMs: 1751000000000, sha: 'aaa' }]);
});

test('scanRepos with a shared cherry cache reruns cherry only for a branch whose tip moved', async () => {
  const tips = { main: 'm1', 'feat/a': 'a1', 'feat/b': 'b1' };
  let cherries = [];
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return 'origin/main\n';
    if (joined.includes('rev-parse')) return tips.main + '\n'; // origin/main tracks the moving base
    if (joined.includes('for-each-ref')) return Object.entries(tips).map(([n, s]) => `${n}\t${Math.floor(NOW / 1000)}\t${s}`).join('\n');
    if (joined.includes('cherry')) { cherries.push(args.at(-1)); return '+ abc\n'; }
    throw new Error(`unexpected git call: ${joined}`);
  };
  const cherryCache = new Map();
  const roots = [{ project: 'p', path: '/p' }];
  await scanRepos({ roots, exec, cherryCache });
  assert.deepEqual(cherries.sort(), ['feat/a', 'feat/b']);
  cherries = [];
  const again = await scanRepos({ roots, exec, cherryCache });
  assert.deepEqual(cherries, [], 'same tips: no cherry launched');
  assert.deepEqual(again[0].branches.map((b) => b.unmerged), [1, 1]);
  tips['feat/b'] = 'b2';
  await scanRepos({ roots, exec, cherryCache });
  assert.deepEqual(cherries, ['feat/b']);
  tips.main = 'm2'; cherries = [];
  await scanRepos({ roots, exec, cherryCache });
  assert.deepEqual(cherries.sort(), ['feat/a', 'feat/b'], 'a moved base invalidates every branch');
});

test('a failed cherry is not cached, and a ref with no tip is never cached', async () => {
  let fail = true; let cherries = 0;
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return 'origin/main\n';
    if (joined.includes('for-each-ref')) return `main\t1\tm1\nfeat/a\t1\ta1\nfeat/old\t1\n`;
    if (joined.includes('cherry')) { cherries++; if (fail && args.at(-1) === 'feat/a') throw new Error('locked'); return ''; }
    throw new Error(`unexpected git call: ${joined}`);
  };
  const cherryCache = new Map();
  const roots = [{ project: 'p', path: '/p' }];
  await scanRepos({ roots, exec, cherryCache });
  fail = false; cherries = 0;
  const repos = await scanRepos({ roots, exec, cherryCache });
  assert.equal(cherries, 2, 'feat/a retried after its failure, feat/old (no tip) rerun');
  assert.equal(repos.length, 1);
});

test('the cherry cache survives a restart through its file, keeping only settled answers', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cherry-')), 'cherry-cache.json');
  const cache = new Map([['k1', Promise.resolve({ unmerged: 2, equivalent: 0 })], ['k2', Promise.reject(new Error('x'))]]);
  cache.get('k2').catch(() => {});
  await saveCherryCache(file, cache);
  const back = loadCherryCache(file);
  assert.deepEqual([...back.keys()], ['k1']);
  assert.deepEqual(await back.get('k1'), { unmerged: 2, equivalent: 0 });
  assert.equal(loadCherryCache(path.join(path.dirname(file), 'none.json')).size, 0);
  fs.writeFileSync(file, '{not json');
  assert.equal(loadCherryCache(file).size, 0);
});

test('collectAlerts maps unmerged-branch findings to warn alerts', () => {
  const unmerged = [{ project: 'glmps', branch: 'feat/finished', unmerged: 3, lastCommitMs: NOW - 5 * DAY }];
  const alerts = collectAlerts({ unmerged });
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.source, 'unmerged-branch');
  assert.equal(a.severity, 'warn');
  assert.ok(a.title.includes('feat/finished'));
  assert.ok(a.title.includes('glmps'));
  assert.ok(a.detail.includes('3'));
  assert.deepEqual(a.target, { view: 'kanban', project: 'glmps' });
});

test('collectAlerts collapses >3 findings in one repo into a single summary alert', () => {
  const unmerged = ['a', 'b', 'c', 'd', 'e'].map(n =>
    ({ project: 'data-research', branch: `autoresearch/${n}`, unmerged: 2, lastCommitMs: NOW - 30 * DAY }));
  const alerts = collectAlerts({ unmerged });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'unmerged-branch');
  assert.ok(alerts[0].title.includes('5'));
  assert.ok(alerts[0].title.includes('data-research'));
  assert.ok(alerts[0].detail.includes('autoresearch/a'));
});

test('collectAlerts keeps per-branch alerts when a repo has 3 or fewer findings', () => {
  const unmerged = ['a', 'b', 'c'].map(n =>
    ({ project: 'p', branch: n, unmerged: 1, lastCommitMs: NOW - 30 * DAY }));
  assert.equal(collectAlerts({ unmerged }).length, 3);
});

test('collectAlerts dedups identical unmerged findings by stable id', () => {
  const f = { project: 'p', branch: 'b', unmerged: 1, lastCommitMs: 0 };
  const alerts = collectAlerts({ unmerged: [f, { ...f }] });
  assert.equal(alerts.length, 1);
});


test('detectUnmergedBranches ignores branches matching ignoreBranches globs (machine-generated run branches)', () => {
  const repos = [{
    project: 'data-research', defaultBranch: 'main',
    branches: [
      { name: 'autoresearch/deep-scalp-20260422-2146', lastCommitMs: NOW - 30 * DAY, unmerged: 2 },
      { name: 'feat/real-work', lastCommitMs: NOW - 30 * DAY, unmerged: 1 },
    ],
  }];
  const found = detectUnmergedBranches({ repos, now: NOW, ignoreBranches: ['autoresearch/*'] });
  assert.deepEqual(found.map(f => f.branch), ['feat/real-work']);
});

test('detectUnmergedBranches ignores whole projects in ignoreProjects (clone/variant repos)', () => {
  const repos = [
    { project: 'Harbor-App-sortino', defaultBranch: 'main',
      branches: [{ name: 'am-discretionary-book', lastCommitMs: NOW - 30 * DAY, unmerged: 3 }] },
    { project: 'harbor-app', defaultBranch: 'main',
      branches: [{ name: 'am-discretionary-book', lastCommitMs: NOW - 30 * DAY, unmerged: 3 }] },
  ];
  const found = detectUnmergedBranches({ repos, now: NOW, ignoreProjects: ['Harbor-App-sortino'] });
  assert.deepEqual(found.map(f => f.project), ['harbor-app']);
});

test('ignore globs are anchored: a mid-string match does not ignore', () => {
  const repos = [{
    project: 'p', defaultBranch: 'main',
    branches: [{ name: 'feat/autoresearch/x', lastCommitMs: NOW - 30 * DAY, unmerged: 1 }],
  }];
  const found = detectUnmergedBranches({ repos, now: NOW, ignoreBranches: ['autoresearch/*'] });
  assert.equal(found.length, 1);
});

test('collectAlerts suppresses capture alerts for tools in captureIgnore', () => {
  const alerts = collectAlerts({
    coverage: { byTool: { aider: 0, windsurf: 0, 'claude-code': 0.9 } },
    captureIgnore: ['aider', 'windsurf'],
  });
  assert.deepEqual(alerts.filter(a => a.source === 'capture'), []);
});

// A local main nobody pulls goes stale and made every branch cut from a fresh
// origin/main read as unmerged (2026-10-24, 2026-11-13).
test('scanRepos compares against origin/main and still lists and labels the default branch by name', async () => {
  const bases = [];
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return 'origin/main\n';
    if (joined.includes('for-each-ref')) return `main\t${Math.floor((NOW - DAY) / 1000)}\nfeat/fresh\t${Math.floor((NOW - DAY) / 1000)}\n`;
    if (joined.includes('cherry')) { const i = args.indexOf('cherry'); bases.push(args[i + 1]); return args[i + 1] === 'origin/main' ? '' : '+ a\n+ b\n'; }
    throw new Error(`unexpected git call: ${joined}`);
  };
  const repos = await scanRepos({ roots: [{ project: 'p', path: '/p' }], exec });
  assert.equal(repos[0].defaultBranch, 'main');
  assert.deepEqual(bases, ['origin/main']);
  assert.deepEqual(repos[0].branches, [{ name: 'feat/fresh', lastCommitMs: NOW - DAY, unmerged: 0 }]);
});

test('scanRepos keys the cherry cache on the origin/main tip, not the stale local main tip', async () => {
  let originTip = 'o1';
  let cherryRuns = 0;
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return 'origin/main\n';
    if (joined.includes('rev-parse')) return originTip + '\n';
    if (joined.includes('for-each-ref')) return `main\t${Math.floor(NOW / 1000)}\tlocalmain\nfeat/a\t${Math.floor(NOW / 1000)}\tsha-a\n`;
    if (joined.includes('cherry')) { cherryRuns++; return ''; }
    throw new Error(`unexpected git call: ${joined}`);
  };
  const cherryCache = new Map();
  const roots = [{ project: 'p', path: '/p' }];
  await scanRepos({ roots, exec, cherryCache });
  await scanRepos({ roots, exec, cherryCache });
  assert.equal(cherryRuns, 1, 'same tips are served from the cache');
  originTip = 'o2';
  await scanRepos({ roots, exec, cherryCache });
  assert.equal(cherryRuns, 2, 'a moved origin/main re-runs cherry even though local main did not move');
});

test('scanRepos compares against the local name when origin/HEAD does not resolve', async () => {
  const bases = [];
  const exec = (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
    if (joined.includes('for-each-ref')) return `main\t${Math.floor(NOW / 1000)}\nfeat/a\t${Math.floor(NOW / 1000)}\n`;
    if (joined.includes('cherry')) { bases.push(args[args.indexOf('cherry') + 1]); return ''; }
    throw new Error(`unexpected git call: ${joined}`);
  };
  await scanRepos({ roots: [{ project: 'p', path: '/p' }], exec });
  assert.deepEqual(bases, ['main']);
});

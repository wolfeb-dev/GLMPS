// Card glmps-2-0-181: as a service the kernel has no GitHub sign-in, so the
// live check's fetch, run in-process, waited on a credential prompt until its
// 120 s limit killed it, and the run recorded only "Command failed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveNoticeLoop, createLiveNoticeGit, gitFailureText } from '../lib/orchestration/live-notice-loop.js';

function seams() {
  const local = [];
  const shell = [];
  return {
    local, shell,
    runLocal: async (file, args, opts) => { local.push({ file, args, opts }); return { status: 0, stdout: 'out', stderr: '' }; },
    shellGit: async (args, opts, extra) => { shell.push({ args, opts, extra }); return { status: 0, stdout: '', stderr: '' }; },
  };
}

test('as a service the fetch goes through the desktop app, naming the live checkout as its root', async () => {
  const s = seams();
  const git = createLiveNoticeGit({ viaShell: true, shellGit: s.shellGit, runLocal: s.runLocal, repoRoot: 'D:\\live' });
  assert.equal((await git(['fetch', '-q', 'origin'])).status, 0);
  assert.deepEqual(s.shell, [{ args: ['fetch', '-q', 'origin'], opts: { cwd: 'D:\\live' }, extra: { extraRepos: ['D:\\live'] } }]);
  assert.equal(s.local.length, 0);
});

test('as a service the local ancestry reads still run in-process, under a short limit', async () => {
  const s = seams();
  const git = createLiveNoticeGit({ viaShell: true, shellGit: s.shellGit, runLocal: s.runLocal, repoRoot: 'D:\\live' });
  await git(['merge-base', '--is-ancestor', 'a', 'b']);
  assert.deepEqual(s.local, [{ file: 'git', args: ['-C', 'D:\\live', 'merge-base', '--is-ancestor', 'a', 'b'], opts: { timeout: 10_000 } }]);
  assert.equal(s.shell.length, 0);
});

test('outside a service the fetch runs in-process with the long limit', async () => {
  const s = seams();
  const git = createLiveNoticeGit({ viaShell: false, shellGit: s.shellGit, runLocal: s.runLocal, repoRoot: 'D:\\live' });
  await git(['fetch', '-q', 'origin']);
  assert.deepEqual(s.local, [{ file: 'git', args: ['-C', 'D:\\live', 'fetch', '-q', 'origin'], opts: { timeout: 120_000 } }]);
  assert.equal(s.shell.length, 0);
});

test('a test process never fetches, by either route', async () => {
  const s = seams();
  for (const viaShell of [true, false]) {
    const git = createLiveNoticeGit({ viaShell, shellGit: s.shellGit, runLocal: s.runLocal, repoRoot: 'D:\\live', refuseFetch: true });
    const r = await git(['fetch', '-q', 'origin']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refused in a test process/);
  }
  assert.equal(s.local.length + s.shell.length, 0);
});

test('a fetch the desktop app cannot take fails the run with its reason', async () => {
  const shellGit = async () => { throw Object.assign(new Error('gitops broker: the desktop app did not pick this up within 60000 ms'), { code: 'NO_SHELL' }); };
  // merge-base 128 and cat-file 1: the merge commit is not in the checkout, so the loop fetches.
  const runLocal = async (file, args) => ({ status: args.includes('merge-base') ? 128 : 1, stdout: '', stderr: '' });
  const git = createLiveNoticeGit({ viaShell: true, shellGit, runLocal, repoRoot: 'D:\\live' });
  const item = { id: 'a', mergeRequest: { repo: 'o/r', base: 'main', number: 1, stage: 'merged', mergeSha: 'sha-a', history: [{ ts: new Date(Date.now() - 3600_000).toISOString(), to: 'merged' }] } };
  const loop = createLiveNoticeLoop({
    loadItems: () => [item], liveSha: () => 'live1', kernelRepo: async () => 'o/r', autoDeploy: () => ({ 'o/r@main': 'deploy-glmps2' }),
    git, entries: () => [], mainSuite: () => ({}), markerExists: () => true, writeMarker: () => {}, save: () => {},
  });
  await assert.rejects(loop.maker({}), /did not pick this up/);
});

test('a killed local git names the time limit instead of a bare "Command failed"', () => {
  const killed = Object.assign(new Error('Command failed: git fetch -q origin'), { killed: true, signal: 'SIGTERM', code: null });
  assert.equal(gitFailureText(killed, '', 120_000), 'timed out after 120 s (killed): Command failed: git fetch -q origin');
  assert.equal(gitFailureText(Object.assign(new Error('Command failed: x'), { code: 128 }), 'fatal: no remote\n', 120_000), 'fatal: no remote\n');
  assert.equal(gitFailureText(Object.assign(new Error('Command failed: x'), { code: 1 }), '', 120_000), 'Command failed: x');
  assert.equal(gitFailureText(null, '', 120_000), '');
});

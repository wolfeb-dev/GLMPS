// server/test/tap-git-clones.test.js
// The tap-git-clones loop's maker and checker (card glmps-2-0-runtime-40) with a
// fake git: reuse before clone, the clone cap, fetch of an existing copy, host
// allowlist, head reachability, and the named no-shell failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTapGitClonesLoop, cloneDirFor, MAX_CLONES_PER_RUN } from '../lib/kernel/tap-git-clones.js';
import { canonicalRemote } from '../lib/kernel/tap-git.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapgitclones-')); tmpDirs.push(d); return d; };
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const remote = (host, owner, repo, heads = [H1], clientId = 'cli_a') => ({ ...canonicalRemote(`https://${host}/${owner}/${repo}`), clients: [{ clientId, heads }] });

function harness({ remotes, checkouts = [], gitImpl, reachable = new Set([H1]), prev = null, hosts } = {}) {
  const clonesDir = path.join(mk(), 'git-clones');
  fs.mkdirSync(clonesDir, { recursive: true });
  const netCalls = []; const readCalls = []; const written = [];
  const git = async (args, opts) => {
    netCalls.push({ args, cwd: opts.cwd });
    if (gitImpl) return gitImpl(args, opts);
    if (args[0] === 'clone') { fs.mkdirSync(args[4], { recursive: true }); fs.writeFileSync(path.join(args[4], 'HEAD'), 'ref: refs/heads/main\n'); }
    return { status: 0, stdout: '', stderr: '' };
  };
  const read = async (args) => { readCalls.push(args); const sha = args[args.length - 1].replace('^{commit}', ''); return { status: reachable.has(sha) ? 0 : 1, stdout: '', stderr: '' }; };
  const loop = createTapGitClonesLoop({
    remotes: () => remotes, serverCheckouts: () => checkouts, clonesDir, git, read, now: () => 5000,
    writeState: (d) => written.push(d), readState: () => prev, ...(hosts ? { hosts } : {}),
  });
  return { loop, clonesDir, netCalls, readCalls, written };
}

test('no client remotes is nothing-to-do', async () => {
  const h = harness({ remotes: [] });
  assert.deepEqual(await h.loop.maker(), { outcome: 'nothing-to-do' });
  assert.equal(h.netCalls.length, 0);
});

test('a new remote is mirror-cloned from its canonical url, then each reported head is checked on the copy', async () => {
  const r = remote('github.com', 'Acme', 'widgets', [H1, H2]);
  const h = harness({ remotes: [r] });
  const made = await h.loop.maker();
  const dest = cloneDirFor(h.clonesDir, r);
  assert.equal(made.outcome, 'done');
  assert.deepEqual(h.netCalls, [{ args: ['clone', '--mirror', '-q', 'https://github.com/Acme/widgets.git', dest], cwd: h.clonesDir }]);
  const row = made.result.state.remotes['github.com/Acme/widgets'];
  assert.deepEqual(row, { source: 'clone', path: dest, lastFetchTs: 5000, error: null, heads: { [H1]: true, [H2]: false } });
  assert.ok(h.readCalls.every((a) => a.includes(`safe.directory=${dest}`) && a.includes('--no-optional-locks') && a.includes('cat-file')));
  assert.deepEqual(await h.loop.checker(made.result), { ok: true, verifierRef: 'git-clones@1' });
  await h.loop.onVerified(made.result);
  assert.equal(h.written.length, 1);
});

test('an existing copy is fetched, not cloned', async () => {
  const r = remote('github.com', 'Acme', 'widgets');
  const h = harness({ remotes: [r] });
  const dest = cloneDirFor(h.clonesDir, r);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'HEAD'), 'ref: refs/heads/main\n');
  await h.loop.maker();
  assert.deepEqual(h.netCalls, [{ args: ['fetch', '-q', '--prune', 'origin'], cwd: dest }]);
});

test('at most 3 clones a run: the rest are pending, existing copies are still fetched', async () => {
  const rs = Array.from({ length: MAX_CLONES_PER_RUN + 2 }, (_, i) => remote('github.com', 'Acme', `r${i}`));
  const h = harness({ remotes: rs });
  const made = await h.loop.maker();
  assert.equal(h.netCalls.filter((c) => c.args[0] === 'clone').length, MAX_CLONES_PER_RUN);
  const pending = Object.values(made.result.state.remotes).filter((x) => x.pending);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending[0].heads, {});
  assert.equal(pending[0].source, null);
  assert.deepEqual(await h.loop.checker(made.result), { ok: true, verifierRef: `git-clones@${rs.length}` });
});

test('a host that is not allowed is recorded as skipped and never touched', async () => {
  const h = harness({ remotes: [remote('gitlab.example.org', 'o', 'r'), remote('github.com', 'Acme', 'w')] });
  const made = await h.loop.maker();
  assert.equal(made.result.state.remotes['gitlab.example.org/o/r'].skipped, 'host not allowed');
  assert.deepEqual(made.result.expected, ['github.com/Acme/w']);
  assert.ok(h.netCalls.every((c) => c.args.every((a) => !String(a).includes('gitlab'))));
  const widened = harness({ remotes: [remote('gitlab.example.org', 'o', 'r')], hosts: ['gitlab.example.org'] });
  await widened.loop.maker();
  assert.equal(widened.netCalls.length, 1, 'config widens the server side; the shell allowlist is the hard boundary');
});

test('a remote that matches a server checkout reads from it and is never fetched or cloned', async () => {
  const r = remote('github.com', 'Acme', 'widgets');
  const h = harness({ remotes: [r], checkouts: [{ path: 'D:/work/widgets', remote: 'git@github.com:Acme/widgets.git' }, { path: 'D:/work/other', remote: null }] });
  const made = await h.loop.maker();
  assert.equal(h.netCalls.length, 0);
  assert.deepEqual(made.result.state.remotes['github.com/Acme/widgets'], { source: 'checkout', path: 'D:/work/widgets', lastFetchTs: null, error: null, heads: { [H1]: true } });
  assert.ok(h.readCalls[0].includes('safe.directory=D:/work/widgets'));
});

test('a failed fetch keeps the old fetch time, still answers from the stale copy and records the error', async () => {
  const r = remote('github.com', 'Acme', 'widgets');
  const h = harness({ remotes: [r], prev: { remotes: { 'github.com/Acme/widgets': { lastFetchTs: 1234 } } }, gitImpl: async () => ({ status: 128, stdout: '', stderr: 'fatal: unable to access\nfatal: repository not found' }) });
  const dest = cloneDirFor(h.clonesDir, r);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'HEAD'), 'x');
  const made = await h.loop.maker();
  const row = made.result.state.remotes['github.com/Acme/widgets'];
  assert.equal(row.error, 'fatal: repository not found');
  assert.equal(row.lastFetchTs, 1234);
  assert.deepEqual(row.heads, { [H1]: true });
});

test('every clone failing because the desktop app cannot be reached fails the run as no-shell, after recording the state', async () => {
  const noShell = async () => { throw Object.assign(new Error('the desktop app did not pick this up'), { code: 'NO_SHELL' }); };
  const h = harness({ remotes: [remote('github.com', 'Acme', 'a'), remote('github.com', 'Acme', 'b')], gitImpl: noShell });
  await assert.rejects(h.loop.maker(), /^Error: no-shell$/);
  assert.equal(h.written.length, 1);
  assert.match(Object.values(h.written[0].remotes)[0].error, /desktop app/);
});

test('one infrastructure failure among successes is a done run with the error on its row', async () => {
  let n = 0;
  const flaky = async (args) => {
    if (n++ === 0) throw Object.assign(new Error('refused by shell'), { code: 'REFUSED' });
    fs.mkdirSync(args[4], { recursive: true }); fs.writeFileSync(path.join(args[4], 'HEAD'), 'x');
    return { status: 0, stdout: '', stderr: '' };
  };
  const h = harness({ remotes: [remote('github.com', 'Acme', 'a'), remote('github.com', 'Acme', 'b'), remote('github.com', 'Acme', 'c')], gitImpl: flaky });
  const made = await h.loop.maker();
  assert.equal(made.outcome, 'done');
  assert.equal(Object.values(made.result.state.remotes).filter((x) => x.error).length, 1);
  assert.equal((await h.loop.checker(made.result)).ok, true, 'one of three is not more than half');
});

test('the checker fails a run where more than half the remotes errored or a row is missing', async () => {
  const bad = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  const h = harness({ remotes: [remote('github.com', 'Acme', 'a'), remote('github.com', 'Acme', 'b')], gitImpl: bad });
  const made = await h.loop.maker();
  const verdict = await h.loop.checker(made.result);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /2 of 2/);
  const missing = await h.loop.checker({ state: { remotes: {} }, expected: ['github.com/Acme/a'] });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no state/);
});

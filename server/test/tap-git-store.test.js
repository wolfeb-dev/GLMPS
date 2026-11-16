// server/test/tap-git-store.test.js
// The server side of the tap's git summaries (card glmps-2-0-runtime-40): the
// canonical remote, body validation, and the per-client store in kernel.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalRemote, validateGitBody, openTapGit, GIT_MAX_REPOS } from '../lib/kernel/tap-git.js';

let sqlite = null;
try { sqlite = process.getBuiltinModule('node:sqlite'); } catch { sqlite = null; }
const SKIP = sqlite?.DatabaseSync ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot run';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkDb = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapgit-store-')); tmpDirs.push(d); return path.join(d, 'kernel.db'); };
const OID = 'a'.repeat(40);
const row = (over = {}) => ({ path: '/work/a', branch: 'main', head: OID, detached: false, worktree: false, ahead: 0, behind: 0, dirty: 0, remote: null, error: null, ...over });

test('canonicalRemote accepts https, ssh:// and scp forms and builds the clone url itself', () => {
  const want = { host: 'github.com', owner: 'Acme', repo: 'widgets', key: 'github.com/Acme/widgets', url: 'https://github.com/Acme/widgets.git' };
  for (const raw of [
    'https://github.com/Acme/widgets', 'https://github.com/Acme/widgets.git', 'https://GitHub.com/Acme/widgets/',
    'https://user:tok@github.com/Acme/widgets.git', 'https://github.com:8443/Acme/widgets.git?x=1#frag',
    'ssh://git@github.com/Acme/widgets.git', 'ssh://git@github.com:22/Acme/widgets', 'git@github.com:Acme/widgets.git', 'git@GITHUB.com:Acme/widgets',
  ]) assert.deepEqual(canonicalRemote(raw), want, raw);
});

test('canonicalRemote refuses local paths, file urls, odd schemes and unsafe names', () => {
  for (const raw of [
    null, undefined, 42, '', 'file:///srv/repo.git', '/srv/repo.git', 'C:\\repos\\x', '../x', 'http://github.com/o/r', 'git://github.com/o/r.git',
    'https://github.com/o', 'https://github.com/o/r/extra', 'https://github.com//r', 'https://github.com/./r', 'https://github.com/o/..',
    'https://github.com/o/r s', 'https://github.com/o%2Fx/r', 'https://github.com/o/.git', 'https://[::1]/o/r', 'https://-evil.com/o/r',
    'git@github.com:o', 'git@github.com:o/r/x', 'ext::sh -c id', '-oProxyCommand=x@h:o/r', 'https://github.com/o/r\n', `https://github.com/${'x'.repeat(101)}/r`,
  ]) assert.equal(canonicalRemote(raw), null, String(raw));
});

test('validateGitBody accepts a good body and drops unknown fields', () => {
  const out = validateGitBody({ scannedTs: 5, repos: [{ ...row(), extra: 'x' }] });
  assert.equal(out.error, undefined);
  assert.deepEqual(Object.keys(out.repos[0]).sort(), ['ahead', 'behind', 'branch', 'dirty', 'detached', 'error', 'head', 'path', 'remote', 'worktree'].sort());
  assert.equal(validateGitBody({ repos: [] }).error, undefined);
  assert.equal(validateGitBody({ repos: [row({ head: 'b'.repeat(64), branch: null })] }).error, undefined);
});

test('validateGitBody refuses the whole body on any bad row', () => {
  const bad = (r, why) => assert.ok(validateGitBody({ repos: [row(), r] }).error, why);
  assert.ok(validateGitBody(null).error); assert.ok(validateGitBody([]).error); assert.ok(validateGitBody({}).error); assert.ok(validateGitBody({ repos: 'x' }).error);
  assert.ok(validateGitBody({ repos: Array.from({ length: GIT_MAX_REPOS + 1 }, (_, i) => row({ path: `/r/${i}` })) }).error, 'too many repos');
  bad(row({ path: 'relative/dir' }), 'relative path');
  bad(row({ path: '' }), 'empty path');
  bad(row({ path: `/${'x'.repeat(1024)}` }), 'long path');
  bad(row({ path: '/a\u0000b' }), 'control char in path');
  bad(row({ path: '/WORK/A' }), 'duplicate path, case-insensitive');
  bad(row({ path: '/work/b', branch: '' }), 'empty branch');
  bad(row({ path: '/work/b', branch: 'x'.repeat(256) }), 'long branch');
  bad(row({ path: '/work/b', branch: 'a\nb' }), 'control char in branch');
  bad(row({ path: '/work/b', head: 'ABC' }), 'bad head');
  bad(row({ path: '/work/b', head: 'a'.repeat(41) }), 'bad head length');
  bad(row({ path: '/work/b', detached: 'no' }), 'detached not boolean');
  bad(row({ path: '/work/b', worktree: 1 }), 'worktree not boolean');
  for (const k of ['ahead', 'behind', 'dirty']) {
    bad(row({ path: '/work/b', [k]: -1 }), `${k} negative`);
    bad(row({ path: '/work/b', [k]: 1.5 }), `${k} fraction`);
    bad(row({ path: '/work/b', [k]: Number.MAX_SAFE_INTEGER + 1 }), `${k} unsafe`);
  }
  bad(row({ path: '/work/b', remote: 'r'.repeat(513) }), 'long remote');
  bad(row({ path: '/work/b', remote: 5 }), 'remote not a string');
  bad(row({ path: '/work/b', error: 'e'.repeat(301) }), 'long error');
  bad('not an object', 'row not an object');
});

test('replace swaps a client set in one step and list reads it back, canonicalising the remote', { skip: SKIP }, () => {
  const store = openTapGit({ dbFile: mkDb(), now: () => 1234 });
  try {
    const first = store.replace('cli_a', { repos: [row({ path: '/w/a', remote: 'https://tok@github.com/Acme/a.git' }), row({ path: '/w/b', remote: '/srv/local.git' }), row({ path: '/w/c' })] });
    assert.deepEqual(first, { status: 200, body: { ok: true, repos: 3 } });
    const listed = store.list('cli_a');
    assert.deepEqual(listed.map((r) => r.path), ['/w/a', '/w/b', '/w/c']);
    assert.equal(listed[0].remote, 'https://github.com/Acme/a.git');
    assert.equal(listed[1].remote, null, 'a local path is not a remote the server will act on');
    assert.equal(listed[0].reportedTs, 1234);
    assert.equal(listed[0].detached, false);

    store.replace('cli_b', { repos: [row({ path: '/w/a' })] });
    store.replace('cli_a', { repos: [row({ path: '/w/z' })] });
    assert.deepEqual(store.list('cli_a').map((r) => r.path), ['/w/z'], 'replaced, not merged');
    assert.deepEqual(store.list('cli_b').map((r) => r.path), ['/w/a'], 'another client is untouched');
    assert.deepEqual(store.list('cli_none'), []);

    const refused = store.replace('cli_a', { repos: [row({ path: 'nope' })] });
    assert.equal(refused.status, 400);
    assert.deepEqual(store.list('cli_a').map((r) => r.path), ['/w/z'], 'a refused body changes nothing');
  } finally { store.closeDb(); }
});

test('statusForCwd picks the longest repo path that prefixes the cwd, slash and case normalised', { skip: SKIP }, () => {
  const store = openTapGit({ dbFile: mkDb() });
  try {
    store.replace('cli_a', { repos: [
      row({ path: 'D:/work/app', branch: 'main', dirty: 2, ahead: 1, behind: 3 }),
      row({ path: 'D:/work/app/pkg', branch: 'dev', dirty: 7 }),
      row({ path: 'D:/work/other', branch: null, detached: true, head: OID }),
    ] });
    assert.deepEqual(store.statusForCwd('cli_a', 'D:\\Work\\App\\src'), { dirty: 2, ahead: 1, behind: 3, branch: 'main' });
    assert.equal(store.statusForCwd('cli_a', 'd:/work/app/pkg/x/y').branch, 'dev');
    assert.equal(store.statusForCwd('cli_a', 'D:/work/app').dirty, 2, 'the repo root itself');
    assert.equal(store.statusForCwd('cli_a', 'D:/work/other').branch, '(detached)');
    assert.equal(store.statusForCwd('cli_a', 'D:/work/application'), null, 'a sibling that shares a name prefix is not inside');
    assert.equal(store.statusForCwd('cli_a', 'E:/elsewhere'), null);
    assert.equal(store.statusForCwd('cli_x', 'D:/work/app'), null);
    assert.equal(store.statusForCwd('cli_a', ''), null);
    assert.equal(store.statusForCwd('cli_a', undefined), null);
  } finally { store.closeDb(); }
});

test('remotes lists each distinct canonical remote once with the heads every client reports', { skip: SKIP }, () => {
  const store = openTapGit({ dbFile: mkDb() });
  try {
    store.replace('cli_a', { repos: [row({ path: '/a/1', remote: 'git@github.com:Acme/w.git', head: OID }), row({ path: '/a/2', remote: 'https://github.com/Acme/w', head: 'b'.repeat(40) }), row({ path: '/a/3', head: null, remote: 'https://example.org/o/r' })] });
    store.replace('cli_b', { repos: [row({ path: '/b/1', remote: 'https://github.com/Acme/w.git', head: 'c'.repeat(40) })] });
    const out = store.remotes().sort((x, y) => (x.key < y.key ? -1 : 1));
    assert.deepEqual(out.map((r) => r.key), ['example.org/o/r', 'github.com/Acme/w']);
    const w = out[1];
    assert.equal(w.url, 'https://github.com/Acme/w.git');
    assert.deepEqual(w.clients.map((c) => c.clientId).sort(), ['cli_a', 'cli_b']);
    assert.deepEqual(w.clients.find((c) => c.clientId === 'cli_a').heads.sort(), [OID, 'b'.repeat(40)].sort());
    assert.deepEqual(out[0].clients[0].heads, [], 'a repo with no commit yet has no head to check');
  } finally { store.closeDb(); }
});

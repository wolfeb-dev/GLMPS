import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextVersion, changelogEntry, releaseNotes, prependChangelog, changelogTitle, runRelease, originRepo } from '../src/lib/release-run.js';

test('nextVersion bumps minor (patch resets) or patch, and refuses a malformed current', () => {
  assert.equal(nextVersion('2.0.0', 'minor'), '2.1.0');
  assert.equal(nextVersion('2.1.7', 'minor'), '2.2.0');
  assert.equal(nextVersion('2.1.7', 'patch'), '2.1.8');
  assert.throws(() => nextVersion('2.0', 'patch'));
  assert.throws(() => nextVersion('v2.0.0', 'patch'));
  assert.throws(() => nextVersion('2.0.0-rc1', 'patch'));
});

const ENTRY = { version: '2.1.0', date: '2026-11-14', cardId: 'glmps-2-0-209', title: '  Add\nversions  ', summary: 'all green', prUrl: 'https://github.com/o/r/pull/9' };

test('changelogEntry (the public file) carries only version, date, title and card id', () => {
  assert.equal(changelogEntry(ENTRY), '## v2.1.0 (2026-11-14)\n\n- Add versions (glmps-2-0-209)\n');
  assert.ok(!/pull|green|http/.test(changelogEntry(ENTRY)), 'no PR url and no gate summary');
  assert.equal(changelogEntry({ ...ENTRY, title: '' }), '## v2.1.0 (2026-11-14)\n\n- glmps-2-0-209\n', 'no title: the card id alone');
});

test('changelogTitle takes the PR title and drops its trailing card reference', () => {
  assert.equal(changelogTitle('Recognise the Tap on the kernel port (card glmps-2-0-214)', 'glmps-2-0-214'), 'Recognise the Tap on the kernel port');
  assert.equal(changelogTitle('Fix it (glmps-2-0-214)', 'glmps-2-0-214'), 'Fix it');
  assert.equal(changelogTitle('Plain title', 'glmps-2-0-214'), 'Plain title');
  assert.equal(changelogTitle('', 'c1'), '');
  assert.equal(changelogTitle(undefined, 'c1'), '');
});

test('releaseNotes (the private GitHub Release) keep the PR link and the gate summary', () => {
  assert.equal(releaseNotes(ENTRY), '## v2.1.0 (2026-11-14)\n\n- Add versions (glmps-2-0-209, [PR](https://github.com/o/r/pull/9)): all green\n');
  assert.equal(releaseNotes({ version: '2.0.1', date: '2026-11-14', cardId: 'c1', title: 'T' }), '## v2.0.1 (2026-11-14)\n\n- T (c1)\n');
});

test('prependChangelog keeps one header and puts the newest entry first', () => {
  const a = prependChangelog('', '## v2.0.0 (2026-11-14)\n\n- baseline\n');
  assert.equal(a, '# Changelog\n\n## v2.0.0 (2026-11-14)\n\n- baseline\n');
  const b = prependChangelog(a, '## v2.0.1 (2026-11-15)\n\n- fix\n');
  assert.equal(b, '# Changelog\n\n## v2.0.1 (2026-11-15)\n\n- fix\n\n## v2.0.0 (2026-11-14)\n\n- baseline\n');
});

function fixture({ name = 'glmps', version = '2.0.0', shell = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-'));
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": true\n}\n`);
  if (shell) {
    fs.mkdirSync(path.join(dir, 'apps', 'shell'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps', 'shell', 'package.json'), `{\n  "name": "glmps-shell",\n  "version": "${version}"\n}\n`);
  }
  return dir;
}

// A scripted run(file, args, { cwd }). `git worktree add --detach <dir> <ref>` copies the fixture clone into
// <dir> (what git would check out); `git commit` records what the worktree held; `git worktree remove` deletes it.
const BASELINE = 'd'.repeat(40);
// `tags` is what origin holds (ls-remote --tags), `localTags` what the clone holds.
function seams({ clone, tags = '', localTags = '', script = {}, prTitle = 'Add versions (card glmps-2-0-209)', baseline = `${BASELINE}\n`, originUrl = 'https://github.com/wolfeb-dev/glmps-2.0.git', originHead = 'main' } = {}) {
  const calls = [];
  const commits = [];
  const worktrees = [];
  const run = async (file, args, opts = {}) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push({ file, args, cwd: opts.cwd });
    const hit = Object.keys(script).find((k) => key.startsWith(k));
    if (hit) {
      const n = calls.filter((c) => `${c.file} ${c.args.join(' ')}`.startsWith(hit)).length;
      const r = typeof script[hit] === 'function' ? script[hit](n) : script[hit];
      if (r) return r;
    }
    if (file === 'gh') {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ title: prTitle }), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    const sub = args[0];
    if (sub === 'worktree' && args[1] === 'add') {
      const dir = args[3];
      worktrees.push(dir);
      fs.cpSync(clone, dir, { recursive: true });
    }
    if (sub === 'worktree' && args[1] === 'remove') fs.rmSync(args.at(-1), { recursive: true, force: true });
    if (sub === 'commit') {
      const read = (f) => (fs.existsSync(path.join(opts.cwd, f)) ? fs.readFileSync(path.join(opts.cwd, f), 'utf8') : null);
      commits.push({ cwd: opts.cwd, pkg: read('package.json'), shell: read(path.join('apps', 'shell', 'package.json')), log: read('CHANGELOG.md'), message: args[args.indexOf('-m') + 1] });
    }
    if (sub === 'tag' && args[1] === '-l') return { status: 0, stdout: localTags, stderr: '' };
    if (sub === 'ls-remote' && args[1] === '--tags') return { status: 0, stdout: tags, stderr: '' };
    if (sub === 'ls-remote' && args[1] === '--symref') return { status: 0, stdout: `ref: refs/heads/${originHead}\tHEAD\n${'f'.repeat(40)}\tHEAD\n`, stderr: '' };
    if (sub === 'remote' && args[1] === 'get-url') return { status: 0, stdout: `${originUrl}\n`, stderr: '' };
    if (sub === 'log') return { status: 0, stdout: baseline, stderr: '' };
    if (sub === 'rev-parse') return { status: 0, stdout: 'c'.repeat(40) + '\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const flat = () => calls.map((c) => `${c.file} ${c.args.join(' ')}`);
  return { run, calls, commits, worktrees, flat };
}

const wtRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-wts-'));
const recipe = (cwd, extra = {}) => ({ kind: 'release', cwd, repo: 'wolfeb-dev/glmps-2.0', base: 'main', number: 9, cardId: 'glmps-2-0-209', bump: 'minor', summary: 'ok', ...extra });
const now = () => new Date('2026-11-14T12:00:00Z');
const clonePkg = (d) => JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));

test('a release works in a worktree under the merge-queue dir, never the clone: bump, changelog, push, then tag and release', async () => {
  const clone = fixture();
  const root = wtRoot();
  const s = seams({ clone, tags: 'v2.0.0\n' });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: root, now });
  assert.deepEqual(r, { ok: true, version: '2.1.0', sha: 'c'.repeat(40) });

  const [wt] = s.worktrees;
  assert.equal(s.worktrees.length, 1);
  assert.ok(wt.startsWith(path.join(root, 'merge-queue') + path.sep), `under <worktrees>/merge-queue: ${wt}`);
  assert.ok(!fs.existsSync(wt), 'the worktree is removed afterwards');
  assert.equal(clonePkg(clone).version, '2.0.0', 'the clone working tree is untouched');
  assert.ok(!fs.existsSync(path.join(clone, 'CHANGELOG.md')));

  const [c] = s.commits;
  assert.equal(c.cwd, wt);
  assert.equal(JSON.parse(c.pkg).version, '2.1.0');
  assert.equal(JSON.parse(c.shell).version, '2.1.0');
  assert.equal(c.log, '# Changelog\n\n## v2.1.0 (2026-11-14)\n\n- Add versions (glmps-2-0-209)\n', 'the PR title, not the card title');
  assert.equal(c.message, 'Release v2.1.0 (glmps-2-0-209)');

  const flat = s.flat();
  assert.ok(flat.includes('gh pr view 9 -R wolfeb-dev/glmps-2.0 --json title'), 'the app reads the PR title itself');
  const push = flat.indexOf('git push origin HEAD:main');
  const tag = flat.findIndex((x) => x.startsWith('git tag -a v2.1.0'));
  const ghc = flat.findIndex((x) => x.startsWith('gh release create v2.1.0'));
  assert.ok(push >= 0 && tag > push && ghc > tag, flat.join('\n'));
  assert.ok(flat[ghc].includes('-R wolfeb-dev/glmps-2.0') && flat[ghc].includes('--target ' + 'c'.repeat(40)) && flat[ghc].includes('--title GLMPS v2.1.0'));
  assert.ok(flat[ghc].includes('[PR](https://github.com/wolfeb-dev/glmps-2.0/pull/9)): ok'), 'release notes keep the PR link and summary');
  assert.ok(!flat.some((x) => /--force\b|\s-f(\s|$)/.test(x.replace('worktree remove --force', ''))), 'never forces a push');
  assert.ok(!flat.some((x) => /checkout|reset/.test(x)), 'never moves the clone HEAD');
});

test('a patch bump raises the patch number', async () => {
  const clone = fixture({ version: '2.1.4' });
  const s = seams({ clone, tags: 'v2.1.4\n' });
  const r = await runRelease(recipe(clone, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.version, '2.1.5');
});

test('with no v* tag the baseline is tagged at the commit that added CHANGELOG.md and pushed before the bump', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: '', baseline: `${'e'.repeat(40)}\n${BASELINE}\n` });
  const r = await runRelease(recipe(clone, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.version, '2.0.1');
  const flat = s.flat();
  assert.ok(flat.some((x) => x.startsWith('git log') && x.includes('--diff-filter=A') && x.includes('CHANGELOG.md')), flat.join('\n'));
  const base = flat.findIndex((x) => x.startsWith('git tag -a v2.0.0') && x.endsWith(BASELINE));
  const basePush = flat.indexOf('git push origin v2.0.0');
  const commit = flat.findIndex((x) => x.startsWith('git commit'));
  assert.ok(base >= 0 && basePush > base && commit > basePush, flat.join('\n'));
});

test('with no v* tag and no CHANGELOG.md history the baseline is the tip', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: '', baseline: '' });
  await runRelease(recipe(clone, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now });
  const t = s.flat().find((x) => x.startsWith('git tag -a v2.0.0'));
  assert.ok(t && !/[0-9a-f]{40}$/.test(t), t);
});

test('a rejected push redoes the bump in a fresh worktree, at most 3 attempts, never forcing', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'git push origin HEAD:main': (n) => (n < 3 ? { status: 1, stdout: '', stderr: '! [rejected] HEAD -> main (fetch first)' } : null) } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, true);
  assert.equal(s.calls.filter((c) => c.args[0] === 'fetch').length, 3);
  assert.equal(new Set(s.worktrees).size, 3, 'a unique worktree per attempt');
  assert.ok(s.worktrees.every((w) => !fs.existsSync(w)), 'all removed');
  assert.deepEqual(s.commits.map((c) => JSON.parse(c.pkg).version), ['2.1.0', '2.1.0', '2.1.0'], 'bumped once per fresh base, not compounded');

  const clone2 = fixture();
  const s2 = seams({ clone: clone2, tags: 'v2.0.0\n', script: { 'git push origin HEAD:main': { status: 1, stdout: '', stderr: '! [rejected] (non-fast-forward)' } } });
  const r2 = await runRelease(recipe(clone2), { run: s2.run, worktreesDir: wtRoot(), now });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /rejected|attempts/);
  assert.equal(s2.calls.filter((c) => c.args[0] === 'push').length, 3);
  assert.ok(!s2.calls.some((c) => c.file === 'gh' && c.args[0] === 'release'));
  assert.ok(s2.worktrees.every((w) => !fs.existsSync(w)));
});

test('a gh failure is a named not-ok result after the push, and never throws; the worktree is still removed', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'gh release': { status: 1, stdout: '', stderr: 'HTTP 502' } } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /gh release create.*502/);
  assert.ok(s.worktrees.every((w) => !fs.existsSync(w)));
  const thrower = await runRelease(recipe(clone), { run: async () => { throw new Error('boom'); }, worktreesDir: wtRoot(), now });
  assert.equal(thrower.ok, false);
  assert.match(thrower.reason, /boom/);
});

test('an unreadable PR title falls back to the card id alone', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'gh pr view': { status: 1, stdout: '', stderr: 'HTTP 404' } } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, true);
  assert.equal(s.commits[0].log, '# Changelog\n\n## v2.1.0 (2026-11-14)\n\n- glmps-2-0-209\n');
});

test('no worktrees dir, or a worktree that cannot be created, is a named not-ok result', async () => {
  const clone = fixture();
  const none = await runRelease(recipe(clone), { run: seams({ clone }).run, worktreesDir: null, now });
  assert.equal(none.ok, false);
  assert.match(none.reason, /worktrees/);
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'git worktree add': { status: 128, stdout: '', stderr: 'fatal: invalid reference: origin/main' } } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /worktree add failed.*invalid reference/);
});

test('another repo (a different package name) is skipped as nothing-to-do, and its worktree is removed', async () => {
  const clone = fixture({ name: 'some-other-app' });
  const s = seams({ clone, tags: 'v1.0.0\n' });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.deepEqual(r, { ok: true, skipped: true, reason: 'package name some-other-app is not glmps' });
  assert.ok(!s.calls.some((c) => c.args[0] === 'commit' || c.args[0] === 'push'));
  assert.ok(s.worktrees.every((w) => !fs.existsSync(w)));
});

test('a missing apps/shell/package.json is tolerated and a malformed version is a not-ok result', async () => {
  const ok = fixture({ shell: false });
  const s = seams({ clone: ok, tags: 'v2.0.0\n' });
  assert.equal((await runRelease(recipe(ok, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now })).version, '2.0.1');
  const badClone = fixture({ version: 'x' });
  const s2 = seams({ clone: badClone, tags: 'v2.0.0\n' });
  assert.equal((await runRelease(recipe(badClone, { bump: 'patch' }), { run: s2.run, worktreesDir: wtRoot(), now })).ok, false);
});

test('a clone with no package.json is skipped, not failed (fail open)', async () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-empty-'));
  const s = seams({ clone, tags: '' });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.deepEqual(r, { ok: true, skipped: true, reason: 'no package.json in the checkout' });
  assert.ok(!s.calls.some((c) => c.file === 'gh'));
});

test('a ref-lock collision on the release fetch is retried, any other fetch failure is not (glmps-2-0-221)', async () => {
  const LOCK = "error: cannot lock ref 'refs/remotes/origin/main': is at b but expected a";
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'git fetch': (n) => (n < 3 ? { status: 1, stdout: '', stderr: LOCK } : null) } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now, sleep });
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.calls.filter((c) => c.args[0] === 'fetch').length, 3);
  assert.equal(sleeps.length, 2);

  const clone2 = fixture();
  const s2 = seams({ clone: clone2, tags: 'v2.0.0\n', script: { 'git fetch': { status: 128, stdout: '', stderr: 'fatal: unable to access origin' } } });
  const r2 = await runRelease(recipe(clone2), { run: s2.run, worktreesDir: wtRoot(), now, sleep });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /fetch.*unable to access/);
  assert.equal(s2.calls.filter((c) => c.args[0] === 'fetch').length, 1, 'a network failure is not retried');
});

// Card glmps-2-0-223: tags are judged on origin, and a failed tag push never
// leaves a local tag behind for the next release to mistake for a pushed one.
test('a local tag origin lacks does not count: the baseline is still tagged and pushed', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: '', localTags: 'v2.0.0\n' });
  const r = await runRelease(recipe(clone, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, true, r.reason);
  const flat = s.flat();
  assert.ok(flat.includes('git ls-remote --tags origin refs/tags/v*'), flat.join('\n'));
  assert.ok(!flat.some((x) => x.startsWith('git tag -l')), 'the local tag list is not consulted');
  const del = flat.indexOf('git tag -d v2.0.0');
  const make = flat.findIndex((x) => x.startsWith('git tag -a v2.0.0'));
  assert.ok(del >= 0 && make > del && flat.indexOf('git push origin v2.0.0') > make, flat.join('\n'));
});

test('a failed baseline tag push deletes the local tag and stops before the bump', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: '', script: { 'git push origin v2.0.0': { status: 128, stdout: '', stderr: 'fatal: Authentication failed' } } });
  const r = await runRelease(recipe(clone, { bump: 'patch' }), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /push origin v2\.0\.0 failed.*Authentication/);
  const flat = s.flat();
  assert.ok(flat.lastIndexOf('git tag -d v2.0.0') > flat.indexOf('git push origin v2.0.0'), flat.join('\n'));
  assert.ok(!flat.some((x) => x.startsWith('git commit') || x === 'git push origin HEAD:main'));
  assert.ok(s.worktrees.every((w) => !fs.existsSync(w)));
});

test('a failed version tag push deletes the local tag and creates no GitHub Release', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'git push origin v2.1.0': { status: 1, stdout: '', stderr: 'unable to access origin' } } });
  const r = await runRelease(recipe(clone), { run: s.run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /push origin v2\.1\.0 failed/);
  const flat = s.flat();
  assert.ok(flat.lastIndexOf('git tag -d v2.1.0') > flat.indexOf('git push origin v2.1.0'), flat.join('\n'));
  assert.ok(!s.calls.some((c) => c.file === 'gh' && c.args[0] === 'release'));
});

// Card glmps-2-0-223: the kernel's repo and base must be this checkout's origin
// and origin's default branch, checked before any worktree or push.
test('originRepo reads owner/repo from https and ssh GitHub URLs', () => {
  assert.equal(originRepo('https://github.com/wolfeb-dev/glmps-2.0.git\n'), 'wolfeb-dev/glmps-2.0');
  assert.equal(originRepo('git@github.com:Wolfeb-Dev/glmps-2.0.git'), 'wolfeb-dev/glmps-2.0');
  assert.equal(originRepo('https://github.com/wolfeb-dev/glmps-2.0'), 'wolfeb-dev/glmps-2.0');
  assert.equal(originRepo('https://gitlab.com/a/b.git'), null);
  assert.equal(originRepo(''), null);
});

test('a release naming another repo or a base that is not origin default branch is refused before anything is written', async () => {
  const clone = fixture();
  const other = seams({ clone, tags: 'v2.0.0\n', originUrl: 'https://github.com/wolfeb-dev/other.git' });
  const r1 = await runRelease(recipe(clone), { run: other.run, worktreesDir: wtRoot(), now });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not this checkout's origin \(wolfeb-dev\/other\)/);
  assert.equal(other.worktrees.length, 0);

  const branch = seams({ clone, tags: 'v2.0.0\n' });
  const r2 = await runRelease(recipe(clone, { base: 'some-new-branch' }), { run: branch.run, worktreesDir: wtRoot(), now });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /base some-new-branch is not origin's default branch \(main\)/);
  assert.equal(branch.worktrees.length, 0);
  assert.ok(!branch.calls.some((c) => c.args[0] === 'push' || c.file === 'gh'));

  const same = seams({ clone, tags: 'v2.0.0\n', originUrl: 'git@github.com:wolfeb-dev/GLMPS-2.0.git' });
  assert.equal((await runRelease(recipe(clone), { run: same.run, worktreesDir: wtRoot(), now })).ok, true, 'case and URL form do not matter');
});

// Card glmps-2-0-224: the runner refuses ordinary steps once the release
// deadline passes, so the steps that undo local state are flagged cleanup and
// still run: the worktree remove and the tag delete after a failed push.
test('the worktree remove and the tag delete after a failed push are cleanup steps that run past the deadline', async () => {
  const clone = fixture();
  const s = seams({ clone, tags: 'v2.0.0\n', script: { 'git push origin v2.1.0': { status: -2, stdout: '', stderr: 'release deadline passed' } } });
  let expired = false;
  const seen = [];
  const run = async (file, args, opts = {}) => {
    seen.push({ key: `${file} ${args.join(' ')}`, cleanup: opts.cleanup === true });
    if (expired && opts.cleanup !== true) return { status: -2, stdout: '', stderr: 'release deadline passed' };
    const r = await s.run(file, args, opts);
    if (file === 'git' && args[0] === 'push' && args[2] === 'v2.1.0') expired = true;
    return r;
  };
  const r = await runRelease(recipe(clone), { run, worktreesDir: wtRoot(), now });
  assert.equal(r.ok, false);
  const pushAt = seen.findIndex((c) => c.key === 'git push origin v2.1.0');
  const tagDel = seen.findIndex((c, i) => i > pushAt && c.key === 'git tag -d v2.1.0');
  assert.ok(tagDel > pushAt && seen[tagDel].cleanup, seen.map((c) => c.key).join('\n'));
  const rm = seen.filter((c) => c.key.startsWith('git worktree remove'));
  assert.ok(rm.length > 0 && rm.every((c) => c.cleanup));
  assert.ok(s.worktrees.length > 0 && s.worktrees.every((w) => !fs.existsSync(w)), 'no worktree is left on disk');
});

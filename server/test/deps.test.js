// server/test/deps.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEP_MANIFEST, checkDep, checkDeps, planDeps, planToTsv, compareVersions, latestVersions, probeArgv } from '../lib/chassis/deps.js';

const WIN_ENV = { PATH: 'C:\\Tools;C:\\Users\\u\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' };

test('probeArgv: an npm .cmd shim on Windows runs through cmd.exe by absolute path', () => {
  const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
  const a = probeArgv(['claude', '--version'], { platform: 'win32', env: WIN_ENV, exists: (p) => p === shim });
  assert.equal(a.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(a.args, ['/d', '/s', '/c', `""${shim}" --version"`]);
});

test('probeArgv: a Windows .exe runs directly, and an unknown name is left for spawn to report', () => {
  const exe = 'C:\\Tools\\gh.exe';
  assert.deepEqual(probeArgv(['gh', '--version'], { platform: 'win32', env: WIN_ENV, exists: (p) => p === exe }), { file: exe, args: ['--version'] });
  assert.deepEqual(probeArgv(['nope', '--version'], { platform: 'win32', env: WIN_ENV, exists: () => false }), { file: 'nope', args: ['--version'] });
});

test('probeArgv: off Windows the command runs as given', () => {
  assert.deepEqual(probeArgv(['claude', '--version'], { platform: 'linux', env: {}, exists: () => true }), { file: 'claude', args: ['--version'] });
});

const fakeRun = (present) => (cmd) =>
  present.includes(cmd[0]) ? { status: 0, stdout: cmd[0] + ' 1.2.3' } : { status: 127, stdout: '' };

test('manifest has node+git required, graphify+claude+gh optional', () => {
  const byName = Object.fromEntries(DEP_MANIFEST.map(d => [d.name, d]));
  assert.equal(byName.node.required, true);
  assert.equal(byName.git.required, true);
  assert.equal(byName.graphify.required, false);
  assert.equal(byName.claude.required, false);
  assert.equal(byName.gh.required, false);
});

test('checkDep reports presence/version', () => {
  const r = checkDep(DEP_MANIFEST[0], fakeRun(['node']));
  assert.equal(r.present, true);
  assert.match(r.version, /1\.2\.3/);
});

test('checkDeps ok only when all required present', () => {
  assert.equal(checkDeps(fakeRun(['node', 'git'])).ok, true);
  const miss = checkDeps(fakeRun(['node'])); // git missing
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missingRequired, ['git']);
});

test('every setup dependency carries verified install and update commands', () => {
  const byName = Object.fromEntries(DEP_MANIFEST.map(d => [d.name, d]));
  const winget = (id, verb) => ['winget', verb, '--id', id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'];
  assert.deepEqual(byName.git.install, winget('Git.Git', 'install'));
  assert.deepEqual(byName.gh.install, winget('GitHub.cli', 'install'));
  assert.deepEqual(byName.claude.install, winget('Anthropic.ClaudeCode', 'install'));
  assert.deepEqual(byName.git.update, winget('Git.Git', 'upgrade'));
  assert.deepEqual(byName.graphify.install, ['uv', 'tool', 'install', 'graphifyy']);
  assert.deepEqual(byName.graphify.update, ['uv', 'tool', 'install', 'graphifyy@latest']);
});

test('compareVersions orders dotted numbers and treats git-for-windows and winget spellings as equal', () => {
  assert.ok(compareVersions('2.103.3', '2.99.0') > 0);
  assert.ok(compareVersions('2.1.302', '2.1.303') < 0);
  assert.equal(compareVersions('git version 2.56.0.windows.4', '2.56.0.4'), 0);
  assert.equal(compareVersions('v26.10.0', '26.10'), 0);
  assert.equal(compareVersions('no version here', '1.0'), null);
});

test('planDeps: missing -> install, behind -> update-available, current -> ok, each with its command', () => {
  const { results } = checkDeps((cmd) => {
    if (cmd[0] === 'git') return { status: 0, stdout: 'git version 2.50.0.windows.1' };
    if (cmd[0] === 'gh') return { status: 0, stdout: 'gh version 2.103.3 (2026-10-01)' };
    if (cmd[0] === 'node') return { status: 0, stdout: 'v26.10.0' };
    return { status: 127, stdout: '' }; // claude, graphify absent
  });
  const plan = Object.fromEntries(planDeps(results, { git: '2.56.0.4', gh: '2.103.3' }).map(p => [p.name, p]));
  assert.equal(plan.claude.action, 'install');
  assert.deepEqual(plan.claude.command, DEP_MANIFEST.find(d => d.name === 'claude').install);
  assert.equal(plan.graphify.action, 'install');
  assert.equal(plan.git.action, 'update-available');
  assert.deepEqual(plan.git.command, DEP_MANIFEST.find(d => d.name === 'git').update);
  assert.equal(plan.git.latest, '2.56.0.4');
  assert.equal(plan.gh.action, 'ok');
  assert.equal(plan.gh.command, null);
  assert.equal(plan.node.action, 'ok');
});

test('planDeps with no latest-version data never claims an update', () => {
  const { results } = checkDeps(fakeRun(['node', 'git', 'gh', 'claude', 'graphify']));
  assert.deepEqual(planDeps(results).map(p => p.action), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('latestVersions reads the Version line of winget show and skips what it cannot read', () => {
  const run = (cmd) => cmd[3] === 'Git.Git'
    ? { status: 0, stdout: 'Found Git [Git.Git]\nVersion: 2.56.0.4\nPublisher: x' }
    : { status: 1, stdout: '' };
  assert.deepEqual(latestVersions(run), { git: '2.56.0.4' });
  assert.deepEqual(latestVersions(() => { throw new Error('no winget'); }), {});
});

test('planToTsv gives the wizard one tab-separated line per dependency, empty cells as a dash', () => {
  const lines = planToTsv([
    { name: 'git', action: 'ok', installed: 'git version 2.56.0.windows.4', latest: '2.56.0.4', command: null, update: ['winget', 'upgrade', '--id', 'Git.Git'] },
    { name: 'gh', action: 'install', installed: null, latest: null, command: ['winget', 'install', '--id', 'GitHub.cli'], update: null },
  ]).split('\n');
  assert.deepEqual(lines, [
    'git\tok\tgit version 2.56.0.windows.4\t2.56.0.4\t-\twinget upgrade --id Git.Git',
    'gh\tinstall\t-\t-\twinget install --id GitHub.cli\t-',
  ]);
});

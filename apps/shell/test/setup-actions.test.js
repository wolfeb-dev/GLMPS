import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  DEP_COMMANDS, UV_INSTALL, GH_LOGIN, CLAUDE_LOGIN, isAllowedVisibleArgv, ghRefreshArgv, depArgv, visibleSpawn, runVisible, runKernelScript,
  mergePathEntries, refreshPathFromRegistry, createSetupHandlers, slackMessage, KERNEL_SCRIPTS, EDITOR_TARGETS,
} from '../src/lib/setup/actions.js';
import { DEP_MANIFEST } from '../../../server/lib/chassis/deps.js';
import { TARGET_IDS } from '../../../server/lib/orchestration/editor-targets.js';

const ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Tools;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const CMD = 'C:\\Windows\\System32\\cmd.exe';

test('the install and update argv are a copy of the kernel dependency manifest', () => {
  assert.deepEqual(Object.keys(DEP_COMMANDS).sort(), DEP_MANIFEST.map((d) => d.name).sort());
  for (const d of DEP_MANIFEST) {
    assert.deepEqual(DEP_COMMANDS[d.name].install, d.install, `${d.name} install`);
    assert.deepEqual(DEP_COMMANDS[d.name].update, d.update, `${d.name} update`);
  }
});

test('gh and claude argv are the spec constants', () => {
  assert.deepEqual([...GH_LOGIN], ['gh', 'auth', 'login', '--web', '--git-protocol', 'https', '--scopes', 'repo,workflow,read:org']);
  assert.deepEqual([...CLAUDE_LOGIN], ['claude', 'auth', 'login']);
  assert.deepEqual(ghRefreshArgv(['workflow', 'evil', 'read:org']), ['gh', 'auth', 'refresh', '--scopes', 'workflow,read:org']);
  assert.equal(ghRefreshArgv([]), null);
  assert.equal(depArgv('constructor', 'install'), null);
});

test('only constant commands may run in a visible console', () => {
  for (const d of Object.values(DEP_COMMANDS)) { assert.ok(isAllowedVisibleArgv(d.install)); assert.ok(isAllowedVisibleArgv(d.update)); }
  assert.ok(isAllowedVisibleArgv([...GH_LOGIN]));
  assert.ok(isAllowedVisibleArgv(['gh', 'auth', 'refresh', '--scopes', 'repo,workflow']));
  for (const bad of [['cmd', '/c', 'calc'], ['gh', 'auth', 'refresh', '--scopes', 'repo,evil'], ['gh', 'auth', 'refresh', '--scopes', ''],
    ['winget', 'install', '--id', 'Evil.Pkg'], 'claude auth login', null, [], ['claude', 'auth', 'login', '& calc']]) {
    assert.equal(isAllowedVisibleArgv(bad), false, JSON.stringify(bad));
  }
});

test('visibleSpawn: start /wait through cmd.exe, an .exe by absolute path, scopes quoted', () => {
  const exe = 'C:\\Tools\\gh.exe';
  const r = visibleSpawn([...GH_LOGIN], { env: ENV, exists: (p) => p === exe });
  assert.equal(r.file, CMD);
  assert.deepEqual(r.args, [`/d /c start "" /wait "${exe}" auth login --web --git-protocol https --scopes "repo,workflow,read:org"`]);
  assert.equal(r.options.windowsVerbatimArguments, true);
  assert.equal(r.options.windowsHide, false);
  assert.equal(r.options.shell, false);
});

test('visibleSpawn: an npm .cmd shim runs through cmd.exe by absolute path', () => {
  const shim = 'C:\\npm\\claude.cmd';
  const r = visibleSpawn([...CLAUDE_LOGIN], { env: ENV, exists: (p) => p === shim });
  assert.deepEqual(r.args, [`/d /c start "" /wait "${CMD}" /d /s /c ""${shim}" auth login"`]);
});

test('visibleSpawn: a name not found on PATH is left for start to resolve', () => {
  const r = visibleSpawn(['winget', 'install'], { env: ENV, exists: () => false });
  assert.deepEqual(r.args, ['/d /c start "" /wait winget install']);
});

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => { c.killed = true; };
  return c;
}

test('runVisible resolves with the exit code, refuses a command that is not a constant, and reports a spawn error', async () => {
  const calls = [];
  const spawnImpl = (file, args, opts) => { calls.push({ file, args, opts }); const c = fakeChild(); queueMicrotask(() => c.emit('exit', 3)); return c; };
  assert.deepEqual(await runVisible([...CLAUDE_LOGIN], { spawnImpl, platform: 'win32', env: ENV, exists: () => false }), { code: 3 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await runVisible(['cmd', '/c', 'calc'], { spawnImpl, platform: 'win32', env: ENV }), { code: null, error: 'command-not-allowed' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await runVisible([...CLAUDE_LOGIN], { spawnImpl, platform: 'linux', env: ENV }), { code: null, error: 'unsupported-platform' });
  const bad = () => { const c = fakeChild(); queueMicrotask(() => c.emit('error', new Error('ENOENT'))); return c; };
  assert.deepEqual(await runVisible([...CLAUDE_LOGIN], { spawnImpl: bad, platform: 'win32', env: ENV, exists: () => false }), { code: null, error: 'ENOENT' });
});

test('runKernelScript: only allowlisted scripts, bundled node, secrets by env, last JSON line parsed', async () => {
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    calls.push({ file, args, opts });
    const c = fakeChild();
    queueMicrotask(() => { c.stdout.write('noise\n{"ok":true,"team":"ACME"}\n'); c.emit('close', 0); });
    return c;
  };
  const r = await runKernelScript({ node: 'N', kernelDir: 'K', script: 'scripts/setup/slack-connect.mjs', env: { SETUP_BOT_TOKEN: 'xoxb-s' }, baseEnv: { PATH: 'p' }, spawnImpl });
  assert.deepEqual(r, { code: 0, json: { ok: true, team: 'ACME' } });
  assert.equal(calls[0].file, 'N');
  assert.deepEqual(calls[0].args, [path.join('K', 'scripts', 'setup', 'slack-connect.mjs')]);
  assert.equal(calls[0].opts.env.SETUP_BOT_TOKEN, 'xoxb-s');
  assert.equal(calls[0].opts.shell, false);
  assert.equal(JSON.stringify(calls[0].args).includes('xoxb'), false);
  for (const script of ['scripts/evil.mjs', '../x.mjs', 'scripts/setup/glmps-setup.ps1', 'scripts/scut-setup.mjs']) {
    assert.deepEqual(await runKernelScript({ node: 'N', kernelDir: 'K', script, spawnImpl }), { code: null, error: 'script-not-allowed' });
  }
  assert.equal(calls.length, 1);
  assert.deepEqual([...KERNEL_SCRIPTS].sort(), ['scripts/glmps-init.mjs', 'scripts/install.mjs', 'scripts/setup/editor-setup.mjs', 'scripts/setup/setup-status.mjs', 'scripts/setup/slack-connect.mjs']);
});

test('runKernelScript: a text script returns its tail, a JSON script never does, a hung script times out', async () => {
  const run = (script, write, opts = {}) => runKernelScript({
    node: 'N', kernelDir: 'K', script, ...opts,
    spawnImpl: () => { const c = fakeChild(); queueMicrotask(() => write(c)); return c; },
  });
  const text = await run('scripts/install.mjs', (c) => { c.stdout.write('A) done\n'); c.stderr.write('warn\n'); setTimeout(() => c.emit('close', 0), 5); });
  assert.equal(text.code, 0);
  assert.match(text.tail, /A\) done/);
  const json = await run('scripts/setup/slack-connect.mjs', (c) => { c.stderr.write('xoxb-leak'); setTimeout(() => c.emit('close', 1), 5); });
  assert.deepEqual(json, { code: 1, json: null });
  const hung = await run('scripts/install.mjs', () => {}, { timeoutMs: 20 });
  assert.deepEqual(hung, { code: null, error: 'timeout' });
});

test('mergePathEntries dedupes ignoring case and trailing slashes, expands %VARS%, keeps the current order first', () => {
  const merged = mergePathEntries({
    current: 'C:\\A;c:\\b\\', user: '%USERPROFILE%\\bin;C:\\A', machine: 'C:\\B;C:\\New', env: { USERPROFILE: 'C:\\Users\\u' },
  });
  assert.equal(merged, 'C:\\A;c:\\b\\;C:\\Users\\u\\bin;C:\\New');
});

test('refreshPathFromRegistry reads HKCU and HKLM Path and merges them; a failing key adds nothing', async () => {
  const queried = [];
  const run = async (argv) => {
    queried.push(argv.join(' '));
    if (argv[2].startsWith('HKCU')) return { status: 0, stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Users\\u\\gh\r\n\r\n' };
    return { status: 1, stdout: '' };
  };
  const p = await refreshPathFromRegistry({ run, env: { Path: 'C:\\A', USERPROFILE: 'C:\\Users\\u' } });
  assert.equal(p, 'C:\\A;C:\\Users\\u\\bin;C:\\Users\\u\\gh');
  assert.equal(queried.length, 2);
  assert.ok(queried.every((q) => q.startsWith('reg query ')));
  const none = await refreshPathFromRegistry({ run: async () => { throw new Error('x'); }, env: { PATH: 'C:\\A' } });
  assert.equal(none, 'C:\\A');
});

function handlerHarness({ status = {}, kernelResult, onScript = null, visibleCode = 0, restart = { ok: true }, kernel = { node: 'N', kernelDir: 'K' }, stateDirOverride = null, kernelStateDir = null } = {}) {
  const calls = { visible: [], script: [], log: [], restart: 0, refresh: 0 };
  const h = createSetupHandlers({
    visible: async (argv) => { calls.visible.push(argv); return { code: typeof visibleCode === 'function' ? visibleCode(argv) : visibleCode }; },
    kernelScript: async (o) => { calls.script.push(o); onScript?.(o); return kernelResult ?? { code: 0, json: { ok: true }, tail: '' }; },
    refreshPath: async () => { calls.refresh += 1; },
    kernel, userData: fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-setup-ud-')), stateDirOverride, kernelStateDir,
    getStatus: () => status,
    restartKernel: async () => { calls.restart += 1; return restart; },
    log: (...a) => calls.log.push(a),
  });
  return { h, calls };
}

test('install-missing runs the manifest argv for each missing tool, refreshing PATH after each', async () => {
  const { h, calls } = handlerHarness({ status: { deps: [{ name: 'git', action: 'install' }, { name: 'gh', action: 'ok' }, { name: 'claude', action: 'install' }] } });
  const r = await h['deps:install-missing']();
  assert.deepEqual(calls.visible, [DEP_COMMANDS.git.install, DEP_COMMANDS.claude.install]);
  assert.equal(calls.refresh, 2);
  assert.deepEqual(r, { ok: true, message: 'Installed git, claude.' });
});

test('a failed install is named and not ok; per-item and update handlers exist for every dependency', async () => {
  const { h } = handlerHarness({ status: { deps: [{ name: 'git', action: 'install' }] }, visibleCode: 1 });
  const r = await h['deps:install-missing']();
  assert.equal(r.ok, false);
  assert.match(r.message, /git/);
  for (const name of Object.keys(DEP_COMMANDS)) { assert.equal(typeof h[`deps:install-${name}`], 'function'); assert.equal(typeof h[`deps:update-${name}`], 'function'); }
  const one = handlerHarness();
  await one.h['deps:update-gh']();
  assert.deepEqual(one.calls.visible, [DEP_COMMANDS.gh.update]);
});

test('graphify installs uv first (its installer), whatever uv answers, and uv is an allowed command', async () => {
  const { h, calls } = handlerHarness({ visibleCode: (argv) => (argv[0] === 'winget' ? 1 : 0) });
  const r = await h['deps:install-graphify']();
  assert.deepEqual(calls.visible, [UV_INSTALL, DEP_COMMANDS.graphify.install]);
  assert.equal(r.ok, true);
  assert.ok(isAllowedVisibleArgv(UV_INSTALL));
  const upd = handlerHarness();
  await upd.h['deps:update-graphify']();
  assert.deepEqual(upd.calls.visible, [DEP_COMMANDS.graphify.update]);
});

test('github sign-in logs in then connects git; refresh asks only for the missing scopes', async () => {
  const a = handlerHarness();
  assert.equal((await a.h['github:sign-in']()).ok, true);
  assert.deepEqual(a.calls.visible, [[...GH_LOGIN], ['gh', 'auth', 'setup-git']]);
  const failed = handlerHarness({ visibleCode: 1 });
  assert.equal((await failed.h['github:sign-in']()).ok, false);
  assert.equal(failed.calls.visible.length, 1);
  const b = handlerHarness({ status: { github: { missingScopes: ['workflow'] } } });
  await b.h['github:refresh-scopes']();
  assert.deepEqual(b.calls.visible, [['gh', 'auth', 'refresh', '--scopes', 'workflow']]);
  assert.deepEqual(await handlerHarness().h['github:refresh-scopes'](), { ok: true, message: 'No permissions are missing.' });
});

test('slack connect: tokens go by env only, never argv, log or result, and the kernel restarts on success', async () => {
  const BOT = 'xoxb-very-secret';
  const APP = 'xapp-very-secret';
  const result = { code: 0, json: { ok: true, team: 'ACME', botUser: 'riker', channels: { created: ['a'], existing: ['b'] }, userId: 'U1', joined: ['a', 'b'], warnings: [] } };
  const { h, calls } = handlerHarness({ kernelResult: result });
  const r = await h['slack:connect']({ botToken: ` ${BOT} `, appToken: APP, email: 'me@acme.co', memberId: '' });
  assert.equal(r.ok, true);
  assert.equal(calls.restart, 1);
  assert.deepEqual(calls.script[0].env, { SETUP_BOT_TOKEN: BOT, SETUP_APP_TOKEN: APP, SETUP_SLACK_EMAIL: 'me@acme.co', SETUP_SLACK_MEMBER_ID: '' });
  assert.equal(calls.script[0].args, undefined);
  const everything = JSON.stringify([calls.log, r]);
  assert.ok(!everything.includes('very-secret'), everything);
});

test('slack connect: bad tokens never reach the script, a Slack failure explains itself and restarts nothing', async () => {
  const none = handlerHarness();
  const bad = await none.h['slack:connect']({ botToken: 'nope', appToken: 'xapp-1' });
  assert.equal(bad.ok, false);
  assert.equal(none.calls.script.length, 0);
  const rejected = handlerHarness({ kernelResult: { code: 1, json: { ok: false, error: 'invalid_auth' } } });
  const r = await rejected.h['slack:connect']({ botToken: 'xoxb-a', appToken: 'xapp-b' });
  assert.equal(r.ok, false);
  assert.match(r.message, /invalid_auth/);
  assert.equal(rejected.calls.restart, 0);
  assert.match(slackMessage(null), /did not answer/);
  const nokernel = await handlerHarness({ kernel: null }).h['slack:connect']({ botToken: 'xoxb-a', appToken: 'xapp-b' });
  assert.equal(nokernel.ok, false);
});

test('slack connect: a failed restart is reported but the connect still counts', async () => {
  const { h } = handlerHarness({ kernelResult: { code: 0, json: { ok: true, team: 'T', botUser: 'b', channels: { created: [], existing: [] }, warnings: [] } }, restart: { ok: false, message: 'not owned' } });
  const r = await h['slack:connect']({ botToken: 'xoxb-a', appToken: 'xapp-b' });
  assert.equal(r.ok, true);
  assert.match(r.message, /could not restart/);
});

test('repos scan: validates the folder and engagement, then runs glmps-init in the user data dir', async () => {
  const { h, calls } = handlerHarness();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-repos-'));
  assert.equal((await h['repos:scan']({ folder: 'relative', engagement: 'acme' })).ok, false);
  assert.equal((await h['repos:scan']({ folder: path.join(folder, 'nope'), engagement: 'acme' })).ok, false);
  assert.equal((await h['repos:scan']({ folder, engagement: '--force' })).ok, false);
  assert.equal((await h['repos:scan']({ folder, engagement: '' })).ok, false);
  assert.equal(calls.script.length, 0);
  const r = await h['repos:scan']({ folder, engagement: 'acme' });
  assert.equal(r.ok, true);
  assert.equal(calls.script[0].script, 'scripts/glmps-init.mjs');
  assert.deepEqual(calls.script[0].args, ['--engagement', 'acme', '--search', folder, '--force']);
  assert.ok(calls.script[0].cwd);
});

test('ide install runs the installer script and reports its exit', async () => {
  const ok = handlerHarness({ kernelResult: { code: 0, tail: 'done' } });
  assert.equal((await ok.h['ide:install-hooks']()).ok, true);
  assert.equal(ok.calls.script[0].script, 'scripts/install.mjs');
  const bad = handlerHarness({ kernelResult: { code: 1, tail: 'refused: x' } });
  const r = await bad.h['ide:install-hooks']();
  assert.equal(r.ok, false);
  assert.match(r.message, /refused: x/);
});

// Card glmps-2-0-205: the state-dir override reaches every kernel script, not
// only Slack connect, or the status reads a different dir than connect wrote.
test('a state-dir override is passed as GLMPS_STATE_DIR to every kernel script the wizard runs', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-repos-'));
  const { h, calls } = handlerHarness({ stateDirOverride: 'D:\state', kernelResult: { code: 0, json: { ok: true, channels: { created: [], existing: [] }, warnings: [] }, tail: '' } });
  await h['slack:connect']({ botToken: 'xoxb-a', appToken: 'xapp-b' });
  await h['ide:install-hooks']();
  await h['repos:scan']({ folder, engagement: 'acme' });
  assert.deepEqual(calls.script.map((s) => [s.script, s.env?.GLMPS_STATE_DIR]), [
    ['scripts/setup/slack-connect.mjs', 'D:\state'], ['scripts/install.mjs', 'D:\state'], ['scripts/glmps-init.mjs', 'D:\state'],
  ]);
  const plain = handlerHarness();
  await plain.h['ide:install-hooks']();
  assert.equal(plain.calls.script[0].env?.GLMPS_STATE_DIR, undefined);
});

test('repos scan: the profile is copied into the kernel state dir and the kernel restarts to use it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-repos-'));
  const kernelStateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-ksd-')), 'state');
  const writeProfile = (o) => fs.writeFileSync(path.join(o.cwd, 'glmps.profile.json'), '{"engagement":"acme"}');
  const { h, calls } = handlerHarness({ kernelStateDir, onScript: writeProfile });
  const r = await h['repos:scan']({ folder, engagement: 'acme' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(kernelStateDir, 'glmps.profile.json'), 'utf8'), '{"engagement":"acme"}');
  assert.equal(calls.restart, 1);
  assert.match(r.message, /restarted/);

  const stuck = handlerHarness({ kernelStateDir, onScript: writeProfile, restart: { ok: false, message: 'not owned' } });
  const s = await stuck.h['repos:scan']({ folder, engagement: 'acme' });
  assert.equal(s.ok, true);
  assert.match(s.message, /could not restart.*tray/);

  const failed = handlerHarness({ kernelStateDir, kernelResult: { code: 1, tail: 'boom' } });
  assert.equal((await failed.h['repos:scan']({ folder, engagement: 'acme' })).ok, false);
  assert.equal(failed.calls.restart, 0);
});

test('slack connect: an app token Slack rejects explains which token and what it needs', () => {
  for (const code of ['app_token:invalid_auth', 'app_token:not_allowed_token_type', 'app_token:missing_scope', 'app_token:token_revoked']) {
    assert.match(slackMessage({ ok: false, error: code }), /app-level token/, code);
  }
  assert.match(slackMessage({ ok: false, error: 'app_token:missing_scope' }), /connections:write/);
});

// Card glmps-2-0-218: the Default IDE step.
test('the wizard knows exactly the six launch targets the kernel has', () => {
  assert.deepEqual(Object.keys(EDITOR_TARGETS), [...TARGET_IDS]);
});

const editorStatus = (companion) => ({ editors: [{ id: 'vscode', label: 'VS Code', installed: true, companion }, { id: 'native-terminal', label: 'Native terminal', installed: true, companion: false }], editorPick: { lastTarget: null, openTarget: null } });

test('editor choose: saves the pick through the kernel script, then installs the companion into that IDE', async () => {
  const { h, calls } = handlerHarness({ status: editorStatus(false) });
  const r = await h['editor:choose-vscode']();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.script.map((s) => [s.script, s.args]), [
    ['scripts/setup/editor-setup.mjs', ['save', 'vscode']],
    ['scripts/setup/editor-setup.mjs', ['install', 'vscode']],
  ]);
  assert.match(r.message, /VS Code/);
});

test('editor choose: an IDE that already has the companion is not reinstalled; the native terminal installs nothing', async () => {
  const has = handlerHarness({ status: editorStatus(true) });
  assert.equal((await has.h['editor:choose-vscode']()).ok, true);
  assert.deepEqual(has.calls.script.map((s) => s.args), [['save', 'vscode']]);
  const native = handlerHarness({ status: editorStatus(false) });
  assert.equal((await native.h['editor:choose-native-terminal']()).ok, true);
  assert.deepEqual(native.calls.script.map((s) => s.args), [['save', 'native-terminal']]);
});

test('editor choose: a failed install keeps the saved pick and names the reason', async () => {
  const results = [{ code: 0, json: { ok: true, target: 'vscode' } }, { code: 1, json: { ok: false, reason: 'no-package' } }];
  const { h } = handlerHarness({ status: editorStatus(false) });
  const calls = [];
  const h2 = createSetupHandlers({
    visible: async () => ({ code: 0 }), kernelScript: async (o) => { calls.push(o.args); return results.shift(); },
    kernel: { node: 'N', kernelDir: 'K' }, userData: os.tmpdir(), getStatus: () => editorStatus(false), log: () => {},
  });
  void h;
  const r = await h2['editor:choose-vscode']();
  assert.equal(r.ok, false);
  assert.match(r.message, /no extension package/i);
  assert.match(r.message, /saved/i);
});

test('editor choose: a save that fails stops before any install', async () => {
  const { h, calls } = handlerHarness({ status: editorStatus(false), kernelResult: { code: 1, json: { ok: false, reason: 'not-saved: EACCES' } } });
  const r = await h['editor:choose-vscode']();
  assert.equal(r.ok, false);
  assert.equal(calls.script.length, 1);
});

test('editor install-companion installs into the saved pick only', async () => {
  const st = { ...editorStatus(false), editorPick: { lastTarget: 'vscode', openTarget: 'vscode' } };
  const { h, calls } = handlerHarness({ status: st });
  assert.equal((await h['editor:install-companion']()).ok, true);
  assert.deepEqual(calls.script.map((s) => s.args), [['install', 'vscode']]);
  const none = handlerHarness({ status: editorStatus(false) });
  assert.equal((await none.h['editor:install-companion']()).ok, false);
  assert.equal(none.calls.script.length, 0);
  const native = handlerHarness({ status: { ...editorStatus(false), editorPick: { lastTarget: 'native-terminal', openTarget: 'native-terminal' } } });
  assert.equal((await native.h['editor:install-companion']()).ok, false);
  assert.equal(native.calls.script.length, 0);
});

test('editor handlers need the local kernel and carry the state-dir override', async () => {
  const noKernel = handlerHarness({ kernel: null, status: editorStatus(false) });
  assert.equal((await noKernel.h['editor:choose-vscode']()).ok, false);
  assert.equal(noKernel.calls.script.length, 0);
  const { h, calls } = handlerHarness({ stateDirOverride: 'D:\\state', status: editorStatus(true) });
  await h['editor:choose-vscode']();
  assert.equal(calls.script[0].env?.GLMPS_STATE_DIR, 'D:\\state');
});

test('no editor handler exists for a target outside the six', () => {
  const { h } = handlerHarness();
  assert.equal(h['editor:choose-zed'], undefined);
  assert.equal(h['editor:choose-constructor'], undefined);
});

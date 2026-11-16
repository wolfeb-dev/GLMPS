import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardLiveWrite, parseLivePaths, liveInstallApproved } from '../lib/governance/live-install-guard.js';

const LIVE = parseLivePaths('D:\\LiveTrading\\Install');

test('parseLivePaths splits, normalizes slashes/case, trims trailing slash', () => {
  const p = parseLivePaths('D:\\A\\B\\ ; C:/x/y/ \n');
  assert.deepEqual(p, ['d:/a/b', 'c:/x/y']);
  assert.deepEqual(parseLivePaths(''), []);
});

test('blocks an Edit/Write into a live-install path', () => {
  const r = guardLiveWrite({
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\LiveTrading\\Install\\bin\\Custom\\Strategies\\Evil.cs' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /live-install/i);
});

test('allows a write outside live-install paths', () => {
  const r = guardLiveWrite({
    tool_name: 'Edit',
    tool_input: { file_path: 'D:\\DevProject\\Strategies\\Thing.cs' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, false);
});

test('blocks a Bash copy INTO a live-install path', () => {
  const r = guardLiveWrite({
    tool_name: 'Bash',
    tool_input: { command: 'cp ./Evil.cs "D:/LiveTrading/Install/bin/Custom/Strategies/"' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, true);
});

// Scan 2026-10-15 F1: default-deny on reference, no write-verb list.
test('F1: any Bash reference to a live-install path is blocked, reads included', () => {
  const r = guardLiveWrite({
    tool_name: 'Bash',
    tool_input: { command: 'cat "D:/LiveTrading/Install/log.txt"' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Read tool/);
});

test('F1: a Bash write with no listed verb is blocked', () => {
  for (const command of [
    'python -c "open(r\'D:\\LiveTrading\\Install\\bin\\x.cs\',\'w\').write(1)"',
    'node -e "require(\'fs\').writeFileSync(\'D:/LiveTrading/Install/x.cs\', 1)"',
    'install -m 644 Evil.cs D:/LiveTrading/Install/bin/',
    'rsync Evil.cs D:\\LiveTrading\\Install\\bin\\',
  ]) assert.equal(guardLiveWrite({ tool_name: 'Bash', tool_input: { command }, livePaths: LIVE }).blocked, true, command);
});

test('F1: other spellings of a live root are blocked', () => {
  for (const command of [
    'cp Evil.cs /d/LiveTrading/Install/bin/',
    'cp Evil.cs /mnt/d/livetrading/install/bin/',
    'cp Evil.cs /cygdrive/d/LiveTrading/Install',
    'copy Evil.cs D:\\\\LiveTrading\\\\Install\\\\bin',
    'cp Evil.cs D://LiveTrading//Install/bin',
    'cp Evil.cs "D:/Live"Trading/Install/bin',
    'Copy-Item Evil.cs D:\\Live`Trading\\Install',
    'copy Evil.cs D:\\Live^Trading\\Install',
    'cd /d D:\\LIVETRADING\\INSTALL && copy Evil.cs .',
  ]) assert.equal(guardLiveWrite({ tool_name: 'Bash', tool_input: { command }, livePaths: LIVE }).blocked, true, command);
});

test('F1: a home-directory variable spelling of a live root under home is blocked', () => {
  const live = parseLivePaths('C:\\Users\\op\\Documents\\NinjaTrader 8\\bin\\Custom');
  for (const command of [
    'cp Evil.cs ~/Documents/"NinjaTrader 8"/bin/Custom/',
    'cp Evil.cs "$HOME/Documents/NinjaTrader 8/bin/Custom"',
    'cp Evil.cs "${HOME}/Documents/NinjaTrader 8/bin/Custom"',
    'Copy-Item Evil.cs "$env:USERPROFILE\\Documents\\NinjaTrader 8\\bin\\Custom"',
    'copy Evil.cs "%USERPROFILE%\\Documents\\NinjaTrader 8\\bin\\Custom"',
  ]) assert.equal(guardLiveWrite({ tool_name: 'Bash', tool_input: { command }, livePaths: live, home: 'C:\\Users\\op' }).blocked, true, command);
});

test('F1: a Bash command that names no live root is allowed', () => {
  for (const command of ['cp a.cs D:/DevProject/Strategies/', 'git status', 'ls ~/Documents', 'echo $HOME']) {
    assert.equal(guardLiveWrite({ tool_name: 'Bash', tool_input: { command }, livePaths: LIVE, home: 'C:\\Users\\op' }).blocked, false, command);
  }
});

test('no live paths configured => never blocks (guard disabled)', () => {
  const r = guardLiveWrite({
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\LiveTrading\\Install\\x.cs' },
    livePaths: [],
  });
  assert.equal(r.blocked, false);
});

test('non-write tools are ignored', () => {
  assert.equal(guardLiveWrite({ tool_name: 'Read', tool_input: { file_path: 'D:/LiveTrading/Install/x.cs' }, livePaths: LIVE }).blocked, false);
});

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'live-install-guard.js');

function runHook({ cwd, livePath, target, extraEnv = {} }) {
  const env = { ...process.env, GLMPS_LIVE_INSTALL_PATHS: livePath };
  delete env.GLMPS_ALLOW_LIVE_INSTALL;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target }, cwd }), env, encoding: 'utf8',
  });
}

test('F10: an agent-written live-install.allow in its own cwd no longer approves a live write', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-cwd-'));
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-live-'));
  try {
    fs.writeFileSync(path.join(cwd, 'live-install.allow'), '');
    const r = runHook({ cwd, livePath: live, target: path.join(live, 'bin', 'Custom', 'Evil.cs') });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /BLOCKED/);
    assert.match(r.stderr, /live-install\.allow.*ignored.*GLMPS_ALLOW_LIVE_INSTALL=1/s, 'a one-line notice names the ignored file and the env switch');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(live, { recursive: true, force: true }); }
});

test('F10: GLMPS_ALLOW_LIVE_INSTALL=1 in the hook environment still approves a deliberate deploy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-cwd-'));
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-live-'));
  try {
    const r = runHook({ cwd, livePath: live, target: path.join(live, 'x.cs'), extraEnv: { GLMPS_ALLOW_LIVE_INSTALL: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(liveInstallApproved({ GLMPS_ALLOW_LIVE_INSTALL: '1' }), true);
    assert.equal(liveInstallApproved({}), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(live, { recursive: true, force: true }); }
});

test('review P4: a relative Edit path is resolved against the cwd before matching', () => {
  const livePaths = parseLivePaths('C:/nt');
  const hit = (file_path, cwd) => guardLiveWrite({ tool_name: 'Write', tool_input: { file_path }, livePaths, cwd }).blocked;
  assert.equal(hit('bin/x.cs', 'C:/nt'), true);
  assert.equal(hit('x.cs', 'C:\\nt\\bin'), true);
  assert.equal(hit('../nt/x.cs', 'C:/other'), true);
  assert.equal(hit('C:/other/../nt/x.cs', 'C:/other'), true);
  assert.equal(hit('./x.cs', 'C:/other'), false);
  assert.equal(hit('../x.cs', 'C:/nt/bin'), true);
  assert.equal(hit('C:/nt2/x.cs', 'C:/other'), false);
  assert.equal(hit('x.cs', ''), false);
});

test('review P4: the Bash branch matches the live root only at a path boundary', () => {
  const livePaths = parseLivePaths('C:/nt');
  const hit = (command) => guardLiveWrite({ tool_name: 'Bash', tool_input: { command }, livePaths }).blocked;
  assert.equal(hit('cp x C:/nt2/y'), false);
  assert.equal(hit('cp x C:/ntfoo'), false);
  assert.equal(hit('cp x C:/nt/y'), true);
  assert.equal(hit('cp x C:\\nt'), true);
  assert.equal(hit('cp x "C:/nt"'), true);
  assert.equal(hit('cd C:/nt && ls'), true);
});

test('review P4: the hook passes its cwd so a relative path into the live root is blocked', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-live-'));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lig-away-'));
  try {
    assert.equal(runHook({ cwd: live, livePath: live, target: 'x.cs' }).status, 2);
    assert.equal(runHook({ cwd: away, livePath: live, target: 'x.cs' }).status, 0);
  } finally { fs.rmSync(live, { recursive: true, force: true }); fs.rmSync(away, { recursive: true, force: true }); }
});

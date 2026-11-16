import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProfile, captureCpuProfile, keepProfile, trackSpawns, spawnKey } from '../lib/kernel/cpu-profile.js';
import { startServer } from '../server.js';

// A hand-built V8 profile: root -> (idle), root -> outer -> inner. Each sample is 1 ms.
function fixture(seq) {
  const frame = (functionName, url = 'file:///srv/a.js', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' });
  const nodes = [
    { id: 1, callFrame: frame('(root)', ''), children: [2, 3] },
    { id: 2, callFrame: frame('(idle)', ''), children: [] },
    { id: 3, callFrame: frame('outer', 'file:///srv/a.js', 9), children: [4] },
    { id: 4, callFrame: frame('inner', 'file:///srv/b.js', 41), children: [] },
  ];
  const ids = { idle: 2, outer: 3, inner: 4 };
  const samples = seq.map((k) => ids[k]);
  return { nodes, startTime: 0, endTime: samples.length * 1000, samples, timeDeltas: samples.map(() => 1000) };
}

test('a busy run over the threshold is reported with its self and inclusive functions', () => {
  const seq = [...Array(5).fill('idle'), ...Array(30).fill('inner'), ...Array(10).fill('outer'), ...Array(5).fill('idle'), ...Array(4).fill('inner')];
  const r = analyzeProfile(fixture(seq), { thresholdMs: 20 });
  assert.equal(r.durationMs, 54);
  assert.equal(r.busyMs, 44);
  assert.equal(r.longestRunMs, 40);
  assert.equal(r.runs.length, 1);
  const [run] = r.runs;
  assert.equal(run.ms, 40);
  assert.equal(run.startMs, 5);
  assert.deepEqual(run.self[0], { fn: 'inner', at: 'b.js:42', ms: 30 });
  assert.deepEqual(run.self[1], { fn: 'outer', at: 'a.js:10', ms: 10 });
  assert.deepEqual(run.inclusive[0], { fn: 'outer', at: 'a.js:10', ms: 40 });
  assert.equal(run.stack.join(' > '), 'outer (a.js:10) > inner (b.js:42)');
});

test('no run reaches the threshold: none reported, the longest still measured', () => {
  const r = analyzeProfile(fixture(['inner', 'inner', 'idle', 'outer']), { thresholdMs: 20 });
  assert.deepEqual(r.runs, []);
  assert.equal(r.longestRunMs, 2);
});

test('capture profiles this process and sees a synchronous block', async () => {
  let started;
  const ready = new Promise((r) => { started = r; });
  const p = captureCpuProfile({ seconds: 1, onStarted: () => started() });
  await ready;
  const end = Date.now() + 400;
  (function spinForStallTest() { while (Date.now() < end); })();
  const profile = await p;
  const r = analyzeProfile(profile, { thresholdMs: 300 });
  assert.equal(r.runs.length, 1, JSON.stringify(r));
  assert.ok(r.runs[0].inclusive.some((f) => f.fn === 'spinForStallTest'), JSON.stringify(r.runs[0].inclusive));
});

test('trackSpawns counts and times every child-process launch by command, then restores', async () => {
  const { execFile } = await import('node:child_process');
  const { ChildProcess } = await import('node:child_process');
  const before = ChildProcess.prototype.spawn;
  const stop = trackSpawns();
  const run = (args) => new Promise((r) => execFile(process.execPath, args, () => r()));
  await run(['-e', '0']);
  await run(['-e', '0']);
  await run(['--version']);
  const s = stop();
  assert.equal(ChildProcess.prototype.spawn, before);
  assert.equal(s.total, 3);
  const node = path.basename(process.execPath, path.extname(process.execPath));
  assert.deepEqual(new Map(s.byCommand.map((c) => [c.cmd, c.n])), new Map([[`${node} -e`, 2], [`${node} --version`, 1]]));
  assert.ok(s.byCommand[0].ms >= 0 && typeof s.byCommand[0].maxMs === 'number');
  await run(['-e', '0']);
  assert.equal(s.total, 3, 'nothing counted after stop');
});

test('spawnKey drops -C <dir> and option values so one git subcommand groups together', () => {
  assert.equal(spawnKey('C:\\Program Files\\Git\\cmd\\git.exe', ['git', '-C', 'D:/a', 'status', '--porcelain=v2']), 'git status');
  assert.equal(spawnKey('git', ['git', '-C', 'D:/b', 'worktree', 'list', '--porcelain']), 'git worktree list');
  assert.equal(spawnKey('tasklist', ['tasklist', '/FI', 'IMAGENAME eq x', '/FO', 'CSV']), 'tasklist /FI');
});

test('spawnKey keys a shell launch on the command it runs', () => {
  assert.equal(spawnKey('/bin/sh', ['/bin/sh', '-c', 'git -C D:/a status --porcelain']), 'git status');
  assert.equal(spawnKey('C:\\Windows\\system32\\cmd.exe', ['cmd.exe', '/d', '/s', '/c', '"claude --version"']), 'claude --version');
});

test('keepProfile writes into the diagnostics dir and keeps the newest 5', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cpuprof-'));
  for (let i = 0; i < 7; i++) keepProfile(dir, { nodes: [], i }, { now: () => Date.UTC(2026, 9, 28, 0, 0, i) });
  const files = fs.readdirSync(path.join(dir, 'diagnostics')).sort();
  assert.equal(files.length, 5);
  assert.match(files[0], /^cpu-2026-10-28T00-00-02.*\.cpuprofile$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics', files[4]), 'utf8')).i, 6);
});

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cpuprof-srv-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
}

test('POST /api/diagnostics/cpu-profile: validates, answers a summary, one at a time', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  const url = `http://127.0.0.1:${srv.port}`;
  try {
    const post = (body) => fetch(`${url}/api/diagnostics/cpu-profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ seconds: 0 })).status, 400);
    assert.equal((await post({ seconds: 121 })).status, 400);
    const both = await Promise.all([post({ seconds: 1, thresholdMs: 1000 }), post({ seconds: 1, thresholdMs: 1000 })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    const res = both.find((r) => r.status === 200);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.durationMs >= 900, JSON.stringify(body));
    assert.ok(Array.isArray(body.runs));
    assert.equal(typeof body.spawns?.total, 'number');
    assert.ok(Array.isArray(body.spawns.byCommand));
    assert.equal(body.kept, null);
  } finally {
    await srv.close();
  }
});

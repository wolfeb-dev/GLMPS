// Tests for the headless replay launcher (glmps-68). No real claude, no real
// git - spawn/exec are injected fakes; state goes to a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  validModel, buildReplayArgs, parseReplayOutput, replayOutcomeRow,
  runReplayTask, runReplaySet,
} from '../lib/evaluation/replay-launch.js';
import { readOutcomes } from '../lib/evaluation/outcome-store.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-')); tmpDirs.push(d); return d; }

// A fake claude process: emits the given stdout and exits.
function fakeSpawn({ stdout = '', code = 0, capture = {} } = {}) {
  return (file, args, opts) => {
    capture.file = file; capture.args = args; capture.opts = opts; capture.stdin = '';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (d) => { capture.stdin += d; }, end: () => {} };
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); });
    return child;
  };
}

const GOOD_JSON = JSON.stringify({
  type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1',
  num_turns: 7, duration_ms: 42000, total_cost_usd: 0.55,
  usage: { input_tokens: 1200, output_tokens: 800 },
});

test('validModel accepts plain model ids and rejects argv-hostile strings', () => {
  assert.ok(validModel('claude-sonnet-5'));
  assert.ok(validModel('claude-opus-4-8'));
  assert.ok(!validModel('x && calc.exe'));
  assert.ok(!validModel('--dangerously-skip-permissions'));
  assert.ok(!validModel(''));
  assert.ok(!validModel(null));
});

test('buildReplayArgs: no prompt on argv; model appended only when given; invalid model throws', () => {
  const base = buildReplayArgs({});
  assert.equal(base.file, 'claude');
  assert.deepEqual(base.args, ['-p', '--output-format', 'json', '--max-turns', '25']);
  const withModel = buildReplayArgs({ model: 'claude-sonnet-5' });
  assert.deepEqual(withModel.args.slice(-2), ['--model', 'claude-sonnet-5']);
  assert.throws(() => buildReplayArgs({ model: 'bad model!' }));
});

test('parseReplayOutput maps the claude -p json shape; garbage is ok:false', () => {
  const p = parseReplayOutput(GOOD_JSON);
  assert.equal(p.ok, true);
  assert.equal(p.turns, 7);
  assert.equal(p.tokens.in, 1200);
  assert.equal(parseReplayOutput('not json').ok, false);
});

test('replayOutcomeRow: model run tags unit model-<id>; baseline run tags replay-baseline', () => {
  const parsed = parseReplayOutput(GOOD_JSON);
  const task = { id: 't1', prompt: 'fix the bug in foo.js' };
  const tagged = replayOutcomeRow({ task, model: 'claude-sonnet-5', parsed, now: 123 });
  assert.equal(tagged.unit, 'model-claude-sonnet-5');
  assert.equal(tagged.model, 'claude-sonnet-5');
  assert.equal(tagged.turns, 7);
  assert.equal(tagged.verifier.exitOk, true);
  assert.equal(tagged.extra.replayTask, 't1');
  const baseline = replayOutcomeRow({ task, model: null, parsed, now: 123 });
  assert.equal(baseline.unit, 'replay-baseline');
  assert.equal(baseline.model, null);
});

test('runReplayTask pipes the prompt via stdin, appends a model-tagged row', async () => {
  const stateDir = mkTmp();
  const promptFile = path.join(mkTmp(), 'p.md');
  fs.writeFileSync(promptFile, 'refactor the widget');
  const capture = {};
  const { row } = await runReplayTask({
    stateDir, task: { id: 't2', promptFile }, repo: null, model: 'claude-sonnet-5',
    spawnFn: fakeSpawn({ stdout: GOOD_JSON, capture }),
    execFn: () => '',
  });
  assert.equal(capture.stdin, 'refactor the widget');
  assert.ok(!capture.args.join(' ').includes('refactor'), 'prompt must not be on argv');
  assert.equal(row.unit, 'model-claude-sonnet-5');
  const stored = readOutcomes(stateDir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, row.id);
});

test('runReplayTask provisions + force-removes a disposable worktree when repo/worktreesDir given', async () => {
  const stateDir = mkTmp();
  const gitCalls = [];
  const { row } = await runReplayTask({
    // a temp-dir repo path (basename 'repo'), since
    // a real, non-temp one is now refused in a test process (next test).
    stateDir, task: { id: 't3', prompt: 'x' }, repo: path.join(mkTmp(), 'repo'), worktreesDir: mkTmp(),
    spawnFn: fakeSpawn({ stdout: GOOD_JSON }),
    execFn: (file, args) => { gitCalls.push(args.join(' ')); return ''; },
    now: () => 999,
  });
  assert.ok(row);
  assert.ok(gitCalls.some(c => c.includes('worktree add')), 'adds a worktree');
  assert.ok(gitCalls.some(c => c.includes('worktree remove')), 'removes it after');
  assert.ok(gitCalls.some(c => c.includes('branch -D replay/repo/t3-999')), 'deletes the disposable branch');
});

// /api/replay/run's worktree add, worktree remove
// --force, branch -D and prune all target the task's repo. In a test process a
// real (non-temp) repo is refused before any of them, and before the headless
// run itself. Both exec and spawn are recorders; the repo path never exists.
test('M5: in a test process, a real (non-temp) repo is refused before any git write or spawn', async () => {
  const stateDir = mkTmp();
  const realRepo = path.join(os.homedir(), `mc-test-not-a-repo-${Date.now()}`);
  const gitCalls = [];
  let spawned = false;
  const res = await runReplayTask({
    stateDir, task: { id: 'm5', prompt: 'x' }, repo: realRepo, worktreesDir: mkTmp(),
    spawnFn: (...a) => { spawned = true; return fakeSpawn({ stdout: GOOD_JSON })(...a); },
    execFn: (file, args) => { gitCalls.push(args.join(' ')); return ''; },
  });
  assert.equal(res.row, null);
  assert.match(res.error, /test process/);
  assert.deepEqual(gitCalls, [], 'no git command was issued against the real repo');
  assert.equal(spawned, false, 'the headless run never started');
  assert.equal(readOutcomes(stateDir).length, 0);
});

test('M5: the refusal is injectable - a caller-supplied guard that allows the repo lets the run proceed', async () => {
  const stateDir = mkTmp();
  const gitCalls = [];
  const { row } = await runReplayTask({
    stateDir, task: { id: 'm5b', prompt: 'x' }, repo: 'D:/some/repo', worktreesDir: mkTmp(),
    gitWriteRefused: () => false,
    spawnFn: fakeSpawn({ stdout: GOOD_JSON }),
    execFn: (file, args) => { gitCalls.push(args.join(' ')); return ''; },
  });
  assert.ok(row);
  assert.ok(gitCalls.some(c => c.includes('worktree add')));
});

test('runReplayTask fail paths: invalid model / missing prompt produce no row', async () => {
  const stateDir = mkTmp();
  const bad = await runReplayTask({ stateDir, task: { id: 't4', prompt: 'x' }, model: 'no good' });
  assert.equal(bad.row, null);
  const noPrompt = await runReplayTask({ stateDir, task: { id: 't5' }, spawnFn: fakeSpawn({}) });
  assert.equal(noPrompt.row, null);
  assert.equal(readOutcomes(stateDir).length, 0);
});

test('runReplayTask marks failed runs verifier.exitOk false but still records the row', async () => {
  const stateDir = mkTmp();
  const { row } = await runReplayTask({
    stateDir, task: { id: 't6', prompt: 'x' },
    spawnFn: fakeSpawn({ stdout: 'crashed', code: 1 }),
    execFn: () => '',
  });
  assert.equal(row.verifier.exitOk, false);
  assert.equal(readOutcomes(stateDir).length, 1);
});

test('runReplaySet runs tasks serially and reports per-task results', async () => {
  const stateDir = mkTmp();
  const results = await runReplaySet({
    stateDir,
    tasks: [{ id: 'a', prompt: 'one' }, { id: 'b' }],
    repoFor: () => null,
    model: 'claude-sonnet-5',
    spawnFn: fakeSpawn({ stdout: GOOD_JSON }),
    execFn: () => '',
  });
  assert.equal(results.length, 2);
  assert.ok(results[0].row);
  assert.equal(results[1].row, null);
  assert.equal(readOutcomes(stateDir).length, 1);
});

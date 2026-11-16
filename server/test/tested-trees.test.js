import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  testedTreesFile, testedTreeRecord, recordTestedTree, readTestedTrees, findTestedTree,
  mainSuiteRecord, lastGreenRecord, isAtOrBehindLastGreen,
} from '../lib/orchestration/tested-trees.js';

const TS = '2026-10-28T10:00:00.000Z';
const mr = { repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'aaa111' };
const passTests = { status: 'pass', treeSha: 'ttt333', headSha: 'aaa111', mergedBaseSha: 'bbb222', durationMs: 12, tail: 'ok' };

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tested-trees-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('testedTreesFile lives in the state dir ledgers folder', () => {
  assert.equal(testedTreesFile('/s').replace(/\\/g, '/'), '/s/ledgers/tested-trees.jsonl');
});

test('testedTreeRecord: a pass names the tree, both shas, the command and the PR, with no output tail', () => {
  const rec = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', command: 'npm test', tests: passTests }, ts: TS });
  assert.deepEqual(rec, {
    ts: TS, treeSha: 'ttt333', status: 'pass', headSha: 'aaa111', mergedBaseSha: 'bbb222',
    command: 'npm test', durationMs: 12, repo: 'acme/widgets', number: 7, base: 'main', cardId: 'c1', flaky: false,
  });
});

test('testedTreeRecord: a fail and a skip are recorded with their status; a flaky pass says so', () => {
  const fail = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'fail', tests: { ...passTests, status: 'fail', reason: 'exit code 1' } }, ts: TS });
  assert.equal(fail.status, 'fail');
  assert.equal(fail.reason, 'exit code 1');
  const skip = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: { status: 'skipped', reason: 'no test command configured', treeSha: 'ttt333', headSha: 'aaa111', mergedBaseSha: 'bbb222' } }, ts: TS });
  assert.equal(skip.status, 'skipped');
  assert.equal(skip.command, null);
  const flaky = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: { ...passTests, flaky: { firstExitCode: 1 } } }, ts: TS });
  assert.equal(flaky.flaky, true);
  const fallback = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: { ...passTests, command: 'npm run build' } }, ts: TS });
  assert.equal(fallback.command, 'npm run build', 'a fallback script names itself on the record');
});

test('testedTreeRecord: no record without a tree sha, or for a held, conflict or error outcome', () => {
  assert.equal(testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: { ...passTests, treeSha: null } }, ts: TS }), null);
  assert.equal(testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'held', reason: 'no shell' }, ts: TS }), null);
  assert.equal(testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'conflict', conflict: { files: ['a'] } }, ts: TS }), null);
  assert.equal(testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'error', tests: { ...passTests, status: 'error' } }, ts: TS }), null);
  assert.equal(testedTreeRecord({ id: 'c1', mr, outcome: null, ts: TS }), null);
});

test('recordTestedTree appends one line per record and readTestedTrees reads them back in order', (t) => {
  const dir = tmpState(t);
  assert.deepEqual(readTestedTrees(dir), [], 'a missing file is no records');
  const a = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', command: 'npm test', tests: passTests }, ts: TS });
  const b = { ...a, ts: '2026-10-28T11:00:00.000Z', treeSha: 'uuu444', status: 'fail' };
  recordTestedTree(dir, a);
  recordTestedTree(dir, b);
  assert.equal(recordTestedTree(dir, null), false, 'nothing to record writes nothing');
  const lines = fs.readFileSync(testedTreesFile(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(readTestedTrees(dir), [a, b]);
});

test('readTestedTrees skips a torn or non-JSON line instead of failing the read', (t) => {
  const dir = tmpState(t);
  const a = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: passTests }, ts: TS });
  fs.mkdirSync(path.dirname(testedTreesFile(dir)), { recursive: true });
  fs.writeFileSync(testedTreesFile(dir), `${JSON.stringify(a)}\n{"treeSha":"tor\nnot json\n42\n`);
  assert.deepEqual(readTestedTrees(dir), [a]);
});

test('findTestedTree returns the latest record for a tree, so a later fail outranks an earlier pass', (t) => {
  const dir = tmpState(t);
  const pass = testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: passTests }, ts: TS });
  recordTestedTree(dir, pass);
  recordTestedTree(dir, { ...pass, treeSha: 'other', ts: '2026-10-28T10:30:00.000Z' });
  assert.deepEqual(findTestedTree(dir, 'ttt333'), pass);
  recordTestedTree(dir, { ...pass, status: 'fail', ts: '2026-10-28T11:00:00.000Z' });
  assert.equal(findTestedTree(dir, 'ttt333').status, 'fail');
  assert.equal(findTestedTree(dir, 'nope'), null);
  assert.equal(findTestedTree(dir, ''), null);
});

const target = { key: 'acme/w@main', repo: 'acme/w', base: 'main' };

test('mainSuiteRecord: a pass or fail of the tip is a record; a timeout or error is not', () => {
  const pass = mainSuiteRecord({ target, sha: 'tip9', treeSha: 'tree9', run: { result: 'pass', command: 'npm test', durationMs: 5 }, ts: TS });
  assert.deepEqual(pass, { ts: TS, source: 'main-suite', sha: 'tip9', treeSha: 'tree9', verdict: 'pass', status: 'pass', repo: 'acme/w', base: 'main', key: 'acme/w@main', command: 'npm test', durationMs: 5 });
  assert.equal(mainSuiteRecord({ target, sha: 'tip9', treeSha: null, run: { result: 'fail' }, ts: TS }).verdict, 'fail');
  assert.equal(mainSuiteRecord({ target, sha: 'tip9', run: { result: 'timeout' }, ts: TS }), null);
  assert.equal(mainSuiteRecord({ target, sha: 'tip9', run: { result: 'error' }, ts: TS }), null);
  assert.equal(mainSuiteRecord({ target, sha: '', run: { result: 'pass' }, ts: TS }), null);
});

test('readTestedTrees keeps a main-suite record with no tree sha; lastGreenRecord skips fails, per-PR records and other keys', (t) => {
  const dir = tmpState(t);
  recordTestedTree(dir, mainSuiteRecord({ target, sha: 'g1', treeSha: null, run: { result: 'pass' }, ts: TS }));
  recordTestedTree(dir, mainSuiteRecord({ target: { ...target, key: 'acme/w@dev' }, sha: 'other', run: { result: 'pass' }, ts: TS }));
  recordTestedTree(dir, mainSuiteRecord({ target, sha: 'r2', run: { result: 'fail' }, ts: TS }));
  recordTestedTree(dir, testedTreeRecord({ id: 'c1', mr, outcome: { kind: 'pass', tests: passTests }, ts: TS }));
  assert.equal(readTestedTrees(dir).length, 4);
  assert.equal(lastGreenRecord(dir, { key: 'acme/w@main' }).sha, 'g1');
  assert.equal(lastGreenRecord(dir).sha, 'other');
  assert.equal(lastGreenRecord(dir, { key: 'nope' }), null);
});

test('isAtOrBehindLastGreen: no green on record is a no with a reason; a git error is never a yes', async (t) => {
  const dir = tmpState(t);
  const none = await isAtOrBehindLastGreen({ stateDir: dir, sha: 'x', git: async () => ({ status: 0 }) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no green full run/);
  recordTestedTree(dir, mainSuiteRecord({ target, sha: 'g1', run: { result: 'pass' }, ts: TS }));
  const calls = [];
  const git = (status) => async (args, opts) => { calls.push({ args, opts }); return { status, stdout: '', stderr: status > 1 ? 'fatal: bad object' : '' }; };
  assert.equal((await isAtOrBehindLastGreen({ stateDir: dir, sha: 'x', git: git(0), cwd: '/r' })).ok, true);
  assert.deepEqual(calls[0], { args: ['merge-base', '--is-ancestor', 'x', 'g1'], opts: { cwd: '/r' } });
  const no = await isAtOrBehindLastGreen({ stateDir: dir, sha: 'x', git: git(1) });
  assert.equal(no.ok, false);
  assert.equal(no.green, 'g1');
  const err = await isAtOrBehindLastGreen({ stateDir: dir, sha: 'x', git: git(128) });
  assert.equal(err.ok, false);
  assert.equal(err.error, true);
  assert.match(err.reason, /bad object/);
  const threw = await isAtOrBehindLastGreen({ stateDir: dir, sha: 'x', git: async () => { throw new Error('spawn git ENOENT'); } });
  assert.equal(threw.ok, false);
  assert.equal(threw.error, true);
  assert.equal((await isAtOrBehindLastGreen({ stateDir: dir, sha: '', git: git(0) })).ok, false);
  const before = calls.length;
  assert.equal((await isAtOrBehindLastGreen({ stateDir: dir, sha: '--output=x', git: git(0) })).ok, false, 'an option is never passed to git');
  assert.equal(calls.length, before);
});

test('isAtOrBehindLastGreen against a real repo: the green sha and its ancestors pass, a later commit does not', async (t) => {
  const repo = tmpState(t);
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  const commit = (m) => { g('commit', '-q', '--allow-empty', '-m', m); return g('rev-parse', 'HEAD').stdout.trim(); };
  const c1 = commit('one'); const c2 = commit('two'); const c3 = commit('three');
  const dir = tmpState(t);
  recordTestedTree(dir, mainSuiteRecord({ target, sha: c2, run: { result: 'pass' }, ts: TS }));
  const git = async (args, { cwd }) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const ask = (sha) => isAtOrBehindLastGreen({ stateDir: dir, sha, key: 'acme/w@main', git, cwd: repo });
  assert.equal((await ask(c1)).ok, true);
  assert.equal((await ask(c2)).ok, true);
  assert.equal((await ask(c3)).ok, false);
});

// dd50673a removed the only caller of recordTestedTree and nothing failed, so
// the record silently stopped. Pin the server's wiring of the full-run writer.
test('the server wires the batched full run to the tested-tree record', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const at = src.indexOf('mainSuite.createMainSuiteLoop({');
  assert.ok(at > 0, 'the main-suite loop is registered');
  const body = src.slice(at, src.indexOf('ceiling:', at));
  assert.ok(body.includes('recordTree: (r) => testedTrees.recordTestedTree(P.stateDir, r)'), 'recordTree is wired to the state dir');
});

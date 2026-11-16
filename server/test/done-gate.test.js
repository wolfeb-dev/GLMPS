// Tests for the Stop-hook done-gate pure decision functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAcceptance, decideDoneGate, parsePorcelain, readProdRoots, confirmAndApprove } from '../../hooks/done-gate.js';


test('readProdRoots reads prodRoots from config.json one level above the hooks dir', () => {
  const tmp = fs.mkdtempSync(path.join(tmpRoot(), 'mc-prodroots-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ prodRoots: ['D:/glmps_prod', 'D:/live/bin/Custom'] }));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), ['D:/glmps_prod', 'D:/live/bin/Custom']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readProdRoots returns [] when config absent, lacks prodRoots, or is invalid', () => {
  const tmp = fs.mkdtempSync(path.join(tmpRoot(), 'mc-prodroots-'));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // absent
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ backtestProjects: ['x'] }));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // no prodRoots key
  fs.writeFileSync(path.join(tmp, 'config.json'), '{not json');
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // invalid json
  fs.rmSync(tmp, { recursive: true, force: true });
});


test('parseAcceptance: extracts frontmatter commands', () => {
  const md = '---\ncommands:\n  - npm test\n  - npm run lint\n---\n# Acceptance\nbody';
  assert.deepEqual(parseAcceptance(md), { commands: ['npm test', 'npm run lint'] });
});

test('parseAcceptance: no frontmatter -> null', () => {
  assert.equal(parseAcceptance('# just a heading\nno fm'), null);
});

test('parseAcceptance: frontmatter without commands -> null', () => {
  assert.equal(parseAcceptance('---\ntitle: x\n---\nbody'), null);
});

test('parseAcceptance: empty commands list -> null', () => {
  assert.equal(parseAcceptance('---\ncommands:\n---\nbody'), null);
});

test('parseAcceptance: a following top-level key ends the list', () => {
  const md = '---\ncommands:\n  - npm test\ntitle: x\n---\nbody';
  assert.deepEqual(parseAcceptance(md), { commands: ['npm test'] });
});

test('parseAcceptance: non-string -> null, never throws', () => {
  assert.equal(parseAcceptance(null), null);
  assert.equal(parseAcceptance(undefined), null);
  assert.equal(parseAcceptance(42), null);
});


const C = { commands: ['npm test'] };

test('decide: no contract -> allow, no run, result no-contract', () => {
  const d = decideDoneGate({ contract: null, dirty: true, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.needsRun, false);
  assert.equal(d.result, 'no-contract');
});

test('decide: skip -> allow + skipped flag', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: true, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.skipped, true);
  assert.equal(d.needsRun, false);
});

test('decide: clean tree -> allow, no run, result clean', () => {
  const d = decideDoneGate({ contract: C, dirty: false, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.needsRun, false);
  assert.equal(d.result, 'clean');
});

test('decide: dirty, no runResult -> needsRun', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.needsRun, true);
});

test('decide: dirty + pass -> allow, reset counter', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 2,
    runResult: { ok: true } });
  assert.equal(d.action, 'allow');
  assert.equal(d.nextBlockCount, 0);
  assert.equal(d.result, 'pass');
});

test('decide: dirty + fail under cap -> block, increment', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 1,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'block');
  assert.equal(d.nextBlockCount, 2);
  assert.equal(d.result, 'block');
  assert.match(d.reason, /npm test/);
});

test('decide: fail at cap (>=3) -> yield (allow), reset', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 3,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'allow');
  assert.equal(d.result, 'yield');
  assert.equal(d.nextBlockCount, 0);
});

test('decide: stop_hook_active false resets count before deciding', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: false, blockCount: 9,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'block');
  assert.equal(d.nextBlockCount, 1); // count reset to 0 first, then +1
});


const CWD = process.platform === 'win32' ? 'D:\\repo' : '/repo';

test('parsePorcelain: normal modified and untracked files (NUL separated)', () => {
  const result = parsePorcelain(' M web/app.js\0?? new.txt\0', CWD);
  assert.deepEqual(result, [path.join(CWD, 'web/app.js'), path.join(CWD, 'new.txt')]);
});

test('parsePorcelain: a -z rename lists the new name then the old name, and both are kept', () => {
  const result = parsePorcelain('R  new.js\0old.js\0 M after.js\0', CWD);
  assert.deepEqual(result, [path.join(CWD, 'new.js'), path.join(CWD, 'old.js'), path.join(CWD, 'after.js')]);
});

test('parsePorcelain: names with spaces, arrows and quotes are taken verbatim', () => {
  const result = parsePorcelain('?? a b.js\0?? x -> y.js\0?? "q".js\0', CWD);
  assert.deepEqual(result, [path.join(CWD, 'a b.js'), path.join(CWD, 'x -> y.js'), path.join(CWD, '"q".js')]);
});

test('parsePorcelain: a copy entry also consumes its source name', () => {
  assert.deepEqual(parsePorcelain('C  dst.js\0src.js\0?? z.js\0', CWD),
    [path.join(CWD, 'dst.js'), path.join(CWD, 'src.js'), path.join(CWD, 'z.js')]);
});

test('parsePorcelain: real git -z output with an untracked directory and an escaped name', () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-porc-'));
  try {
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'newdir', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'newdir', 'deep', 'a.txt'), 'x');
    fs.writeFileSync(path.join(repo, 'caf\u00E9 \u00FC.txt'), 'x');
    const out = git('status', '--porcelain', '-z', '--untracked-files=all').stdout;
    const got = parsePorcelain(out, repo);
    assert.ok(got.includes(path.join(repo, 'newdir', 'deep', 'a.txt')), got.join('|'));
    assert.ok(got.includes(path.join(repo, 'caf\u00E9 \u00FC.txt')), got.join('|'));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('parsePorcelain: empty input -> []', () => {
  assert.deepEqual(parsePorcelain('', CWD), []);
});

// CLI entry: spawn the hook as a real subprocess (Stop-hook JSON on stdin)
// so the two previously-silent paths (clean tree, missing acceptance.md) are
// checked end-to-end, not just via decideDoneGate's return value. Isolated via
// GLMPS_DONE_GATE_DIR / GLMPS_STATE_DIR tmpdirs so the real ~/.glmps state
// is never touched. Neither done-gate-endpoint.test.js nor done-gate-feed.test.js
// actually spawns the hook (they drive the pure function / the server route),
// so this harness is new.

const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'done-gate.js');

function runDoneGateCli({ cwd, sessionId, doneGateDir, stateDir }) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({ cwd, session_id: sessionId, stop_hook_active: false }),
    env: { ...process.env, GLMPS_DONE_GATE_DIR: doneGateDir, GLMPS_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('CLI entry: clean tree -> records a clean line (previously silent)', () => {
  const cwd = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-cwd-'));
  const doneGateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-dir-'));
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-state-'));
  try {
    fs.writeFileSync(path.join(cwd, 'acceptance.md'), '---\ncommands:\n  - node -e "process.exit(0)"\n---\n# Acceptance\n');
    const res = runDoneGateCli({ cwd, sessionId: 'sid-clean', doneGateDir, stateDir });
    assert.equal(res.status, 0, `hook exited non-zero.\nstderr:\n${res.stderr}`);
    const jsonlPath = path.join(doneGateDir, 'sid-clean.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'expected a jsonl line for a clean tree, got none');
    const lines = readJsonl(jsonlPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, 'clean');
    assert.equal(lines[0].sessionId, 'sid-clean');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(doneGateDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('CLI entry: missing acceptance.md -> records a no-contract line (previously silent)', () => {
  const cwd = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-cwd-'));
  const doneGateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-dir-'));
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-state-'));
  try {
    const res = runDoneGateCli({ cwd, sessionId: 'sid-nocontract', doneGateDir, stateDir });
    assert.equal(res.status, 0, `hook exited non-zero.\nstderr:\n${res.stderr}`);
    const jsonlPath = path.join(doneGateDir, 'sid-nocontract.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'expected a jsonl line for a missing acceptance.md, got none');
    const lines = readJsonl(jsonlPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, 'no-contract');
    assert.equal(lines[0].sessionId, 'sid-nocontract');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(doneGateDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// D30 item 2: approval only from the hook's own environment, never from a
// file in the agent's cwd (done.skip / prod.allow were agent-writable bypasses).

function gitCwd() {
  const cwd = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-cwd-'));
  spawnSync('git', ['init', '-q'], { cwd });
  return cwd;
}
async function runBypassCli({ cwd, extraEnv = {}, approve = false }) {
  const doneGateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-dir-'));
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-state-'));
  const env = { ...process.env, GLMPS_DONE_GATE_DIR: doneGateDir, GLMPS_STATE_DIR: stateDir };
  delete env.GLMPS_DONE_GATE; delete env.GLMPS_ALLOW_PROD;
  Object.assign(env, extraEnv);
  try {
    // commands run only for an operator-approved acceptance.md.
    if (approve) {
      const a = await confirmAndApprove(doneGateDir, cwd, { isTTY: true, ask: async () => 'y' });
      assert.equal(a.approved, true, 'the approve step must succeed');
    }
    return spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ cwd, session_id: 'sid-bypass', stop_hook_active: false }), env, encoding: 'utf8',
    });
  } finally {
    fs.rmSync(doneGateDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('D30: a done.skip file in cwd no longer skips the gate; GLMPS_DONE_GATE=off does', async () => {
  const cwd = gitCwd();
  try {
    fs.writeFileSync(path.join(cwd, 'acceptance.md'), '---\ncommands:\n  - node -e "process.exit(1)"\n---\n');
    fs.writeFileSync(path.join(cwd, 'done.skip'), '');
    const blocked = await runBypassCli({ cwd, approve: true });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /done\.skip.*ignored.*GLMPS_DONE_GATE=off/s);
    const off = await runBypassCli({ cwd, approve: true, extraEnv: { GLMPS_DONE_GATE: 'off' } });
    assert.equal(off.status, 0, off.stderr);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('D30: a prod.allow file in cwd no longer bypasses the scope guard; GLMPS_ALLOW_PROD=1 does', async () => {
  const cwd = gitCwd();
  try {
    fs.writeFileSync(path.join(cwd, 'acceptance.md'), '---\ncommands:\n  - node -e "process.exit(0)"\n---\n');
    fs.mkdirSync(path.join(cwd, 'prod'));
    fs.writeFileSync(path.join(cwd, 'prod', 'x.txt'), 'edited');
    fs.writeFileSync(path.join(cwd, 'prod.allow'), '');
    const blocked = await runBypassCli({ cwd });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /scope-guard: blocked/);
    assert.match(blocked.stderr, /prod\.allow.*ignored.*GLMPS_ALLOW_PROD=1/s);
    const allowed = await runBypassCli({ cwd, extraEnv: { GLMPS_ALLOW_PROD: '1' } });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// Review P4 follow-up: git status paths are relative to the repo root, not the
// hook's cwd, so a Stop fired from a subdirectory must still see them.
test('CLI entry: scope-guard resolves changed paths against the repo root when run from a subdirectory', () => {
  const repo = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-sub-'));
  const doneGateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-dir-'));
  const stateDir = fs.mkdtempSync(path.join(tmpRoot(), 'mc-dg-state-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.mkdirSync(path.join(repo, 'guarded'));
    fs.writeFileSync(path.join(repo, 'guarded', 'x.txt'), 'x');
    const contract = '---\ncommands:\n  - node -e "process.exit(0)"\n---\n';
    fs.writeFileSync(path.join(repo, 'acceptance.md'), contract);
    fs.writeFileSync(path.join(repo, 'sub', 'acceptance.md'), contract);
    const zones = JSON.stringify({ prefixes: [], protectedSegments: [], protectedRoots: [path.join(repo, 'guarded')] });
    const env = { ...process.env, GLMPS_DONE_GATE_DIR: doneGateDir, GLMPS_STATE_DIR: stateDir, GLMPS_ZONE_CONFIG: zones };
    delete env.GLMPS_DONE_GATE; delete env.GLMPS_ALLOW_PROD;
    const run = (cwd) => spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ cwd, session_id: 'sid-sub', stop_hook_active: false }), env, encoding: 'utf8',
    });
    assert.equal(run(repo).status, 2, 'from the root the protected edit blocks the stop');
    const fromSub = run(path.join(repo, 'sub'));
    assert.equal(fromSub.status, 2, `from a subdirectory too.\nstderr:\n${fromSub.stderr}`);
  } finally {
    for (const d of [repo, doneGateDir, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

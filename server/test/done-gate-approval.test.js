// server/test/done-gate-approval.test.js
// the global Stop hook ran whatever a repo's acceptance.md listed, with
// no Bash approval. Now only an operator-approved file (by sha256) runs.
// All state lives in temp dirs (GLMPS_DONE_GATE_DIR / GLMPS_STATE_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contractHash, isContractApproved, approvalKey, confirmAndApprove, loadContract, approvedMessage } from '../../hooks/done-gate.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'done-gate.js');

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dga-repo-'));
  const doneGateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dga-dir-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dga-state-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dga-home-'));
  execFileSync('git', ['init', '-q'], { cwd });
  // The command proves it ran by writing a marker; acceptance.md itself is untracked, so the tree is dirty.
  fs.writeFileSync(path.join(cwd, 'acceptance.md'), '---\ncommands:\n  - node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"\n---\n# Acceptance\n');
  const env = { ...process.env, GLMPS_DONE_GATE_DIR: doneGateDir, GLMPS_STATE_DIR: stateDir, HOME: home, USERPROFILE: home };
  const stop = (sid) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, session_id: sid, stop_hook_active: false }), env, cwd, encoding: 'utf8' });
  // --approve needs a TTY, so tests approve through the injected-TTY seam.
  const approve = (answer = 'y') => confirmAndApprove(doneGateDir, cwd, { isTTY: true, ask: async () => answer });
  const cliApprove = () => spawnSync(process.execPath, [HOOK, '--approve', cwd], { env, cwd, input: 'y\n', encoding: 'utf8' });
  const approvalsPath = path.join(doneGateDir, 'approved-contracts.json');
  const last = (sid) => JSON.parse(fs.readFileSync(path.join(doneGateDir, `${sid}.jsonl`), 'utf8').trim().split('\n').pop()).result;
  const cleanup = () => { for (const d of [cwd, doneGateDir, stateDir, home]) fs.rmSync(d, { recursive: true, force: true }); };
  return { cwd, env, stop, approve, cliApprove, approvalsPath, last, cleanup };
}

test('F17: an unapproved acceptance.md is not run; the stop is allowed and stderr says how to approve', () => {
  const s = setup();
  try {
    const r = s.stop('sid-a');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(s.cwd, 'ran.txt')), false, 'the repo-supplied command never ran');
    assert.equal(s.last('sid-a'), 'unapproved');
    assert.match(r.stderr, /not operator-approved/);
    assert.match(r.stderr, /--approve/);
  } finally { s.cleanup(); }
});

test('F17: after --approve the same file runs', async () => {
  const s = setup();
  try {
    const a = await s.approve();
    assert.equal(a.approved, true);
    const r = s.stop('sid-b');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(s.cwd, 'ran.txt')), true);
    assert.equal(s.last('sid-b'), 'pass');
  } finally { s.cleanup(); }
});

test('Review focus 3: editing an approved acceptance.md un-approves it until it is approved again', async () => {
  const s = setup();
  try {
    assert.equal((await s.approve()).approved, true);
    fs.appendFileSync(path.join(s.cwd, 'acceptance.md'), '\nedited by an agent\n');
    const r = s.stop('sid-c');
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(s.cwd, 'ran.txt')), false);
    assert.equal(s.last('sid-c'), 'unapproved');
  } finally { s.cleanup(); }
});

test('F17: the pure approval check matches only the exact content for the exact directory', () => {
  const md = '---\ncommands:\n  - npm test\n---\n';
  const approvals = { [approvalKey('/repo/a')]: contractHash(md) };
  assert.equal(isContractApproved(approvals, '/repo/a', md), true);
  assert.equal(isContractApproved(approvals, '/repo/a', md + ' '), false);
  assert.equal(isContractApproved(approvals, '/repo/b', md), false);
  assert.equal(isContractApproved(null, '/repo/a', md), false);
});

test('I3: the --approve CLI refuses without a TTY (exit 1) and writes nothing', () => {
  const s = setup();
  try {
    const r = s.cliApprove();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /operator at an interactive terminal/);
    assert.equal(fs.existsSync(s.approvalsPath), false);
  } finally { s.cleanup(); }
});

test('I3: TTY seam: only "y" writes the approval, and the prompt lists the exact commands', async () => {
  const s = setup();
  try {
    for (const no of ['', 'n', 'yes please', 'N']) {
      assert.equal((await s.approve(no)).approved, false);
      assert.equal(fs.existsSync(s.approvalsPath), false, `answer ${JSON.stringify(no)} wrote nothing`);
    }
    let shown = '';
    const r = await confirmAndApprove(path.dirname(s.approvalsPath), s.cwd, { isTTY: true, ask: async () => 'Y', out: (t) => { shown += t; } });
    assert.equal(r.approved, true);
    assert.match(shown, /ran\.txt/);
    assert.equal(fs.existsSync(s.approvalsPath), true);
  } finally { s.cleanup(); }
});

test('--approve names the absolute approvals store it wrote, so a GLMPS_STATE_DIR mismatch is visible', async () => {
  const s = setup();
  try {
    const r = await s.approve();
    assert.equal(r.store, path.resolve(s.approvalsPath));
    assert.ok(path.isAbsolute(r.store));
    assert.match(approvedMessage(r), new RegExp(r.store.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  } finally { s.cleanup(); }
});

test('I3: no TTY in the seam refuses and never asks', async () => {
  const s = setup();
  try {
    const r = await confirmAndApprove(path.dirname(s.approvalsPath), s.cwd, { isTTY: false, ask: async () => { throw new Error('asked'); } });
    assert.equal(r.approved, false);
    assert.equal(fs.existsSync(s.approvalsPath), false);
  } finally { s.cleanup(); }
});

test('I1: the contract is read once; the parsed commands and the hashed text are the same string', () => {
  let reads = 0;
  const first = '---\ncommands:\n  - echo approved\n---\n';
  const read = () => (++reads === 1 ? first : '---\ncommands:\n  - echo evil\n---\n');
  const { raw, contract } = loadContract('/x', read);
  assert.equal(reads, 1);
  assert.equal(raw, first);
  assert.deepEqual(contract.commands, ['echo approved']);
  const approvals = { [approvalKey('/x')]: contractHash(first) };
  assert.equal(isContractApproved(approvals, '/x', raw), true);
  assert.equal(loadContract('/x', () => null).contract, null);
});

test('I2: the unapproved notice is also printed to stdout', () => {
  const s = setup();
  try {
    const r = s.stop('sid-d');
    assert.match(r.stdout, /not operator-approved/);
  } finally { s.cleanup(); }
});

// Card glmps-2-0-192: on Windows (core.autocrlf=true) acceptance.md checks
// out with CRLF, which the parser rejected, so every Stop logged 'no-contract'
// and verifier pass was never captured.
test('a CRLF acceptance.md parses, and hashes the same as its LF form', async () => {
  const { parseAcceptance } = await import('../../hooks/done-gate.js');
  const lf = '---\ncommands:\n  - node scripts/affected-tests.mjs\n---\n# Acceptance\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(parseAcceptance(crlf), { commands: ['node scripts/affected-tests.mjs'] });
  assert.equal(contractHash(crlf), contractHash(lf));
});

test('an approval recorded for the main checkout covers its worktrees, for the same content only', () => {
  const md = '---\ncommands:\n  - x\n---\n';
  const approvals = { [approvalKey('/repo/main')]: contractHash(md) };
  assert.equal(isContractApproved(approvals, '/wt/card-1', md, { repoRoot: '/repo/main' }), true);
  assert.equal(isContractApproved(approvals, '/wt/card-1', md + 'edited', { repoRoot: '/repo/main' }), false);
  assert.equal(isContractApproved(approvals, '/wt/card-1', md, { repoRoot: '/repo/other' }), false);
  assert.equal(isContractApproved(approvals, '/wt/card-1', md), false);
});

test('the hook runs an approved contract in a git worktree of the approved checkout', async () => {
  const s = setup();
  const wt = path.join(os.tmpdir(), `mc-dga-wt-${process.pid}-${Date.now()}`);
  try {
    execFileSync('git', ['add', 'acceptance.md'], { cwd: s.cwd });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c'], { cwd: s.cwd });
    assert.equal((await s.approve()).approved, true);
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: s.cwd });
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: wt, session_id: 'sid-wt', stop_hook_active: false }), env: s.env, cwd: wt, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.last('sid-wt'), 'pass');
    assert.equal(fs.existsSync(path.join(wt, 'ran.txt')), true);
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: s.cwd }); } catch { /* best effort */ }
    fs.rmSync(wt, { recursive: true, force: true });
    s.cleanup();
  }
});

// Card glmps-2-0-192 T6: runner sessions commit before they stop, so the tree
// is clean and the gate recorded 'clean' with no verdict. Unmerged commits
// now count as work to verify.
test('a clean tree with commits not on origin/main still runs the contract', async () => {
  const s = setup();
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: s.cwd });
    g('add', 'acceptance.md'); g('commit', '-qm', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.writeFileSync(path.join(s.cwd, '.gitignore'), 'ran.txt\n');
    g('add', '.gitignore'); g('commit', '-qm', 'work');
    assert.equal((await s.approve()).approved, true);
    const r = s.stop('sid-ahead');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.last('sid-ahead'), 'pass');
    assert.equal(fs.existsSync(path.join(s.cwd, 'ran.txt')), true);
  } finally { s.cleanup(); }
});

test('a clean tree already on origin/main records clean and runs nothing', async () => {
  const s = setup();
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: s.cwd });
    fs.writeFileSync(path.join(s.cwd, '.gitignore'), 'ran.txt\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal((await s.approve()).approved, true);
    const r = s.stop('sid-even');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.last('sid-even'), 'clean');
    assert.equal(fs.existsSync(path.join(s.cwd, 'ran.txt')), false);
  } finally { s.cleanup(); }
});

test('a clean tree with no remote-tracking base records clean', async () => {
  const s = setup();
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: s.cwd });
    fs.writeFileSync(path.join(s.cwd, '.gitignore'), 'ran.txt\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    assert.equal((await s.approve()).approved, true);
    assert.equal(s.stop('sid-nobase').status, 0);
    assert.equal(s.last('sid-nobase'), 'clean');
  } finally { s.cleanup(); }
});

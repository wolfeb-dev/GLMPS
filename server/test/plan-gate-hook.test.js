// Routes under test: server/lib/routes/guards-routes.js
// server/test/plan-gate-hook.test.js
// K7 (D6 borrow c): the blocking plan gate. Pure functions (planGateDecision,
// isSourcePath, classifyGitError, repoRelativePath, resolveCardId) are tested
// directly. The fail-open error paths, the git-backed commit checks, and the
// per-session tracking file are hook-level behavior and are tested by
// spawning the real hook script against a real (throwaway, temp-dir) git
// repo, with HOME/USERPROFILE/GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR redirected and a
// stub HTTP server standing in for the kernel on an ephemeral port. Never the
// real 8123/8124, never a real git repo outside a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCardId, fetchChain, boardUrl, envStateDir, reportRefusal } from '../../hooks/lib/card-context.js';
import { planGateDecision, isSourcePath, classifyGitError, repoRelativePath, branchReadIssue, gitRepoTop, bumpCounter } from '../../hooks/plan-gate.js';

const chain = (plan) => ({ id: 'mc-1', intent: 'x', plan, taskClass: 'feature' });
const repo = (committed) => ({ isCommitted: (p) => committed.includes(p), readCommitted: (p) => (p.endsWith('p.md') ? '# P\n\n**Spec:** `docs/superpowers/specs/s.md`\n' : '') });

test('card id comes from the runner branch or GLMPS_CARD_ID', () => {
  assert.equal(resolveCardId({ branch: 'glmps-runner/glmps-2.0/glmps-2-0-11', env: {} }), 'glmps-2-0-11');
  assert.equal(resolveCardId({ branch: 'feat/x', env: { GLMPS_CARD_ID: 'mc-9' } }), 'mc-9');
  assert.equal(resolveCardId({ branch: 'feat/x', env: {} }), null);
});

test('docs and markdown are not source', () => {
  assert.equal(isSourcePath('docs/superpowers/plans/p.md'), false);
  assert.equal(isSourcePath('README.md'), false);
  assert.equal(isSourcePath('server/server.js'), true);
});

// only the TOP-level docs/ is exempt. The old regex
// matched `(^|\/)docs\/`, which also exempted a NESTED docs directory
// anywhere in the tree - server/lib/docs/foo.js is a real source file, not
// documentation, and must count toward the distinct-file budget.
test('M6: a nested docs directory is source, only the top-level docs/ is exempt', () => {
  assert.equal(isSourcePath('server/lib/docs/foo.js'), true);
  assert.equal(isSourcePath('a/docs/b.js'), true);
  assert.equal(isSourcePath('docs/x.js'), false);
  assert.equal(isSourcePath('Docs/x.js'), false, 'case-insensitive, e.g. a win32 caller');
});

test('two files pass, a source file beyond the first two needs the chain', () => {
  assert.equal(planGateDecision({ chain: chain(null), files: ['a.js'], filePath: 'b.js', repoCheck: repo([]) }).allow, true);
  assert.equal(planGateDecision({ chain: chain(null), files: ['a.js', 'b.js'], filePath: 'b.js', repoCheck: repo([]) }).allow, true, 'a file already counted');
  // A scratch home: boardUrl() and the default boardBaseUrl would otherwise stat the real ~/.glmps/cutover/active.json.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plan-gate-home-'));
  const boardBaseUrl = boardUrl({}, home);
  const d = planGateDecision({ chain: chain(null), files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo([]), boardBaseUrl });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.equal(d.allow, false);
  // wording changed from "third source file" to "a
  // source file beyond the first two", and the deny now names the board URL.
  assert.match(d.reason, /source file beyond the first two.*no plan is declared/);
  // Phase K final I6: the default board is the 2.0 kernel (boardUrl(): GLMPS_BOARD_URL,
  // else GLMPS_PORT, else 8124), no longer production's 8123.
  assert.ok(d.reason.includes(`${boardBaseUrl}/api/backlog/mc-1/progress`), d.reason);
});

test('the plan must be committed and name a committed spec', () => {
  const at3 = (committed) => planGateDecision({ chain: chain('docs/superpowers/plans/p.md'), files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo(committed) });
  assert.match(at3([]).reason, /plan .* is not committed/);
  assert.match(at3(['docs/superpowers/plans/p.md']).reason, /spec .* is not committed/);
  assert.equal(at3(['docs/superpowers/plans/p.md', 'docs/superpowers/specs/s.md']).allow, true);
});

test('board unreachable fails open with an alert line', () => {
  const d = planGateDecision({ chain: null, unavailable: 'dashboard unreachable', files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo([]) });
  assert.equal(d.allow, true); assert.equal(d.failOpen, true); assert.match(d.reason, /board unreachable/);
});

// K7 addition: fetchChain's 404 maps to `unknownCard`, not `unavailable` - a
// deleted/renamed card must still fail open, with its own distinct reason.
test('an unknown card fails open with an alert line', () => {
  const d = planGateDecision({ chain: null, unknownCard: true, files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo([]) });
  assert.equal(d.allow, true); assert.equal(d.failOpen, true); assert.match(d.reason, /unknown card/);
});

// Only a BACKTICKED path counts as a spec path. An absolute/outside-repo
// backticked path, or a **Spec:** line with no backticked path at all, is
// allowed with a named reason - never denied, since this gate was never
// given a verifiable in-repo path to check. Tested against the five real
// plan header shapes the round-1 review cited.
test('I7: a backticked spec outside the repo is allowed with a named reason, never denied', () => {
  const at3 = (planText) => planGateDecision({
    chain: chain('docs/superpowers/plans/p.md'),
    files: ['a.js', 'b.js'], filePath: 'c.js',
    repoCheck: { isCommitted: (p) => p === 'docs/superpowers/plans/p.md', readCommitted: () => planText },
  });

  // graphify-sync-visibility-and-auto-update.md:11 - backticked absolute
  // Windows path to the separate corpus repo (decision D29).
  const d1 = at3('**Spec:** `D:\\glmps-2.0\\glmps-2.0-upgrade-plan.md` item 7b (the measured diagnosis...).');
  assert.equal(d1.allow, true); assert.equal(d1.failOpen, true); assert.match(d1.reason, /outside the repo/);

  // d23-port-per-loop.md:13 - same shape, a different corpus file.
  const d2 = at3('**Spec:** `D:\\glmps-2.0\\decisions.md` D22, D23, D24, D25 (glmps-2.0 main 819a847)...');
  assert.equal(d2.allow, true); assert.equal(d2.failOpen, true); assert.match(d2.reason, /outside the repo/);
});

test('I7: a **Spec:** line with no backticked path is allowed with a named reason, never denied', () => {
  const at3 = (planText) => planGateDecision({
    chain: chain('docs/superpowers/plans/p.md'),
    files: ['a.js', 'b.js'], filePath: 'c.js',
    repoCheck: { isCommitted: (p) => p === 'docs/superpowers/plans/p.md', readCommitted: () => planText },
  });

  // glmps-2.0-own-project.md:11 - prose, a Slack instruction.
  const d3 = at3("**Spec:** the operator's Slack instruction on card glmps-93, thread 1788057931.881919, quoted verbatim:");
  assert.equal(d3.allow, true); assert.equal(d3.failOpen, true); assert.match(d3.reason, /not a path/);

  // runner-worktree-reclaim.md:20 - prose, "this document".
  const d4 = at3('**Spec:** this document (Evidence + Design sections below). Ticket:\nglmps-53 on the GLMPS board.');
  assert.equal(d4.allow, true); assert.equal(d4.failOpen, true); assert.match(d4.reason, /not a path/);

  // scut-attachments.md:19 - "none", with an UNRELATED backtick later in the
  // paragraph (a ticket id, not a path) - must not be mistaken for the spec.
  const d5 = at3('**Spec:** none; this plan is the design. Source of truth for the requirement is backlog card\n`glmps-89` (Slack thread `1788014503.449529`).');
  assert.equal(d5.allow, true); assert.equal(d5.failOpen, true); assert.match(d5.reason, /not a path/);
});

// Direct unit tests over synthetic error shapes. Node's own child_process
// timeout/kill machinery is not this project's code to re-verify; what
// matters is that each error shape maps to the right, named fail-open reason.

test('classifyGitError: ENOENT is "git is not installed or not on PATH"', () => {
  assert.match(classifyGitError({ code: 'ENOENT' }), /not installed or not on PATH/);
});

test('classifyGitError: a killed/timed-out process names the timeout', () => {
  // The real shape execFileSync produces on a timeout kill (verified by the
  // round-2 reviewer's own probe A on this machine): code:'ETIMEDOUT',
  // signal:'SIGTERM', killed:undefined. Checking code is the reliable
  // signal; killed/signal alone are kept only as a fallback.
  assert.match(classifyGitError({ code: 'ETIMEDOUT', signal: 'SIGTERM', killed: undefined }, 2000), /did not respond within 2000ms/);
  assert.match(classifyGitError({ killed: true }, 2000), /did not respond within 2000ms/);
  assert.match(classifyGitError({ signal: 'SIGTERM' }, 2000), /did not respond within 2000ms/);
});

test('classifyGitError: ENOBUFS names the read buffer', () => {
  assert.match(classifyGitError({ code: 'ENOBUFS' }), /read buffer/);
});

// I-new-2: probe A's own observed shape - a REAL ENOBUFS
// error ALSO carries signal:'SIGTERM' (Node kills the process the same way
// it kills a timeout), so checking killed/signal before code:'ENOBUFS'
// misreports a genuine buffer overflow as a timeout. ENOBUFS must win.
test('classifyGitError: a real ENOBUFS error (which also carries signal:SIGTERM) is never misreported as a timeout', () => {
  const msg = classifyGitError({ code: 'ENOBUFS', signal: 'SIGTERM', killed: undefined }, 2000);
  assert.match(msg, /read buffer/);
  assert.doesNotMatch(msg, /did not respond within/);
});

test('classifyGitError: any other failure is a generic, bounded git-exited reason', () => {
  const msg = classifyGitError({ code: 1, stderr: 'fatal: not a git repository' });
  assert.match(msg, /git exited with an error/);
  assert.match(msg, /not a git repository/);
});

// Pure, with injected exists/realpath so it needs no real filesystem.

test('repoRelativePath: a file outside the repo top level never counts (returns null)', () => {
  assert.equal(repoRelativePath({ abs: 'C:/elsewhere/x.js', repoTop: 'C:/repo', exists: () => false }), null);
  assert.equal(repoRelativePath({ abs: 'D:/repo/x.js', repoTop: 'C:/repo', exists: () => false }), null, 'a different drive is outside too');
});

test('repoRelativePath: an ordinary in-repo file normalizes to a forward-slash relative path', () => {
  assert.equal(repoRelativePath({ abs: 'C:/repo/src/a.js', repoTop: 'C:/repo', exists: () => false }), 'src/a.js');
});

test('repoRelativePath: a cwd change resolving to the same file does not double count', () => {
  const a = repoRelativePath({ abs: path.resolve('C:/repo/sub', '../src/a.js'), repoTop: 'C:/repo', exists: () => false });
  const b = repoRelativePath({ abs: 'C:/repo/src/a.js', repoTop: 'C:/repo', exists: () => false });
  assert.equal(a, b);
});

test('repoRelativePath: case variants collapse to one file on win32, stay distinct elsewhere', () => {
  const upper = repoRelativePath({ abs: 'C:/repo/SRC/A.JS', repoTop: 'C:/repo', platform: 'win32', exists: () => false });
  const lower = repoRelativePath({ abs: 'C:/repo/src/a.js', repoTop: 'C:/repo', platform: 'win32', exists: () => false });
  assert.equal(upper, lower, 'win32 is case-insensitive');
  const posixUpper = repoRelativePath({ abs: '/repo/SRC/A.JS', repoTop: '/repo', platform: 'linux', exists: () => false });
  const posixLower = repoRelativePath({ abs: '/repo/src/a.js', repoTop: '/repo', platform: 'linux', exists: () => false });
  assert.notEqual(posixUpper, posixLower, 'posix is case-sensitive');
});

test('repoRelativePath: an existing file is realpath-resolved (symlink/junction safe)', () => {
  const real = repoRelativePath({
    abs: 'C:/repo/link.js', repoTop: 'C:/repo',
    exists: (p) => p === 'C:/repo/link.js',
    realpath: (p) => (p === 'C:/repo/link.js' ? 'C:/repo/real.js' : p),
  });
  assert.equal(real, 'real.js');
});

// "outside the repo" ---------------------------------------------------------
// git expands an 8.3 short-name path (e.g. a GitHub Actions runner's own
// `C:\Users\RUNNER~1`, from a TEMP env var naming the long profile dir via
// its short alias) when it prints `--show-toplevel`, but the plain (JS-
// implemented) fs.realpathSync does NOT expand a short name on its own -
// only fs.realpathSync.native does. Before this fix, gitRepoTop's resolved
// repoTop (git-expanded, long form) and repoRelativePath's own realpath of
// the SAME short-name cwd (never touched by git, so still short form)
// disagreed on which string names the identical directory, so path.relative
// between them always started with '..' and every file under a short-name
// temp dir read as outside the repo - silently, no error anywhere, every
// gate/guard decision downstream became a no-op. This is exactly what made
// every plan-gate/test-file-guard hook test that depends on being "inside
// the repo" fail on windows-latest CI while passing on a short-username dev
// machine (`C:\Users\op` never needs an 8.3 alias).
test('gitRepoTop + repoRelativePath: a file under an 8.3 short-name cwd is still recognized as inside the repo', { skip: process.platform !== 'win32' && 'win32-only: 8.3 short names are an NTFS/Windows concept' }, () => {
  // A long name (`mkdtempSync`'s prefix here is deliberately > 8 chars) is
  // what actually gets Windows to generate a short alias at all; a short
  // prefix like plain 'mc-' would not reproduce the bug.
  const longDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plan-gate-shortname-repro-'));
  try {
    let shortDir;
    try {
      shortDir = execFileSync(
        'powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDir}').ShortPath`],
        { encoding: 'utf8' },
      ).trim();
    } catch (e) {
      assert.fail(`could not query the 8.3 short name via PowerShell/COM: ${e.message}`);
    }
    if (shortDir.toLowerCase() === longDir.toLowerCase()) {
      // 8dot3name generation is disabled on this volume (fsutil 8dot3name) -
      // nothing to reproduce the bug with; skip rather than false-pass.
      return;
    }
    initGitRepo(longDir);
    const repoTop = gitRepoTop(shortDir);
    const rel = repoRelativePath({ abs: path.resolve(shortDir, 'a.js'), repoTop });
    assert.equal(rel, 'a.js', `expected 'a.js' to be recognized as inside the repo; got ${JSON.stringify(rel)} (repoTop=${repoTop}, shortDir=${shortDir})`);
  } finally {
    fs.rmSync(longDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Every other fs write in this file treats failure as best-effort (log to
// stderr, move on): bumpCounter's own mkdirSync used to be the one exception,
// outside its try/catch. It is called unconditionally on EVERY invocation
// (the one shared step every plan-gate/test-file-guard decision passes
// through), so any transient fs failure there - reproduced here by a
// colliding non-directory 'guards' path, a real-world equivalent being an
// AV/Defender lock on a just-created directory on a Windows CI runner -
// used to propagate, uncaught, straight past main()'s own try/catches into
// the top-level safety net, which (before its own companion fix) wrote
// nothing at all to stdout: the caller got empty stdout instead of a
// fail-open decision (`JSON.parse('')` -> "Unexpected end of JSON input",
// exactly CI's symptom). Before the fix: this call throws. After: it is
// silent (best-effort), matching every other write in this file.
test('bumpCounter never throws, even when its own directory path is blocked (CI regression)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bumpcounter-'));
  // 'guards' exists as a plain FILE, not a directory: fs.mkdirSync(stateDir/
  // guards, {recursive:true}) cannot create it and must throw EEXIST.
  fs.writeFileSync(path.join(stateDir, 'guards'), 'not a directory');
  try {
    assert.doesNotThrow(() => bumpCounter(stateDir, 'plan-gate', 0));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Fast, in-process coverage of card-context.js's own error shapes. The
// hook-level tests below prove these actually make plan-gate.js allow and
// record why; these prove fetchChain reports the right reason for each.

function startStubKernel({ onChain } = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, body });
        if (req.url.endsWith('/chain')) return onChain(req, res);
        if (req.url === '/api/guards/refusal') { res.writeHead(204); return res.end(); }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

// this used to close a port-0 stub and then
// fetch the freed port; under --test-concurrency=4 another test's port-0
// server could take that port in between, and fetchChain then reached a
// live server (unknownCard, or a hang) instead of a dead one. The port is
// now HELD for the whole test by a listener that resets every connection
// the moment it is accepted, so nothing else can be assigned it and every
// connection still fails at the transport level - the same non-timeout
// fetch failure a closed port produces.
function startRefusingListener() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => { socket.resetAndDestroy(); });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('fetchChain: a port that refuses the connection reports board unreachable', async () => {
  const dead = await startRefusingListener();
  try {
    const res = await fetchChain('mc-1', { port: dead.port, timeoutMs: 500 });
    assert.equal(res.chain, undefined);
    assert.match(res.unavailable, /unreachable/);
  } finally { await dead.close(); }
});

test('fetchChain: invalid JSON from a reachable board is a named unavailable reason, not a throw', async () => {
  const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); } });
  try {
    const res = await fetchChain('mc-1', { port: stub.port, timeoutMs: 1000 });
    assert.equal(res.chain, undefined);
    assert.match(res.unavailable, /invalid JSON/i);
  } finally { await stub.close(); }
});

test('fetchChain: a 404 reports unknownCard, not unavailable', async () => {
  const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(404); res.end(); } });
  try {
    const res = await fetchChain('mc-1', { port: stub.port, timeoutMs: 1000 });
    assert.equal(res.chain, null);
    assert.equal(res.unknownCard, true);
    assert.equal(res.unavailable, undefined);
  } finally { await stub.close(); }
});

// I6 test gap: a non-2xx, non-404 board response (e.g. a 500) is its own
// named "unavailable", distinct from unreachable/timeout/bad-json/unknown.
test('fetchChain: a 500 from the board is a named unavailable reason', async () => {
  const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(500); res.end(); } });
  try {
    const res = await fetchChain('mc-1', { port: stub.port, timeoutMs: 1000 });
    assert.equal(res.chain, undefined);
    assert.match(res.unavailable, /HTTP 500/);
  } finally { await stub.close(); }
});

// Spawned exactly the way the operator's Claude Code would run it: JSON on
// stdin, HOME/USERPROFILE/GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR redirected to a fresh
// temp dir, GLMPS_PORT pointed at a stub kernel (or a closed port). cwd is now a
// REAL (throwaway) git repo, since I4's path normalization needs a real
// `git rev-parse --show-toplevel` and I1's commit checks need a real HEAD.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const planGateScript = path.join(repoRoot, 'hooks', 'plan-gate.js');

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plan-gate-'));
  try { return await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

function gitBin(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A real (throwaway) git repo at `dir`, with local-only identity config (no
// touch to any real/global git config) and, unless `empty` is set, one
// initial commit so HEAD exists.
function initGitRepo(dir, { empty = false } = {}) {
  const git = gitBin(dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  if (!empty) {
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    git(['add', '.gitkeep']);
    git(['commit', '-q', '-m', 'initial commit']);
  }
  return git;
}

function commitFile(git, dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(['add', relPath]);
  git(['commit', '-q', '-m', `add ${relPath}`]);
}

// I5's ndjson format: one {cardId, path, ts} line per touched file.
function seedTouched(stateDir, sessionId, cardId, files) {
  const dir = path.join(stateDir, 'guards', 'plan-gate');
  fs.mkdirSync(dir, { recursive: true });
  const lines = files.map((f) => JSON.stringify({ cardId, path: f, ts: Date.now() }));
  fs.writeFileSync(path.join(dir, `${sessionId}.ndjson`), lines.length ? `${lines.join('\n')}\n` : '');
}

function readFailOpenLines(stateDir) {
  const f = path.join(stateDir, 'guards', 'fail-open.ndjson');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readTouchedLines(stateDir, sessionId) {
  const f = path.join(stateDir, 'guards', 'plan-gate', `${sessionId}.ndjson`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function baseEnv(home, stateDir, port) {
  return {
    ...process.env,
    HOME: home, USERPROFILE: home,
    GLMPS_CLAUDE_DIR: path.join(home, '.claude'),
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CARD_ID: 'mc-1',
    GLMPS_PORT: String(port),
    // Generous on purpose: a loaded Windows CI runner has taken over 2 s for
    // the hook's git calls. Tests of the timeouts set their own short value.
    GLMPS_HOOK_HTTP_TIMEOUT_MS: '5000',
    GLMPS_HOOK_GIT_TIMEOUT_MS: '20000',
    // Phase K final I6: GLMPS_BOARD_URL outranks GLMPS_PORT, so an ambient one
    // must never steer these tests away from their own stub port.
    GLMPS_BOARD_URL: undefined,
  };
}

// Async spawn, not execFileSync: the stub kernel lives in THIS process, and a
// synchronous spawn blocks this process's event loop for the child's whole
// lifetime, so the stub server could never accept or answer the child's
// request, an artificial deadlock, not a real product behavior.
function runHook(env, cwd, targetFile, sessionId = 'sess-1') {
  const input = { cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, targetFile) }, session_id: sessionId };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [planGateScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('hook: kernel unreachable allows a source file beyond the first two and records a fail-open line', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({ onChain: () => {} });
    await stub.close(); // closed: nothing answers
    const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'no permissionDecision:deny, the tool call proceeds');
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => l.hook === 'plan-gate' && /unreachable/.test(l.reason)), 'a fail-open line naming the unreachable board');
  });
});

test('hook: a board that never answers times out, allows, and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({ onChain: () => { /* never responds */ } });
    try {
      const { stdout } = await runHook({ ...baseEnv(home, stateDir, stub.port), GLMPS_HOOK_HTTP_TIMEOUT_MS: '300' }, home, 'c.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /did not answer within/i.test(l.reason)), 'a fail-open line naming the timeout');
    } finally { await stub.close(); }
  });
});

test('hook: invalid JSON from the board allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /invalid JSON/i.test(l.reason)), 'a fail-open line naming the bad JSON');
    } finally { await stub.close(); }
  });
});

test('hook: an unknown card (404) allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(404); res.end(); } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /unknown card/i.test(l.reason)), 'a fail-open line naming the unknown card');
      // the reported refusal must be MARKED as a fail-open, so the
      // dashboard's recent-refusals feed never lists an allowed edit as an
      // indistinguishable refusal.
      const posted = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/guards/refusal');
      assert.ok(posted, 'expected a POST to /api/guards/refusal');
      assert.equal(JSON.parse(posted.body).failOpen, true);
      assert.equal(JSON.parse(posted.body).sessionId, 'sess-1');
    } finally { await stub.close(); }
  });
});

test('hook: git missing on PATH allows the plan/spec check and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home); // built with the real PATH still in scope
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: 'docs/superpowers/plans/p.md', taskClass: 'feature' }));
      },
    });
    try {
      const env = baseEnv(home, stateDir, stub.port);
      for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
      env.PATH = path.join(home, 'no-git-here'); // guaranteed not to contain git
      const { stdout } = await runHook(env, home, 'c.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'a broken git must never turn into a wrongful deny');
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /git is not installed or not on PATH/i.test(l.reason)), 'a fail-open line naming the missing git');
    } finally { await stub.close(); }
  });
});

// I-new-2:
// this used to retry a real git call up to 3 times under a 1ms budget and
// SKIP (not fail) if no attempt happened to observe the timeout - flaky by
// construction, and its own stale comment claimed removing `timeout:` from
// gitRun would turn the test RED, when in fact it only ever turned it into
// that same skip, never a failure. Replaced with a deterministic fixture: a
// fake `git` that always sleeps far longer than any timeout, placed first on
// PATH, so the timeout fires on every machine, every run.
//
// The fake cannot be a `.cmd`/`.bat` wrapper. gitRun's own execFileSync call
// never sets `shell: true` (by design - it never shells out unescaped
// arguments), and Node/libuv's shell-less spawn on Windows only resolves a
// bare, extension-less command name to a real `.exe`/`.com`, never `.cmd`/
// `.bat` - verified directly against a git.cmd fixture: an explicit
// `git.cmd` threw EINVAL (Node refuses a batch file without a shell) and a
// bare `git` with only a `.cmd` on PATH threw ENOENT (never even found). So
// this fixture compiles a genuine, tiny native `git.exe` (via the C#
// compiler every .NET Framework install ships) that unconditionally sleeps,
// ignoring argv entirely. On a machine with no such compiler (or on a
// non-Windows one, where a plain shebang script needs no compiler at all)
// the test skips with a named reason rather than failing outright - the same
// posture the junction test below already takes for a privilege it cannot
// assume either.
//
// Verified RED: with `timeout:` deleted from gitRun (a real edit, reverted
// immediately after observing the failure), the fail-open line asserted
// below was never written and this test failed outright - exactly the
// regression a silently-dropped timeout option must be caught by.
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

function buildFakeHangingGit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    // POSIX: a real, directly-executable shebang script needs no compiler -
    // the kernel itself resolves the interpreter, no shell wrapper involved.
    const script = path.join(dir, 'git');
    fs.writeFileSync(script, '#!/bin/sh\nsleep 60\n');
    fs.chmodSync(script, 0o755);
    return script;
  }
  const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
  if (!csc) return null;
  const src = path.join(dir, 'fake-git.cs');
  const exe = path.join(dir, 'git.exe');
  fs.writeFileSync(src, 'using System.Threading;\nclass FakeGit { static void Main(string[] args) { Thread.Sleep(60000); } }\n');
  execFileSync(csc, ['/nologo', `/out:${exe}`, src], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return exe;
}

test('I-new-2: a real git timeout fails open deterministically (a fake hanging git on PATH)', async (t) => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const fakeGitDir = path.join(home, 'fake-git-bin');
    const fakeGit = buildFakeHangingGit(fakeGitDir);
    if (!fakeGit) {
      t.skip('no C# compiler (csc.exe) found to build a fake hanging git on this machine');
      return;
    }
    const env = { ...baseEnv(home, stateDir, 65527), GLMPS_HOOK_GIT_TIMEOUT_MS: '100' };
    const pathKey = Object.keys(env).find((k) => /^path$/i.test(k));
    const realPath = pathKey ? env[pathKey] : '';
    if (pathKey) delete env[pathKey];
    env.PATH = fakeGitDir + path.delimiter + realPath;
    const { stdout } = await runHook(env, home, 'a.js');
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'a git timeout must never turn into a deny');
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => /did not respond within 100ms/i.test(l.reason)), 'a fail-open line naming the timeout');
  });
});

test('hook: an unreadable/corrupt tracking file allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const dir = path.join(stateDir, 'guards', 'plan-gate');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.ndjson'), '{ this is not valid json\n');
    // A closed port: this call must never need the board (a torn tracking
    // file counts as zero touched files, so this is file #1, a free pass).
    const { stdout } = await runHook(baseEnv(home, stateDir, 65530), home, 'a.js');
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => /tracking file is unreadable or corrupt/i.test(l.reason)), 'a fail-open line naming the corrupt state file');
  });
});

// I-new-1: a torn line alongside otherwise-valid history is
// a DIFFERENT case from a wholly-unreadable file - the valid lines (a.js,
// b.js) still count, so this call can genuinely need the chain, and if the
// board is ALSO down that call's own fail-open must not stack a second
// report on top of the state-issue report. The round-1 code reported BOTH
// (reproduced by the round-2 reviewer's probe D); fixed by making
// reportOnce a true once-per-invocation guard, and by repairing the
// tracking file (rewriting out the torn line) the first time it is seen, so
// a later, unrelated call never re-reports the same old corruption.
test('I-new-1: a torn line plus board-down reports exactly once, and repairs the file so the next call is silent', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const dir = path.join(stateDir, 'guards', 'plan-gate');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.ndjson'), [
      JSON.stringify({ cardId: 'mc-1', path: 'a.js', ts: 1 }),
      '{ torn',
      JSON.stringify({ cardId: 'mc-1', path: 'b.js', ts: 2 }),
    ].join('\n') + '\n');

    const { stdout } = await runHook(baseEnv(home, stateDir, 65529), home, 'c.js');
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    const lines = readFailOpenLines(stateDir);
    assert.equal(lines.length, 1, 'exactly one fail-open report for this call, not one per issue');

    // The file must now be repaired: the torn line is gone, the two valid
    // lines survive, so a second call on an ALREADY-touched file (still a
    // source file, so it actually reaches readTouchedFiles) reports nothing
    // new. K7 fix round 3: this used README.md, a docs file that the
    // cheap pre-check now returns on before ever calling readTouchedFiles -
    // that version proved nothing about the repair. a.js does reach it.
    const repaired = readTouchedLines(stateDir, 'sess-1');
    assert.deepEqual(repaired.map((l) => l.path).sort(), ['a.js', 'b.js']);

    const r2 = await runHook(baseEnv(home, stateDir, 65529), home, 'a.js');
    assert.equal(r2.stdout.trim(), '');
    assert.equal(readFailOpenLines(stateDir).length, 1, 'the repaired file must not be re-reported on a later call that reaches readTouchedFiles again');
  });
});

// git ls-tree distinguishes a real "not committed" -
// from "git could not answer" -------------------------------------------

test('hook: a plan genuinely not committed at HEAD is a real deny (not a fail-open)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home); // HEAD exists, but the plan file is never added
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: 'docs/superpowers/plans/uncommitted.md', taskClass: 'feature' }));
      },
    });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /not committed at HEAD/);
      const lines = readFailOpenLines(stateDir);
      assert.equal(lines.length, 0, 'a real deny is not a fail-open');
      const posted = JSON.parse(stub.calls.find((c) => c.method === 'POST' && c.url === '/api/guards/refusal').body);
      assert.equal(posted.failOpen, false);
      assert.equal(posted.sessionId, 'sess-1');
    } finally { await stub.close(); }
  });
});

// Card glmps-2-0-85: card 83 declared its plan on its spec branch and built on
// sibling branches cut before that merge, and every edit past the second was
// refused although the plan was committed.
test('hook: a plan committed only on a sibling branch is recognized (no false deny)', async () => {
  await withTempHome(async (home) => {
    const git = initGitRepo(home);
    const build = git(['symbolic-ref', '--short', 'HEAD']).trim();
    git(['checkout', '-q', '-b', 'spec']);
    commitFile(git, home, 'docs/specs/plan.md', '# Plan\n');
    git(['checkout', '-q', build]);
    assert.equal(fs.existsSync(path.join(home, 'docs/specs/plan.md')), false, 'sanity: the plan is not at HEAD');
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    let plan = 'docs/specs/plan.md';
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan, taskClass: 'feature' }));
      },
    });
    try {
      const ok = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      assert.doesNotMatch(ok.stdout, /"permissionDecision":"deny"/);
      plan = 'docs/specs/missing.md';
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'd.js');
      assert.match(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason, /not committed at HEAD or on any branch/);
    } finally { await stub.close(); }
  });
});

test('hook: a repo with no commits at all (unborn HEAD) fails open, never denies', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home, { empty: true }); // git init, but zero commits: no HEAD yet
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: 'docs/superpowers/plans/p.md', taskClass: 'feature' }));
      },
    });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'no HEAD is a git problem, not evidence the plan is uncommitted');
    } finally { await stub.close(); }
  });
});

// C-new: git ls-tree/show resolve their
// pathspec relative to CWD, not the repo root. A session whose cwd is a
// subdirectory (very ordinary - an agent cd'd into server/ before editing)
// got a FALSE DENY on a genuinely committed plan/spec, because
// `git ls-tree HEAD -- docs/plans/p.md` run from inside a subdirectory looks
// for `<subdir>/docs/plans/p.md`, not `docs/plans/p.md` from the top. A gate
// that denies real work because of where the agent's shell happened to be
// is exactly the fail-closed outcome this hook must never produce. Fixed by
// running every isCommitted/readCommitted git call with cwd = the resolved
// repo top level, never the tool call's own cwd.

test('C-new: a committed plan and spec are recognized from a repo subdirectory cwd (no false deny)', async () => {
  await withTempHome(async (home) => {
    const git = initGitRepo(home);
    commitFile(git, home, 'docs/specs/s.md', 'spec');
    commitFile(git, home, 'docs/plans/p.md', '# P\n\n**Spec:** `docs/specs/s.md`\n');
    fs.mkdirSync(path.join(home, 'server'));
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: 'docs/plans/p.md', taskClass: 'feature' }));
      },
    });
    try {
      const rootRun = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js', 'sess-1');
      assert.doesNotMatch(rootRun.stdout, /"permissionDecision":"deny"/, 'sanity: from the repo root this already passes');

      const subdirEnv = baseEnv(home, stateDir, stub.port);
      const subRun = await runHook(subdirEnv, path.join(home, 'server'), 'd.js', 'sess-1');
      assert.doesNotMatch(subRun.stdout, /"permissionDecision":"deny"/, 'a committed plan/spec must be recognized from a subdirectory cwd too');
    } finally { await stub.close(); }
  });
});


test('hook: bad stdin JSON allows and does NOT write a fail-open line (M4: no card is known yet)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65531);
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [planGateScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, code }));
      child.stdin.end('{ this is not valid json for the hook itself');
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), '');
    assert.match(out.stderr, /could not parse the tool-call payload/);
    assert.deepEqual(readFailOpenLines(stateDir), [], 'no card is resolved yet: stderr only, never a fail-open line');
  });
});

test('hook: a genuine deny is exactly the documented PreToolUse JSON shape', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass: 'feature' }));
      },
    });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), home, 'c.js');
      const parsed = JSON.parse(stdout);
      assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, 'string');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /no plan is declared/);
      // the board URL must name the REAL configured port, not a
      // hardcoded default - this session's GLMPS_PORT is the stub's own port.
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, new RegExp(`http://127\\.0\\.0\\.1:${stub.port}/api/backlog/mc-1/progress`));
    } finally { await stub.close(); }
  });
});

// Minor: a .md edit must cost nothing (no git
// spawn) and never report anything, even outside any git repo at all -
// round 1 called gitRepoTop() unconditionally before checking isSourcePath,
// so a documentation edit outside a repo produced a spurious fail-open
// report ("git exited with an error... not a git repository"). Title fixed
// : this covers only the cwd-independent `.md` suffix
// check, not the separate top-level docs/ directory exemption (see the
// subdirectory docs/ test just below), and the old title claimed both.
test('minor: a .md edit costs nothing and never reports, even outside any git repo', async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, '.glmps');
    // No git repo anywhere under `home`; GIT_CEILING_DIRECTORIES stops git
    // from ascending past `home` into whatever real repo sits above the OS
    // temp dir.
    const env = { ...baseEnv(home, stateDir, 65535), GIT_CEILING_DIRECTORIES: home };
    const { stdout } = await runHook(env, home, 'notes.md');
    assert.equal(stdout.trim(), '');
    assert.deepEqual(readFailOpenLines(stateDir), [], 'a .md edit must never produce a fail-open report');
  });
});

// a top-level docs/ file that is NOT `.md` (so it does
// not return via the cheap .md$ pre-check above) must still be exempt via
// isSourcePath's own top-level docs/ rule, even when the tool call's cwd is a
// subdirectory - and being exempt, it must cost nothing: no chain call, and
// nothing recorded as a touched file either.
test('hook: a top-level docs/ non-md file edited from a subdirectory cwd stays exempt (no chain call, nothing recorded)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    fs.mkdirSync(path.join(home, 'server'));
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass: 'feature' }));
      },
    });
    try {
      // cwd = home/server, target = ../docs/x.js - the real, repo-root-
      // relative path is docs/x.js, a TOP-LEVEL docs/ file (exempt), even
      // though it is reached from a subdirectory cwd and is not `.md`.
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), path.join(home, 'server'), path.join('..', 'docs', 'x.js'));
      assert.equal(stdout.trim(), '', 'a top-level docs/ file must never be gated, even from a subdirectory cwd');
      const chainCalls = stub.calls.filter((c) => c.url.endsWith('/chain'));
      assert.equal(chainCalls.length, 0, 'no chain call for an exempt docs/ file');
      assert.deepEqual(readTouchedLines(stateDir, 'sess-1').map((l) => l.path).sort(), ['a.js', 'b.js'], 'the docs file must not be recorded as touched either');
    } finally { await stub.close(); }
  });
});

// the round-2 cheap
// pre-check computed cheapRel relative to CWD and reused isSourcePath
// (which also checks ^docs/) - so from a subdirectory cwd, a real, nested
// source file under a "docs" directory (server/docs/y.js, edited with cwd
// server/) looked like a TOP-LEVEL docs file ("docs/y.js") and was exempted
// before ever reaching the repo-root-relative check that would have
// correctly counted it as source. This reopened M6 behind a comment that
// claimed it could not happen (reproduced by the round-3 reviewer's probe
// G: from the repo root the same file correctly denies; from server/ it
// silently passes with zero chain calls). Fixed: the cheap pre-check now
// tests ONLY the cwd-independent .md$ suffix; the docs/ directory exemption
// is left entirely to the repo-root-relative isSourcePath check.
test('I-r2-1: a nested docs/ source file edited from a subdirectory cwd still counts (and denies at a source file beyond the first two)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    fs.mkdirSync(path.join(home, 'server', 'docs'), { recursive: true });
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass: 'feature' }));
      },
    });
    try {
      // cwd = home/server, target = home/server/docs/y.js - cwd-relative
      // this LOOKS like "docs/y.js" (top-level docs), but the real,
      // repo-root-relative path is "server/docs/y.js" (nested, real source).
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), path.join(home, 'server'), path.join('docs', 'y.js'));
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', 'a nested docs/ file must be counted like any other source file, not exempted by a cwd-relative illusion');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /no plan is declared/);
    } finally { await stub.close(); }
  });
});

// Minor: `git rev-parse --show-toplevel` resolves
// a junction to its real target, but a NEW file's path (it does not exist
// yet, so realpath on the file itself fails) was left unresolved under the
// junction - the two sides of path.relative() then belonged to different
// (though equivalent) trees, computed as "outside the repo", and the file
// silently bypassed the gate entirely rather than being counted. Fixed by
// realpath-ing the nearest EXISTING parent directory and rejoining the
// remaining path segments.
test('minor: a new file reached through a junction is counted, not silently bypassed', async (t) => {
  await withTempHome(async (home) => {
    const real = path.join(home, 'real');
    fs.mkdirSync(real);
    initGitRepo(real);
    const link = path.join(home, 'link');
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch (e) {
      t.skip(`platform refused to create a junction without privilege (${e.code ?? e.message})`);
      return;
    }
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({
      onChain: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass: 'feature' }));
      },
    });
    try {
      // c.js is a NEW file (does not exist yet), reached through the
      // junction. It must be recognized as the third IN-REPO file (needs
      // the chain) and, since chain.plan is null, DENY - proving it was
      // counted rather than silently treated as outside the repo (which
      // would produce empty stdout instead).
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), link, 'c.js');
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', 'a file reached through a junction must be counted like any other in-repo file');
    } finally { await stub.close(); }
  });
});


test('hook: a scratchpad file outside the repo never counts and is never blocked', async () => {
  await withTempHome(async (home) => {
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);
    const scratchDir = path.join(home, 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    const stateDir = path.join(home, '.glmps');
    // Two REAL in-repo files already touched, so a third in-repo file would
    // need the chain - but this call targets a file OUTSIDE the repo. A
    // non-.md name (notes.js), since round 3's fix (I-r2-1) makes a .md file
    // return before ever reaching the repo-relative/outside-repo check this
    // test means to exercise.
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const { stdout } = await runHook(baseEnv(home, stateDir, 65532), repoDir, path.join('..', 'scratch', 'notes.js'));
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    assert.deepEqual(readTouchedLines(stateDir, 'sess-1').map((l) => l.path).sort(), ['a.js', 'b.js'], 'the outside-repo file must never be recorded as a distinct touched file');
  });
});

// Minor: a repair (torn tracking line rewritten out) that
// happens to coincide with an OUTSIDE-REPO edit used to be entirely silent -
// repoRelativePath returning null triggered an early return BEFORE the
// `if (stateIssue)` report check ever ran, so the repair (a real anomaly
// worth the dashboard seeing) left no trace anywhere. The tool call itself
// was always correctly allowed either way (an outside-repo file is never
// gated); what changes here is only that the repair is now reported, same
// as it would be for an in-repo file.
test('hook: a repair seen on an outside-repo edit is still reported, not silent', async () => {
  await withTempHome(async (home) => {
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);
    const scratchDir = path.join(home, 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    const stateDir = path.join(home, '.glmps');
    const dir = path.join(stateDir, 'guards', 'plan-gate');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.ndjson'), '{ torn\n');

    const { stdout } = await runHook(baseEnv(home, stateDir, 65531), repoDir, path.join('..', 'scratch', 'notes.js'));
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'an outside-repo file is still never gated');
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => /tracking file is unreadable or corrupt/i.test(l.reason)), 'the repair must still be reported even though this particular edit is outside the repo');
  });
});


// renamed from "two concurrent touches" - these two
// hook invocations run sequentially, not concurrently. The property under
// test (an APPEND never clobbers a prior append, unlike a read-modify-write)
// holds identically either way; the name should not claim more than the
// test does.
test('hook: two sequential touches on the same session append-only, neither is lost', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    await runHook(baseEnv(home, stateDir, 65533), home, 'a.js');
    await runHook(baseEnv(home, stateDir, 65533), home, 'b.js');
    const touched = readTouchedLines(stateDir, 'sess-1').map((l) => l.path).sort();
    assert.deepEqual(touched, ['a.js', 'b.js']);
  });
});


test('hook: switching cards on the same session_id does not carry over the old card\'s file count', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    // Two files already touched, but for a DIFFERENT card than the one this
    // call is running under.
    seedTouched(stateDir, 'sess-1', 'mc-OLD', ['a.js', 'b.js']);
    const env = { ...baseEnv(home, stateDir, 65534), GLMPS_CARD_ID: 'mc-NEW' };
    const { stdout } = await runHook(env, home, 'c.js');
    // c.js is only the FIRST file under mc-NEW (the mc-OLD lines do not
    // count), so this must pass free with no board call needed at all.
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    assert.doesNotMatch(stdout, /additionalContext/);
  });
});

// The empty catch around `git symbolic-ref` read EVERY failure (a timeout, a
// missing git) as "no card", which silently switched the gate off. Only a
// definitive "there is no branch" answer from git (a detached HEAD, or a cwd
// that is not a repository at all) is still "no card"; anything else is a
// named fail-open through reportOnce.
const gitFail = (stderr, extra = {}) => Object.assign(new Error('x'), { cause: { status: 128, stderr, ...extra } });
test('I5: branchReadIssue: a detached HEAD or a non-repo cwd is a definitive no-branch answer (null)', () => {
  assert.equal(branchReadIssue(gitFail('fatal: ref HEAD is not a symbolic ref\n')), null);
  assert.equal(branchReadIssue(gitFail('fatal: not a git repository (or any of the parent directories): .git\n')), null);
});
test('I5: branchReadIssue: a timeout, a missing git or any other git error is a named issue', () => {
  assert.match(branchReadIssue(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } })), /did not respond within/);
  assert.match(branchReadIssue(Object.assign(new Error('x'), { cause: { code: 'ENOENT' } })), /not installed or not on PATH/);
  assert.match(branchReadIssue(gitFail('fatal: unable to read HEAD: Permission denied')), /git exited with an error/);
  assert.match(branchReadIssue(new Error('no cause at all')), /git exited with an error/);
});

test('I5: a detached HEAD with no GLMPS_CARD_ID is still "no card": silent, nothing logged', async () => {
  await withTempHome(async (home) => {
    const git = initGitRepo(home);
    git(['checkout', '-q', '--detach']);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65526);
    delete env.GLMPS_CARD_ID;
    const { stdout } = await runHook(env, home, 'a.js');
    assert.equal(stdout.trim(), '');
    assert.deepEqual(readFailOpenLines(stateDir), []);
  });
});

test('I5: a branch read that times out is a named fail-open, never a silent "no card"', async (t) => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const fakeGitDir = path.join(home, 'fake-git-bin');
    const fakeGit = buildFakeHangingGit(fakeGitDir);
    if (!fakeGit) { t.skip('no C# compiler (csc.exe) found to build a fake hanging git on this machine'); return; }
    const env = { ...baseEnv(home, stateDir, 65525), GLMPS_HOOK_GIT_TIMEOUT_MS: '100' };
    delete env.GLMPS_CARD_ID; // the card would come from the branch: the read failing must not read as "no card"
    const pathKey = Object.keys(env).find((k) => /^path$/i.test(k));
    const realPath = pathKey ? env[pathKey] : '';
    if (pathKey) delete env[pathKey];
    env.PATH = fakeGitDir + path.delimiter + realPath;
    const { stdout } = await runHook(env, home, 'a.js');
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    assert.match(stdout, /could not read the current branch/);
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => /could not read the current branch.*did not respond within 100ms/i.test(l.reason)), `a named fail-open line, got ${JSON.stringify(lines)}`);
  });
});

test('I5: a touched-file append failure is a named fail-open (reportOnce), not stderr only', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js']);
    const tracking = path.join(stateDir, 'guards', 'plan-gate', 'sess-1.ndjson');
    fs.chmodSync(tracking, 0o444); // readable, not appendable
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, 65524), home, 'b.js');
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /could not record the touched file/i.test(l.reason)), `a named fail-open line, got ${JSON.stringify(lines)}`);
    } finally { fs.chmodSync(tracking, 0o644); }
  });
});

test('silent-failure: gitRepoTop names a realpath failure instead of swallowing it', () => {
  const writes = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (m) => { writes.push(String(m)); return true; };
  let top;
  try {
    top = gitRepoTop('X:/repo', { run: () => 'X:/repo\n', realpath: () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); } });
  } finally { process.stderr.write = realWrite; }
  assert.equal(top, path.resolve('X:/repo'));
  assert.ok(writes.some((w) => /could not realpath the repo top level.*EACCES/.test(w)), JSON.stringify(writes));
});

test('I6: boardUrl is GLMPS_BOARD_URL, else GLMPS_PORT, else 8124 (the 2.0 kernel, not production)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-i6-home-'));
  try {
    assert.equal(boardUrl({}, home), 'http://127.0.0.1:8124');
    assert.equal(boardUrl({ GLMPS_PORT: '9001' }, home), 'http://127.0.0.1:9001');
    assert.equal(boardUrl({ GLMPS_PORT: '9001', GLMPS_BOARD_URL: 'http://127.0.0.1:7777/' }, home), 'http://127.0.0.1:7777');
  } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('I6: envStateDir is GLMPS_STATE_DIR, else ~/.glmps-2', () => {
  assert.equal(envStateDir({ GLMPS_STATE_DIR: 'X:/s' }, 'X:/home'), 'X:/s');
  assert.equal(envStateDir({}, 'X:/home'), path.join('X:/home', '.glmps-2'));
});

test('I6: the hook reaches the board at GLMPS_BOARD_URL ahead of GLMPS_PORT', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    seedTouched(stateDir, 'sess-1', 'mc-1', ['a.js', 'b.js']);
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(404); res.end(); } });
    try {
      const env = { ...baseEnv(home, stateDir, 65523), GLMPS_BOARD_URL: `http://127.0.0.1:${stub.port}` };
      await runHook(env, home, 'c.js');
      assert.ok(stub.calls.some((c) => c.url.endsWith('/chain')), 'the chain was fetched from GLMPS_BOARD_URL, not GLMPS_PORT');
    } finally { await stub.close(); }
  });
});

test('I6: with GLMPS_STATE_DIR unset, the hook writes under ~/.glmps-2, never ~/.glmps', async () => {
  await withTempHome(async (home) => {
    const notRepo = path.join(home, 'not-a-repo');
    fs.mkdirSync(notRepo);
    const env = baseEnv(home, 'unused', 65522);
    delete env.GLMPS_STATE_DIR;
    await runHook(env, notRepo, 'a.js'); // GLMPS_CARD_ID set, no repo: a fail-open that must land in the 2.0 state dir
    assert.ok(readFailOpenLines(path.join(home, '.glmps-2')).length >= 1, 'fail-open logged under ~/.glmps-2');
    assert.equal(fs.existsSync(path.join(home, '.glmps')), false, 'production state dir untouched');
  });
});

function writeCutoverMarker(home) {
  const dir = path.join(home, '.glmps', 'cutover');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active.json'), '{}');
}

test('D30: with the cutover marker, boardUrl defaults to 8123 and envStateDir to ~/.glmps; env still wins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-d30-home-'));
  try {
    writeCutoverMarker(home);
    assert.equal(boardUrl({}, home), 'http://127.0.0.1:8123');
    assert.equal(envStateDir({}, home), path.join(home, '.glmps'));
    assert.equal(boardUrl({ GLMPS_PORT: '9001' }, home), 'http://127.0.0.1:9001');
    assert.equal(envStateDir({ GLMPS_STATE_DIR: 'X:/s' }, home), 'X:/s');
  } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('D30: with the cutover marker and GLMPS_STATE_DIR unset, the hook writes under ~/.glmps, not ~/.glmps-2', async () => {
  await withTempHome(async (home) => {
    writeCutoverMarker(home);
    const notRepo = path.join(home, 'not-a-repo');
    fs.mkdirSync(notRepo);
    const env = baseEnv(home, 'unused', 65521);
    delete env.GLMPS_STATE_DIR;
    await runHook(env, notRepo, 'a.js');
    assert.ok(readFailOpenLines(path.join(home, '.glmps')).length >= 1, 'fail-open logged under ~/.glmps');
    assert.equal(fs.existsSync(path.join(home, '.glmps-2')), false, 'the shadow state dir is not used after cutover');
  });
});

test("silent-failure: reportRefusal caps fields client-side to the route's own caps", async () => {
  const stub = await startStubKernel({ onChain: () => {} });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rr-'));
  try {
    const r = await reportRefusal({ hook: 'plan-gate', cardId: 'c'.repeat(300), sessionId: 's'.repeat(300), tool: 't'.repeat(100), path: 'p'.repeat(3000), reason: 'r'.repeat(5000), failOpen: true },
      { baseUrl: `http://127.0.0.1:${stub.port}`, timeoutMs: 1000, stateDir });
    assert.equal(r.ok, true);
    const sent = JSON.parse(stub.calls.find((c) => c.url === '/api/guards/refusal').body);
    assert.ok(sent.reason.length <= 2000 && sent.path.length <= 1024 && sent.cardId.length <= 128 && sent.sessionId.length <= 128 && sent.tool.length <= 64,
      JSON.stringify(Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, String(v).length]))));
  } finally { await stub.close(); }
});

test('silent-failure: a refused or unreachable report is logged locally with the reason', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rr2-'));
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"unknown hook"}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await reportRefusal({ hook: 'plan-gate', cardId: 'mc-1', reason: 'denied' }, { baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000, stateDir });
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 400/);
    const closed = await reportRefusal({ hook: 'plan-gate', cardId: 'mc-2', reason: 'denied' }, { baseUrl: 'http://127.0.0.1:65521', timeoutMs: 500, stateDir });
    assert.equal(closed.ok, false);
    const lines = fs.readFileSync(path.join(stateDir, 'guards', 'report-failures.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].cardId, 'mc-1');
    assert.match(lines[0].reportError, /HTTP 400/);
    assert.match(lines[1].reportError, /unreachable|did not answer/);
  } finally { await new Promise((r) => server.close(r)); }
});

// Card glmps-2-0-33 (D32 follow-on, Q4): a committed Pocock spec is itself the design.
test('a declared spec under docs/specs that is committed passes at the third file', () => {
  const d = planGateDecision({ chain: chain('docs/specs/2026-10-17-x.md'), files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo(['docs/specs/2026-10-17-x.md']) });
  assert.equal(d.allow, true);
  assert.equal(d.failOpen, undefined, 'a real pass, not a skipped check');
});

test('an uncommitted spec is refused, and the no-design refusal names to-spec', () => {
  const unc = planGateDecision({ chain: chain('docs/specs/2026-10-17-x.md'), files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo([]) });
  assert.equal(unc.allow, false);
  assert.match(unc.reason, /not committed at HEAD/);
  const none = planGateDecision({ chain: chain(null), files: ['a.js', 'b.js'], filePath: 'c.js', repoCheck: repo([]) });
  assert.match(none.reason, /to-spec/);
  assert.doesNotMatch(none.reason, /superpowers/);
  assert.match(none.reason, /docs\/specs\//);
});

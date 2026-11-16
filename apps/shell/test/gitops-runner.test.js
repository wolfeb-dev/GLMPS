// apps/shell/test/gitops-runner.test.js
// The shell's half of the merge queue's git, gh and test runs: the service
// kernel queues a 'gitops' launch record, this runner (in the operator's own
// session, where the GitHub sign-in is) claims it through the authenticated
// launch protocol, re-checks it against the allowlist, runs it and posts the
// result. Nothing here starts a real process.
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitopsRunner, resolveClaudeBinary } from '../src/lib/gitops-runner.js';
import { computeProof, sha256Hex } from '../src/lib/launch-auth.js';

const token = 'b'.repeat(64);
const ID = 'ln_3f2a9b1c-1111-4222-8333-444455556666';
const ROOTS = { repos: ['D:\\glmps'], worktrees: 'C:\\wt' };
const readLaunchToken = () => ({ token, reason: null });

function respondSigned(tok, url, opts, body) {
  const nonce = opts?.headers?.['x-launch-nonce'];
  const u = new URL(url);
  const proof = nonce ? computeProof(tok, { direction: 'res', method: opts?.method || 'GET', path: u.pathname + u.search, nonce, bodyHash: sha256Hex(JSON.stringify(body)) }) : null;
  return { ok: true, status: 200, json: async () => body, headers: { get: (n) => (n === 'x-launch-response-proof' ? proof : null) } };
}

function fakeKernel(records, { signWith = token, cancel = [] } = {}) {
  const calls = [];
  let handed = false;
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.pathname === '/api/launches') {
      const pending = typeof records === 'function' ? records(polls++) : (handed ? [] : records);
      handed = true;
      return respondSigned(signWith, url, opts, { pending, allowedCommands: ['claude'], cancel: typeof cancel === 'function' ? cancel(polls - 1) : cancel });
    }
    if (u.pathname.endsWith('/claim')) return respondSigned(signWith, url, opts, { state: 'claimed' });
    return { ok: true, status: 204, json: async () => null, headers: { get: () => null } };
  };
  return { fetchImpl, calls, results: () => calls.filter((c) => c.path.endsWith('/result')).map((c) => c.body) };
}

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, fail = null } = {}) {
  const runs = [];
  const children = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    children.push(child);
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 4242;
    const run = { file, args, opts, stdin: '', stdinEnded: false };
    child.stdin = Object.assign(new EventEmitter(), { write(d) { run.stdin += String(d); return true; }, end(d) { if (d != null) run.stdin += String(d); run.stdinEnded = true; } });
    runs.push(run);
    setImmediate(() => {
      if (fail) { child.emit('error', fail); return; }
      if (hang) return;
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, null);
    });
    return child;
  };
  return { spawnImpl, runs, lastChild: () => children.at(-1) };
}

const gitRec = (over = {}, op = {}) => ({
  id: ID, origin: 'gitops', command: 'gitops git', cwd: 'D:\\glmps', state: 'pending',
  op: { kind: 'git', cwd: 'D:\\glmps', args: ['status', '--porcelain'], timeoutMs: 5000, roots: ROOTS, maxOutput: 1000, ...op }, ...over,
});

function runner(kernel, spawn, extra = {}) {
  const logs = [];
  const killed = [];
  const r = createGitopsRunner({
    kernelUrl: 'http://127.0.0.1:8123', fetchImpl: kernel.fetchImpl, spawnImpl: spawn.spawnImpl, readLaunchToken, stateDir: 'x', worktreesDir: 'C:\\wt',
    env: { PATH: '/bin', GH_TOKEN: 'secret' }, log: (m) => logs.push(m), killTree: (c) => killed.push(c), ...extra,
  });
  return { r, logs, killed };
}

test('a verified poll with a git record: claim, spawn git with the validated argv in the validated cwd, post the result', async () => {
  const kernel = fakeKernel([gitRec()]);
  const spawn = fakeSpawn({ stdout: ' M a.js\n', stderr: 'warn' });
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.deepEqual(kernel.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/launches', `POST /api/launches/${ID}/claim`, `POST /api/launches/${ID}/result`]);
  assert.equal(spawn.runs.length, 1);
  const { file, args, opts } = spawn.runs[0];
  assert.equal(file, 'git');
  assert.deepEqual(args, ['status', '--porcelain']);
  assert.equal(opts.cwd, 'D:\\glmps');
  assert.equal(opts.shell, undefined);
  assert.deepEqual(kernel.results(), [{ result: { status: 0, stdout: ' M a.js\n', stderr: 'warn', timedOut: false } }]);
});

test('the child gets a filtered environment: no token variables, git prompts off', async () => {
  const kernel = fakeKernel([gitRec()]);
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn, { env: undefined });
  const saved = process.env.GH_TOKEN; process.env.GH_TOKEN = 'leak-me-not';
  try { await r.tick(); await r.idle(); } finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
  const env = spawn.runs[0].opts.env;
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('a gh pr merge record runs gh with the pinned head; --admin is refused before any spawn and reported as a refusal', async () => {
  const sha = 'c'.repeat(40);
  const good = { id: ID, origin: 'gitops', command: 'gitops gh', cwd: 'gitops', state: 'pending', op: { kind: 'gh', args: ['pr', 'merge', '5', '-R', 'wolfeb-dev/glmps-2.0', '--merge', '--match-head-commit', sha], timeoutMs: 5000, roots: ROOTS } };
  const k1 = fakeKernel([good]); const s1 = fakeSpawn({ stdout: 'merged' });
  const a = runner(k1, s1); await a.r.tick(); await a.r.idle();
  assert.equal(s1.runs[0].file, 'gh');
  assert.deepEqual(k1.results()[0].result.status, 0);

  const bad = { ...good, op: { ...good.op, args: [...good.op.args, '--admin'] } };
  const k2 = fakeKernel([bad]); const s2 = fakeSpawn();
  const b = runner(k2, s2); await b.r.tick(); await b.r.idle();
  assert.equal(s2.runs.length, 0, 'nothing is started for a refused op');
  assert.match(k2.results()[0].error, /^refused by shell: /);
});

test('a push record is claimed, refused, and reported; git is never spawned', async () => {
  const kernel = fakeKernel([gitRec({}, { args: ['push', 'origin', 'main'] })]);
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell: git push is not allowed/);
});

test('a cwd outside the roots the record names is refused', async () => {
  const kernel = fakeKernel([gitRec({}, { cwd: 'C:\\Windows' })]);
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell: .*root/);
});

test('a test record runs the package command through the shell in the merge-queue dir; a non-zero exit is a result', async () => {
  const rec = { id: ID, origin: 'gitops', command: 'gitops test', cwd: 'C:\\wt\\merge-queue\\c1', state: 'pending', op: { kind: 'test', cwd: 'C:\\wt\\merge-queue\\c1', command: 'npm test', timeoutMs: 5000, roots: ROOTS, maxOutput: 1000 } };
  const kernel = fakeKernel([rec]);
  const spawn = fakeSpawn({ stdout: '1 failing', code: 1 });
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs[0].file, 'npm test');
  assert.equal(spawn.runs[0].opts.shell, true);
  assert.equal(spawn.runs[0].opts.cwd, 'C:\\wt\\merge-queue\\c1');
  assert.deepEqual(kernel.results(), [{ result: { status: 1, stdout: '1 failing', stderr: '', timedOut: false } }]);
  const outside = { ...rec, op: { ...rec.op, cwd: 'D:\\glmps' } };
  const k2 = fakeKernel([outside]); const s2 = fakeSpawn();
  const b = runner(k2, s2); await b.r.tick(); await b.r.idle();
  assert.equal(s2.runs.length, 0);
  assert.match(k2.results()[0].error, /merge-queue/);
});

test('a run past its timeout has its process tree killed and reports timedOut', async () => {
  const kernel = fakeKernel([gitRec({}, { timeoutMs: 1000 })]);
  const spawn = fakeSpawn({ hang: true });
  const { r, killed } = runner(kernel, spawn, { setTimeoutImpl: (fn) => setImmediate(fn), clearTimeoutImpl: clearImmediate });
  await r.tick(); await r.idle();
  assert.equal(killed.length, 1, 'killTree was called on the child');
  const res = kernel.results()[0].result;
  assert.deepEqual([res.timedOut, Number.isInteger(res.status)], [true, true]);
});

test('output is capped: a git read keeps its head, a test run its tail', async () => {
  const kernel = fakeKernel([gitRec({}, { maxOutput: 5 })]);
  const spawn = fakeSpawn({ stdout: '0123456789' });
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(kernel.results()[0].result.stdout, '01234');
  const rec = { id: ID, origin: 'gitops', command: 'gitops test', cwd: 'x', state: 'pending', op: { kind: 'test', cwd: 'C:\\wt\\merge-queue\\c1', command: 'npm test', timeoutMs: 5000, roots: ROOTS, maxOutput: 5 } };
  const k2 = fakeKernel([rec]); const s2 = fakeSpawn({ stdout: '0123456789' });
  const b = runner(k2, s2); await b.r.tick(); await b.r.idle();
  assert.equal(k2.results()[0].result.stdout, '56789');
});

test('a gh job-log read keeps its tail, where a test leg prints its summary; other gh reads keep their head', async () => {
  const ghRec = (args) => ({ id: ID, origin: 'gitops', command: 'gitops gh', cwd: 'gitops', state: 'pending', op: { kind: 'gh', args, timeoutMs: 5000, roots: ROOTS, maxOutput: 5 } });
  const k1 = fakeKernel([ghRec(['run', 'view', '--job', '42', '-R', 'wolfeb-dev/glmps-2.0', '--log'])]);
  const a = runner(k1, fakeSpawn({ stdout: '0123456789' })); await a.r.tick(); await a.r.idle();
  assert.equal(k1.results()[0].result.stdout, '56789');
  const k2 = fakeKernel([ghRec(['run', 'view', '42', '-R', 'wolfeb-dev/glmps-2.0', '--json', 'jobs'])]);
  const b = runner(k2, fakeSpawn({ stdout: '0123456789' })); await b.r.tick(); await b.r.idle();
  assert.equal(k2.results()[0].result.stdout, '01234');
});

test('a spawn error is reported as an error, not a result', async () => {
  const kernel = fakeKernel([gitRec()]);
  const spawn = fakeSpawn({ fail: new Error('spawn git ENOENT') });
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.match(kernel.results()[0].error, /ENOENT/);
});

test('records of other origins are left alone; an unverifiable kernel runs nothing', async () => {
  const other = fakeKernel([{ id: ID, origin: 'terminal', command: 'claude', cwd: 'x', state: 'pending' }]);
  const s1 = fakeSpawn();
  const a = runner(other, s1); await a.r.tick(); await a.r.idle();
  assert.deepEqual(other.calls.map((c) => c.path), ['/api/launches']);
  const forged = fakeKernel([gitRec()], { signWith: 'f'.repeat(64) });
  const s2 = fakeSpawn();
  const b = runner(forged, s2); await b.r.tick(); await b.r.idle();
  assert.equal(s2.runs.length, 0);
  assert.deepEqual(forged.calls.map((c) => c.path), ['/api/launches']);
});

test('with no launch token the runner refuses to run anything', async () => {
  const kernel = fakeKernel([gitRec()]);
  const spawn = fakeSpawn();
  const { r, logs } = runner(kernel, spawn, { readLaunchToken: () => ({ token: null, reason: 'no token file' }) });
  await r.tick();
  assert.equal(kernel.calls.length, 0);
  assert.match(logs[0], /no token file/);
});

test('a long run does not block the next poll: a second record is claimed while the first is still running', async () => {
  const second = gitRec({ id: 'ln_3f2a9b1c-1111-4222-8333-444455556677' }, { args: ['rev-parse', 'HEAD'] });
  const kernel = fakeKernel((i) => (i === 0 ? [gitRec()] : i === 1 ? [second] : []));
  const hanging = fakeSpawn({ hang: true });
  const { r } = runner(kernel, hanging);
  await r.tick();
  await r.tick();
  assert.equal(hanging.runs.length, 2, 'both records are running at once');
  assert.deepEqual(kernel.results(), []);
});

const STATE = 'C:\\state';
const WTS = 'C:\\wt';
const CLAUDE = 'C:\\npm\\claude.exe';
const REVIEW_OP = {
  kind: 'review', cwd: `${WTS}\\proj\\card-1-review-r1`, model: 'sonnet', timeoutMs: 5000, roots: { repos: ['D:\\glmps'], worktrees: WTS },
  settings: `${STATE}\\role-settings\\reviewer-card-1-review-r1.json`, promptFile: `${STATE}\\runner\\card-1-review-r1.prompt.md`,
};
const reviewRec = (op = {}) => ({ id: ID, origin: 'gitops', command: 'gitops review', cwd: REVIEW_OP.cwd, state: 'pending', op: { ...REVIEW_OP, ...op } });
const reviewRunner = (kernel, spawn, extra = {}) => runner(kernel, spawn, {
  stateDir: STATE, resolveClaude: () => CLAUDE, readPrompt: () => ({ ok: true, text: 'REVIEW THIS DIFF' }), ...extra,
});

test('a review record spawns claude -p with the fixed argv in the review worktree, the prompt on stdin, and posts the exit', async () => {
  const kernel = fakeKernel([reviewRec()]);
  const spawn = fakeSpawn({ stdout: 'verdict posted', code: 0 });
  const { r } = reviewRunner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 1);
  const run = spawn.runs[0];
  assert.equal(run.file, CLAUDE);
  assert.deepEqual(run.args, ['-p', '--model', 'sonnet', '--settings', REVIEW_OP.settings, '--permission-mode', 'auto', '--fallback-model', 'haiku']);
  assert.equal(run.opts.cwd, REVIEW_OP.cwd);
  assert.equal(run.opts.shell, undefined);
  assert.deepEqual(run.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(run.stdin, 'REVIEW THIS DIFF');
  assert.equal(run.stdinEnded, true);
  assert.ok(!run.args.some((a) => a.includes('REVIEW THIS DIFF')), 'the prompt is never on the command line');
  assert.deepEqual(kernel.results(), [{ result: { status: 0, stdout: 'verdict posted', stderr: '', timedOut: false } }]);
});

test('a review that exits non-zero reports its code and the tail of its output', async () => {
  const kernel = fakeKernel([reviewRec({ maxOutput: 5 })]);
  const spawn = fakeSpawn({ stdout: '0123456789', stderr: 'abcdefghij', code: 2 });
  const { r } = reviewRunner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.deepEqual(kernel.results(), [{ result: { status: 2, stdout: '56789', stderr: 'fghij', timedOut: false } }]);
});

test('a review past its timeout has its process tree killed and reports timedOut', async () => {
  const kernel = fakeKernel([reviewRec({ timeoutMs: 1000 })]);
  const spawn = fakeSpawn({ hang: true });
  const { r, killed } = reviewRunner(kernel, spawn, { setTimeoutImpl: (fn) => setImmediate(fn), clearTimeoutImpl: clearImmediate });
  await r.tick(); await r.idle();
  assert.equal(killed.length, 1);
  assert.equal(kernel.results()[0].result.timedOut, true);
});

test('hostile review records are refused before any process starts', async () => {
  const hostile = [
    { cwd: 'D:\\glmps' },
    { cwd: `${WTS}\\proj\\card-1` },
    { model: '--dangerously-skip-permissions' },
    { settings: 'C:\\evil\\reviewer-x.json' },
    { promptFile: 'C:\\evil\\x.prompt.md' },
  ];
  for (const over of hostile) {
    const kernel = fakeKernel([reviewRec(over)]);
    const spawn = fakeSpawn();
    const { r } = reviewRunner(kernel, spawn);
    await r.tick(); await r.idle();
    assert.equal(spawn.runs.length, 0, JSON.stringify(over));
    assert.match(kernel.results()[0].error, /^refused by shell: /);
  }
});

test('a review whose prompt file cannot be read, or with no claude binary, is reported as an error and nothing starts', async () => {
  const k1 = fakeKernel([reviewRec()]); const s1 = fakeSpawn();
  const a = reviewRunner(k1, s1, { readPrompt: () => ({ ok: false, reason: 'prompt path is not a regular file' }) });
  await a.r.tick(); await a.r.idle();
  assert.equal(s1.runs.length, 0);
  assert.match(k1.results()[0].error, /prompt path is not a regular file/);

  const k2 = fakeKernel([reviewRec()]); const s2 = fakeSpawn();
  const b = reviewRunner(k2, s2, { resolveClaude: () => null });
  await b.r.tick(); await b.r.idle();
  assert.equal(s2.runs.length, 0);
  assert.match(k2.results()[0].error, /claude/i);
});

test('resolveClaudeBinary finds claude.exe on PATH, behind an npm shim, or in ~/.local/bin, and never returns a .cmd', () => {
  const files = new Set(['c:\\bin\\claude.exe']);
  const has = (p) => files.has(p.toLowerCase());
  assert.equal(resolveClaudeBinary({ env: { PATH: 'C:\\x;C:\\bin' }, exists: has, home: 'C:\\h', platform: 'win32' }), 'C:\\bin\\claude.exe');
  files.clear(); files.add('c:\\npm\\claude.cmd'); files.add('c:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(resolveClaudeBinary({ env: { PATH: 'C:\\npm' }, exists: has, home: 'C:\\h', platform: 'win32' }), 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  files.clear(); files.add('c:\\h\\.local\\bin\\claude.exe');
  assert.equal(resolveClaudeBinary({ env: { PATH: 'C:\\npm' }, exists: has, home: 'C:\\h', platform: 'win32' }), 'C:\\h\\.local\\bin\\claude.exe');
  files.clear(); files.add('c:\\npm\\claude.cmd');
  assert.equal(resolveClaudeBinary({ env: { PATH: 'C:\\npm' }, exists: has, home: 'C:\\h', platform: 'win32' }), null);
});

test('a record whose roots.worktrees lies about where worktrees live is refused: the runner pins paths to its own worktrees dir', async () => {
  const lying = gitRec({}, { cwd: 'C:\\evil\\p\\x', roots: { repos: ROOTS.repos, worktrees: 'C:\\evil' } });
  const kernel = fakeKernel([lying]);
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell: cwd is outside the allowed roots/);
});

test('a cancel request in the poll kills the in-flight run and reports it as cancelled with what it printed', async () => {
  let cancelNow = false;
  const kernel = fakeKernel((i) => (i === 0 ? [reviewRec()] : []), { cancel: () => (cancelNow ? [ID, 'ln_unknown'] : []) });
  const spawn = fakeSpawn({ hang: true });
  const { r, killed } = reviewRunner(kernel, spawn);
  await r.tick();
  assert.equal(spawn.runs.length, 1);
  spawn.lastChild().stdout.emit('data', Buffer.from('partial output'));
  await r.tick();
  assert.equal(killed.length, 0, 'no cancel asked yet');
  cancelNow = true;
  await r.tick();
  await r.idle();
  assert.equal(killed.length, 1);
  assert.deepEqual(kernel.results(), [{ result: { status: -2, stdout: 'partial output', stderr: '', timedOut: false, cancelled: true } }]);
  await r.tick();
  assert.equal(killed.length, 1, 'a finished run is not killed twice');
});

test('start registers one interval and stop clears it', () => {
  const kernel = fakeKernel([]);
  const { r } = runner(kernel, fakeSpawn(), { intervalMs: 1000000 });
  r.start(); r.start(); r.stop();
  assert.ok(true);
});

// Unattended reliability T6: the headless card run.
const CARD_SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CARD_OP = {
  kind: 'card', cwd: `${WTS}\\proj\\card-1`, sessionId: CARD_SID, resume: false, timeoutMs: 5000, roots: { repos: ['D:\\glmps'], worktrees: WTS },
  settings: `${STATE}\\role-settings\\worker-card-1.json`, promptFile: `${STATE}\\runner\\card-1.prompt.md`,
};
const cardRec = (op = {}) => ({ id: ID, origin: 'gitops', command: 'gitops card', cwd: CARD_OP.cwd, state: 'pending', op: { ...CARD_OP, ...op } });

test('a card record spawns claude -p under its session id in the card worktree, the prompt on stdin, and posts the exit tail', async () => {
  const kernel = fakeKernel([cardRec({ resume: true, maxOutput: 5 })]);
  const spawn = fakeSpawn({ stdout: '0123456789', code: 0 });
  const { r } = reviewRunner(kernel, spawn, { readPrompt: () => ({ ok: true, text: 'DO THE CARD' }) });
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 1);
  const run = spawn.runs[0];
  assert.equal(run.file, CLAUDE);
  assert.deepEqual(run.args, ['-p', '--settings', CARD_OP.settings, '--permission-mode', 'auto', '--resume', CARD_SID, '--fallback-model', 'sonnet,haiku']);
  assert.equal(run.opts.cwd, CARD_OP.cwd);
  assert.equal(run.stdin, 'DO THE CARD');
  assert.deepEqual(kernel.results(), [{ result: { status: 0, stdout: '56789', stderr: '', timedOut: false } }]);
});

// Card glmps-2-0-162: a non-Claude vendor card, one JSON document on stdout.
const VC_OP = {
  kind: 'vendor-card', vendor: 'gemini', model: null, cwd: `${WTS}\\proj\\card-1`, promptFile: `${STATE}\\runner\\card-1.prompt.md`,
  branch: 'card/card-1', base: 'glmps2/main', cardId: 'card-1', title: 'Do it', timeoutMs: 5000, roots: { repos: ['D:\\glmps'], worktrees: WTS },
};
const vcRec = (op = {}) => ({ id: ID, origin: 'gitops', command: 'gitops vendor-card', cwd: VC_OP.cwd, state: 'pending', op: { ...VC_OP, ...op } });
const AGY_JSON = '{"conversation_id":"c-1","status":"SUCCESS","response":"OK","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}';
const baseName = (file) => file.replace(/^.*[\\/]/, '').replace(/\.exe$/, '');

function scriptedSpawn(script) {
  const runs = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 1;
    const run = { file, args, opts, stdin: '' };
    child.stdin = Object.assign(new EventEmitter(), { end(d) { if (d != null) run.stdin += String(d); } });
    runs.push(run);
    const out = script(baseName(file), args) ?? { stdout: '' };
    setImmediate(() => { if (out.stdout) child.stdout.emit('data', Buffer.from(out.stdout)); child.emit('close', out.code ?? 0, null); });
    return child;
  };
  return { spawnImpl, runs };
}
const vendorRunner = (kernel, spawn, extra = {}) => runner(kernel, spawn, {
  stateDir: STATE, readPrompt: () => ({ ok: true, text: 'PROMPT' }), resolveBinary: (n) => `C:\\bin\\${n}.exe`,
  writeTemp: () => 'C:\\tmp\\body.md', exists: () => false, ...extra,
});

test('a vendor-card record runs the fixed sequence and posts one JSON result with status 0', async () => {
  const kernel = fakeKernel([vcRec()]);
  const spawn = scriptedSpawn((name, args) => {
    if (name === 'agy' && args[0] === 'models') return { stdout: 'gemini-4-argon-high\tGemini 4 Argon (High)\n' };
    if (name === 'agy') return { stdout: AGY_JSON };
    if (name === 'git' && args[0] === 'status') return { stdout: ' M docs/a.md\0' };
    if (name === 'git' && args[0] === 'rev-parse') return { stdout: 'abc\n' };
    if (name === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
    if (name === 'gh') return { stdout: 'https://github.com/o/r/pull/7\n' };
    return { stdout: '' };
  });
  const { r } = vendorRunner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.deepEqual(spawn.runs.map((x) => baseName(x.file)), ['agy', 'agy', 'git', 'git', 'git', 'git', 'git', 'gh', 'gh']);
  assert.deepEqual(spawn.runs[0].args, ['models']);
  assert.equal(spawn.runs[0].opts.env.GH_TOKEN, 'glmps-vendor-fence-no-github');
  assert.equal(spawn.runs[1].opts.env.GH_TOKEN, 'glmps-vendor-fence-no-github');
  assert.equal(spawn.runs[1].opts.cwd, VC_OP.cwd);
  assert.deepEqual(spawn.runs[1].args.slice(0, 2), ['--model', 'Gemini 4 Argon (High)']);
  assert.equal(spawn.runs.at(-2).opts.env.GIT_CONFIG_COUNT, undefined);
  assert.notEqual(spawn.runs.at(-2).opts.env.GH_TOKEN, 'glmps-vendor-fence-no-github');
  assert.equal(spawn.runs[1].opts.shell, undefined);
  const [res] = kernel.results();
  assert.equal(res.result.status, 0);
  const doc = JSON.parse(res.result.stdout);
  assert.equal(doc.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(doc.agent.sessionId, 'c-1');
  assert.deepEqual(doc.changed, ['docs/a.md']);
});

test('a vendor-card with a bad cwd is refused by the shell and nothing is spawned', async () => {
  const kernel = fakeKernel([vcRec({ cwd: 'D:\\glmps' })]);
  const spawn = scriptedSpawn(() => ({ stdout: '' }));
  const { r } = vendorRunner(kernel, spawn);
  await r.tick(); await r.idle();
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell/);
});

test('an executor crash is status 1 with a JSON error, and a small maxOutput does not truncate the result document', async () => {
  const crash = fakeKernel([vcRec()]);
  const { r } = vendorRunner(crash, scriptedSpawn(() => ({})), { readPrompt: () => { throw new Error('boom'); } });
  await r.tick(); await r.idle();
  const res = crash.results()[0].result;
  assert.equal(res.status, 1);
  assert.match(JSON.parse(res.stdout).error, /boom/);

  const big = fakeKernel([vcRec({ maxOutput: 10 })]);
  const spawn = scriptedSpawn((name) => (name === 'agy' ? { stdout: AGY_JSON } : { stdout: '' }));
  const v = vendorRunner(big, spawn);
  await v.r.tick(); await v.r.idle();
  assert.equal(JSON.parse(big.results()[0].result.stdout).agent.text, 'OK');
});

// Card glmps-2-0-216: the release action, values in, one JSON document out.
const REL_OP = { kind: 'release', cwd: 'D:\\glmps', repo: 'wolfeb-dev/glmps-2.0', base: 'main', number: 212, cardId: 'glmps-2-0-214', bump: 'patch', summary: 'ok', roots: { repos: ['D:\\glmps'], worktrees: WTS } };
const relRec = (op = {}) => ({ id: ID, origin: 'gitops', command: 'gitops release', cwd: REL_OP.cwd, state: 'pending', op: { ...REL_OP, ...op } });

test('a release record runs the fixed release in the operator session and posts its JSON result', async () => {
  const kernel = fakeKernel([relRec()]);
  const spawn = scriptedSpawn(() => ({ stdout: '' }));
  const seen = [];
  const { r } = runner(kernel, spawn, {
    worktreesDir: WTS,
    runReleaseImpl: async (recipe, io) => {
      seen.push({ recipe, worktreesDir: io.worktreesDir });
      const g = await io.run('git', ['fetch', '-q', '--tags', 'origin'], { cwd: recipe.cwd });
      return { ok: true, version: '2.0.1', sha: 'c'.repeat(40), fetched: g.status };
    },
  });
  await r.tick(); await r.idle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].worktreesDir, WTS, 'the release uses the shell own worktrees dir');
  assert.deepEqual({ ...seen[0].recipe, timeoutMs: undefined }, { kind: 'release', cwd: REL_OP.cwd, repo: REL_OP.repo, base: 'main', number: 212, cardId: REL_OP.cardId, bump: 'patch', summary: 'ok', timeoutMs: undefined });
  assert.equal(spawn.runs.length, 1);
  assert.equal(spawn.runs[0].file, 'git');
  assert.equal(spawn.runs[0].opts.cwd, REL_OP.cwd);
  assert.equal(spawn.runs[0].opts.shell, undefined);
  const [res] = kernel.results();
  assert.equal(res.result.status, 0);
  assert.deepEqual(JSON.parse(res.result.stdout), { ok: true, version: '2.0.1', sha: 'c'.repeat(40), fetched: 0 });
});

test('a release record for the public repo is refused before anything runs', async () => {
  const kernel = fakeKernel([relRec({ repo: 'wolfeb-dev/glmps' })]);
  const spawn = scriptedSpawn(() => ({ stdout: '' }));
  let called = 0;
  const { r } = runner(kernel, spawn, { worktreesDir: WTS, runReleaseImpl: async () => { called += 1; return { ok: true }; } });
  await r.tick(); await r.idle();
  assert.equal(called, 0);
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell.*public/);
});

// Card glmps-2-0-223: the whole release stops at recipe.timeoutMs (10 min),
// inside the broker's 11 minute release timeout.
function fakeTimers() {
  const timers = [];
  let now = 0;
  return {
    timers,
    advance(ms) { now += ms; },
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => { if (t) t.cleared = true; },
    nowImpl: () => now,
  };
}

test('a release past its overall deadline cancels the running step, starts no more and reports not-ok', async () => {
  const kernel = fakeKernel([relRec()]);
  const spawn = fakeSpawn({ hang: true });
  const clock = fakeTimers();
  const steps = [];
  const { r } = runner(kernel, spawn, {
    worktreesDir: WTS, ...clock,
    runReleaseImpl: async (recipe, io) => {
      steps.push(await io.run('git', ['fetch', '-q', '--tags', 'origin'], { cwd: recipe.cwd }));
      steps.push(await io.run('git', ['push', 'origin', 'HEAD:main'], { cwd: recipe.cwd }));
      return { ok: false, reason: 'git fetch -q failed: cancelled' };
    },
  });
  await r.tick();
  await new Promise((res) => setImmediate(res));
  const overall = clock.timers.find((t) => t.ms === 10 * 60 * 1000);
  assert.ok(overall, 'one timer for the whole release, at the recipe timeout');
  assert.equal(clock.timers.filter((t) => t !== overall)[0].ms, 2 * 60 * 1000, 'a step is still capped at 2 minutes');
  clock.advance(10 * 60 * 1000);
  overall.fn();
  await r.idle();
  assert.equal(spawn.runs.length, 1, 'the push is never started');
  assert.equal(steps[0].cancelled, true);
  assert.equal(steps[1].status, -2);
  const doc = JSON.parse(kernel.results()[0].result.stdout);
  assert.equal(doc.ok, false);
  assert.match(doc.reason, /^release stopped at its 10 minute deadline/);
  assert.equal(overall.cleared, true);
});

test('a release step never runs past the overall deadline', async () => {
  const kernel = fakeKernel([relRec()]);
  const spawn = fakeSpawn();
  const clock = fakeTimers();
  const { r } = runner(kernel, spawn, {
    worktreesDir: WTS, ...clock,
    runReleaseImpl: async (recipe, io) => {
      clock.advance(9 * 60 * 1000 + 30 * 1000);
      await io.run('git', ['push', 'origin', 'HEAD:main'], { cwd: recipe.cwd });
      return { ok: true, version: '2.0.1', sha: 'c'.repeat(40) };
    },
  });
  await r.tick(); await r.idle();
  const stepTimer = clock.timers.find((t) => t.ms !== 10 * 60 * 1000);
  assert.equal(stepTimer.ms, 30 * 1000, 'the last step gets only the time left');
  assert.equal(JSON.parse(kernel.results()[0].result.stdout).ok, true, 'a release that finishes in time is untouched');
});

test('a release that throws is reported as a JSON not-ok result, never a crash', async () => {
  const kernel = fakeKernel([relRec()]);
  const { r } = runner(kernel, scriptedSpawn(() => ({})), { worktreesDir: WTS, runReleaseImpl: async () => { throw new Error('boom'); } });
  await r.tick(); await r.idle();
  const res = kernel.results()[0].result;
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { ok: false, reason: 'boom' });
});

// Card glmps-2-0-224: past the deadline the release's own cleanup (worktree
// remove, local tag delete) still runs, each under a short cap, so a release
// that times out leaves no worktree behind.
test('a cleanup step still runs after the release deadline, under a short cap', async () => {
  const kernel = fakeKernel([relRec()]);
  const spawn = fakeSpawn();
  const clock = fakeTimers();
  const steps = [];
  const { r } = runner(kernel, spawn, {
    worktreesDir: WTS, ...clock,
    runReleaseImpl: async (recipe, io) => {
      clock.advance(10 * 60 * 1000 + 1);
      steps.push(await io.run('git', ['push', 'origin', 'HEAD:main'], { cwd: recipe.cwd }));
      steps.push(await io.run('git', ['worktree', 'remove', '--force', 'X'], { cwd: recipe.cwd, cleanup: true }));
      return { ok: false, reason: 'late' };
    },
  });
  await r.tick(); await r.idle();
  assert.equal(steps[0].status, -2, 'a normal step past the deadline is refused');
  assert.equal(steps[1].status, 0, 'the cleanup step ran');
  assert.deepEqual(spawn.runs.map((x) => x.args.slice(0, 2)), [['worktree', 'remove']]);
  const stepTimer = clock.timers.find((t) => t.ms !== 10 * 60 * 1000);
  assert.equal(stepTimer.ms, 30 * 1000, 'a cleanup step is capped at 30 seconds');
  assert.match(JSON.parse(kernel.results()[0].result.stdout).reason, /^release stopped at its 10 minute deadline/);
});

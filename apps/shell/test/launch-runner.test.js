// apps/shell/test/launch-runner.test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLaunch, createLaunchRunner, defaultReadLaunchToken } from '../src/lib/launch-runner.js';
import { computeProof, sha256Hex } from '../src/lib/launch-auth.js';

const allowedCommands = ['claude'];
const UUID = '3f2a9b1c-1111-4222-8333-444455556666';

// a runner-origin command's prompt path must resolve
// (path.resolve AND fs.realpathSync.native) inside the shell's own state
// dir - a real directory with a real file in it, not just a string that
// looks right, so every runner-origin fixture below needs one.
// CI fix: realpath'd, because validRunnerPath compares the prompt file's REAL
// path against <stateDir>/runner, and os.tmpdir() on the Windows CI runner is
// an 8.3 short path (C:\Users\RUNNER~1\...) whose realpath expands.
const stateDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-state-')));
// CI fix: a real, existing, absolute cwd on every platform (a literal drive
// path is not absolute on Linux and does not exist on the CI runner).
const CWD = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-cwd-')));
const promptFile = path.join(stateDir, 'runner', 'glmps-1.prompt.md');
fs.mkdirSync(path.dirname(promptFile), { recursive: true });
fs.writeFileSync(promptFile, 'x');
const TASK = `Read the task described in this file and complete it, then update its backlog card status: ${promptFile}`;

// the kernel's own GET
// /api/launches, claim and result all require a per-request proof of
// knowledge of this per-install token now - the raw value is only ever
// used LOCALLY, to compute a proof or to sign a mock response in these
// fixtures, never sent on the wire itself.
const launchToken = 'a'.repeat(64);
fs.writeFileSync(path.join(stateDir, 'launch-token'), launchToken);

// Builds a fetchImpl response signed the way the real kernel signs one:
// the proof is computed over the SAME nonce the request (opts.headers)
// carried and the JSON text of `body`. `token` is a parameter (not always
// `launchToken`) so a test can deliberately sign with the WRONG token.
// the response proof is bound to direction 'res' and to the
// request's own method and path+query.
function respondSigned(token, url, opts, body, { ok = true, status = ok ? 200 : 400, direction = 'res' } = {}) {
  const nonce = opts?.headers?.['x-launch-nonce'];
  const u = new URL(url);
  const proof = nonce ? computeProof(token, { direction, method: opts?.method || 'GET', path: u.pathname + u.search, nonce, bodyHash: sha256Hex(JSON.stringify(body)) }) : null;
  return { ok, status, json: async () => body, headers: { get: (name) => (name === 'x-launch-response-proof' ? proof : null) } };
}

// Task 15, SF-1: a fake child process that behaves like node:child_process's
// own ChildProcess - an EventEmitter that emits its scripted events AFTER
// spawn returns (never synchronously, exactly like the real one). Each script
// entry is [event, ...args] or { wait: ms }. The default script is the real
// win32 recipe's normal shape: `cmd /c start` spawns, opens the terminal
// window and exits 0 at once.
function fakeChild(script = [['spawn'], ['exit', 0, null]], { pid = 7 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  setImmediate(async () => {
    for (const step of script) {
      if (step && typeof step === 'object' && !Array.isArray(step)) { await new Promise((r) => setTimeout(r, step.wait)); continue; }
      const [event, ...args] = step;
      child.emit(event, ...args);
    }
  });
  return child;
}

test('only known origins, one-line commands and absolute existing cwds run', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude', cwd: CWD }, { exists, allowedCommands }).ok, true);
  assert.equal(validateLaunch({ origin: 'web', command: 'claude', cwd: CWD }, { exists, allowedCommands }).ok, false);
  assert.equal(validateLaunch({ origin: 'terminal', command: 'a\nb', cwd: CWD }, { exists, allowedCommands }).ok, false);
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude', cwd: 'relative' }, { exists, allowedCommands }).ok, false);
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude', cwd: path.join(CWD, 'gone') }, { exists: () => false, allowedCommands }).ok, false);
});

// each origin has its own recognizable recipe shape
// (the exact way editor-targets.js/learning-apply.js build it) - a generic
// one-line/absolute-cwd check alone let the shell run ANY command from ANY
// record, from any kernel URL, in the operator's own session.
test('resume: only "<allowed command> --resume <uuid>", nothing else', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'resume', command: `claude --resume ${UUID}`, cwd: CWD }, { exists, allowedCommands }).ok, true);
  assert.equal(validateLaunch({ origin: 'resume', command: `evil --resume ${UUID}`, cwd: CWD }, { exists, allowedCommands }).ok, false, 'leading command not in the allowlist');
  assert.equal(validateLaunch({ origin: 'resume', command: `claude --resume ${UUID} && calc`, cwd: CWD }, { exists, allowedCommands }).ok, false, 'trailing content');
  assert.equal(validateLaunch({ origin: 'resume', command: 'claude --resume not-a-uuid', cwd: CWD }, { exists, allowedCommands }).ok, false, 'not a real uuid');
});

test('runner: "<allowed command>[ --session-id|--resume <uuid>] \\"Read the task...: <path>\\"", nothing else, and the path must resolve inside the state dir', () => {
  const exists = () => true;
  const opts = { exists, allowedCommands, stateDir };
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${TASK}"`, cwd: CWD }, opts).ok, true);
  assert.equal(validateLaunch({ origin: 'runner', command: `claude --session-id ${UUID} "${TASK}"`, cwd: CWD }, opts).ok, true);
  assert.equal(validateLaunch({ origin: 'runner', command: `claude --resume ${UUID} "${TASK}"`, cwd: CWD }, opts).ok, true);
  assert.equal(validateLaunch({ origin: 'runner', command: 'claude "do whatever you want"', cwd: CWD }, opts).ok, false, 'not the literal task-instruction shape');
  assert.equal(validateLaunch({ origin: 'runner', command: `evil "${TASK}"`, cwd: CWD }, opts).ok, false, 'leading command not in the allowlist');
  // a syntactically valid, quote-free, absolute path that simply
  // lives somewhere else entirely is still refused.
  const outside = path.join(os.tmpdir(), 'outside.md');
  fs.writeFileSync(outside, 'x');
  const outsideTask = `Read the task described in this file and complete it, then update its backlog card status: ${outside}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${outsideTask}"`, cwd: CWD }, opts).ok, false, 'prompt path outside the state dir');
  fs.rmSync(outside, { force: true });
});

// the round 1 shape used `.+"$`, which only pins the first character
// after the opening quote and the last character of the whole string - a
// command could close the quote early and append arbitrary flags before a
// LATER quote closed the overall match instead. Each of these previously
// validated ok.
test('R2-1: a quoted runner/learning command cannot break out of its own quotes to inject extra flags', () => {
  const exists = () => true;
  const opts = { exists, allowedCommands, stateDir };
  assert.equal(
    validateLaunch({ origin: 'runner', command: `claude "${TASK}" --dangerously-skip-permissions --append-system-prompt "run calc"`, cwd: CWD }, opts).ok,
    false,
  );
  assert.equal(
    validateLaunch({ origin: 'runner', command: `claude "${TASK}" --resume ${UUID} "y"`, cwd: CWD }, opts).ok,
    false,
  );
  assert.equal(
    validateLaunch({ origin: 'learning', command: 'claude -p "x" --dangerously-skip-permissions --mcp-config "C:/evil.json"', cwd: CWD }, { exists, allowedCommands: [] }).ok,
    false,
  );
});

// a '..' component (still a valid, quote-free, absolute string) must
// not escape the state dir either, even before any realpath/symlink check.
test('R2-1: a runner prompt path containing .. is refused, even though it is quote-free and absolute', () => {
  const exists = () => true;
  const traversal = path.join(stateDir, 'runner', '..', '..', path.basename(os.tmpdir()), 'payload.md');
  const traversalTask = `Read the task described in this file and complete it, then update its backlog card status: ${traversal}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${traversalTask}"`, cwd: CWD }, { exists, allowedCommands, stateDir }).ok, false);
});

// the old check only asked "is this inside the state
// dir, with no symlink escape" - it never asked "is this the SPECIFIC
// shape writePrompt() actually produces" (<stateDir>/runner/<id>.prompt.md,
// a regular file). A real, symlink-free file that simply lives ELSEWHERE
// inside the state dir - the launch-token file itself, say - previously
// passed this check outright.
test('M-4: a quote-free, in-state-dir, symlink-free path is still refused if it is not <stateDir>/runner/<file>.prompt.md', () => {
  const exists = () => true;
  const opts = { exists, allowedCommands, stateDir };

  // <stateDir>/launch-token: a real file, genuinely inside the state dir,
  // no symlink involved anywhere - and still never a prompt this runner
  // wrote.
  const tokenFile = path.join(stateDir, 'launch-token');
  fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const tokenTask = `Read the task described in this file and complete it, then update its backlog card status: ${tokenFile}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${tokenTask}"`, cwd: CWD }, opts).ok, false, 'the launch-token file itself is refused');

  // A DIRECTORY named exactly like a real prompt file (same parent, same
  // .prompt.md suffix) - the shape check alone is not enough; it must
  // also be a regular file.
  const dirShapedLikeAPrompt = path.join(stateDir, 'runner', 'evil.prompt.md');
  fs.mkdirSync(dirShapedLikeAPrompt, { recursive: true });
  const dirTask = `Read the task described in this file and complete it, then update its backlog card status: ${dirShapedLikeAPrompt}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${dirTask}"`, cwd: CWD }, opts).ok, false, 'a directory is refused even with the right name shape');
  fs.rmSync(dirShapedLikeAPrompt, { recursive: true, force: true });

  // A maliciously-named directory - neither inside <stateDir>/runner nor
  // shaped like a prompt file.
  const evilDir = path.join(stateDir, 'a --mcp-config x');
  fs.mkdirSync(evilDir, { recursive: true });
  const evilTask = `Read the task described in this file and complete it, then update its backlog card status: ${evilDir}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${evilTask}"`, cwd: CWD }, opts).ok, false, 'a maliciously-named directory is refused');
  fs.rmSync(evilDir, { recursive: true, force: true });
});

// glmps-2-0-61: the kernel appends --settings <role file> [--model <name>].
// The settings file can grant permissions, so it gets the prompt path's checks.
test('runner: a trailing --settings must be a regular *.json directly in <stateDir>/role-settings; --model a bare token', () => {
  const opts = { exists: () => true, allowedCommands, stateDir };
  const roleDir = path.join(stateDir, 'role-settings');
  fs.mkdirSync(roleDir, { recursive: true });
  const good = path.join(roleDir, 'worker-glmps-1.json');
  fs.writeFileSync(good, '{}');
  const run = (tail) => validateLaunch({ origin: 'runner', command: `claude --session-id ${UUID} "${TASK}"${tail}`, cwd: CWD }, opts);

  assert.equal(run(` --settings "${good}"`).ok, true);
  assert.equal(run(` --settings "${good}" --model opus`).ok, true);
  assert.equal(run(' --model claude-opus-5-5').ok, true);
  if (/^[A-Za-z0-9_:=./-]+$/.test(good)) assert.equal(run(` --settings ${good}`).ok, true, 'a bare POSIX path, as appendArgs leaves it');

  const refused = (tail, why) => {
    const v = run(tail);
    assert.equal(v.ok, false, why);
    return v.reason;
  };
  // Joined by hand: path.join would normalize the '..' away.
  assert.match(refused(` --settings "${[roleDir, '..', '..', 'evil.json'].join(path.sep)}"`, 'traversal'), /clean absolute/);
  const elsewhere = path.join(stateDir, 'settings.json');
  fs.writeFileSync(elsewhere, '{}');
  assert.match(refused(` --settings "${elsewhere}"`, 'in the state dir but not role-settings'), /direct child of <stateDir>\/role-settings/);
  const outside = path.join(CWD, 'worker-x.json');
  fs.writeFileSync(outside, '{}');
  assert.match(refused(` --settings "${outside}"`, 'outside the state dir'), /direct child/);
  const nested = path.join(roleDir, 'sub', 'worker-x.json');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, '{}');
  assert.match(refused(` --settings "${nested}"`, 'nested, not a direct child'), /direct child/);
  const notJson = path.join(roleDir, 'worker-x.md');
  fs.writeFileSync(notJson, '{}');
  assert.match(refused(` --settings "${notJson}"`, 'not *.json'), /\.json/);
  const dirJson = path.join(roleDir, 'dir.json');
  fs.mkdirSync(dirJson, { recursive: true });
  assert.match(refused(` --settings "${dirJson}"`, 'a directory'), /regular file/);
  assert.match(refused(` --settings "${path.join(roleDir, 'missing.json')}"`, 'missing'), /could not be resolved/);
  assert.match(refused(` --settings "relative.json"`, 'relative'), /clean absolute/);

  refused(` --model opus --settings "${good}"`, 'the kernel never emits --model first');
  refused(` --settings "${good}" --settings "${good}"`, 'one settings file only');
  refused(` --settings "${good}" --model "opus" --dangerously-skip-permissions`, 'nothing after --model');
  refused(` --settings "${good}" --mcp-config "${good}"`, 'no other flag');
  refused(` --model "a b"`, 'a quoted model');
});

test('runner: a --settings link inside role-settings that points out is refused', (t) => {
  const roleDir = path.join(stateDir, 'role-settings');
  fs.mkdirSync(roleDir, { recursive: true });
  const target = path.join(CWD, 'payload.json');
  fs.writeFileSync(target, '{}');
  const link = path.join(roleDir, 'linked.json');
  try { fs.symlinkSync(target, link, 'file'); } catch (e) { t.skip(`symlinks unavailable here: ${e.code}`); return; }
  const v = validateLaunch({ origin: 'runner', command: `claude "${TASK}" --settings "${link}"`, cwd: CWD }, { exists: () => true, allowedCommands, stateDir });
  assert.equal(v.ok, false);
  assert.match(v.reason, /via a symlink/);
});

// the leading command token is now matched case-sensitively - only
// the UUID's own hex digits are deliberately case-insensitive (a real
// session id can legitimately arrive in either case).
test('resume: the leading command is matched case-sensitively; the uuid itself may be either case', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'resume', command: `CLAUDE --resume ${UUID}`, cwd: CWD }, { exists, allowedCommands }).ok, false);
  assert.equal(validateLaunch({ origin: 'resume', command: `claude --resume ${UUID.toUpperCase()}`, cwd: CWD }, { exists, allowedCommands }).ok, true);
});

test('terminal: the command must equal one of the allowed terminal commands exactly', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude', cwd: CWD }, { exists, allowedCommands }).ok, true);
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude --resume x', cwd: CWD }, { exists, allowedCommands }).ok, false, 'not an exact match');
  assert.equal(validateLaunch({ origin: 'terminal', command: 'powershell', cwd: CWD }, { exists, allowedCommands }).ok, false, 'not configured');
});

test('learning: "claude -p \\"...\\"" exactly, independent of the terminal allowlist', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'learning', command: 'claude -p "do the thing"', cwd: CWD }, { exists, allowedCommands: [] }).ok, true);
  assert.equal(validateLaunch({ origin: 'learning', command: 'claude -p', cwd: CWD }, { exists, allowedCommands }).ok, false, 'missing the quoted instruction');
  assert.equal(validateLaunch({ origin: 'learning', command: 'claude --resume x', cwd: CWD }, { exists, allowedCommands }).ok, false, 'not the learning shape');
});

test('backstop: a shell metacharacter refuses the command even inside an otherwise-matching shape', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${TASK} & calc"`, cwd: CWD }, { exists, allowedCommands }).ok, false);
  assert.equal(validateLaunch({ origin: 'learning', command: 'claude -p "do it | calc"', cwd: CWD }, { exists, allowedCommands: [] }).ok, false);
});

// resume/runner/terminal all depend on the allowlist the shell learns from
// the kernel's own authenticated poll response; with nothing learned yet,
// they fail closed rather than falling back to accepting any single-token
// command.
test('resume/runner/terminal fail closed when the terminal-command allowlist has not loaded yet; learning is unaffected', () => {
  const exists = () => true;
  assert.equal(validateLaunch({ origin: 'resume', command: `claude --resume ${UUID}`, cwd: CWD }, { exists, allowedCommands: [] }).ok, false);
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${TASK}"`, cwd: CWD }, { exists, allowedCommands: [] }).ok, false);
  assert.equal(validateLaunch({ origin: 'terminal', command: 'claude', cwd: CWD }, { exists, allowedCommands: [] }).ok, false);
  assert.equal(validateLaunch({ origin: 'learning', command: 'claude -p "do the thing"', cwd: CWD }, { exists, allowedCommands: [] }).ok, true);
});

// claim THEN process, per record - not
// claim-all-first. The brief's own sample test asserted claim-all-first,
// but the brief's own sample implementation never matched its own test;
// the ruling is that the test, not the implementation, was the brief's
// error.
test('a tick claims each pending launch, then spawns it, per record (not claim-all-first)', async () => {
  const calls = [];
  const posted = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url.replace('http://k', '')]);
    if (opts.body) posted.push(JSON.parse(opts.body));
    if (url.endsWith('/api/launches?state=pending')) {
      return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'runner', command: `claude "${TASK}"`, cwd: CWD }, { id: 'b', origin: 'resume', command: `claude --resume ${UUID}`, cwd: CWD }], allowedCommands: ['claude'] });
    }
    if (url.includes('/claim')) {
      const ok = !url.includes('/b/');
      return respondSigned(launchToken, url, opts, {}, { ok, status: ok ? 200 : 409 });
    }
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const spawned = [];
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (file, args) => { spawned.push([file, args]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.equal(spawned.length, 1, 'b lost its claim race and is not spawned');
  assert.deepEqual(calls.filter(([m]) => m === 'POST').map(([, u]) => u), ['/api/launches/a/claim', '/api/launches/a/result', '/api/launches/b/claim']);
  // m4: the posted result body itself, not only which URL it hit.
  const resultBody = posted.find((p) => 'pid' in p);
  assert.deepEqual(resultBody, { pid: 7 });
});

// The agy and gitops runners own their origins: claiming one here would fail it as unknown.
test('a tick leaves agy, gitops and editor records to their own runners', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url.replace('http://k', '')]);
    if (url.endsWith('/api/launches?state=pending')) {
      return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'agy', command: 'agy', cwd: 'agy' }, { id: 'b', origin: 'gitops', command: 'gitops git', cwd: CWD }, { id: 'c', origin: 'editor', command: 'open-in-editor', cwd: CWD, path: CWD }], allowedCommands: ['claude'] });
    }
    return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
  };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: () => { throw new Error('must not spawn'); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.deepEqual(calls, [['GET', '/api/launches?state=pending']]);
});

// m4 (the refusal path): a record that fails validateLaunch posts an error,
// never a pid, and is never spawned.
test('a record that fails validateLaunch posts an error result and is never spawned', async () => {
  const posted = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.body) posted.push(JSON.parse(opts.body));
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'runner', command: 'a\nb', cwd: CWD }], allowedCommands: ['claude'] });
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const spawned = [];
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (file, args) => { spawned.push([file, args]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.equal(spawned.length, 0, 'never spawned');
  const resultBody = posted.find((p) => 'error' in p);
  assert.match(resultBody.error, /refused by shell/);
  assert.equal('pid' in resultBody, false);
});

// one record's result POST throwing (a network hiccup) must not
// abandon the rest of the SAME batch.
test('one record whose result POST throws does not stop the rest of the batch', async () => {
  const spawned = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'runner', command: `claude "${TASK}"`, cwd: CWD }, { id: 'b', origin: 'terminal', command: 'claude', cwd: CWD }], allowedCommands: ['claude'] });
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    if (url.includes('/a/result')) throw new Error('ECONNRESET');
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (file, args) => { spawned.push([file, args]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.equal(spawned.length, 2, 'b is still spawned despite a\'s result POST throwing');
});

// A real kernelUrl (resolveKernelUrl's own `new URL(...).href` in main.js)
// carries a trailing slash for a bare origin. A naive `${kernelUrl}${path}`
// concatenation would then request '//api/launches...' - a path the
// server's router never matches - so the trailing slash must be stripped
// once, at construction, not left to every call site.
test('a kernelUrl with a trailing slash does not produce a double slash in the request path', async () => {
  const urls = [];
  const fetchImpl = async (url, opts = {}) => { urls.push(url); return respondSigned(launchToken, url, opts, { pending: [], allowedCommands: [] }); };
  const r = createLaunchRunner({ kernelUrl: 'http://k/', fetchImpl, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.deepEqual(urls, ['http://k/api/launches?state=pending']);
});

// request URLs were built by string concatenation onto the raw
// kernelUrl, so a configured URL carrying a path or a #fragment silently broke
// every poll (http://k/x#y + /api/launches never reaches the route). They are
// now built from the kernel URL's origin.
test('W4: a kernelUrl with a path, query or fragment still polls the origin\'s own /api/launches', async () => {
  for (const kernelUrl of ['http://k/dashboard#top', 'http://k/some/path?x=1', 'http://k#frag']) {
    const urls = [];
    const fetchImpl = async (url, opts = {}) => { urls.push(url); return respondSigned(launchToken, url, opts, { pending: [], allowedCommands: [] }); };
    const r = createLaunchRunner({ kernelUrl, fetchImpl, exists: () => true, stateDir, log: () => {}, notify: () => {} });
    await r.tick();
    assert.deepEqual(urls, ['http://k/api/launches?state=pending'], kernelUrl);
  }
});

// the shell's half of the same backstop launchNative now
// carries on the kernel side. No spawnImpl is injected here on purpose -
// the point is to prove the DEFAULT refuses in this test process - but the
// refusal must be provable with no risk of a real spawn even if the guard
// were broken, so this never touches node:child_process directly (an
// earlier attempt at mocking it for a server-side sibling test silently
// failed to intercept a named import; see launch-native-test-guard.test.js
// on the kernel side for that finding). The observable instead is the
// posted result: a real spawn would report a pid; the guard reports an
// error naming the refusal.
test('the default spawnImpl refuses a real spawn in a test process when none was injected', async () => {
  const posted = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.body) posted.push(JSON.parse(opts.body));
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'terminal', command: 'claude', cwd: CWD }], allowedCommands: ['claude'] });
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  // No spawnImpl passed: exercises the real default.
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  const result = posted.find((p) => 'error' in p || 'pid' in p);
  assert.ok(result?.error, 'refused by name, never a real pid');
  assert.match(result.error, /test process, no injected spawnImpl/);
});

// the
// raw token itself must never leave this process - every outbound request
// instead carries a fresh nonce and a proof of KNOWLEDGE of the token.
test('I-1: every request carries a nonce+proof computed from the token read from the state dir, and the raw token string never appears on the wire', async () => {
  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    requests.push(opts);
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [], allowedCommands: [] });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.ok(requests.length > 0);
  assert.ok(requests.every((o) => typeof o.headers?.['x-launch-nonce'] === 'string' && o.headers['x-launch-nonce'].length >= 32));
  assert.ok(requests.every((o) => typeof o.headers?.['x-launch-proof'] === 'string' && o.headers['x-launch-proof'].length === 64));
  // The raw token must never appear anywhere in any request this runner
  // sent - not a header value, not a body.
  const haystack = requests.map((o) => JSON.stringify(o)).join('\n');
  assert.equal(haystack.includes(launchToken), false, 'the raw token string never appears in any request the shell sends');
});

// I-1: the specific attack the finding named - an impostor on the loopback
// port answers the poll with an otherwise well-formed record (and
// allowlist), but cannot produce a valid response proof without the real
// token. A missing proof and a proof signed with the WRONG token must both
// be refused outright (no claim ever sent, nothing ever spawned); a
// correctly-signed response runs the ordinary flow.
test('I-1: an impostor answering the poll with a missing or wrong response proof is refused (no claim, no spawn); a correct proof runs normally', async () => {
  const cwd = CWD;
  const pendingBody = { pending: [{ id: 'a', origin: 'terminal', command: 'claude', cwd }], allowedCommands: ['claude'] };
  const makeFetch = (mode) => async (url, opts = {}) => {
    if (url.endsWith('/api/launches?state=pending')) {
      if (mode === 'missing') return { ok: true, status: 200, json: async () => pendingBody, headers: { get: () => null } };
      if (mode === 'wrong') return respondSigned('f'.repeat(64), url, opts, pendingBody); // signed with the WRONG token
      return respondSigned(launchToken, url, opts, pendingBody); // correct
    }
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  for (const mode of ['missing', 'wrong']) {
    const claimed = []; const spawned = [];
    const fetchImpl = async (url, opts = {}) => { if (url.includes('/claim')) claimed.push(url); return makeFetch(mode)(url, opts); };
    const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (file, args) => { spawned.push([file, args]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
    await r.tick();
    assert.equal(claimed.length, 0, `${mode} proof: no claim`);
    assert.equal(spawned.length, 0, `${mode} proof: no spawn`);
  }
  const claimed = []; const spawned = [];
  const fetchImpl = async (url, opts = {}) => { if (url.includes('/claim')) claimed.push(url); return makeFetch('correct')(url, opts); };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (file, args) => { spawned.push([file, args]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.equal(claimed.length, 1, 'correct proof: claimed');
  assert.equal(spawned.length, 1, 'correct proof: spawned');
});

// every request proof is bound to direction 'req', the
// method and the exact path+query the request went to - a proof the kernel
// recomputes from what it received, so a captured one fits no other route.
test('F2: each request proof is bound to direction, method and path+query', async () => {
  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    requests.push([url, opts]);
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a b', origin: 'terminal', command: 'claude', cwd: CWD }], allowedCommands: ['claude'] });
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const r = createLaunchRunner({ kernelUrl: 'http://k/', fetchImpl, spawnImpl: () => fakeChild(), exists: () => true, stateDir, log: () => {}, notify: () => {} });
  await r.tick();
  assert.equal(requests.length, 3, 'poll, claim, result');
  for (const [url, opts] of requests) {
    const u = new URL(url);
    const expected = computeProof(launchToken, { direction: 'req', method: opts.method || 'GET', path: u.pathname + u.search, nonce: opts.headers['x-launch-nonce'], bodyHash: sha256Hex(opts.body ?? '') });
    assert.equal(opts.headers['x-launch-proof'], expected, `${opts.method || 'GET'} ${u.pathname}`);
  }
  assert.ok(requests.some(([url]) => url.includes('/a%20b/claim')), 'the encoded id is what gets signed');
});

// the claim response decides whether a terminal opens, so its proof
// must verify as a RESPONSE, for THIS claim's own target. An impostor
// reflecting the shell's own claim request (body and request proof) back
// used to verify, because both directions shared one MAC format. Each
// impostor shape is refused; the genuine response (the control, so a
// refusal cannot pass vacuously) opens exactly one terminal.
test('F2: a claim response that reflects the request proof, is signed as a request, or is signed for another path is refused; the genuine one is not', async () => {
  const claimResponse = {
    genuine: (url, opts) => respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 }),
    reflect: (url, opts) => {
      const reflected = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => reflected, headers: { get: (n) => (n === 'x-launch-response-proof' ? opts.headers['x-launch-proof'] : null) } };
    },
    requestDirection: (url, opts) => respondSigned(launchToken, url, opts, {}, { ok: true, status: 200, direction: 'req' }),
    otherPath: (url, opts) => respondSigned(launchToken, url.replace('/a/claim', '/other/claim'), opts, {}, { ok: true, status: 200 }),
  };
  for (const [mode, respond] of Object.entries(claimResponse)) {
    const spawned = [];
    const fetchImpl = async (url, opts = {}) => {
      if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'terminal', command: 'claude', cwd: CWD }], allowedCommands: ['claude'] });
      if (url.includes('/claim')) return respond(url, opts);
      return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
    };
    const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: (f, a) => { spawned.push([f, a]); return fakeChild(); }, exists: () => true, stateDir, log: () => {}, notify: () => {} });
    await r.tick();
    assert.equal(spawned.length, mode === 'genuine' ? 1 : 0, mode);
  }
});

// with no token file at the resolved state dir at all, the shell
// must refuse to run anything - not poll with an empty/missing header and
// let the kernel's own 401 be the only defense.
test('R2-5: the shell refuses to run anything when it has no launch token at all', async () => {
  const noTokenStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-notoken-'));
  const calls = [];
  const logs = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => [] }; };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, exists: () => true, stateDir: noTokenStateDir, log: (m) => logs.push(m), notify: () => {} });
  await r.tick();
  assert.equal(calls.length, 0, 'never even polled - no point without a token');
  assert.ok(logs.some((m) => /launch token/i.test(m)));
  fs.rmSync(noTokenStateDir, { recursive: true, force: true });
});

// a 401 from the kernel on the poll is refused like any other
// non-ok response - never signed, so `res.headers` is never even touched.
test('R2-5: a 401 from the kernel on the poll is refused like any other non-ok response', async () => {
  const logs = [];
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, exists: () => true, stateDir, log: (m) => logs.push(m), notify: () => {} });
  await r.tick();
  assert.ok(logs.some((m) => m.includes('401')));
});

// the poll's own failure lines ("kernel answered 401",
// "did not verify", a connection error) logged on every 2-second tick with
// no limit - a shell left running against a kernel with launches disabled
// wrote the same line 1800 times an hour. Each reason now logs at most once
// per window, again once the window has passed, and immediately again after
// a successful poll in between (the condition cleared and came back).
test('F5: a repeating poll failure logs once per reason per window, again after the window, and again after a success clears it', async () => {
  let now = 1_790_000_000_000;
  const logs = [];
  let mode = '401';
  const fetchImpl = async (url, opts = {}) => {
    if (mode === '401') return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    if (mode === 'unverified') return { ok: true, status: 200, json: async () => ({ pending: [] }), headers: { get: () => null } };
    if (mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
    return respondSigned(launchToken, url, opts, { pending: [], allowedCommands: ['claude'] });
  };
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, exists: () => true, stateDir, log: (m) => logs.push(m), notify: () => {}, now: () => now });
  const count = (re) => logs.filter((m) => re.test(m)).length;

  for (let i = 0; i < 5; i++) { await r.tick(); now += 2000; }
  assert.equal(count(/401/), 1, '401 five ticks running: one line');
  mode = 'unverified';
  for (let i = 0; i < 5; i++) { await r.tick(); now += 2000; }
  assert.equal(count(/did not verify/), 1, 'unverified five ticks running: one line');
  mode = 'down';
  for (let i = 0; i < 5; i++) { await r.tick(); now += 2000; }
  assert.equal(count(/ECONNREFUSED/), 1, 'kernel down five ticks running: one line');

  mode = '401';
  now += 10 * 60_000 + 1;
  await r.tick();
  assert.equal(count(/401/), 2, 'the window passed: logged again');
  now += 2000;
  await r.tick();
  assert.equal(count(/401/), 2, 'and limited again');

  mode = 'ok';
  await r.tick();
  mode = '401';
  await r.tick();
  assert.equal(count(/401/), 3, 'a successful poll in between clears the limit');
});

// defaultReadLaunchToken used to collapse every read
// failure (missing file, a permissions error, anything else) into a bare
// null, so the tick's own log line always said the same generic "no
// launch token found" regardless of WHY. It now names the actual reason,
// distinguishing a genuinely missing file from any other read error.
test('M-3: defaultReadLaunchToken names a missing file distinctly from any other read error', () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-m3-missing-'));
  const missing = defaultReadLaunchToken(missingDir);
  assert.equal(missing.token, null);
  assert.match(missing.reason, /no launch token/i);
  fs.rmSync(missingDir, { recursive: true, force: true });

  const errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-m3-err-'));
  fs.mkdirSync(path.join(errDir, 'launch-token')); // a directory, not a file - EISDIR, not ENOENT
  const errored = defaultReadLaunchToken(errDir);
  assert.equal(errored.token, null);
  assert.match(errored.reason, /EISDIR|could not be read/i);
  assert.notEqual(errored.reason, missing.reason, 'a different failure gets a different, named reason');
  fs.rmSync(errDir, { recursive: true, force: true });
});

// M-3: the tick's own log line must name whatever reason readLaunchToken
// gave it, and must not repeat the SAME reason on every single tick - a
// shell left running with (say) an unreadable token file would otherwise
// write that line to the log forever.
test('M-3: a token-read failure reason is logged once per distinct reason, not on every tick', async () => {
  const logs = [];
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ pending: [] }) }; };
  const readLaunchToken = () => ({ token: null, reason: 'launch token could not be read (EACCES): x' });
  const r = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, readLaunchToken, exists: () => true, stateDir, log: (m) => logs.push(m), notify: () => {} });
  await r.tick();
  await r.tick();
  await r.tick();
  assert.equal(fetchCalls, 0, 'never even polled - no point without a token');
  const matching = logs.filter((m) => m.includes('EACCES'));
  assert.equal(matching.length, 1, 'the same reason is logged once, not once per tick');
});

// Task 15, SF-1 (silent-failure hunt, Critical): the runner used to read
// child.pid synchronously, POST { pid } as a success and notify "Opened a
// terminal" before the child could report anything, so an async 'error'
// (ENOENT, EACCES, a policy block) or a launcher that exited non-zero was
// only ever a line in shell.log while the kernel's ledger said done.
// the launch succeeds when the child emits 'spawn' (and does not then
// exit non-zero within the settle window); it fails on 'error' before that,
// or on a non-zero exit inside the window. A terminal the operator closes
// later is not a launch failure. The result is posted only once the outcome
// is known, so a failure can never arrive after a success was reported.
// The default window is long because the tests that keep it settle on the
// child's own event; a short one only ever fired on a stalled CI runner.
function sf1Harness({ script, settleMs = 5000 }) {
  const posted = [];
  const notes = [];
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/result')) posted.push(JSON.parse(opts.body));
    if (url.endsWith('/api/launches?state=pending')) return respondSigned(launchToken, url, opts, { pending: [{ id: 'a', origin: 'terminal', command: 'claude', cwd: CWD }], allowedCommands: ['claude'] });
    if (url.includes('/claim')) return respondSigned(launchToken, url, opts, {}, { ok: true, status: 200 });
    return respondSigned(launchToken, url, opts, undefined, { ok: true, status: 204 });
  };
  const runner = createLaunchRunner({ kernelUrl: 'http://k', fetchImpl, spawnImpl: () => fakeChild(script), exists: () => true, stateDir, log: (m) => logs.push(m), notify: (m) => notes.push(m), spawnSettleMs: settleMs });
  return { runner, posted, notes, logs };
}

test('SF-1: spawn then a clean launcher exit posts { pid } and notifies success', async () => {
  const h = sf1Harness({ script: [['spawn'], ['exit', 0, null]] });
  await h.runner.tick();
  assert.deepEqual(h.posted, [{ pid: 7 }]);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Opened a terminal/);
});

test('SF-1: an async spawn error posts { error } (never a pid) and notifies the failure', async () => {
  const err = Object.assign(new Error('spawn cmd ENOENT'), { code: 'ENOENT' });
  const h = sf1Harness({ script: [['error', err]] });
  await h.runner.tick();
  assert.equal(h.posted.length, 1, 'exactly one result');
  assert.equal('pid' in h.posted[0], false, 'never reported as a success');
  assert.match(h.posted[0].error, /ENOENT/);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Could not open a terminal/);
  assert.doesNotMatch(h.notes[0], /Opened a terminal/);
});

test('SF-1: a launcher that spawns then exits non-zero inside the window posts { error } naming the code', async () => {
  const h = sf1Harness({ script: [['spawn'], ['exit', 1, null]] });
  await h.runner.tick();
  assert.equal(h.posted.length, 1);
  assert.equal('pid' in h.posted[0], false);
  assert.match(h.posted[0].error, /code 1/);
  assert.match(h.notes[0], /Could not open a terminal/);
});

test('SF-1: an exit after the settle window is not a launch failure: one success, no correction', async () => {
  const h = sf1Harness({ script: [['spawn'], { wait: 120 }, ['exit', 1, null]], settleMs: 40 });
  await h.runner.tick();
  await new Promise((r) => setTimeout(r, 200)); // let the late exit fire
  assert.deepEqual(h.posted, [{ pid: 7 }], 'one success result, never re-posted');
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Opened a terminal/);
  assert.ok(h.logs.some((m) => /after the launch settled/.test(m)), 'the late exit is still logged');
});

test('SF-1: a child that never reports spawn or error within the window is a named failure, not a success', async () => {
  const h = sf1Harness({ script: [], settleMs: 40 });
  await h.runner.tick();
  assert.equal(h.posted.length, 1);
  assert.equal('pid' in h.posted[0], false);
  assert.match(h.posted[0].error, /did not report starting/);
});

// PR #27 follow-up: the state dir itself reached through a link (an 8.3
// short name, a junction or a symlink) must not refuse every runner launch;
// a link inside runner/ pointing out is still refused.
test('a state dir reached through a link still accepts its own runner prompt, and still refuses an escape', (t) => {
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-alias-')), 'state-link');
  try { fs.symlinkSync(stateDir, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create a directory link here: ${e.code}`); return; }
  const opts = { allowedCommands: ['claude'], stateDir: alias };
  const viaAlias = path.join(alias, 'runner', 'glmps-1.prompt.md');
  const task = `Read the task described in this file and complete it, then update its backlog card status: ${viaAlias}`;
  assert.equal(validateLaunch({ origin: 'runner', command: `claude "${task}"`, cwd: CWD }, opts).ok, true);
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launchrunner-out-')), 'evil.prompt.md');
  fs.writeFileSync(outsideFile, 'x');
  const escapeLink = path.join(stateDir, 'runner', 'escape.prompt.md');
  try { fs.symlinkSync(outsideFile, escapeLink, 'file'); }
  catch (e) { return; } // file symlinks need privilege on Windows; the alias case above is the regression
  try {
    const viaEscape = path.join(alias, 'runner', 'escape.prompt.md');
    const bad = `Read the task described in this file and complete it, then update its backlog card status: ${viaEscape}`;
    assert.equal(validateLaunch({ origin: 'runner', command: `claude "${bad}"`, cwd: CWD }, opts).ok, false);
  } finally { fs.rmSync(escapeLink, { force: true }); }
});

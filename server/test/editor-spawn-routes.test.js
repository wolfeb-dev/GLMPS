// every request route that spawns the
// editor goes through the one guarded spawn, and no request field is ever
// interpolated into a shell:true command line unvalidated.
//
// SAFETY: every server here is started with `editorSpawnFn` (a fake that only
// records its arguments and never creates a process) and `agAliveProbe`
// (always false, so the spawn branch is reached on any host, whether or not
// Antigravity IDE is running). No payload below can reach a real shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';
import { shellArg } from '../lib/orchestration/guarded-spawn.js';
import { nativeTerminalRecipe, windowsCmdPath } from '../lib/orchestration/editor-targets.js';
import { readEvents } from '../lib/observability/event-log.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// D20: /api/resume now builds `claude --resume <id>` for a real CLI flag
// (resumeCommand, same UUID rule as resumedCommand), so a sessionId reaching
// this route must be UUID-shaped or it 400s before ever reaching a spawn.
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

function fakeSpawn(mode = 'ok') {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    if (mode === 'throw') throw new Error('EMFILE: simulated synchronous spawn failure');
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => {};
    if (mode === 'error') setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })));
    // With shell:true, a missing editor command shows up only as the shell exiting 1.
    if (mode === 'exit1') setImmediate(() => child.emit('exit', 1, null));
    return child;
  };
  return { fn, calls };
}

async function withServer({ spawnMode = 'ok', config = {}, env: extraEnv = {}, editorDetect } = {}, fn) {
  const stateDir = tmp('mc-edspawn-');
  const claudeDir = claudeTmp();
  const assetsDir = tmp('mc-edspawn-assets-');
  const root = tmp('mc-edspawn-root-');
  const fake = fakeSpawn(spawnMode);
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    antigravityCommand: 'fake-antigravity',
    terminals: [{ label: 'Claude', command: 'claude' }],
    editableRoots: [root],
    ...config,
  }));
  // this suite never disabled the worktree sweep, so
  // every boot here fired a REAL (fire-and-forget) sweepWorktrees() against
  // this machine's ~20-25 real repo roots, including REPO_ROOT itself. A
  // later test's fs.statSync mock (below) then intermittently caught that
  // leftover scan's own stat calls, still in flight after h.close() -
  // observed as "a UNC path must never be stat-ed: 2519 !== 0" on a full
  // npm test run, never in isolation. GLMPS_UNMERGED_SCAN=off is the same
  // pre-existing gate runner-worktree.test.js and api-purge-worktree.test.js
  // already set for exactly this reason.
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_ALLOW_ACT: '1', GLMPS_UNMERGED_SCAN: 'off', ...extraEnv };
  const h = await startServer({ port: 0, env, configFile, editorSpawnFn: fake.fn, agAliveProbe: () => false, ...(editorDetect ? { editorDetect } : {}) });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, { ...opt, headers: { ...(opt?.headers), 'x-glmps-local-session': h.localSession } }); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try { await fn({ get: (p) => j(p), post, fake, root, stateDir }); }
  finally {
    await h.close?.();
    for (const d of [stateDir, claudeDir, assetsDir, root]) fs.rmSync(d, { recursive: true, force: true });
  }
}
const settle = () => new Promise((r) => setTimeout(r, 30));

// Each route: how to reach its spawn with a SAFE request, and its miss key.
// D20: resume and terminal now open the terminal directly via launchNative,
// which can only ever learn about a SYNCHRONOUS spawn failure (a throw)
// before its HTTP response has to go out - exactly like every other
// fire-and-forget launch in this file (launchSession, spawnEditorApp), an
// ASYNC failure ('error' event or a non-zero exit, discovered after the pid
// already looked real) can only ever be reported through the named miss
// (and now also the launch.failed event), never by changing a response
// that already went out. failStatus(mode) -> 500 only for the mode that can
// be caught synchronously; every other route/mode stays < 500.
const syncOnly500 = (mode) => (mode === 'throw' ? 500 : undefined);
// a route whose spawn goes through the shared launchNative
// also lands a `launch.failed` event, lane set to that route's own origin
// (not always 'runner') - `lane` below names the origin each expects.
const ROUTES = {
  resume: {
    key: 'spawn:resume',
    lane: 'resume',
    failStatus: syncOnly500,
    hit: async ({ post, root }) => post('/api/resume', { sessionId: SID, cwd: root }),
  },
  terminal: {
    key: 'spawn:terminal',
    lane: 'terminal',
    failStatus: syncOnly500,
    hit: async ({ post, root }) => post('/api/terminal', { terminal: 'Claude', cwd: root }),
  },
  'open-in-editor': {
    key: 'spawn:open-in-editor',
    hit: async ({ post, root }) => {
      const f = path.join(root, 'notes.md');
      fs.writeFileSync(f, '# n\n');
      return post('/api/open-in-editor', { path: f });
    },
  },
  'learning-apply': {
    key: 'spawn:learning-apply',
    lane: 'learning',
    hit: async ({ post }) => {
      const idea = await post('/api/learning/idea', { text: 'a memory worth keeping' });
      return post(`/api/learning/item/${idea.body.id}/promote`, { target: 'memory' });
    },
  },
};

for (const [route, spec] of Object.entries(ROUTES)) {
  for (const mode of ['throw', 'error', 'exit1']) {
    test(`${route}: a spawn that ${mode === 'throw' ? 'throws' : mode === 'error' ? 'emits error' : 'exits 1'} is a named ${spec.key} miss and the server stays up`, async () => {
      await withServer({ spawnMode: mode }, async (ctx) => {
        resetAdapterHealth();
        const r = await spec.hit(ctx);
        const expect500 = spec.failStatus?.(mode);
        if (expect500) assert.equal(r.status, expect500, `the route answers (${r.status}): ${JSON.stringify(r.body)}`);
        else assert.ok(r.status < 500, `the route answers (${r.status}): ${JSON.stringify(r.body)}`);
        await settle();
        assert.equal(ctx.fake.calls.length, 1, 'the spawn went through the seam');
        assert.equal((await ctx.get('/api/config')).status, 200, 'the server is still answering');
        const miss = adapterHealth()[spec.key];
        assert.ok(miss, `a ${spec.key} miss is reported`);
        assert.match(miss.lastReason, mode === 'throw' ? /EMFILE/ : mode === 'error' ? /ENOENT/ : /exited with code 1/);
        if (spec.lane) {
          const failed = readEvents(ctx.stateDir).filter((e) => e.kind === 'launch.failed');
          assert.equal(failed.length, 1, 'exactly one launch.failed event lands in the event log');
          assert.equal(failed[0].lane, spec.lane);
        }
      });
    });
  }
}

// SECURITY: a request path must never be interpolated into the shell:true
// command line. Real directories are created where the platform allows the
// name, so the refusal is the metacharacter check, not a missing path.
const PAYLOADS = ['a & calc', 'b ^ c', '%PATH%', '$(calc)', 'q " & calc & "'];

for (const payload of PAYLOADS) {
  test(`resume: a cwd containing ${JSON.stringify(payload)} is refused 400 by name, never spawned, never queued`, async () => {
    await withServer({}, async ({ post, fake, root, stateDir }) => {
      const d = path.join(root, payload);
      try { fs.mkdirSync(d); } catch (e) { assert.ok(e.code, 'illegal name on this platform: tested as a string'); }
      const r = await post('/api/resume', { sessionId: 's-1', cwd: d });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /cwd .*shell metacharacter/);
      assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
      assert.equal(fs.existsSync(path.join(stateDir, 'requests', 'resume.jsonl')), false, 'nothing was queued');
    });
  });

  test(`terminal: a cwd containing ${JSON.stringify(payload)} is refused 400 by name and never spawned`, async () => {
    await withServer({}, async ({ post, fake, root }) => {
      const d = path.join(root, payload);
      try { fs.mkdirSync(d); } catch (e) { assert.ok(e.code, 'illegal name on this platform: tested as a string'); }
      const r = await post('/api/terminal', { terminal: 'Claude', cwd: d });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /cwd .*shell metacharacter/);
      assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    });
  });

  test(`open-in-editor: a path containing ${JSON.stringify(payload)} is refused 400 by name and never spawned`, async () => {
    await withServer({}, async ({ post, fake, root }) => {
      const f = path.join(root, `${payload}.md`);
      try { fs.writeFileSync(f, 'x'); } catch (e) { assert.ok(e.code, 'illegal name on this platform: tested as a string'); }
      const r = await post('/api/open-in-editor', { path: f });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /path .*shell metacharacter/);
      assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    });
  });
}

// D20: resume/terminal now open a native terminal directly (nativeTerminalRecipe,
// shell:false) instead of spawning the Antigravity editor app via a shell:true
// command line - the cwd reaches the spawn only as the process options.cwd
// (never interpolated into the args), and the seeded command is the sole arg
// that carries the launch intent.
test('resume and terminal: a safe cwd with a space reaches the spawn only as the cwd option, never interpolated into args', async () => {
  await withServer({}, async ({ post, fake, root }) => {
    const d = path.join(root, 'My Project');
    fs.mkdirSync(d);
    assert.equal((await post('/api/resume', { sessionId: SID, cwd: d })).status, 200);
    assert.equal((await post('/api/terminal', { terminal: 'Claude', cwd: d })).status, 200);
    assert.equal(fake.calls.length, 2);
    // CI fix: the recipe is per platform (cmd on win32, osascript on darwin,
    // x-terminal-emulator elsewhere). win32 asserts the absolute cmd.exe (F18);
    // other platforms assert the recipe's own file.
    const expectedFile = process.platform === 'win32' ? windowsCmdPath(process.env) : nativeTerminalRecipe({ platform: process.platform, seededCmd: 'x', cwd: d }).file;
    for (const c of fake.calls) {
      assert.equal(c.file, expectedFile);
      assert.equal(c.options.cwd, path.resolve(d));
      // darwin's AppleScript recipe carries the cwd inside its script by
      // design (Terminal.app has no cwd option); everywhere else it must
      // reach the spawn only as options.cwd.
      if (process.platform !== 'darwin') assert.ok(!c.args.some((a) => a.includes(path.resolve(d))), 'the cwd never appears in the spawned argv');
    }
  });
});

test('open-in-editor: a safe path reaches the spawn only as a quoted argument', async () => {
  await withServer({}, async ({ post, fake, root }) => {
    const f = path.join(root, 'My Notes.md');
    fs.writeFileSync(f, 'x');
    assert.equal((await post('/api/open-in-editor', { path: f })).status, 200);
    assert.deepEqual(fake.calls[0].args, ['-g', shellArg(path.resolve(f))]);
  });
});

// Card glmps-2-0-runtime-129: the server's own background capture poll stats
// adapter dirs and the backlog store while a request is in flight, so counting
// EVERY statSync call failed these tests whenever a loaded full-suite run made
// the request slow (7 stray calls in an 8 s request). Only a stat of a UNC or
// device path is the outbound SMB probe these tests forbid; every other stat
// passes through to the real fs.statSync so background work is undisturbed.
const isNetworkPath = (p) => /^(\\\\|\/\/)/.test(String(p));
function spyUncStats(t) {
  const realStatSync = fs.statSync;
  const calls = [];
  t.mock.method(fs, 'statSync', (...args) => {
    if (!isNetworkPath(args[0])) return realStatSync.apply(fs, args);
    calls.push(args);
    throw new Error('a UNC path must not be stat-ed');
  });
  return calls;
}

test('spyUncStats: unrelated stats pass through uncounted, a UNC stat is counted', (t) => {
  const calls = spyUncStats(t);
  assert.ok(fs.statSync(os.tmpdir()).isDirectory(), 'a local stat reaches the real fs');
  assert.equal(calls.length, 0, 'a background stat of a local path is not a UNC probe');
  assert.throws(() => fs.statSync('\\\\host\\share\\dir'));
  assert.throws(() => fs.statSync('//host/share/dir'));
  assert.equal(calls.length, 2, 'a UNC stat is still caught');
});

// Task 7 final review carry-in (a): the route used to run shellSafePath's
// stat (fs.statSync) BEFORE the FileApi allowlist check, so an unallowlisted
// path (a \\host\share UNC path, say) still triggered an outbound stat -
// letting any caller use this route as an existence oracle, or worse, an SMB
// probe against an arbitrary host. The allowlist must refuse the path before
// any stat is attempted.
test('open-in-editor: an unallowlisted UNC path is refused by the allowlist before any stat is attempted', async (t) => {
  await withServer({}, async ({ post, fake }) => {
    const statCalls = spyUncStats(t);
    const r = await post('/api/open-in-editor', { path: '\\\\host\\share\\secret.md' });
    assert.notEqual(r.status, 200, 'an unallowlisted path must never reach the spawn');
    assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    assert.equal(statCalls.length, 0, 'the allowlist check must refuse the path before any stat runs');
  });
});

// resume and terminal have no FileApi allowlist stage at
// all - shellSafePathSyntax's own UNC/device-prefix refusal is the ONLY gate
// standing between a request field and an outbound stat over SMB. Every
// route built on it must refuse a UNC cwd/path by name, with no stat ever
// attempted.
test('resume: a UNC cwd is refused by name before any stat is attempted', async (t) => {
  await withServer({}, async ({ post, fake }) => {
    const statCalls = spyUncStats(t);
    const r = await post('/api/resume', { sessionId: 's-1', cwd: '\\\\host\\share\\dir' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cwd .*(UNC|device)/);
    assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    assert.equal(statCalls.length, 0, 'a UNC cwd must never be stat-ed');
  });
});

test('terminal: a UNC cwd is refused by name before any stat is attempted', async (t) => {
  await withServer({}, async ({ post, fake }) => {
    const statCalls = spyUncStats(t);
    const r = await post('/api/terminal', { terminal: 'Claude', cwd: '\\\\host\\share\\dir' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cwd .*(UNC|device)/);
    assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    assert.equal(statCalls.length, 0, 'a UNC cwd must never be stat-ed');
  });
});

// the allowlist check must run WITHOUT reading the file, so
// (a) an unallowlisted-but-otherwise-valid local path is refused by name
// (never a raw filesystem error), and (b) an ALLOWED path that is missing or
// the wrong kind gets shellSafePath's own named 400, not an uncaught
// readFileSync throw surfacing as a 500.
test('open-in-editor: a path outside the allowed roots is refused by name, and the file is never read', async (t) => {
  await withServer({}, async ({ post, fake }) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-edspawn-outside-'));
    const f = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(f, 'top secret contents');
    const origReadFileSync = fs.readFileSync;
    const reads = [];
    t.mock.method(fs, 'readFileSync', (...args) => { reads.push(args); return origReadFileSync.apply(fs, args); });
    try {
      const r = await post('/api/open-in-editor', { path: f });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /not allowed/i);
      assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
      assert.equal(reads.filter((args) => args[0] === f).length, 0, 'the refused file was never read');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('open-in-editor: an allowed but missing file returns a clean 400, not a raw read error', async () => {
  await withServer({}, async ({ post, root }) => {
    const missing = path.join(root, 'does-not-exist.md');
    const r = await post('/api/open-in-editor', { path: missing });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /path refused/);
    assert.match(r.body.error, /not found/);
  });
});

test('open-in-editor: a UNC path is refused by name before any stat is attempted', async (t) => {
  await withServer({}, async ({ post, fake }) => {
    const statCalls = spyUncStats(t);
    const r = await post('/api/open-in-editor', { path: '\\\\host\\share\\secret.md' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /path .*(UNC|device)/);
    assert.equal(fake.calls.length, 0, 'nothing reached a spawn');
    assert.equal(statCalls.length, 0, 'a UNC path must never be stat-ed');
  });
});

// location:'workspace' had no coverage at all. Antigravity
// sessions cannot be resumed, so this branch opens the folder in the IDE
// instead of building a resumeCommand - distinct from every other test in
// this file, which hits the launchNative path.
test('resume (workspace): 400 when antigravityCommand is not configured, nothing reaches a spawn', async () => {
  await withServer({ config: { antigravityCommand: null } }, async ({ post, fake, root }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'antigravityCommand not configured');
    assert.equal(fake.calls.length, 0);
  });
});

test('resume (workspace): opens the editor app with only the quoted, gated cwd as an argument', async () => {
  await withServer({}, async ({ post, fake, root }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { opened: true, cwd: path.resolve(root) });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].file, 'fake-antigravity');
    assert.deepEqual(fake.calls[0].args, [shellArg(path.resolve(root))]);
    assert.equal(fake.calls[0].options.shell, true);
  });
});

// Pre-step (a) of Task 12b: the workspace branch used to answer only
// { opened: true } no matter what cwd actually resolved to, so a requested
// folder that no longer exists looked identical to an ordinary success. Same
// cwdFallback contract as the resume-a-terminal path just above it.
test('resume (workspace): a requested cwd that no longer exists reports cwdFallback and the effective cwd', async () => {
  await withServer({}, async ({ post, fake, root }) => {
    // the vanished cwd must sit inside a configured root, or the launch is refused 403 before any fallback.
    const gone = path.join(root, 'no-such-dir-glmps-workspace');
    const r = await post('/api/resume', { sessionId: SID, cwd: gone, location: 'workspace' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cwdFallback, true);
    assert.equal(path.resolve(r.body.cwd), path.resolve(process.cwd()));
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].args, [], 'no cwd argument when nothing resolved');
  });
});

test('resume (workspace): an ordinary successful open carries no cwdFallback field', async () => {
  await withServer({}, async ({ post, root }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
    assert.equal(r.status, 200);
    assert.equal('cwdFallback' in r.body, false);
  });
});

// a service-mode kernel runs in session 0 and cannot put
// ANY desktop app on the operator's screen, the same reason launchNative
// cannot open a terminal there. Checked unconditionally, before ever
// building a spawn - `editorSpawnFn` is still injected by withServer as
// this suite's own safety net, but the assertion that proves the guard ran
// is `fake.calls.length === 0`, not the injected fake's mere presence.
test('resume (workspace): service mode refuses by name (409) and never reaches a spawn', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' } }, async ({ post, fake, root }) => {
    resetAdapterHealth();
    const r = await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'service mode cannot open a desktop app from session 0');
    assert.equal(fake.calls.length, 0, 'the spawn (even the injected fake one) was never reached');
    const miss = adapterHealth()['spawn:resume-workspace'];
    assert.ok(miss, 'a spawn:resume-workspace miss is reported');
  });
});

const queued = (stateDir) => JSON.parse(fs.readFileSync(path.join(stateDir, 'launches', 'queue.json'), 'utf8'));

test('open-in-editor: service mode queues an editor launch for the desktop shell and never spawns', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' } }, async ({ post, fake, root, stateDir }) => {
    const f = path.join(root, 'notes.md');
    fs.writeFileSync(f, 'x');
    const r = await post('/api/open-in-editor', { path: f });
    assert.equal(r.status, 200);
    assert.equal(r.body.queued, true);
    assert.equal(fake.calls.length, 0, 'the kernel never spawns an editor from session 0');
    const rows = queued(stateDir).filter((q) => q.origin === 'editor');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, f);
    assert.equal(rows[0].state, 'pending');
  });
});

test('open-in-editor: service mode still refuses a path outside the allowlist, queueing nothing', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' } }, async ({ post, stateDir }) => {
    const outside = path.join(os.tmpdir(), 'mc-not-allowed-notes.md');
    fs.writeFileSync(outside, 'x');
    try {
      const r = await post('/api/open-in-editor', { path: outside });
      assert.equal(r.status, 403);
      assert.equal(fs.existsSync(path.join(stateDir, 'launches', 'queue.json')) ? queued(stateDir).length : 0, 0);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});

test('open-in-editor: kind dir opens a folder, and a file path with kind dir is refused', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' } }, async ({ post, root, stateDir }) => {
    const f = path.join(root, 'notes.md');
    fs.writeFileSync(f, 'x');
    assert.equal((await post('/api/open-in-editor', { path: root, kind: 'dir' })).status, 200);
    assert.equal((await post('/api/open-in-editor', { path: f, kind: 'dir' })).status, 400);
    assert.equal(queued(stateDir).filter((q) => q.origin === 'editor').length, 1);
  });
});

test('resume (workspace): the service-mode refusal is a durable launch.failed event', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' } }, async ({ post, root, stateDir }) => {
    await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.deepEqual(events.map((e) => e.lane), ['resume-workspace']);
  });
});

for (const mode of ['throw', 'error', 'exit1']) {
  test(`resume (workspace): a spawn that ${mode} is a named spawn:resume-workspace miss`, async () => {
    await withServer({ spawnMode: mode }, async ({ post, fake, root }) => {
      resetAdapterHealth();
      const r = await post('/api/resume', { sessionId: SID, cwd: root, location: 'workspace' });
      assert.ok(r.status < 500, `the route answers (${r.status}): ${JSON.stringify(r.body)}`);
      await settle();
      assert.equal(fake.calls.length, 1);
      const miss = adapterHealth()['spawn:resume-workspace'];
      assert.ok(miss, 'a spawn:resume-workspace miss is reported');
    });
  });
}

// a statSync failure that is NOT "the path is gone"
// (ENOENT/ENOTDIR) must not be swallowed into the same silent fallback -
// it is a real, unexplained I/O failure and must surface by name.
test('resume: a statSync failure other than ENOENT/ENOTDIR is a named failure, not a silent fallback', async (t) => {
  await withServer({}, async ({ post, root }) => {
    t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
    const r = await post('/api/resume', { sessionId: SID, cwd: root });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /EACCES/);
  });
});

test('F16: the editor app (shell:true) is spawned with NoDefaultCurrentDirectoryInExePath=1, so an editor shim planted in the cwd never runs', async () => {
  await withServer({}, async ({ post, fake, root }) => {
    const f = path.join(root, 'notes.md');
    fs.writeFileSync(f, 'x');
    assert.equal((await post('/api/open-in-editor', { path: f })).status, 200);
    assert.equal(fake.calls[0].options.shell, true);
    assert.equal(fake.calls[0].options.env.NoDefaultCurrentDirectoryInExePath, '1');
  });
});

// card 87: Open follows the board picker (runner lastTarget) when no
// antigravityCommand is set by hand. Installs are faked by an injected probe
// over a home that contains a space, so the quoting is exercised too.
const FAKE_HOME = 'C:\\Users\\op x';
const progPath = (rel) => path.win32.join(FAKE_HOME, 'AppData', 'Local', 'Programs', rel);
const FAKE_BIN = {
  antigravity: progPath('Antigravity IDE\\bin\\antigravity-ide.cmd'),
  vscode: progPath('Microsoft VS Code\\bin\\code.cmd'),
  cursor: progPath('cursor\\resources\\app\\bin\\cursor.cmd'),
};
const detectWith = (...ids) => {
  const set = new Set(ids.map((i) => FAKE_BIN[i]));
  return { home: FAKE_HOME, programFiles: [], exists: (p) => set.has(p) };
};
const openNotes = async ({ post, root }) => {
  const f = path.join(root, 'notes.md');
  fs.writeFileSync(f, 'x');
  return post('/api/open-in-editor', { path: f });
};

test('open-in-editor: with no antigravityCommand, follows the picker and quotes a path with spaces', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith('antigravity', 'cursor') }, async (ctx) => {
    runnerStore.saveConfig(ctx.stateDir, { openTarget: 'cursor' });
    assert.equal((await openNotes(ctx)).status, 200);
    assert.equal(ctx.fake.calls[0].file, `"${FAKE_BIN.cursor}"`);
  });
});

test('open-in-editor: a picker change applies on the next Open with no restart', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith('antigravity', 'vscode') }, async (ctx) => {
    runnerStore.saveConfig(ctx.stateDir, { openTarget: 'vscode' });
    await openNotes(ctx);
    runnerStore.saveConfig(ctx.stateDir, { openTarget: 'antigravity' });
    await openNotes(ctx);
    assert.deepEqual(ctx.fake.calls.map((c) => c.file), [`"${FAKE_BIN.vscode}"`, `"${FAKE_BIN.antigravity}"`]);
  });
});

test('open-in-editor: native-terminal picker falls back to the first installed IDE in order', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith('cursor', 'vscode') }, async (ctx) => {
    runnerStore.saveConfig(ctx.stateDir, { openTarget: 'native-terminal' });
    assert.equal((await openNotes(ctx)).status, 200);
    assert.equal(ctx.fake.calls[0].file, `"${FAKE_BIN.vscode}"`);
  });
});

// Card glmps-2-0-runtime-90: file opens follow "Open files in", never the
// board's session picker.
test('open-in-editor: the board session picker does not choose the file editor', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith('antigravity', 'cursor') }, async (ctx) => {
    runnerStore.saveConfig(ctx.stateDir, { lastTarget: 'cursor', openTarget: null });
    assert.equal((await openNotes(ctx)).status, 200);
    assert.equal(ctx.fake.calls[0].file, `"${FAKE_BIN.antigravity}"`);
  });
});

test('GET /api/runner lists the installed IDEs a file can open in, with labels', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith('cursor', 'antigravity') }, async (ctx) => {
    const r = (await ctx.get('/api/runner')).body;
    assert.deepEqual(r.openTargets, [{ id: 'antigravity', label: 'Antigravity' }, { id: 'cursor', label: 'Cursor' }]);
    assert.equal(r.config.openTarget, null);
  });
});

test('open-in-editor: no supported IDE installed is a named 400 and nothing spawns', async () => {
  await withServer({ config: { antigravityCommand: null }, editorDetect: detectWith() }, async (ctx) => {
    const r = await openNotes(ctx);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no supported IDE found; install one or set antigravityCommand/);
    assert.equal(ctx.fake.calls.length, 0);
  });
});

test('open-in-editor: a hand-set antigravityCommand still wins over the picker', async () => {
  await withServer({ config: { antigravityCommand: 'my-editor' }, editorDetect: detectWith('cursor') }, async (ctx) => {
    runnerStore.saveConfig(ctx.stateDir, { openTarget: 'cursor' });
    assert.equal((await openNotes(ctx)).status, 200);
    assert.equal(ctx.fake.calls[0].file, 'my-editor');
  });
});

test('open-in-editor: a configured command containing a space is quoted for shell:true', async () => {
  await withServer({ config: { antigravityCommand: 'C:\\Tools x\\ed.cmd' } }, async (ctx) => {
    assert.equal((await openNotes(ctx)).status, 200);
    assert.equal(ctx.fake.calls[0].file, '"C:\\Tools x\\ed.cmd"');
  });
});

test('service mode: an installed IDE lets Open queue for the desktop shell', async () => {
  await withServer({ env: { GLMPS_SERVICE: '1' }, config: { antigravityCommand: null }, editorDetect: detectWith('cursor') }, async (ctx) => {
    const r = await openNotes(ctx);
    assert.equal(r.status, 200);
    assert.equal(r.body.queued, true);
  });
});

// server/test/learning-apply.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuard, buildMemoryApplyCommand, ingestResults } from '../lib/evaluation/learning-apply.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// applyGuard - verbatim from plan Task 3 Step 1

test('applyGuard transforms file, commits via injected runner, returns sha', () => {
  let written = null; const calls = [];
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => '# T\n',
    writeFile: (p, c) => { written = { p, c }; },
    runGit: (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'abc123' : ''; },
  });
  assert.match(written.c, /## Learned guards\n- r/);
  assert.deepEqual(calls[0], ['add', 'CLAUDE.global.md']);
  assert.equal(calls[1][0], 'commit');
  assert.equal(res.commit, 'abc123'); assert.equal(res.changed, true);
});

test('buildMemoryApplyCommand references id, memoryDir, MEMORY.md and result path', () => {
  const cmd = buildMemoryApplyCommand('idea-7', {
    requestPath: '/R/idea-7.json', resultPath: '/Res/idea-7.json', memoryDir: '/M/proj/memory',
  });
  assert.match(cmd, /^claude -p /);
  assert.match(cmd, /idea-7/);
  assert.match(cmd, /\/M\/proj\/memory/);
  assert.match(cmd, /MEMORY\.md/);
  assert.match(cmd, /\/Res\/idea-7\.json/);
});

test('ingestResults reads+clears (D20: the request-file enqueue step it used to be paired with is gone)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const resDir = path.join(dir, 'learning', 'results'); fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'idea-1.json'), JSON.stringify({ status: 'applied', commit: 'z' }));
  const out = ingestResults(dir);
  assert.equal(out[0].id, 'idea-1'); assert.equal(out[0].commit, 'z');
  assert.equal(fs.existsSync(path.join(resDir, 'idea-1.json')), false); // consumed
});

// applyGuard - changed:false path (rule already present)

test('applyGuard (default git runner) throws when assetsDir is not a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nogit-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.global.md'), '# G\n');
  // No injected runGit -> uses the real spawnSync git, which must fail loudly
  // (not silently report success) when the dir is not a git repository.
  assert.throws(
    () => applyGuard({ assetsDir: dir, file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- x', message: 'm' }),
    /git/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyGuard: simThreshold forwarded to insertGuard skips a near-dup paraphrase', () => {
  const calls = [];
  const existingContent = '# Title\n\n## Learned guards\n- Before any UI/CSS/layout/styling work, invoke the frontend-design skill. Invoke it BEFORE the first UI/CSS edit, not after.\n';
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards',
    rule: '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.',
    message: 'm', simThreshold: 0.5,
    readFile: () => existingContent,
    writeFile: () => { throw new Error('writeFile should not be called for a near-dup'); },
    runGit: (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'HEAD123' : ''; },
  });
  assert.equal(res.changed, false);
  assert.equal(res.commit, 'HEAD123');
  assert.equal(calls.length, 1); // only rev-parse, no add/commit
});

test('applyGuard: without simThreshold, the same paraphrase is still appended (backward compatible)', () => {
  let written = null;
  const existingContent = '# Title\n\n## Learned guards\n- Before any UI/CSS/layout/styling work, invoke the frontend-design skill. Invoke it BEFORE the first UI/CSS edit, not after.\n';
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards',
    rule: '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.',
    message: 'm',
    readFile: () => existingContent,
    writeFile: (_p, c) => { written = c; },
    runGit: (args) => (args[0] === 'rev-parse' ? 'HEAD123' : ''),
  });
  assert.equal(res.changed, true);
  assert.match(written, /frontend-design skill/);
});

test('applyGuard with changed:false returns HEAD sha without committing', () => {
  const calls = [];
  const existingContent = '# Title\n\n## Learned guards\n- r\n';
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => existingContent,
    writeFile: (_p, _c) => { throw new Error('writeFile should not be called when unchanged'); },
    runGit: (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'HEAD123' : ''; },
  });
  assert.equal(res.changed, false);
  assert.equal(res.commit, 'HEAD123');
  // Only rev-parse should have been called (no add, no commit)
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['rev-parse', 'HEAD']);
});

// applyGuard - shadow/control-arm wiring (glmps champion-challenger floor,
// Phase 2): on a successful apply, record an actual "fired" shadow entry so the
// auto-apply gap-recurrence confound can be broken. Opt-in via `stateDir` so
// callers that don't pass one (the manual approve/promote HTTP routes in
// server.js) are completely unaffected.

test('applyGuard records a shadow fire on success when stateDir is passed', () => {
  const calls = [];
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => '# T\n',
    writeFile: () => {},
    runGit: (args) => (args[0] === 'rev-parse' ? 'sha1' : ''),
    stateDir: '/state', taskClass: 'ui-without-frontend-design', sid: 'sess-1',
    recordShadow: (stateDir, entry) => calls.push({ stateDir, entry }),
  });
  assert.equal(res.commit, 'sha1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    stateDir: '/state',
    entry: { taskClass: 'ui-without-frontend-design', fired: true, sid: 'sess-1' },
  });
});

test('applyGuard does not record a shadow entry when stateDir is omitted', () => {
  let called = false;
  applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => '# T\n',
    writeFile: () => {},
    runGit: (args) => (args[0] === 'rev-parse' ? 'sha1' : ''),
    recordShadow: () => { called = true; },
  });
  assert.equal(called, false);
});

test('buildMemoryApplyCommand rejects an id or path a shell could interpret', () => {
  const ok = { requestPath: 'C:\\State\\req\\a.json', resultPath: 'C:\\State\\res\\a.json', memoryDir: 'C:\\Users\\me (x86)\\.claude\\projects\\p\\memory' };
  assert.doesNotThrow(() => buildMemoryApplyCommand('idea-7', ok));
  for (const bad of ['a"; rm -rf ~; "', 'a b', '$(whoami)', 'x`y`', '', '../x', 'a%PATH%']) {
    assert.throws(() => buildMemoryApplyCommand(bad, ok), /unsafe id/, bad);
  }
  for (const key of ['requestPath', 'resultPath', 'memoryDir']) {
    // \u201c etc: PowerShell treats typographic quotes as quote characters.
    for (const bad of ['/x"y', '/x$HOME', '/x`id`', '/x%TEMP%', '/x;y', '/x\ny', '/x&y', '/x|y', '/x\u201cy', '/x\u201dy', '/x\u201ey', '/x\u2018y', '/x\u2019y']) {
      assert.throws(() => buildMemoryApplyCommand('idea-7', { ...ok, [key]: bad }), new RegExp(`unsafe ${key}`), `${key} ${bad}`);
    }
  }
});

test('buildMemoryApplyCommand emits no shell metacharacters beyond the wrapping quotes', () => {
  const cmd = buildMemoryApplyCommand('idea-7', { requestPath: '/R/a.json', resultPath: '/Res/a.json', memoryDir: '/M/memory' });
  const body = cmd.slice('claude -p "'.length, -1);
  assert.doesNotMatch(body, /["`$%!^&|<>;\\]/);
});

test('ingestResults leaves a young malformed result alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const resDir = path.join(dir, 'learning', 'results'); fs.mkdirSync(resDir, { recursive: true });
  const f = path.join(resDir, 'idea-2.json');
  fs.writeFileSync(f, '{"status": "appl');
  assert.deepEqual(ingestResults(dir), []);
  assert.equal(fs.existsSync(f), true, 'still there for the writer to finish');
  assert.equal(fs.existsSync(path.join(resDir, 'idea-2.bad')), false);
});

test('ingestResults renames an old malformed result to .bad instead of deleting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const resDir = path.join(dir, 'learning', 'results'); fs.mkdirSync(resDir, { recursive: true });
  const f = path.join(resDir, 'idea-3.json');
  fs.writeFileSync(f, 'not json');
  fs.writeFileSync(path.join(resDir, 'idea-4.json'), JSON.stringify({ status: 'applied' }));
  const out = ingestResults(dir, { now: Date.now() + 120_000 });
  assert.deepEqual(out.map((r) => r.id), ['idea-4']);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.readFileSync(path.join(resDir, 'idea-3.bad'), 'utf8'), 'not json');
});

test('ingestResults: a rename error on one malformed file does not abort the batch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const resDir = path.join(dir, 'learning', 'results'); fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'a-bad.json'), 'nope');
  // A non-empty directory already at the .bad destination makes the rename fail.
  fs.mkdirSync(path.join(resDir, 'a-bad.bad', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(resDir, 'b-good.json'), JSON.stringify({ status: 'applied' }));
  const out = ingestResults(dir, { now: Date.now() + 120_000 });
  assert.deepEqual(out.map((r) => r.id), ['b-good']);
});

// applyGuard - own-checkout refusal (card glmps-2-0-runtime-48, dev/prod T1)

function gitIn(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function tempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitIn(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'CLAUDE.global.md'), '# G\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('applyGuard refuses to commit in the server\'s own checkout and leaves the file untouched', () => {
  const repo = tempRepo('mc-own-');
  try {
    const before = fs.readFileSync(path.join(repo, 'CLAUDE.global.md'), 'utf8');
    const calls = [];
    assert.throws(
      () => applyGuard({
        assetsDir: repo, file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- x', message: 'm',
        serverRoot: path.join(repo, '.'),
        runGit: (args) => { calls.push(args); return ''; },
      }),
      /refusing to commit in the server's own checkout .*dev\/prod T5/,
    );
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.global.md'), 'utf8'), before);
    assert.equal(calls.some((a) => a[0] === 'commit'), false);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('applyGuard refuses when assetsDir is a subdirectory of the server checkout', () => {
  const repo = tempRepo('mc-own-sub-');
  try {
    const sub = path.join(repo, 'assets');
    fs.mkdirSync(sub);
    assert.throws(
      () => applyGuard({ assetsDir: sub, file: 'g.md', section: 'S', rule: '- x', message: 'm', serverRoot: repo, runGit: () => '' }),
      /own checkout/,
    );
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('applyGuard commits in a separate clone with real git', () => {
  const server = tempRepo('mc-srv-');
  const assets = tempRepo('mc-assets-');
  try {
    const res = applyGuard({
      assetsDir: assets, file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- real rule', message: 'add guard',
      serverRoot: server,
      runGit: (args) => gitIn(assets, ...args),
    });
    assert.equal(res.changed, true);
    assert.match(fs.readFileSync(path.join(assets, 'CLAUDE.global.md'), 'utf8'), /- real rule/);
    assert.equal(res.commit, gitIn(assets, 'rev-parse', 'HEAD'));
    assert.equal(gitIn(assets, 'log', '-1', '--format=%s'), 'add guard');
  } finally {
    fs.rmSync(server, { recursive: true, force: true });
    fs.rmSync(assets, { recursive: true, force: true });
  }
});

test('applyGuard proceeds when either toplevel cannot be resolved', () => {
  const calls = [];
  const run = (toplevelOf, serverRoot) => applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    serverRoot, toplevelOf,
    readFile: () => '# T\n', writeFile: () => {},
    runGit: (args) => { calls.push(args); return 'sha'; },
  });
  assert.equal(run(() => null, '/S').commit, 'sha');
  assert.equal(run(() => '/A', null).commit, 'sha');
  assert.equal(run((d) => (d === '/A' ? '/A' : null), '/S').commit, 'sha');
});

test('applyGuard default toplevelOf does not throw for a nonexistent dir', () => {
  const res = applyGuard({
    assetsDir: path.join(os.tmpdir(), 'mc-definitely-missing-dir-48'), file: 'g.md', section: 'S', rule: '- r', message: 'm',
    readFile: () => '', writeFile: () => {}, runGit: () => 'sha',
  });
  assert.equal(res.commit, 'sha');
});

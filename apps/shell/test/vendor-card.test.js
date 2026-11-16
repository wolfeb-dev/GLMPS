// apps/shell/test/vendor-card.test.js
// A card run by a non-Claude vendor CLI: argv shapes, the push fence, the
// changed-file fence, output parsing and the fixed commit/push/PR sequence.
// Only the credential test starts a process (a real git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  vendorArgs, fencedAgentEnv, fenceViolations, parseAgentOutput, parseStatusZ, resolveVendorBinary, runVendorCard,
  interactiveVendorArgs, parseAgyModels, chooseAgyModel, nextAgyModel,
} from '../src/lib/vendor-card.js';

test('vendorArgs: agy puts --model before -p and passes the prompt as argv', () => {
  const v = vendorArgs({ vendor: 'gemini', model: null, cwd: 'C:\\wt\\p\\c', prompt: 'DO IT' });
  assert.equal(v.file, 'agy');
  assert.deepEqual(v.args, ['--model', 'Gemini 4 Argon (High)', '--output-format', 'json', '--sandbox', '-p', 'DO IT']);
  assert.equal(v.stdin, null);
  const m = vendorArgs({ vendor: 'gemini', model: 'Gemini 4 Argon (Low)', cwd: 'x', prompt: 'p' });
  assert.ok(m.args.indexOf('--model') < m.args.indexOf('-p'));
  assert.equal(m.args[1], 'Gemini 4 Argon (Low)');
});

test('vendorArgs: codex reads the prompt on stdin and never uses --ephemeral', () => {
  const v = vendorArgs({ vendor: 'gpt', model: 'gpt-5', cwd: 'C:\\wt\\p\\c', prompt: 'DO IT' });
  assert.equal(v.file, 'codex');
  assert.deepEqual(v.args, ['exec', '--sandbox', 'workspace-write', '--json', '-C', 'C:\\wt\\p\\c', '-m', 'gpt-5', '-']);
  assert.equal(v.stdin, 'DO IT');
  assert.ok(!v.args.includes('--ephemeral'));
  assert.deepEqual(vendorArgs({ vendor: 'gpt', model: null, cwd: 'c', prompt: 'p' }).args.slice(-2), ['c', '-']);
});

test('vendorArgs: grok denies push and gh and takes the model last', () => {
  const v = vendorArgs({ vendor: 'grok', model: 'grok-4', cwd: 'C:\\wt\\p\\c', prompt: 'DO IT' });
  assert.equal(v.file, 'grok');
  assert.deepEqual(v.args, ['-p', 'DO IT', '--cwd', 'C:\\wt\\p\\c', '--output-format', 'streaming-json', '--always-approve',
    '--deny', 'Bash(git push*)', '--deny', 'Bash(gh *)', '-m', 'grok-4']);
  assert.equal(v.stdin, null);
  assert.throws(() => vendorArgs({ vendor: 'claude', cwd: 'c', prompt: 'p' }), /unknown vendor/);
});

test('vendorArgs: a prompt passed as argv is capped at 30000 characters with a marker, a stdin prompt is not', () => {
  const big = 'x'.repeat(50000);
  const a = vendorArgs({ vendor: 'gemini', cwd: 'c', prompt: big }).args.at(-1);
  assert.ok(a.length < 30200 && a.startsWith('x'.repeat(30000)) && /truncated/.test(a));
  assert.equal(vendorArgs({ vendor: 'grok', cwd: 'c', prompt: big }).args[1].length, a.length);
  assert.equal(vendorArgs({ vendor: 'gpt', cwd: 'c', prompt: big }).stdin.length, 50000);
});

test('fencedAgentEnv: an invalid GH_TOKEN and an unusable pushurl, appended to an existing GIT_CONFIG_COUNT', () => {
  const e = fencedAgentEnv({ PATH: 'p' });
  assert.equal(e.PATH, 'p');
  assert.equal(e.GH_TOKEN, 'glmps-vendor-fence-no-github');
  assert.equal(e.GIT_CONFIG_COUNT, '2');
  assert.equal(e.GIT_CONFIG_KEY_0, 'remote.origin.pushurl');
  assert.equal(e.GIT_CONFIG_VALUE_0, 'glmps-fence://push-blocked');
  assert.equal(e.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(e.GIT_CONFIG_VALUE_1, '');
  assert.equal(e.GIT_TERMINAL_PROMPT, '0');
  assert.equal(e.GCM_INTERACTIVE, 'never');
  assert.match(e.GH_CONFIG_DIR, /glmps-vendor-fence-gh$/);
  assert.equal(e.GIT_ASKPASS, '');
  assert.equal(e.SSH_ASKPASS, '');
  assert.equal(e.GIT_SSH_COMMAND, 'glmps-vendor-fence-no-ssh');
  assert.equal(fencedAgentEnv({ VSCODE_GIT_ASKPASS_MAIN: 'x', VSCODE_GIT_IPC_HANDLE: 'y' }).VSCODE_GIT_ASKPASS_MAIN, undefined);
  const f = fencedAgentEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_KEY_1: 'c', GIT_CONFIG_VALUE_1: 'd' });
  assert.equal(f.GIT_CONFIG_COUNT, '4');
  assert.equal(f.GIT_CONFIG_KEY_0, 'a');
  assert.equal(f.GIT_CONFIG_KEY_2, 'remote.origin.pushurl');
  assert.equal(f.GIT_CONFIG_VALUE_2, 'glmps-fence://push-blocked');
});

test('fenceViolations: secrets, prod zones and instruction, hook and agent-settings files are caught; ordinary code and docs pass', () => {
  const bad = ['.env', 'a/.env.local', 'k.PEM', 'x/server.key', 'id_rsa.pub', 'a.pfx', 'a.p12', 'credentials.json', 'my-secret-file.txt', 'auth-token.json',
    '.npmrc', 'sub/.netrc', 'server/prod/x.js', 'Prod/x', 'CLAUDE.md', 'sub\\AGENTS.md', 'GEMINI.md', 'CLAUDE.global.md', 'hooks/a.js',
    '.claude/settings.json', '.codex/config.toml', '.grok/x', '.gemini/x', '.github/workflows/ci.yml', 'a\\.claude\\x'];
  assert.deepEqual(fenceViolations(bad), bad);
  const good = ['server/lib/a.js', 'docs/x.md', 'web/hooks-list.js', 'apps/shell/src/lib/a.js', 'README.md', '.github/CODEOWNERS', 'tokens.js'];
  assert.deepEqual(fenceViolations(good), []);
  assert.deepEqual(fenceViolations(['docs/x.md', '.env']), ['.env']);
});

test('parseStatusZ: plain entries, untracked, and a rename that adds the old path', () => {
  assert.deepEqual(parseStatusZ(' M a.js\0?? b/c.md\0R  new.js\0old.js\0A  d.js\0'), ['a.js', 'b/c.md', 'new.js', 'old.js', 'd.js']);
  assert.deepEqual(parseStatusZ(''), []);
});

const AGY_OK = '{"conversation_id":"c-1","status":"SUCCESS","response":"OK\\n","duration_seconds":4.05,"num_turns":1,"usage":{"input_tokens":8232,"output_tokens":116,"thinking_tokens":115,"cache_read_tokens":0,"total_tokens":8348}}';

test('parseAgentOutput: the real agy sample', () => {
  const p = parseAgentOutput('gemini', AGY_OK, '');
  assert.deepEqual(p, { sessionId: 'c-1', text: 'OK\n', usage: { input: 8232, output: 116, total: 8348 }, costUsd: null, authFailed: false, quotaExhausted: false });
});

test('parseAgentOutput: the real codex failure sample is a failed sign-in with the thread id', () => {
  const out = [
    '{"type":"thread.started","thread_id":"01a1b345-aaaa"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}',
    '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed."}}',
  ].join('\n');
  const p = parseAgentOutput('gpt', out, '');
  assert.equal(p.authFailed, true);
  assert.equal(p.sessionId, '01a1b345-aaaa');
  assert.equal(p.usage, null);
});

test('parseAgentOutput: codex success takes the last agent_message and sums usage across turns', () => {
  const out = [
    '{"type":"thread.started","thread_id":"t-9"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
    '{"type":"item.completed","item":{"type":"command_execution","text":"ls"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"I logged in to the login page and fixed it"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":3}}',
  ].join('\n');
  const p = parseAgentOutput('gpt', out, '');
  assert.equal(p.text, 'I logged in to the login page and fixed it');
  assert.deepEqual(p.usage, { input: 15, output: 5, total: 20 });
  assert.equal(p.authFailed, false);
});

test('parseAgentOutput: grok is parsed defensively and sign-in text in stderr or an agy sign-in marker is an auth failure', () => {
  const g = parseAgentOutput('grok', '{"session_id":"g-1"}\n{"type":"result","result":"done","usage":{"input_tokens":3,"output_tokens":4}}\nnot json', '');
  assert.equal(g.sessionId, 'g-1');
  assert.equal(g.text, 'done');
  assert.deepEqual(g.usage, { input: 3, output: 4, total: 7 });
  assert.equal(parseAgentOutput('grok', '', '401 Unauthorized').authFailed, true);
  assert.equal(parseAgentOutput('gemini', '', 'time=1 triggering interactive OAuth').authFailed, true);
  assert.equal(parseAgentOutput('gemini', 'garbage', '').text, 'garbage');
  assert.equal(parseAgentOutput('gemini', JSON.stringify({ status: 'SUCCESS', response: 'x'.repeat(9000) }), '').text.length, 4000);
});

test('resolveVendorBinary: exe on PATH or ~/.local/bin, never a cmd shim', () => {
  const have = new Set(['C:\\tools\\agy.exe', 'C:\\Users\\op\\.local\\bin\\codex.exe', 'C:\\tools\\grok.cmd']);
  const opts = { env: { PATH: 'C:\\x;C:\\tools' }, exists: (p) => have.has(p), home: 'C:\\Users\\op', platform: 'win32' };
  assert.equal(resolveVendorBinary('agy', opts), 'C:\\tools\\agy.exe');
  assert.equal(resolveVendorBinary('codex', opts), 'C:\\Users\\op\\.local\\bin\\codex.exe');
  assert.equal(resolveVendorBinary('grok', opts), null);
});

const RECIPE = {
  kind: 'vendor-card', vendor: 'gemini', model: null, cwd: 'C:\\wt\\p\\c1', promptFile: 'S\\runner\\c1.prompt.md',
  branch: 'card/c1', base: 'glmps2/main', cardId: 'c1', title: 'Fix the thing', timeoutMs: 60000,
};
const BIN = { agy: 'C:\\b\\agy.exe', codex: 'C:\\b\\codex.exe', grok: 'C:\\b\\grok.exe', graphify: 'C:\\b\\graphify.exe' };

// scripts: map of "file arg0 arg1" prefixes to results; default exit 0 with empty output.
function harness({ replies = {}, exists = true, binaries = BIN, prompt = { ok: true, text: 'PROMPT' } } = {}) {
  const calls = [];
  const bodies = [];
  const run = async (file, args, opts) => {
    const base = file.replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    const key = base === 'agy' && args[0] === 'models' ? 'agy models' : base === 'git' ? `git ${args[0]}` : base === 'gh' ? `gh pr ${args[1]}` : base === 'node' ? 'tests' : base;
    calls.push({ key, file, args, opts });
    const r = replies[key];
    return { status: 0, stdout: '', stderr: '', timedOut: false, ...(typeof r === 'function' ? r(args) : r) };
  };
  const deps = {
    run, readPrompt: async () => prompt, writeTemp: async (t) => { bodies.push(t); return 'C:\\tmp\\body.md'; },
    resolveBinary: (n) => binaries[n] ?? null, now: (() => { let t = 0; return () => (t += 10); })(), env: { PATH: 'p' },
    exists: () => exists, nodePath: 'node',
  };
  return { deps, calls, bodies, keys: () => calls.map((c) => c.key) };
}
const HAPPY = {
  agy: { stdout: AGY_OK },
  'git status': { stdout: ' M server/lib/a.js\0?? docs/new.md\0' },
  'git rev-parse': { stdout: 'abc123\n' },
  'gh pr create': { stdout: 'Creating pull request...\nhttps://github.com/o/r/pull/42\n' },
  'gh pr list': { stdout: '[]\n' },
  tests: { stdout: 'affected-tests: 2 changed file(s) since origin/main; 1 of 9 test files affected\naffected-tests: node --test server/test/a.test.js\nok', status: 0 },
};

test('runVendorCard: happy path runs the fixed sequence and returns the PR url', async () => {
  const h = harness({ replies: HAPPY });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.deepEqual(h.keys(), ['agy models', 'agy', 'git status', 'graphify', 'tests', 'git add', 'git commit', 'git rev-parse', 'git push', 'gh pr list', 'gh pr create']);
  assert.equal(r.error, null);
  assert.deepEqual(r.changed, ['server/lib/a.js', 'docs/new.md']);
  assert.deepEqual(r.fence, { ok: true, violations: [] });
  assert.deepEqual(r.graph, { ran: true, status: 0 });
  assert.equal(r.tests.ran, true);
  assert.equal(r.tests.exitCode, 0);
  assert.equal(r.tests.selection, 'ran');
  assert.match(r.tests.tail, /ok$/);
  assert.equal(r.commit, 'abc123');
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(r.agent.sessionId, 'c-1');
  assert.equal(r.agent.text, 'OK\n');
  assert.deepEqual(r.agent.usage, { input: 8232, output: 116, total: 8348 });
  assert.equal(r.agent.authFailed, false);

  const byKey = (k) => h.calls.find((c) => c.key === k);
  assert.deepEqual(byKey('agy').args.slice(0, 2), ['--model', 'Gemini 4 Argon (High)']);
  assert.deepEqual(byKey('agy models').args, ['models']);
  assert.equal(r.agent.model, 'Gemini 4 Argon (High)');
  assert.deepEqual(byKey('git status').args, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.deepEqual(byKey('graphify').args, ['update', '.']);
  assert.deepEqual(byKey('tests').args, ['scripts/affected-tests.mjs', '--base', 'origin/glmps2/main']);
  assert.deepEqual(byKey('git add').args, ['add', '-A']);
  assert.deepEqual(byKey('git commit').args, ['commit', '-m', 'Fix the thing (card c1, gemini)']);
  assert.deepEqual(byKey('git push').args, ['push', 'origin', 'HEAD:refs/heads/card/c1']);
  assert.ok(!h.calls.some((c) => c.args.some((a) => /force|^-f$|\+HEAD/.test(a))));
  assert.deepEqual(byKey('gh pr create').args, ['pr', 'create', '--base', 'glmps2/main', '--head', 'card/c1', '--title', 'Fix the thing (card c1)', '--body-file', 'C:\\tmp\\body.md']);
  assert.match(h.bodies[0], /OK/);
  assert.match(h.bodies[0], /gemini/);
  assert.ok(h.calls.every((c) => c.opts.cwd === RECIPE.cwd));
});

test('runVendorCard: the agent and tests run with the push fence, the push and PR run without it', async () => {
  const h = harness({ replies: HAPPY });
  await runVendorCard(RECIPE, h.deps);
  const env = (k) => h.calls.find((c) => c.key === k).opts.env;
  for (const k of ['agy', 'graphify', 'tests']) {
    assert.equal(env(k).GH_TOKEN, 'glmps-vendor-fence-no-github', k);
    assert.equal(env(k).GIT_CONFIG_VALUE_0, 'glmps-fence://push-blocked', k);
  }
  for (const k of ['git push', 'gh pr create', 'git commit']) {
    assert.equal(env(k).GH_TOKEN, undefined, k);
    assert.equal(env(k).GIT_CONFIG_COUNT, undefined, k);
  }
  assert.equal(h.calls.find((c) => c.key === 'agy').opts.timeoutMs, 60000);
});

test('runVendorCard: codex gets the prompt on stdin', async () => {
  const h = harness({ replies: { ...HAPPY, codex: { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' } } });
  const r = await runVendorCard({ ...RECIPE, vendor: 'gpt', model: 'gpt-5' }, h.deps);
  const c = h.calls[0];
  assert.equal(c.key, 'codex');
  assert.equal(c.opts.stdin, 'PROMPT');
  assert.equal(r.agent.text, 'done');
  assert.match(h.calls.find((x) => x.key === 'git commit').args[2], /\(card c1, gpt\)$/);
});

test('runVendorCard: a fence breach stops before add, commit and push', async () => {
  const h = harness({ replies: { ...HAPPY, 'git status': { stdout: ' M server/lib/a.js\0 M CLAUDE.md\0?? .env\0' } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.deepEqual(h.keys(), ['agy models', 'agy', 'git status']);
  assert.equal(r.fence.ok, false);
  assert.deepEqual(r.fence.violations, ['CLAUDE.md', '.env']);
  assert.equal(r.commit, null);
  assert.equal(r.prUrl, null);
  assert.ok(r.error);
});

test('runVendorCard: an auth failure makes no git call', async () => {
  const out = '{"type":"error","message":"Your access token could not be refreshed. Please log out and sign in again."}';
  const h = harness({ replies: { codex: { stdout: out, status: 1 } } });
  const r = await runVendorCard({ ...RECIPE, vendor: 'gpt' }, h.deps);
  assert.deepEqual(h.keys(), ['codex']);
  assert.equal(r.agent.authFailed, true);
  assert.ok(r.error);
  assert.equal(r.prUrl, null);
});

test('runVendorCard: red tests commit nothing, push nothing and open no PR', async () => {
  const h = harness({ replies: { ...HAPPY, tests: { status: 1, stdout: 'not ok 1' } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.deepEqual(h.keys(), ['agy models', 'agy', 'git status', 'graphify', 'tests']);
  assert.equal(r.tests.exitCode, 1);
  assert.match(r.tests.tail, /not ok 1/);
  assert.equal(r.prUrl, null);
  assert.equal(r.commit, null);
});

test('runVendorCard: no graphify binary, no affected-tests script and no code change skip those steps', async () => {
  const noGraph = harness({ replies: HAPPY, binaries: { agy: BIN.agy }, exists: false });
  const r = await runVendorCard(RECIPE, noGraph.deps);
  assert.deepEqual(noGraph.keys(), ['agy models', 'agy', 'git status', 'git add', 'git commit', 'git rev-parse', 'git push', 'gh pr list', 'gh pr create']);
  assert.deepEqual(r.graph, { ran: false, status: null });
  assert.equal(r.tests.ran, false);
  const docs = harness({ replies: { ...HAPPY, 'git status': { stdout: '?? docs/x.md\0' } } });
  await runVendorCard(RECIPE, docs.deps);
  assert.ok(!docs.keys().includes('graphify'));
});

test('runVendorCard: the graph is refreshed only in a repo that already keeps one', async () => {
  const kept = harness({ replies: HAPPY });
  kept.deps.exists = (p) => /graphify-out[\\/]graph\.json$/.test(p) || /affected-tests\.mjs$/.test(p);
  await runVendorCard(RECIPE, kept.deps);
  assert.ok(kept.keys().includes('graphify'));
  const none = harness({ replies: HAPPY });
  none.deps.exists = (p) => /affected-tests.mjs$/.test(p);
  const r = await runVendorCard(RECIPE, none.deps);
  assert.ok(!none.keys().includes('graphify'));
  assert.equal(r.graph.ran, false);
});

test('runVendorCard: nothing changed returns without commit or PR', async () => {
  const h = harness({ replies: { ...HAPPY, 'git status': { stdout: '' } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.deepEqual(h.keys(), ['agy models', 'agy', 'git status', 'git rev-list']);
  assert.deepEqual(h.calls.find((c) => c.key === 'git rev-list').args, ['rev-list', 'HEAD', '--not', '--remotes=origin']);
  assert.deepEqual(r.changed, []);
  assert.equal(r.error, null);
  assert.equal(r.prUrl, null);
});

// Card glmps-2-0-180: a round that committed and then failed to push leaves a
// clean tree; the next round must ship that commit, not call it nothing new.
const HELD_BACK = { ...HAPPY, 'git status': { stdout: '' }, 'git rev-list': { stdout: 'c2\nc1\n' }, 'git log': { stdout: 'server/lib/a.js\0server/test/a.test.js\0' }, 'git rev-parse': { stdout: 'c2\n' } };

test('runVendorCard: a clean tree with an unpushed commit pushes it and opens the PR, without rerunning the tests', async () => {
  const h = harness({ replies: HELD_BACK });
  const r = await runVendorCard({ ...RECIPE, finishOnly: true, agentText: '' }, h.deps);
  assert.deepEqual(h.keys(), ['git status', 'git rev-list', 'git log', 'git rev-parse', 'git push', 'gh pr list', 'gh pr create']);
  assert.deepEqual(h.calls.find((c) => c.key === 'git log').args, ['log', '--format=', '--name-only', '-z', '--cc', 'HEAD', '--not', '--remotes=origin']);
  assert.equal(r.error, null);
  assert.deepEqual(r.changed, ['server/lib/a.js', 'server/test/a.test.js']);
  assert.equal(r.unpushedCommits, 2);
  assert.equal(r.tests.ran, false);
  assert.match(r.tests.skipped, /never reached origin/);
  assert.equal(r.commit, 'c2');
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/42');
});

test('runVendorCard: an unpushed commit that touches fenced files is not pushed', async () => {
  const h = harness({ replies: { ...HELD_BACK, 'git log': { stdout: 'server/lib/a.js\0CLAUDE.md\0' } } });
  const r = await runVendorCard({ ...RECIPE, finishOnly: true, agentText: '' }, h.deps);
  assert.deepEqual(h.keys(), ['git status', 'git rev-list', 'git log']);
  assert.equal(r.fence.ok, false);
  assert.deepEqual(r.fence.violations, ['CLAUDE.md']);
  assert.equal(r.prUrl, null);
  assert.ok(r.error);
});

// Card glmps-2-0-184: with main merged into the branch, the oldest unpushed
// commit's parent sits below the merge base, so diffing from it listed main's
// fenced CLAUDE.md change as the branch's own and blocked a clean push.
test('runVendorCard: a merge of the base in the unpushed range lists only the branch files (real git)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-heldback-'));
  try {
    const sh = (cwd, args, env = {}) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const at = (n) => ({ GIT_AUTHOR_DATE: `2026-01-0${n}T00:00:00Z`, GIT_COMMITTER_DATE: `2026-01-0${n}T00:00:00Z` });
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
    const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
    const origin = path.join(root, 'origin.git');
    const wt = path.join(root, 'wt');
    const other = path.join(root, 'other');
    sh(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    sh(root, ['clone', '-q', origin, wt]);
    put(wt, 'README.md', 'a\n');
    sh(wt, ['add', '-A']); sh(wt, [...id, 'commit', '-q', '-m', 'base'], at(1));
    sh(wt, ['push', '-q', 'origin', 'HEAD:main']);
    sh(wt, ['checkout', '-q', '-b', 'card/c1']);
    put(wt, 'server/lib/a.js', 'x\n');
    sh(wt, ['add', '-A']); sh(wt, [...id, 'commit', '-q', '-m', 'branch work'], at(2));
    sh(root, ['clone', '-q', origin, other]);
    put(other, 'CLAUDE.md', 'rules\n');
    sh(other, ['add', '-A']); sh(other, [...id, 'commit', '-q', '-m', 'main moves'], at(3));
    sh(other, ['push', '-q', 'origin', 'HEAD:main']);
    sh(wt, ['fetch', '-q', 'origin']);
    sh(wt, [...id, 'merge', '-q', '--no-edit', 'origin/main'], at(4));

    const h = harness({ replies: { ...HAPPY, 'git push': { status: 0 } } });
    const fakeRun = h.deps.run;
    h.deps.run = async (file, args, opts) => {
      if (file === 'git' && ['status', 'rev-list', 'log', 'rev-parse'].includes(args[0])) {
        await fakeRun(file, args, opts);
        const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', windowsHide: true });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
      }
      return fakeRun(file, args, opts);
    };
    const r = await runVendorCard({ ...RECIPE, cwd: wt, base: 'main', finishOnly: true, agentText: '' }, h.deps);
    assert.equal(r.error, null);
    assert.deepEqual(r.changed, ['server/lib/a.js']);
    assert.equal(r.unpushedCommits, 2);
    assert.ok(h.keys().includes('git push'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Card glmps-2-0-188: an earlier commit on the branch that already reached
// origin is not part of what this round pushes, so its fenced file must not
// refuse a clean later commit.
test('runVendorCard: a commit already pushed to the branch is not fence-checked again (real git)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-pushed-'));
  try {
    const sh = (cwd, args, env = {}) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
    const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
    const origin = path.join(root, 'origin.git');
    const wt = path.join(root, 'wt');
    sh(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    sh(root, ['clone', '-q', origin, wt]);
    put(wt, 'README.md', 'a\n');
    sh(wt, ['add', '-A']); sh(wt, [...id, 'commit', '-q', '-m', 'base']);
    sh(wt, ['push', '-q', 'origin', 'HEAD:main']);
    sh(wt, ['checkout', '-q', '-b', 'card/c1']);
    put(wt, 'CLAUDE.md', 'operator rules\n');
    sh(wt, ['add', '-A']); sh(wt, [...id, 'commit', '-q', '-m', 'operator edit, pushed']);
    sh(wt, ['push', '-q', 'origin', 'HEAD:refs/heads/card/c1']);
    put(wt, 'server/lib/b.js', 'y\n');
    sh(wt, ['add', '-A']); sh(wt, [...id, 'commit', '-q', '-m', 'clean work, not pushed']);

    const h = harness({ replies: { ...HAPPY, 'git push': { status: 0 } } });
    const fakeRun = h.deps.run;
    h.deps.run = async (file, args, opts) => {
      if (file === 'git' && ['status', 'rev-list', 'log', 'rev-parse'].includes(args[0])) {
        await fakeRun(file, args, opts);
        const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', windowsHide: true });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
      }
      return fakeRun(file, args, opts);
    };
    const r = await runVendorCard({ ...RECIPE, cwd: wt, base: 'main', finishOnly: true, agentText: '' }, h.deps);
    assert.equal(r.error, null);
    assert.deepEqual(r.changed, ['server/lib/b.js']);
    assert.equal(r.unpushedCommits, 1);
    assert.ok(h.keys().includes('git push'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runVendorCard: an unreadable unpushed commit is reported, not pushed', async () => {
  const h = harness({ replies: { ...HELD_BACK, 'git log': { status: 128, stderr: 'bad revision' } } });
  const r = await runVendorCard({ ...RECIPE, finishOnly: true, agentText: '' }, h.deps);
  assert.ok(!h.keys().includes('git push'));
  assert.match(r.error, /git log failed: bad revision/);
});

test('runVendorCard: a missing CLI, an unreadable prompt, a timeout and a failed push are reported, not thrown', async () => {
  const missing = harness({ replies: HAPPY, binaries: {} });
  const m = await runVendorCard(RECIPE, missing.deps);
  assert.match(m.error, /agy CLI was not found/);
  assert.equal(m.agent.authFailed, false);
  assert.equal(missing.calls.length, 0);

  const noPrompt = harness({ replies: HAPPY, prompt: { ok: false, reason: 'gone' } });
  assert.match((await runVendorCard(RECIPE, noPrompt.deps)).error, /gone/);

  const slow = harness({ replies: { agy: { status: -1, timedOut: true } } });
  const t = await runVendorCard(RECIPE, slow.deps);
  assert.equal(t.agent.timedOut, true);
  assert.match(t.error, /timed out/);
  assert.deepEqual(slow.keys(), ['agy models', 'agy']);

  const bad = harness({ replies: { ...HAPPY, 'git push': { status: 1, stderr: 'rejected' } } });
  const p = await runVendorCard(RECIPE, bad.deps);
  assert.match(p.error, /git push failed/);
  assert.equal(p.commit, 'abc123');
  assert.equal(p.prUrl, null);
  assert.ok(!bad.keys().includes('gh pr create'));
});

// AC-6: the agent worked in its Antigravity tab; the desktop app only verifies and ships.
test('runVendorCard: finishOnly skips the agent and the prompt, then runs the same sequence', async () => {
  const h = harness({ replies: HAPPY, prompt: { ok: false, reason: 'must not be read' } });
  const r = await runVendorCard({ ...RECIPE, finishOnly: true, agentText: 'Fixed it. AC-1 met.' }, h.deps);
  assert.deepEqual(h.keys(), ['git status', 'graphify', 'tests', 'git add', 'git commit', 'git rev-parse', 'git push', 'gh pr list', 'gh pr create']);
  assert.equal(r.error, null);
  assert.equal(r.agent.text, 'Fixed it. AC-1 met.');
  assert.equal(r.agent.usage, null);
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/42');
  assert.match(h.bodies[0], /Fixed it/);
  assert.equal(h.calls.find((c) => c.key === 'tests').opts.env.GH_TOKEN, 'glmps-vendor-fence-no-github');
});

test('runVendorCard: finishOnly still refuses a fence breach', async () => {
  const h = harness({ replies: { ...HAPPY, 'git status': { stdout: '?? .env\0' } } });
  const r = await runVendorCard({ ...RECIPE, finishOnly: true, agentText: '' }, h.deps);
  assert.equal(r.fence.ok, false);
  assert.ok(!h.keys().includes('git push'));
});

test('interactiveVendorArgs: agy -i with the model first and the sandbox on, codex in workspace-write, grok has none', () => {
  assert.deepEqual(interactiveVendorArgs({ vendor: 'gemini', cwd: 'C:\\wt\\p\\c', instruction: 'GO' }),
    { file: 'agy', args: ['--model', 'Gemini 4 Argon (High)', '--sandbox', '-i', 'GO'] });
  assert.deepEqual(interactiveVendorArgs({ vendor: 'gpt', model: 'gpt-5', cwd: 'C:\\wt\\p\\c', instruction: 'GO' }),
    { file: 'codex', args: ['--sandbox', 'workspace-write', '-C', 'C:\\wt\\p\\c', '-m', 'gpt-5', 'GO'] });
  assert.equal(interactiveVendorArgs({ vendor: 'grok', cwd: 'c', instruction: 'GO' }), null);
  assert.equal(interactiveVendorArgs({ vendor: 'claude', cwd: 'c', instruction: 'GO' }), null);
});

const AGY_MODELS_OUT = [
  'Fetching available models...',
  'gemini-5-boron-high\tGemini 5 Boron (High)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  '',
].join('\r\n');

test('parseAgyModels: the display names from agy models, header and junk lines dropped', () => {
  assert.deepEqual(parseAgyModels(AGY_MODELS_OUT), ['Gemini 5 Boron (High)', 'Gemini 4 Argon (High)', 'Gemini 3.8 Flash (High)', 'Claude Opus 5.5 (High)']);
  assert.deepEqual(parseAgyModels(''), []);
  assert.deepEqual(parseAgyModels(null), []);
});

test('chooseAgyModel: no model runs the newest listed; a listed model is kept; a retired one is refused naming the newest; no list falls back', () => {
  const live = parseAgyModels(AGY_MODELS_OUT);
  assert.deepEqual(chooseAgyModel(null, live), { model: 'Gemini 5 Boron (High)' });
  assert.deepEqual(chooseAgyModel('Gemini 3.8 Flash (High)', live), { model: 'Gemini 3.8 Flash (High)' });
  const bad = chooseAgyModel('Gemini 3.5 Flash (High)', live);
  assert.equal(bad.model, undefined);
  assert.ok(bad.error.includes('"Gemini 3.5 Flash (High)"'), bad.error);
  assert.ok(bad.error.includes('"Gemini 5 Boron (High)"'), bad.error);
  assert.deepEqual(chooseAgyModel(null, []), { model: 'Gemini 4 Argon (High)' });
  assert.deepEqual(chooseAgyModel('Gemini 3.8 Flash (Low)', null), { model: 'Gemini 3.8 Flash (Low)' });
});

test('runVendorCard: a Gemini card with no model runs on the newest model agy lists right now', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { stdout: AGY_MODELS_OUT } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.equal(r.error, null);
  assert.deepEqual(h.calls.find((c) => c.key === 'agy').args.slice(0, 2), ['--model', 'Gemini 5 Boron (High)']);
  assert.equal(r.agent.model, 'Gemini 5 Boron (High)');
});

test('runVendorCard: a model agy no longer lists fails before the agent runs, naming the newest', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { stdout: AGY_MODELS_OUT } } });
  const r = await runVendorCard({ ...RECIPE, model: 'Gemini 3.5 Flash (High)' }, h.deps);
  assert.ok(r.error.includes('no longer lists the model "Gemini 3.5 Flash (High)"'), r.error);
  assert.ok(r.error.includes('"Gemini 5 Boron (High)"'), r.error);
  assert.deepEqual(h.keys(), ['agy models']);
});

test('runVendorCard: an agy models failure keeps the run going on the pinned newest', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { status: 1, stderr: 'boom' } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.equal(r.error, null);
  assert.equal(h.calls.find((c) => c.key === 'agy').args[1], 'Gemini 4 Argon (High)');
});

// The real agy 1.5.2 reply when the account's quota for a model ran out (2026-11-07).
const AGY_QUOTA = {
  status: 3,
  stdout: '{"conversation_id":"61aa716b","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 147h2m53s.","duration_seconds":1887.3,"num_turns":1,"finished_reason":"error"}',
  stderr: 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 147h2m53s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429}',
};
const LIVE = ['gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-medium\tGemini 4 Argon (Medium)', 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'claude-opus-5-5-high\tClaude Opus 5.5 (High)'].join('\n');
const agySequence = (...replies) => { let i = 0; return () => replies[Math.min(i++, replies.length - 1)]; };

test('parseAgentOutput: a quota error is recognised from the agy reply, and a success is not', () => {
  assert.equal(parseAgentOutput('gemini', AGY_QUOTA.stdout, AGY_QUOTA.stderr).quotaExhausted, true);
  assert.equal(parseAgentOutput('gemini', AGY_QUOTA.stdout, '').quotaExhausted, true);
  assert.equal(parseAgentOutput('gemini', AGY_OK, '').quotaExhausted, false);
});

test('nextAgyModel: the newest Gemini from another family, same tier first; null when none is left', () => {
  const live = parseAgyModels(LIVE);
  assert.equal(nextAgyModel('Gemini 4 Argon (High)', live), 'Gemini 3.8 Flash (High)');
  assert.equal(nextAgyModel('Gemini 4 Argon (Low)', live), 'Gemini 3.8 Flash (High)');
  assert.equal(nextAgyModel('Gemini 3.8 Flash (High)', live), 'Gemini 4 Argon (High)');
  assert.equal(nextAgyModel('Gemini 4 Argon (High)', ['Gemini 4 Argon (High)', 'Gemini 4 Argon (Medium)']), null);
});

test('runVendorCard: a card with no model that hits a quota reruns once on the next-newest Gemini', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { stdout: LIVE }, agy: agySequence(AGY_QUOTA, HAPPY.agy) } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.equal(r.error, null);
  const runs = h.calls.filter((c) => c.key === 'agy');
  assert.deepEqual(runs.map((c) => c.args[1]), ['Gemini 4 Argon (High)', 'Gemini 3.8 Flash (High)']);
  assert.equal(r.agent.model, 'Gemini 3.8 Flash (High)');
  assert.equal(r.agent.fallbackFrom, 'Gemini 4 Argon (High)');
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/42');
});

test('runVendorCard: a card that names its model fails on a quota, saying so, with no second run', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { stdout: LIVE }, agy: AGY_QUOTA } });
  const r = await runVendorCard({ ...RECIPE, model: 'Gemini 4 Argon (High)' }, h.deps);
  assert.match(r.error, /quota/);
  assert.ok(r.error.includes('"Gemini 4 Argon (High)"'), r.error);
  assert.equal(h.calls.filter((c) => c.key === 'agy').length, 1);
  assert.ok(!h.keys().includes('git push'));
});

test('runVendorCard: a quota with no other Gemini listed fails, saying so, and pushes nothing', async () => {
  const h = harness({ replies: { ...HAPPY, 'agy models': { stdout: 'gemini-4-argon-high\tGemini 4 Argon (High)' }, agy: AGY_QUOTA } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.match(r.error, /quota/);
  assert.match(r.error, /no other Gemini/);
  assert.equal(h.calls.filter((c) => c.key === 'agy').length, 1);
  assert.ok(!h.keys().includes('git push'));
});

// F1 (card glmps-2-0-172): an explicit-URL push ignores remote.origin.pushurl,
// so the fence must also keep git from reaching a stored login. This asks a
// real git for credentials through a helper that would hand one out.
test('fencedAgentEnv: a real git asking for an https credential gets none from a configured helper', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-fence-'));
  try {
    const cfg = path.join(dir, 'gitconfig');
    fs.writeFileSync(cfg, '[credential]\n\thelper = "!f() { echo username=u; echo password=fence-test-secret; }; f"\n');
    const base = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const ask = (env) => spawnSync('git', ['credential', 'fill'], { cwd: dir, env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.match(ask(base).stdout, /fence-test-secret/, 'the helper hands out its secret without the fence');
    const fenced = ask(fencedAgentEnv(base));
    assert.doesNotMatch(fenced.stdout, /fence-test-secret/);
    assert.notEqual(fenced.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runVendorCard: a change to the test harness is not run unsandboxed and is reported as skipped', async () => {
  for (const f of ['package.json', 'package-lock.json', 'test.env', 'scripts/affected-tests.mjs', 'server/lib/orchestration/affected-tests.js']) {
    const h = harness({ replies: { ...HAPPY, 'git status': { stdout: ` M ${f}\0 M server/lib/a.js\0` } } });
    const r = await runVendorCard(RECIPE, h.deps);
    assert.ok(!h.keys().includes('tests'), f);
    assert.equal(r.tests.ran, false, f);
    assert.match(r.tests.skipped, /test harness/, f);
    assert.ok(r.tests.skipped.includes(f), f);
    assert.equal(r.prUrl, 'https://github.com/o/r/pull/42', f);
  }
});

test('runVendorCard: the tests record what the selection actually ran', async () => {
  const cases = [
    ['affected-tests: 1 changed file(s) since origin/main; 0 of 9 test files affected\naffected-tests: nothing to run\n', 'none'],
    ['affected-tests: 1 changed file(s) since origin/main; full suite needed (package.json)\naffected-tests: the merge queue and the batched run on the base cover the full suite; run with --full only if you must.\n', 'full'],
    ['ok\n', null],
  ];
  for (const [stdout, selection] of cases) {
    const h = harness({ replies: { ...HAPPY, tests: { stdout, status: 0 } } });
    const r = await runVendorCard(RECIPE, h.deps);
    assert.equal(r.tests.ran, true);
    assert.equal(r.tests.selection, selection, stdout);
  }
});

// F3: a rerun reuses the branch's open PR instead of failing gh pr create.
test('runVendorCard: a second run on a branch with an open PR reuses it and opens no new one', async () => {
  const h = harness({ replies: { ...HAPPY, 'gh pr list': { stdout: '[{"url":"https://github.com/o/r/pull/7"}]\n' } } });
  const r = await runVendorCard(RECIPE, h.deps);
  assert.equal(r.error, null);
  assert.equal(r.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(r.prReused, true);
  assert.ok(!h.keys().includes('gh pr create'));
  const list = h.calls.find((c) => c.key === 'gh pr list');
  assert.deepEqual(list.args, ['pr', 'list', '--head', 'card/c1', '--state', 'open', '--json', 'url', '--limit', '1']);
  assert.equal(list.opts.env.GH_TOKEN, undefined);
  const fresh = harness({ replies: { ...HAPPY, 'gh pr list': { status: 1, stderr: 'boom' } } });
  const f = await runVendorCard(RECIPE, fresh.deps);
  assert.equal(f.prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(f.prReused, false);
});

// server/test/huddle-researcher.test.js
// Howard's two-step lookup (AC-17). Nothing here starts a real claude: every
// test hands createResearcher a fake spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webStepArgs, repoStepArgs, createResearcher, STEP_TIMEOUT_MS, OUTSIDE_LABEL } from '../lib/huddle/researcher.js';

const FORBIDDEN = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'PowerShell', 'Task', 'Agent'];
const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

test('step 1 argv: exactly WebSearch and WebFetch, no MCP, dontAsk, no settings, no budget cap', () => {
  const a = webStepArgs({ model: 'sonnet', sysFile: '/tmp/s.txt', platform: 'linux' });
  assert.equal(flag(a, '--tools'), 'WebSearch,WebFetch');
  assert.equal(flag(a, '--allowedTools'), 'WebSearch,WebFetch');
  assert.equal(flag(a, '--disallowedTools'), 'mcp__*');
  assert.equal(flag(a, '--permission-mode'), 'dontAsk');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('--setting-sources='));
  assert.ok(a.includes('--no-session-persistence'));
  assert.equal(flag(a, '--system-prompt-file'), '/tmp/s.txt');
  for (const bad of [...FORBIDDEN, 'Read', 'Grep', 'Glob']) assert.ok(!a.join(' ').includes(bad), `${bad} must not appear in step 1`);
  for (const bad of ['--max-budget-usd', '--max-turns', '--add-dir', '--mcp-config']) assert.ok(!a.includes(bad), bad);
});

test('step 2 argv: exactly Read, Grep and Glob, no web, no MCP, secrets denied', () => {
  const a = repoStepArgs({ model: 'sonnet', sysFile: '/tmp/s.txt', platform: 'linux' });
  assert.equal(flag(a, '--tools'), 'Read,Grep,Glob');
  // A bare Read/Grep/Glob allow approves any path and lifts dontAsk's
  // working-directory limit, so step 2 must carry no allow at all.
  assert.ok(!a.includes('--allowedTools'), 'step 2 must not pre-approve its tools');
  assert.match(flag(a, '--disallowedTools'), /^mcp__\*,/);
  assert.match(flag(a, '--disallowedTools'), /Read\(\*\*\/\.env\*\)/);
  for (const p of ['Read(**/*.env)', 'Read(**/config.json*)', 'Read(**/*token*)', 'Read(**/*secret*)', 'Read(**/credentials*)', 'Read(**/oauth*)', 'Read(~/.claude/**)', 'Read(~/.ssh/**)', 'Read(~/.gemini/**)', 'Read(//**/.env*)', 'Read(//**/*token*)', 'Read(//**/.credentials*)', 'Read(//**/id_rsa*)']) assert.ok(flag(a, '--disallowedTools').split(',').includes(p), `${p} must be denied`);
  assert.equal(flag(a, '--permission-mode'), 'dontAsk');
  assert.ok(a.includes('--strict-mcp-config'));
  for (const bad of [...FORBIDDEN, 'WebSearch', 'WebFetch', '--max-budget-usd', '--add-dir']) assert.ok(!a.join(' ').replace(flag(a, '--disallowedTools'), '').includes(bad), `${bad} must not appear in step 2`);
});

test('on win32 the shell-bound values are quoted', () => {
  const a = webStepArgs({ model: 'sonnet', sysFile: 'C:\\t m\\s.txt', platform: 'win32' });
  assert.equal(flag(a, '--system-prompt-file'), '"C:\\t m\\s.txt"');
  assert.equal(flag(a, '--disallowedTools'), '"mcp__*"');
});

// A fake claude child: answers with `reply` (a result string) on stdin end.
function fakeSpawn({ replies, hang = false, record = [] } = {}) {
  let n = 0;
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4000 + n;
    let prompt = '';
    child.stdin = Object.assign(new EventEmitter(), {
      end(p) {
        prompt = String(p ?? '');
        record.push({ cmd, args, cwd: opts.cwd, env: opts.env, prompt, sys: fs.readFileSync(flag(args, '--system-prompt-file').replace(/"/g, ''), 'utf8'), cwdExisted: fs.existsSync(opts.cwd) });
        if (hang) return;
        const reply = replies[n++];
        setImmediate(() => {
          child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: Boolean(reply?.error), result: reply?.error ?? reply }));
          child.emit('close', reply?.error ? 1 : 0);
        });
      },
    });
    return child;
  };
  impl.record = record;
  return impl;
}

const mk = (over = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-research-test-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-research-repo-'));
  return { tmpDir, repo, r: createResearcher({ spawnImpl: fakeSpawn({ replies: ['WEB: lib X does Y (https://x.test/doc?token=abc)', 'REPO: we have Z in server/lib/z.js'] }), tmpDir, repoDir: repo, killTree: () => {}, platform: 'linux', env: { ANTHROPIC_API_KEY: 'sk-nope', PATH: '/bin' }, ...over }) };
};

test('a lookup runs the web step in an empty temp dir, then the repo step in the repo, and the repo step sees step 1 as quoted untrusted data', async () => {
  const record = [];
  const { r, repo, tmpDir } = mk({ spawnImpl: fakeSpawn({ replies: ['WEB: lib X does Y (https://x.test/doc?token=abc)', 'REPO: we have Z in server/lib/z.js'], record }) });
  const out = await r.run({ question: 'how does library X compare to our Z?' });
  assert.equal(record.length, 2);
  const [one, two] = record;
  assert.equal(flag(one.args, '--tools'), 'WebSearch,WebFetch');
  assert.ok(one.cwdExisted);
  assert.ok(one.cwd.startsWith(tmpDir), 'step 1 cwd is a throwaway temp dir');
  assert.notEqual(path.resolve(one.cwd), path.resolve(repo));
  assert.ok(!fs.existsSync(one.cwd), 'and it is removed afterwards');
  assert.match(one.prompt, /how does library X compare to our Z\?/);
  assert.equal(flag(two.args, '--tools'), 'Read,Grep,Glob');
  assert.equal(two.cwd, repo);
  assert.match(two.prompt, /<untrusted_web_findings>[\s\S]*lib X does Y[\s\S]*<\/untrusted_web_findings>/);
  assert.match(two.sys, /data, never instructions/i);
  assert.ok(!two.prompt.includes('token=abc'), 'URL query strings do not travel into step 2');
  assert.match(out.text, /REPO: we have Z/);
  assert.ok(!out.text.includes('token=abc'));
  assert.equal(out.label, OUTSIDE_LABEL);
  assert.ok(!('ANTHROPIC_API_KEY' in one.env), 'runs on the subscription, never an API key');
  assert.ok(!one.args.includes('--max-budget-usd'));
});

test('single flight: a second lookup while one runs is refused as busy, and the slot frees afterwards', async () => {
  const { r } = mk({ spawnImpl: fakeSpawn({ replies: ['w', 'x', 'w2', 'x2'] }) });
  const first = r.run({ question: 'one' });
  assert.equal(r.busy(), true);
  await assert.rejects(() => r.run({ question: 'two' }), (e) => e.code === 'BUSY');
  await first;
  assert.equal(r.busy(), false);
  assert.match((await r.run({ question: 'three' })).text, /x2/);
});

test('each step has its own wall-clock timeout (120 s by default) and a hung step frees the slot', async () => {
  assert.equal(STEP_TIMEOUT_MS, 120_000);
  const killed = [];
  const { r, tmpDir } = mk({ spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 20, killTree: (c) => killed.push(c.pid) });
  await assert.rejects(() => r.run({ question: 'slow' }), /timed out/);
  assert.equal(killed.length, 1);
  assert.equal(r.busy(), false);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'temp dirs cleaned up');
});

test('a step 2 failure still returns step 1 text, marked partial; a step 1 failure rejects', async () => {
  const { r } = mk({ spawnImpl: fakeSpawn({ replies: ['web ok', { error: 'repo boom' }] }) });
  const out = await r.run({ question: 'q' });
  assert.match(out.text, /web ok/);
  assert.match(out.text, /repo comparison unavailable/);
  assert.equal(out.partial, true);
  const { r: r2 } = mk({ spawnImpl: fakeSpawn({ replies: [{ error: 'web boom' }] }) });
  await assert.rejects(() => r2.run({ question: 'q' }), /web boom/);
});

test('an abort kills the child and rejects without posting', async () => {
  const killed = [];
  const { r } = mk({ spawnImpl: fakeSpawn({ hang: true }), killTree: (c) => killed.push(c.pid) });
  const ac = new AbortController();
  const p = r.run({ question: 'q', signal: ac.signal });
  setImmediate(() => ac.abort());
  await assert.rejects(() => p, (e) => e.name === 'AbortError');
  assert.equal(killed.length, 1);
  assert.equal(r.busy(), false);
});

test('the real claude is never started from a test process', async () => {
  const r = createResearcher({ repoDir: os.tmpdir() });
  await assert.rejects(() => r.run({ question: 'q' }), /test process|disabled/);
  assert.equal(r.busy(), false);
});

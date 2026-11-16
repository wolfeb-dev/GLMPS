// hooks/denial-feed.js: a PermissionDenied hook that puts every auto-mode
// denial on the owning card's devlog. Spawns the real script against a temp git
// repo and a stub board, so the stdin-JSON-in / HTTP-out contract is what is
// tested. Card 'glmps-2-0-48'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { denialLine, inputExcerpt } from '../lib/governance/denial-feed.js';

const hookScript = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'denial-feed.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function initRepo(dir, branch) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  git(['add', '.gitkeep']);
  git(['commit', '-q', '-m', 'init']);
  git(['checkout', '-q', '-b', branch]);
}

function startStubBoard() {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

// Held for the whole test so another test's port-0 server cannot take it; every
// connection is reset, which is the transport failure a dead board produces.
function startRefusingListener() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => { s.resetAndDestroy(); });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

function runHook(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

const baseEnv = (port) => ({
  ...process.env,
  GLMPS_PORT: String(port),
  GLMPS_BOARD_URL: undefined,
  GLMPS_CARD_ID: undefined,
});

const denial = (cwd, extra = {}) => ({
  session_id: 's1', cwd, hook_event_name: 'PermissionDenied', permission_mode: 'auto',
  tool_name: 'Bash', tool_input: { command: 'gh pr merge 22 --squash' }, tool_use_id: 'tu1',
  reason: '[Merge Without Review]', ...extra,
});

test('denialLine names the reason, the tool and the input', () => {
  assert.equal(
    denialLine({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, reason: '[Irreversible Local Destruction]' }),
    'Blocked by auto mode: [Irreversible Local Destruction] on Bash: git push origin main',
  );
});

test('inputExcerpt prefers command, then file_path, then the JSON, capped at 200 chars', () => {
  assert.equal(inputExcerpt({ command: 'ls', file_path: '/x' }), 'ls');
  assert.equal(inputExcerpt({ file_path: 'D:/a/b.js', content: 'zzz' }), 'D:/a/b.js');
  assert.equal(inputExcerpt({ pattern: 'foo' }), '{"pattern":"foo"}');
  assert.equal(inputExcerpt({ command: 'x'.repeat(500) }).length, 200);
  assert.equal(inputExcerpt(undefined), '');
});

test('hook: a runner session denial lands on its card devlog with tool, reason and a 200-char excerpt', async () => {
  const repo = tmp('mc-denial-repo-');
  const stub = await startStubBoard();
  try {
    initRepo(repo, 'glmps-runner/glmps-2.0/glmps-2-0-48');
    const long = `gh pr merge 22 --squash ${'y'.repeat(400)}`;
    const { code, stdout } = await runHook(baseEnv(stub.port), denial(repo, { tool_input: { command: long } }));
    assert.equal(code, 0);
    assert.equal(stdout, '', 'the hook never writes retry or any other decision');
    assert.equal(stub.calls.length, 1);
    const c = stub.calls[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, '/api/backlog/glmps-2-0-48/devlog');
    assert.equal(c.body.by, 'denial-feed');
    assert.equal(c.body.text, `Blocked by auto mode: [Merge Without Review] on Bash: ${long.slice(0, 200)}`);
  } finally {
    await stub.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hook: a session with no card posts nothing and exits 0 silently', async () => {
  const repo = tmp('mc-denial-nocard-');
  const stub = await startStubBoard();
  try {
    initRepo(repo, 'feat/not-a-runner-branch');
    const { code, stdout, stderr } = await runHook(baseEnv(stub.port), denial(repo));
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hook: GLMPS_CARD_ID names the card when the branch does not', async () => {
  const repo = tmp('mc-denial-envcard-');
  const stub = await startStubBoard();
  try {
    initRepo(repo, 'feat/x');
    await runHook({ ...baseEnv(stub.port), GLMPS_CARD_ID: 'mc-7' }, denial(repo, { tool_name: 'Write', tool_input: { file_path: 'D:/x/settings.json' }, reason: 'Auto mode could not evaluate this action' }));
    assert.equal(stub.calls[0].url, '/api/backlog/mc-7/devlog');
    assert.equal(stub.calls[0].body.text, 'Blocked by auto mode: Auto mode could not evaluate this action on Write: D:/x/settings.json');
  } finally {
    await stub.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hook: a board that is down is silent, exit 0, no output', async () => {
  const repo = tmp('mc-denial-down-');
  const dead = await startRefusingListener();
  try {
    initRepo(repo, 'glmps-runner/glmps-2.0/glmps-2-0-48');
    const { code, stdout, stderr } = await runHook(baseEnv(dead.port), denial(repo));
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  } finally {
    await dead.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hook: garbage stdin and a non-denial event exit 0 silently', async () => {
  const stub = await startStubBoard();
  try {
    const child = spawn(process.execPath, [hookScript], { env: baseEnv(stub.port), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = await new Promise((resolve) => {
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end('not json');
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, '');
    const other = await runHook(baseEnv(stub.port), { hook_event_name: 'PreToolUse', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(other.code, 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stub.close();
  }
});

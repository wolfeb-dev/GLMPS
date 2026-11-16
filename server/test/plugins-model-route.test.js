// Routes under test: server/lib/routes/plugins-routes.js
// D23 loop-plugins: POST /api/plugins/model/v1/chat/completions wiring.
// This exercises request parsing and error-status mapping. The server boots
// the route with the real `createChatCompletion(getModelConfig(cfg))` (no
// injected runImpl, per the brief's boot line), so a call that actually
// reached spawn would launch the real `claude` CLI. toClaudeCall validates
// `messages` synchronously before any spawn happens, so the 400 paths below
// prove the route is wired end to end without an external process; the
// VALID-body test further down proves the same for a request that clears
// that check, relying on runClaude's own NODE_TEST_CONTEXT guard
// (claude-model.js) rather than on this file happening to only send invalid
// bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function mkEnv() {
  const base = tmp('mc-model-route-');
  return {
    GLMPS_CLAUDE_DIR: path.join(base, 'claude'),
    GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(base, 'agy'),
    GLMPS_CODEX_DIR: path.join(base, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(base, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(base, 'opencode'),
  };
}

async function postRaw(url, rawBody) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody });
  return { status: r.status, body: await r.json() };
}

test('POST /api/plugins/model/v1/chat/completions: 400 when messages is missing', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, configFile: path.join(env.GLMPS_STATE_DIR, 'no-config.json') });
  try {
    const r = await postRaw(`http://127.0.0.1:${srv.port}/api/plugins/model/v1/chat/completions`, JSON.stringify({}));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'messages is required');
  } finally { await srv.close(); }
});

test('POST /api/plugins/model/v1/chat/completions: 400 on invalid JSON body', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, configFile: path.join(env.GLMPS_STATE_DIR, 'no-config.json') });
  try {
    const r = await postRaw(`http://127.0.0.1:${srv.port}/api/plugins/model/v1/chat/completions`, '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid json');
  } finally { await srv.close(); }
});

// mkEnv() above
// is exactly the pattern the re-review flagged - a hand-built env object
// that never spreads process.env, so test.env's suite-wide GLMPS_MODEL_RUNNER=
// off default (and any per-server override relying on it) never reaches
// this server's chatCompletion at all. Before the structural fix, a VALID
// body here would have cleared toClaudeCall's checks and reached the real
// runClaude, actually spawning `claude -p`. It is not appropriate to mock
// node:child_process.spawn to prove the negative directly: Node's built-in
// module exports are not reconfigurable (`t.mock.method` throws
// "Cannot redefine property: spawn" - confirmed while writing this test),
// so a fast rejection well under a real `claude -p` cold start is used as
// the same proxy server/test/model-runner-disabled.test.js already relies
// on for this exact claim. The exact message text runClaude rejects with
// depends on whether the invoking process itself carries GLMPS_MODEL_RUNNER=off
// in process.env (true when this file runs via `npm test`'s test.env, false
// when run bare via `node --test server/test/plugins-model-route.test.js`) -
// either is correct closed-by-default evidence, so this checks the shared
// "model runner disabled" prefix rather than pinning one exact wording.
test('POST /api/plugins/model/v1/chat/completions: a VALID body still gets 503 with no real spawn, even with a hand-built env (no process.env spread)', async () => {
  const env = mkEnv();
  const srv = await startServer({ port: 0, env, configFile: path.join(env.GLMPS_STATE_DIR, 'no-config.json') });
  try {
    const start = Date.now();
    const r = await postRaw(`http://127.0.0.1:${srv.port}/api/plugins/model/v1/chat/completions`, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    const elapsedMs = Date.now() - start;
    assert.equal(r.status, 503);
    assert.match(r.body.error, /model runner disabled/);
    assert.ok(elapsedMs < 1000, `expected a fast rejection (no real claude -p spawn), took ${elapsedMs}ms`);
  } finally { await srv.close(); }
});

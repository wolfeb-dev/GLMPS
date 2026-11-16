// Routes that parse their body without a guard of their own used to fall to the
// request handler's catch-all and answer 500 with the parser's message, where
// the guarded routes answer 400 invalid json (card glmps-2-0-220).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const ROUTES = [
  '/api/scut/park',
  '/api/approvals/request',
  '/api/approvals/run',
  '/api/runner/config',
  '/api/settings/timezone',
  '/api/learning/idea',
  '/api/graph/rebuild',
];

test('a malformed JSON body answers 400 invalid json on routes without their own guard', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-body-err-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    for (const route of ROUTES) {
      const r = await fetch(`http://127.0.0.1:${h.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ticket":' });
      const body = await r.json();
      assert.deepEqual([route, r.status, body.error], [route, 400, 'invalid json']);
    }
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

// Card glmps-2-0-224: only the request's own body earns 400 invalid json. A
// SyntaxError from anything else the route reads (a corrupt state file) is the
// server's fault and stays 500.
import { bodyErrorReply, rememberBodyText } from '../server.js';

test('bodyErrorReply blames the caller only when the request body itself is not JSON', () => {
  const syntax = () => { try { JSON.parse('{oops'); } catch (e) { return e; } };
  const bad = {}; rememberBodyText(bad, '{"ticket":');
  const good = {}; rememberBodyText(good, '{"ticket":"x"}');
  const empty = {}; rememberBodyText(empty, '');
  assert.deepEqual(bodyErrorReply(syntax(), bad), [400, { error: 'invalid json' }]);
  assert.equal(bodyErrorReply(syntax(), good)[0], 500, 'valid body, server-side parse failure');
  assert.equal(bodyErrorReply(syntax(), empty)[0], 500, 'an empty body, on a route that defaults it to {}');
  assert.equal(bodyErrorReply(syntax(), {})[0], 500, 'no body read at all');
  assert.equal(bodyErrorReply(syntax())[0], 500, 'no request');
  assert.deepEqual(bodyErrorReply(new Error('body too large'), good), [413, { error: 'body too large' }]);
});

// Card glmps-2-0-228: these routes have no defaults for an empty body, so an
// empty body is the caller's bad body there, not {}.
const BARE = [['PUT', '/api/file'], ['POST', '/api/file/undo'], ['POST', '/api/resume'], ['POST', '/api/terminal'], ['POST', '/api/open-in-editor']];

test('an empty or malformed body answers 400 invalid json on routes that parse it bare', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-body-bare-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    for (const [method, route] of BARE) {
      for (const body of ['', '{"path":']) {
        const r = await fetch(`http://127.0.0.1:${h.port}${route}`, { method, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body });
        const j = await r.json();
        assert.deepEqual([route, body, r.status, j.error], [route, body, 400, 'invalid json']);
      }
    }
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

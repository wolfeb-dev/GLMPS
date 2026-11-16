// server/test/api-wiki-ask.test.js - POST /api/wiki/ask (glmps-44).
// The backend probe is env-gated: agy availability comes from P.agyCliDir
// (GLMPS_AGY_CLI_DIR points at a nonexistent temp path here) and the Gemini key
// from the server's own env object (never process.env) - so these tests can
// exercise validation + the 503 no-backend path without ever calling an LLM.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { wikiPaths } from '../lib/observability/wiki-publish.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-ask-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects', 'D--test'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return {
    projectDir: tmp,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'),
           // Nonexistent on purpose: <agyCliDir>/conversations must not exist,
           // so agyAvailable-style probing is falsy in tests.
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
           GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'),
           GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'oc') },
  };
}

function seedWiki(projectDir) {
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'deadbeef', generatedAt: '2026-07-06T00:00:00Z', tierLlm: true,
    sections: [{ slug: 'server', title: 'Server', community: 1, llm: true, fileCount: 4,
                 searchText: 'server http routes sse' }],
  }));
  fs.writeFileSync(path.join(wikiDir, 'server.html'), '<html><body>The server serves SSE.</body></html>');
}

// /api/wiki/ask only answers for a project in the graph-root allowlist.
function registerAllowlistedRoot(claudeDir, root) {
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [root.replace(/\\/g, '/')] },
  }));
}

async function ask(port, body) {
  return fetch(`http://127.0.0.1:${port}/api/wiki/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let projectDir;
let env;
let srv;

before(async () => {
  ({ projectDir, env } = mkEnv());
  srv = await startServer({ port: 0, pollMs: 1000, env });
});

beforeEach(() => {
  delete env.GEMINI_API_KEY;
  fs.rmSync(wikiPaths(env.GLMPS_STATE_DIR).root, { recursive: true, force: true });
  fs.rmSync(path.join(env.GLMPS_AGY_CLI_DIR, 'conversations'), { recursive: true, force: true });
  fs.rmSync(path.join(projectDir, 'graphify-out'), { recursive: true, force: true });
});

after(async () => {
  await srv?.close();
});

test('POST /api/wiki/ask: 400 on a missing/empty question', async () => {
  for (const body of [{}, { question: '' }, { question: '   ' }, { question: 42 }]) {
    const res = await ask(srv.port, body);
    assert.equal(res.status, 400, `400 for ${JSON.stringify(body)}`);
    const j = await res.json();
    assert.match(j.error, /question/i);
  }
});

test('POST /api/wiki/ask: 400 on a question over 2000 chars', async () => {
  const res = await ask(srv.port, { question: 'q'.repeat(2001) });
  assert.equal(res.status, 400);
});

test('POST /api/wiki/ask: 400 on invalid json', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
  });
  assert.equal(res.status, 400);
});

test('POST /api/wiki/ask: 503 { error: "no llm backend" } when neither agy nor a key is available', async () => {
  seedWiki(projectDir);
  const res = await ask(srv.port, { question: 'how does the server work?' });
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.error, 'no llm backend');
});

test('POST /api/wiki/ask: 404 when the project has no generated wiki (backend present)', async () => {
  // A fake key makes a backend present so the request reaches the wiki check.
  // The 404 fires before any LLM call.
  env.GEMINI_API_KEY = 'fake-test-key'; // a backend is present; both answers come before any model call
  registerAllowlistedRoot(env.GLMPS_CLAUDE_DIR, projectDir);
  const res = await ask(srv.port, { question: 'anything?', project: projectDir });
  assert.equal(res.status, 404);
});

// readWikiState(project) throws when resolveWikiSource's
// repo-root branch hits a malformed current.json (readCurrentWiki, Task 3).
// No `project` in the body defaults to REPO_ROOT, the one root that reads
// through that branch, so this reaches the same leak fix rounds 1-2 closed
// at /wiki/* and GET /api/wiki -- here at POST /api/wiki/ask instead.
test('POST /api/wiki/ask on a malformed current.json answers with a generic error, never the path or "malformed" detail', async () => {
  env.GEMINI_API_KEY = 'fake-test-key'; // a backend is present; both answers come before any model call
  fs.mkdirSync(wikiPaths(env.GLMPS_STATE_DIR).root, { recursive: true });
  fs.writeFileSync(wikiPaths(env.GLMPS_STATE_DIR).current, '{ not valid json');
  const res = await ask(srv.port, { question: 'anything?' });
  const bodyText = await res.text();
  assert.doesNotMatch(bodyText, /malformed/);
  assert.doesNotMatch(bodyText, new RegExp(env.GLMPS_STATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(res.status, 500);
  const body = JSON.parse(bodyText);
  assert.equal(body.error, 'wiki build unavailable');
});

// resolveWikiSource(project).wikiDir used to be
// called a SECOND time at this route (server.js:5660, after readWikiState's
// own guarded call), unguarded -- a TOCTOU window where current.json is
// valid at the first read and malformed by the second leaks the absolute
// state-dir path straight into the HTTP response (the same class of leak
// "fix round 3" closed for the FIRST call only). readWikiState must resolve
// wikiDir ONCE and the route must reuse it, not re-read current.json; a real
// current.json read that would throw on any read past the first proves the
// redundant call is gone, not just caught.
test('POST /api/wiki/ask reads current.json exactly once per request: a second read never happens, so it can never leak (S1)', async () => {
  env.GEMINI_API_KEY = 'fake-test-key'; // agy stays unready; this backend path hits defaultCallModel(fetch), which we stub below
  const p = wikiPaths(env.GLMPS_STATE_DIR);
  fs.mkdirSync(p.builds, { recursive: true });
  const buildDir = path.join(p.builds, 'abc123456789-1');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'deadbeef', generatedAt: '2026-07-06T00:00:00Z',
    sections: [{ slug: 'server', title: 'Server', llm: true, searchText: 'server http routes sse' }],
  }));
  fs.writeFileSync(path.join(buildDir, 'server.html'), '<html><body>The server serves SSE.</body></html>');
  fs.writeFileSync(p.current, JSON.stringify({ build: 'abc123456789-1', builtAtCommit: 'deadbeef', sections: 1 }));

  const realReadFileSync = fs.readFileSync;
  const realFetch = globalThis.fetch;
  let currentReads = 0;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === p.current) {
      currentReads += 1;
      if (currentReads > 1) throw new Error(`wiki current.json is malformed: ${p.current}`);
    }
    return realReadFileSync(file, ...rest);
  };
  // Never let this test make a real network call to Gemini: any model call
  // the fixed code reaches (past the now-single current.json read) is
  // answered fast and locally, with no retry (a non-429 non-ok response).
  // The test's OWN fetch() calls to the local server must pass through
  // unchanged -- only the Gemini endpoint is stubbed.
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('generativelanguage.googleapis.com')) return { ok: false, status: 400, json: async () => ({}) };
    return realFetch(url, ...rest);
  };
  try {
    const res = await ask(srv.port, { question: 'how does the server work?' });
    const bodyText = await res.text();
    assert.equal(currentReads, 1, 'current.json must be read exactly once per request: no redundant second resolveWikiSource call');
    assert.doesNotMatch(bodyText, /malformed/);
    assert.doesNotMatch(bodyText, new RegExp(env.GLMPS_STATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.readFileSync = realReadFileSync;
    globalThis.fetch = realFetch;
  }
});

// readSectionHtml's containment check was
// the same path-STRING comparison R-M5 already fixed for /wiki/* -- a
// single safe slug (regex-checked) always passes syntactically even when
// the FILE it names is itself a symlink whose target lives outside wikiDir;
// fs.readFileSync follows it, and the content would be fed straight to the
// model. File symlinks need no special privilege on most hosts but DO on a
// locked-down Windows host without Developer Mode; skip with a named
// reason there rather than fail. globalThis.fetch is stubbed so a pre-fix
// run (which WOULD successfully read the secret file and attempt a real
// model call) never reaches a real network call either.
test('POST /api/wiki/ask refuses a symlinked section file, never feeding it to the model (M5)', async (t) => {
  env.GEMINI_API_KEY = 'fake-test-key';
  const p = wikiPaths(env.GLMPS_STATE_DIR);
  fs.mkdirSync(p.builds, { recursive: true });
  const buildDir = path.join(p.builds, 'abc123456789-1');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'deadbeef', generatedAt: '2026-07-06T00:00:00Z',
    sections: [{ slug: 'server', title: 'Server', llm: true, searchText: 'server http routes sse' }],
  }));
  const secretFile = path.join(os.tmpdir(), `mc-ask-secret-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(secretFile, 'TOP SECRET, never feed this to the model');
  try {
    fs.symlinkSync(secretFile, path.join(buildDir, 'server.html'), 'file');
  } catch (e) {
    fs.rmSync(secretFile, { force: true });
    t.skip(`file symlink creation not permitted on this host (${e.code}): skipping this case`);
    return;
  }
  fs.writeFileSync(p.current, JSON.stringify({ build: 'abc123456789-1', builtAtCommit: 'deadbeef', sections: 1 }));

  const realFetch = globalThis.fetch;
  // Capture the actual request body sent toward the model, not just the
  // HTTP response: the response body never echoes the section text back
  // verbatim (the model call itself fails in this stub), so asserting on
  // the response alone would pass even with the secret content successfully
  // read and transmitted. This is the actual harm the finding names.
  let sentToModel = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      sentToModel = opts?.body != null ? String(opts.body) : '';
      return { ok: false, status: 400, json: async () => ({}) };
    }
    return realFetch(url, opts);
  };
  try {
    const res = await ask(srv.port, { question: 'how does the server work?' });
    await res.text();
    assert.equal(sentToModel, null, 'the symlinked section must never be read at all: readSectionHtml must return null, so the model is never even called');
  } finally {
    fs.rmSync(secretFile, { force: true });
    globalThis.fetch = realFetch;
  }
});

// readSectionHtml's catch was bare
// (`catch { return null; }`) around BOTH realpathContained's own realpath()
// throw and the readFileSync call -- a non-ENOENT failure (EPERM, EACCES)
// vanished with no trace anywhere, unlike resolveWikiRequest's own
// equivalent catch, which already logs the code for
// anything that is not the expected ENOENT case.
test('POST /api/wiki/ask logs a non-ENOENT section-read failure, not a bare swallow (N7)', async () => {
  env.GEMINI_API_KEY = 'fake-test-key';
  const p = wikiPaths(env.GLMPS_STATE_DIR);
  fs.mkdirSync(p.builds, { recursive: true });
  const buildDir = path.join(p.builds, 'abc123456789-1');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'deadbeef', generatedAt: '2026-07-06T00:00:00Z',
    sections: [{ slug: 'server', title: 'Server', llm: true, searchText: 'server http routes sse' }],
  }));
  const sectionFile = path.join(buildDir, 'server.html');
  fs.writeFileSync(sectionFile, '<html><body>ok</body></html>');
  fs.writeFileSync(p.current, JSON.stringify({ build: 'abc123456789-1', builtAtCommit: 'deadbeef', sections: 1 }));

  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === sectionFile) {
      const e = new Error('EPERM: operation not permitted, open ' + sectionFile);
      e.code = 'EPERM';
      throw e;
    }
    return realReadFileSync(file, ...rest);
  };
  const realError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    const res = await ask(srv.port, { question: 'how does the server work?' });
    const bodyText = await res.text();
    assert.doesNotMatch(bodyText, /EPERM/, 'the raw fs error must never reach the client');
    assert.ok(logs.some((m) => /EPERM/.test(m)), `expected the non-ENOENT failure to be logged server-side, got: ${JSON.stringify(logs)}`);
  } finally {
    fs.readFileSync = realReadFileSync;
    console.error = realError;
  }
});

test('F8: an installed agy is NOT used for wiki questions unless wikiAsk.allowAgentBackend is set', async () => {
  fs.mkdirSync(path.join(env.GLMPS_AGY_CLI_DIR, 'conversations'), { recursive: true });
  const res = await ask(srv.port, { question: 'anything?' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'no llm backend');
});

test('F8: with wikiAsk.allowAgentBackend the operator opts agy back in (stops at the no-wiki 404, no spawn)', async () => {
  const { env: ownEnv } = mkEnv();
  fs.mkdirSync(path.join(ownEnv.GLMPS_AGY_CLI_DIR, 'conversations'), { recursive: true });
  const configFile = path.join(ownEnv.GLMPS_STATE_DIR + '-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ wikiAsk: { allowAgentBackend: true } }));
  const ownSrv = await startServer({ port: 0, pollMs: 1000, env: ownEnv, configFile });
  try {
    assert.equal((await ask(ownSrv.port, { question: 'anything?' })).status, 404);
  } finally { await ownSrv.close(); }
});

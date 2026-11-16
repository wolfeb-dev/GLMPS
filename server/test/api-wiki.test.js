// server/test/api-wiki.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { graphFingerprint } from '../lib/observability/graph-fingerprint.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects', 'D--test'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return {
    projectDir: tmp,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
           GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'),
           GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'oc') },
  };
}

function mkProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-proj-'));
  tmpDirs.push(dir);
  return dir;
}

let sharedEnv;
let srv;

before(async () => {
  ({ env: sharedEnv } = mkEnv());
  srv = await startServer({ port: 0, pollMs: 1000, env: sharedEnv });
});

after(async () => {
  await srv?.close();
});

test('GET /api/wiki returns manifest:null and empty sections when no wiki exists', async () => {
  const projectDir = mkProjectDir();
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki?project=${encodeURIComponent(projectDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.manifest, null);
  assert.deepEqual(body.sections, []);
  assert.equal(body.needsUpdate, false);
  // needsUpdate:false alone is exactly the ambiguity f7e0c0f removed on the
  // graph side: with no manifest there is no build marker, so freshness is
  // not knowable and the route must say so rather than let the UI infer
  // health from a missing flag. The route hand-picks its response fields, so
  // this pins that freshness is one of them.
  assert.equal(body.freshness, 'unknown');
});

test('GET /api/wiki surfaces another project\'s generated manifest with per-section stale flags and a /wiki-ext base', async () => {
  const projectDir = mkProjectDir();
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'deadbeef', generatedAt: '2026-07-02T00:00:00Z', tierLlm: true,
    sections: [{ slug: 'server', title: 'Server', community: 1, llm: true, fileCount: 4 }],
  }));
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki?project=${encodeURIComponent(projectDir)}`)).json();
  assert.ok(body.manifest, 'manifest loaded');
  assert.equal(body.base, `/wiki-ext/${encodeURIComponent(path.basename(projectDir))}`);
  assert.equal(body.sections.length, 1);
  assert.equal(body.sections[0].slug, 'server');
  assert.equal(typeof body.sections[0].stale, 'boolean');
});

test('POST /api/wiki/rebuild rejects a root outside the allowlist before spawning', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: 'x && calc.exe' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /allowlist/i);
});


function registerAllowlistedRoot(claudeDir, root) {
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [root.replace(/\\/g, '/')] },
  }));
}

test('GET /api/wiki maps a graphify-out/wiki manifest to a /wiki-ext/<project> base', async () => {
  const projectDir = mkProjectDir();
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: 'cafebabe', generatedAt: '2026-07-05T00:00:00Z', tierLlm: false,
    sections: [{ slug: 'core', title: 'Core', community: 0, llm: false, fileCount: 2 }],
  }));
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki?project=${encodeURIComponent(projectDir)}`);
  const body = await res.json();
  assert.ok(body.manifest, 'manifest loaded');
  assert.equal(body.base, `/wiki-ext/${encodeURIComponent(path.basename(projectDir))}`);
  assert.equal(body.sections[0].slug, 'core');
});

test('GET /wiki-ext/<project>/<slug>.html serves a generated page for an allowlisted project', async () => {
  const projectDir = mkProjectDir();
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'core.html'), '<html><body>hello core</body></html>');
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const key = encodeURIComponent(path.basename(projectDir));
  const res = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/${key}/core.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await res.text(), '<html><body>hello core</body></html>');
});

test('GET /wiki-ext/<project>/<slug>.html 404s for a project not in the graph allowlist', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/not-a-known-project-xyz/core.html`);
  assert.equal(res.status, 404);
});

test('GET /wiki-ext/<project>/<slug>.html 404s when the page file does not exist', async () => {
  const projectDir = mkProjectDir();
  fs.mkdirSync(path.join(projectDir, 'graphify-out', 'wiki'), { recursive: true });
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const key = encodeURIComponent(path.basename(projectDir));
  const res = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/${key}/missing.html`);
  assert.equal(res.status, 404);
});

test('GET /wiki-ext/<project>/<slug>.html rejects a slug with disallowed characters (400)', async () => {
  const projectDir = mkProjectDir();
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'core.html'), 'ok');
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const key = encodeURIComponent(path.basename(projectDir));
  const badSlug = encodeURIComponent('bad slug!.html');
  const res = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/${key}/${badSlug}`);
  assert.equal(res.status, 400);
});

test('GET /wiki-ext/<project>/<slug>.html rejects an encoded traversal attempt (400, never reaches the fs)', async () => {
  const projectDir = mkProjectDir();
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  // A file OUTSIDE the wiki dir the traversal attempt tries to reach.
  fs.writeFileSync(path.join(projectDir, 'graphify-out', 'secret.html'), 'do not serve me');
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const key = encodeURIComponent(path.basename(projectDir));
  const traversal = encodeURIComponent('../secret.html');
  const res = await fetch(`http://127.0.0.1:${srv.port}/wiki-ext/${key}/${traversal}`);
  assert.equal(res.status, 400);
});


test('POST /api/wiki/rebuild returns 500 + stderr reason on a real build failure (malformed graph.json), not a stale 200', async () => {
  // A synthetic root, allowlisted via additionalDirectories (same mechanism
  // as registerAllowlistedRoot below), with a graph.json that fails to parse
  // -- wiki-build-cli.mjs's JSON.parse throws, which is now a clean non-zero
  // exit (see the uncaughtException guard added to that file) instead of a
  // raw stack dump the caller has to guess the meaning of.
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-broken-'));
  tmpDirs.push(brokenRoot);
  fs.mkdirSync(path.join(brokenRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(brokenRoot, 'graphify-out', 'graph.json'), '{ not valid json');
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, brokenRoot);

  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: brokenRoot }),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /wiki rebuild failed \(exit \d+\)/);
  assert.match(body.stderr, /wiki: build failed:/);
  assert.match(body.stderr, /Expected property name|JSON/i);
});

// the LLM-backed spawn for a non-repo-root
// rebuild had no isTestProcess guard at all -- body.llm: true in a test
// process would start a real model build attempt (the CLI's own backend
// auto-detection: agy/gemini/none). Refused here with a named reason
// unless a spawnWikiRebuildCli override is actually injected. The no-LLM
// structural-only rebuild test just above is untouched by this: it never
// sets body.llm, so it keeps exercising the real (but harmless) spawn.
test('POST /api/wiki/rebuild with llm:true refuses under isTestProcess() with no override given, never starts a real model build (N8)', async () => {
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-llm-'));
  tmpDirs.push(otherRoot);
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, otherRoot);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: otherRoot, llm: true }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /llm.*refused.*isTestProcess/i);
});

test('POST /api/wiki/rebuild with llm:true proceeds when a spawnWikiRebuildCli override is injected', async () => {
  const { env } = mkEnv();
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-llm-ok-'));
  tmpDirs.push(otherRoot);
  fs.mkdirSync(path.join(otherRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(otherRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }));
  registerAllowlistedRoot(env.GLMPS_CLAUDE_DIR, otherRoot);
  let seenArgs = null;
  const ownSrv = await startServer({
    port: 0, pollMs: 1000, env,
    spawnWikiRebuildCli: async (cliArgs) => { seenArgs = cliArgs; return { code: 0, stderr: '' }; },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${ownSrv.port}/api/wiki/rebuild`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: otherRoot, llm: true }),
    });
    assert.notEqual(res.status, 503);
    assert.ok(seenArgs?.includes('--llm'), `expected the injected spawn to see --llm, got: ${JSON.stringify(seenArgs)}`);
  } finally { await ownSrv.close(); }
});

// a rebuild of the kernel's OWN repo (no `root`, or `root`
// resolving to REPO_ROOT) is no longer a synchronous CLI spawn at all -- it is
// always routed through the wiki loop (409 when the loop is not running here,
// 202 queued when it is; see api-wiki-loop.test.js). That retires the tests
// that used to live here for the old repo-root rebuild path, including its
// scheduled auto-refresh timer (D-W6, 2026-09): the loop builds into
// <stateDir>/wiki, so the override and timer scenarios those tests guarded
// against cannot happen on this path any more. The remaining "malformed
// current.json answers with a generic error" leak fix is still covered live
// at GET /api/wiki and POST /api/wiki/ask (api-wiki-ask.test.js).

test('GET /api/wiki: same commit and same graph is fresh; the graph rewritten at that commit is stale with reason graph', async () => {
  const projectDir = mkProjectDir();
  const git = (...a) => execFileSync('git', ['-C', projectDir, ...a], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(projectDir, '.gitignore'), 'graphify-out/\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  const head = git('rev-parse', 'HEAD');
  const graphFile = path.join(projectDir, 'graphify-out', 'graph.json');
  const g = { built_at_commit: head, nodes: [{ id: 'a', label: 'A', source_file: 'a.js' }], links: [] };
  const wikiDir = path.join(projectDir, 'graphify-out', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(graphFile, JSON.stringify(g));
  fs.writeFileSync(path.join(wikiDir, 'manifest.json'), JSON.stringify({
    builtAtCommit: head, graphFingerprint: graphFingerprint(g), sections: [{ slug: 'server', title: 'Server', llm: true }],
  }));
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const get = async () => (await fetch(`http://127.0.0.1:${srv.port}/api/wiki?project=${encodeURIComponent(projectDir)}`)).json();
  const fresh = await get();
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(fresh.staleReason, null);
  assert.equal(fresh.builtFromGraph, graphFingerprint(g));
  assert.equal(fresh.currentGraph, graphFingerprint(g));
  const moved = { ...g, nodes: [...g.nodes, { id: 'b', label: 'B', source_file: 'b.js' }] };
  fs.writeFileSync(graphFile, JSON.stringify(moved));
  const stale = await get();
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.staleReason, 'graph');
  assert.equal(stale.needsUpdate, true);
  assert.equal(stale.sections[0].stale, true);
  assert.equal(stale.currentGraph, graphFingerprint(moved));
  fs.rmSync(graphFile);
  const gone = await get();
  assert.equal(gone.freshness, 'unknown');
  assert.equal(gone.staleReason, 'graph-unreadable');
});

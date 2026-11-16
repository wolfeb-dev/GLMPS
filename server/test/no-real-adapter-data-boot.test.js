// server/test/no-real-adapter-data-boot.test.js
// K Task 16 phase-end carry 1: a server booted with a bare env literal in a
// test process - fresh GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR, none of the other ~8
// GLMPS_*_DIR adapter overrides - must never read the operator's real
// Antigravity/Gemini/VS Code/agy-cli/Codex/Copilot CLI/OpenCode/Hermes/Cline
// session stores.
//
// Root cause (traced by reading code only, never opening a real session
// file): server.js's pollCore() runs synchronously once at boot (`poll();`
// before startServer() returns). For every GENERIC_TOOL_ID (gemini-cli,
// copilot-chat, copilot-cli, codex-cli, hermes, agy-cli, opencode, cline) it
// calls adapter.discover(P), where P = getPaths(env, profile). Those
// adapters' own directories (server/lib/paths.js) derived from the real
// os.homedir() regardless of GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR - only each
// adapter's OWN env var (GLMPS_GEMINI_TMP_DIR, GLMPS_HERMES_DIR, ...) ever
// overrode it. Whatever those adapters discovered on the real machine was
// tailed straight into the in-memory eventLog, which GET /api/alerts then
// scans (scanEventsForInjection/detectEgress) for injection/sensitive-data
// alerts - so a server-booting test that forgot even one of those ~8
// overrides got a phantom alert sourced from the operator's own real
// session history.
//
// paths.js's own test-process redirect (see paths.test.js /
// paths-editor-storage.test.js) is the actual fix; this proves it holds
// through a REAL boot and the REAL /api/alerts route, not just the
// unit-level path assertions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../lib/paths.js';
import { startServer, resolveIcons } from '../server.js';
import { promptVersionFor } from '../lib/evaluation/prompt-version.js';
import { detectAll } from '../lib/adapters/index.js';
import { AGY_CONV_DIR } from '../lib/observability/wiki-agy.js';

let bareNoClaudeStateDir;
let bareNoClaudeProjectDir;
let bareNoClaudeEnv;
let bareNoClaudeSrv;

before(async () => {
  bareNoClaudeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noreal2-state-'));
  bareNoClaudeProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noreal3-project-'));
  bareNoClaudeEnv = { GLMPS_STATE_DIR: bareNoClaudeStateDir, GLMPS_UNMERGED_SCAN: 'off' };
  fs.writeFileSync(path.join(bareNoClaudeProjectDir, 'CLAUDE.md'), 'project rules for the no-real-home test');
  fs.mkdirSync(path.join(bareNoClaudeStateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(bareNoClaudeStateDir, 'state', 'index.json'),
    JSON.stringify([{ id: 'noreal3sess', cwd: bareNoClaudeProjectDir }]));
  bareNoClaudeSrv = await startServer({ port: 0, env: bareNoClaudeEnv, pollMs: 100000, restartFn: () => {} });
});

after(async () => {
  await bareNoClaudeSrv?.close();
  fs.rmSync(bareNoClaudeStateDir, { recursive: true, force: true });
  fs.rmSync(bareNoClaudeProjectDir, { recursive: true, force: true });
});

test('server booted with a bare env literal in a test process reads no real adapter store', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noreal-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noreal-claude-'));
  // Deliberately NOT spreading process.env, and NOT setting any of
  // GLMPS_ANTIGRAVITY_DIR/GLMPS_GEMINI_TMP_DIR/GLMPS_VSCODE_STORAGE_DIR/GLMPS_AGY_CLI_DIR/
  // GLMPS_CODEX_DIR/GLMPS_COPILOT_CLI_DIR/GLMPS_HERMES_DIR/GLMPS_OPENCODE_DIR - the exact "bare literal" shape the carry names (about 17
  // existing server-booting test files set every one of these explicitly;
  // this proves that boilerplate is no longer load-bearing for safety).
  const env = { GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };

  // Same env, same (default, real) profile server.js itself passes to
  // getPaths(env, profile) inside startServer - this repo has no
  // glmps.profile.json / GLMPS_PROFILE at this cwd, so loadProfile() returns
  // null here just like it does inside the real boot below. Proves the
  // adapter paths the real boot computes resolve under the system tmp dir
  // or to a path that does not exist, never the operator's real home dir.
  const P = getPaths(env);
  for (const [name, dir] of [
    ['antigravityDir', P.antigravityDir], ['geminiTmpDir', P.geminiTmpDir], ['agyCliDir', P.agyCliDir],
    ['opencodeDir', P.opencodeDir], ['codexDir', P.codexDir], ['copilotCliDir', P.copilotCliDir],
    ['hermesDir', P.hermesDir],
  ]) {
    assert.ok(!fs.existsSync(dir), `${name} (${dir}) must not point at a real, existing directory`);
  }
  for (const d of P.vscodeStorageDirs) assert.ok(!fs.existsSync(d), `vscodeStorageDirs entry must not exist: ${d}`);

  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/alerts`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const fromAmbientData = body.alerts.filter((a) => a.source === 'injection' || a.source === 'egress');
    assert.deepEqual(fromAmbientData, [], `expected no injection/egress alert from ambient adapter data, got ${JSON.stringify(fromAmbientData)}`);
  } finally { await srv.close(); }
});

// Phase K final review I1: the variant the carry above left open. A test
// that omits GLMPS_CLAUDE_DIR and GLMPS_ASSETS_DIR too (27 of 84 server-booting
// tests omit GLMPS_CLAUDE_DIR) used to boot with claudeDir under the real home,
// so poll() tailed the operator's real ~/.claude/projects transcripts, and
// with assetsDir at the sibling production assets checkout. The path
// assertions run BEFORE the boot, so on the pre-fix code this test fails
// without the server ever reading a real file.
test('server booted in a test process without GLMPS_CLAUDE_DIR or GLMPS_ASSETS_DIR reads no real home or production assets dir', async () => {
  const P = getPaths(bareNoClaudeEnv);
  const tmpRoot = path.resolve(os.tmpdir());
  for (const [name, dir] of [['claudeDir', P.claudeDir], ['assetsDir', P.assetsDir], ['memoryDir', P.memoryDir], ['projectsDir', P.projectsDir]]) {
    assert.ok(!fs.existsSync(dir), `${name} (${dir}) must not point at a real, existing directory`);
    assert.ok(path.resolve(dir).startsWith(tmpRoot), `${name} (${dir}) must resolve under the system tmp dir`);
  }
  const r = await fetch(`http://127.0.0.1:${bareNoClaudeSrv.port}/api/alerts`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const fromAmbientData = body.alerts.filter((a) => a.source === 'injection' || a.source === 'egress');
  assert.deepEqual(fromAmbientData, [], `expected no injection/egress alert from ambient data, got ${JSON.stringify(fromAmbientData)}`);
});

// Phase K final review (minors wave): five call sites derived a path from
// os.homedir() directly, bypassing getPaths()'s own test-process redirect
// entirely - prompt-version's cohort tag (server.js finalizeAndQueueJudge),
// adapters/index.js's DETECT_ONLY tools (cursor/windsurf/aider/continue/zed),
// server.js's resolveIcons (claude-code/antigravity
// install scan), and wiki-agy.js's AGY_CONV_DIR. Each now routes through
// getPaths() (or isTestProcess() directly, where no P exists yet at the call
// site) so a bare-env test process never resolves any of them to the real
// home dir.
test('in a test process with a bare env, none of the K-final minors-wave call sites resolve to the real home dir', async () => {
  const P = getPaths(bareNoClaudeEnv);
  // Same shape as the two tests above: a redirected path must (a) not
  // already exist (never a real, populated directory) and (b) resolve under
  // the system tmp dir - NOT "not under os.homedir()", since on Windows the
  // system tmp dir is itself a subdirectory of the user profile root.
  const tmpRoot = path.resolve(os.tmpdir());
  const assertRedirected = (name, dir) => {
    assert.ok(!fs.existsSync(dir), `${name} (${dir}) must not point at a real, existing directory`);
    assert.ok(path.resolve(dir).startsWith(tmpRoot), `${name} (${dir}) must resolve under the system tmp dir`);
  };

  // 2. adapters/index.js DETECT_ONLY tools.
  const detectOnly = detectAll(P).filter((e) => e.depth === 'detect-only');
  assert.equal(detectOnly.length, 5);
  for (const entry of detectOnly) {
    for (const d of entry.dataDirs) assertRedirected(entry.id, d);
  }


  // 4. resolveIcons: claude-code/antigravity/agy-cli derive from a real
  // install scan (extensions dir, LOCALAPPDATA); must be null in a test
  // process rather than scanning the operator's real machine.
  const icons = resolveIcons();
  assert.equal(icons['claude-code'], null);
  assert.equal(icons['antigravity'], null);
  assert.equal(icons['agy-cli'], null);

  // 5. wiki-agy.js's AGY_CONV_DIR.
  assertRedirected('AGY_CONV_DIR', AGY_CONV_DIR);

  // 1. prompt-version cohort tag, proven through a real boot + a real
  // /api/outcomes/finalize call (not just the path computation above).
  const r = await fetch(`http://127.0.0.1:${bareNoClaudeSrv.port}/api/outcomes/finalize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'noreal3sess' }),
  });
  const body = await r.json();
  const expected = promptVersionFor({ cwd: bareNoClaudeProjectDir, claudeDir: P.claudeDir });
  assert.equal(body.row.unit, expected);
  assert.match(body.row.unit, /^prompt-/);
});

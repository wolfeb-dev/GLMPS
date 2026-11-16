// server/test/paths.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPaths, ensureStateDirs, isTestProcess, noRealAdapterDataDir, claudeProjectDirName, configFileFor } from '../lib/paths.js';
import { homeStateDir } from '../lib/state-dir.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

// K Task 16 phase-end carry 1: isTestProcess() forced false (a real,
// non-test launch) simulates production, even though this assertion itself
// runs inside node --test (whose own ambient NODE_TEST_CONTEXT would
// otherwise make isTestProcess() true here too, redirecting the adapter
// defaults asserted below off the real home dir).
const notTest = { processEnv: {}, argv: ['node', 'server.js'] };

test('defaults derive from home dir', () => {
  const p = getPaths({}, null, notTest);
  assert.equal(p.claudeDir, path.join(os.homedir(), '.claude'));
  assert.equal(p.activeSessionsFile,
    path.join(os.homedir(), '.claude', '.claude-manager', 'active-sessions.json'));
  // primary antigravityDir is now antigravity-ide
  assert.equal(p.antigravityDir, path.join(os.homedir(), '.gemini', 'antigravity-ide'));
  assert.deepEqual(p.antigravityDirs, [
    path.join(os.homedir(), '.gemini', 'antigravity-ide'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    path.join(os.homedir(), '.gemini', 'antigravity'),
  ]);
  // ~/.glmps2 once the cutover has made it, else ~/.glmps: which one
  // depends on the machine, so the test asks the seam rather than naming one.
  assert.equal(p.stateDir, homeStateDir(os.homedir()));
});

// A server-booting test that sets a fresh GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR but
// never touches the other ~8 GLMPS_*_DIR adapter overrides used to still read
// the operator's REAL Antigravity/Gemini/VS Code/agy-cli/Codex/Copilot CLI/
// OpenCode/Hermes/Cline stores, because `home` inside getPaths() is always
// the real os.homedir() - only each adapter's OWN env var ever overrode it.
// isTestProcess() closes this centrally: when it is true (ambient
// NODE_TEST_CONTEXT/GLMPS_TEST, or an injected equivalent, or argv[1] a test
// file) and an adapter's own override is unset, that adapter's default
// redirects to a path that does not exist, instead of the real home dir.

test('isTestProcess: true via injected env.NODE_TEST_CONTEXT, false with no signal at all', () => {
  assert.equal(isTestProcess({ env: { NODE_TEST_CONTEXT: '1' }, processEnv: {}, argv: ['node', 'x.js'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'x.js'] }), false);
});

test('isTestProcess: true via injected env.GLMPS_TEST === "1"', () => {
  assert.equal(isTestProcess({ env: { GLMPS_TEST: '1' }, processEnv: {}, argv: ['node', 'x.js'] }), true);
  assert.equal(isTestProcess({ env: { GLMPS_TEST: 'yes' }, processEnv: {}, argv: ['node', 'x.js'] }), false, 'only the exact string "1" counts');
});

test('isTestProcess: true via the REAL ambient processEnv.NODE_TEST_CONTEXT - the bare-literal-env case', () => {
  // The caller's own injected `env` has no signal at all - only the real
  // ambient process.env (the server's actual process, not whatever bare
  // literal a server-booting test built for startServer) carries it. This is
  // the exact ~17-file pattern the carry names: a test builds env as a bare
  // literal, never spreading process.env, so the signal can only be read
  // from the TRUE ambient process state.
  assert.equal(isTestProcess({ env: {}, processEnv: { NODE_TEST_CONTEXT: '1' }, argv: ['node', 'x.js'] }), true);
});

test('isTestProcess: true via the REAL ambient processEnv.GLMPS_TEST === "1"', () => {
  assert.equal(isTestProcess({ env: {}, processEnv: { GLMPS_TEST: '1' }, argv: ['node', 'x.js'] }), true);
});

test('isTestProcess: true via argv[1] matching a .test.js/.mjs file, even with no env signal at all', () => {
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'foo.test.js'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'foo.test.mjs'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'foo.js'] }), false);
});

test('under test-process detection, antigravityDirs/antigravityDir default to a path that does not exist, never the real home dir', () => {
  // Ambient: this file runs under node --test, so isTestProcess() is already
  // true here without any injection at all - the exact condition every test
  // in the suite runs under today.
  const p = getPaths({});
  assert.ok(!fs.existsSync(p.antigravityDir), `expected a non-existent path, got ${p.antigravityDir}`);
  assert.ok(path.resolve(p.antigravityDir).startsWith(path.resolve(os.tmpdir())), `expected antigravityDir under the system tmp dir, got ${p.antigravityDir}`);
  for (const d of p.antigravityDirs) assert.ok(!fs.existsSync(d), `antigravityDirs entry must not exist: ${d}`);
});

test('an explicit GLMPS_ANTIGRAVITY_DIR override still wins under test-process detection', () => {
  const p = getPaths({ GLMPS_ANTIGRAVITY_DIR: '/custom/ag' });
  assert.equal(p.antigravityDir, '/custom/ag');
  assert.deepEqual(p.antigravityDirs, ['/custom/ag']);
});

test('test-process detection redirects every unset adapter-store default off the real home dir (geminiTmp, agyCli, opencode, codex, copilotCli, hermes)', () => {
  const p = getPaths({}); // ambient test process, no adapter overrides at all
  const checks = [
    ['geminiTmpDir', p.geminiTmpDir],
    ['agyCliDir', p.agyCliDir],
    ['opencodeDir', p.opencodeDir],
    ['codexDir', p.codexDir],
    ['copilotCliDir', p.copilotCliDir],
    ['hermesDir', p.hermesDir],
    ['cursorDir', p.cursorDir],
    ['grokDir', p.grokDir],
    ['piDir', p.piDir],
    ['factoryDir', p.factoryDir],
    ...p.clineStorageDirs.map((d, i) => [`clineStorageDirs[${i}]`, d]),
    ...p.openclawDirs.map((d, i) => [`openclawDirs[${i}]`, d]),
  ];
  for (const [name, dir] of checks) {
    assert.ok(dir, `${name} must still be a usable path, not null/undefined`);
    assert.ok(!fs.existsSync(dir), `${name} (${dir}) must not point at a real, existing directory`);
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), `${name} (${dir}) must resolve under the system tmp dir`);
  }
});

test('explicit adapter-store overrides still win under test-process detection (geminiTmp, agyCli, opencode, codex, copilotCli, hermes)', () => {
  const p = getPaths({
    GLMPS_GEMINI_TMP_DIR: '/custom/gemini', GLMPS_AGY_CLI_DIR: '/custom/agy', GLMPS_OPENCODE_DIR: '/custom/opencode',
    GLMPS_CODEX_DIR: '/custom/codex', GLMPS_COPILOT_CLI_DIR: '/custom/copilot', GLMPS_HERMES_DIR: '/custom/hermes',
    GLMPS_CURSOR_DIR: '/custom/cursor', GLMPS_GROK_DIR: '/custom/grok', GLMPS_PI_DIR: '/custom/pi', GLMPS_FACTORY_DIR: '/custom/factory',
    GLMPS_CLINE_STORAGE_DIR: '/custom/cline-gs', GLMPS_OPENCLAW_DIR: '/custom/openclaw',
  });
  assert.equal(p.geminiTmpDir, '/custom/gemini');
  assert.equal(p.agyCliDir, '/custom/agy');
  assert.equal(p.opencodeDir, '/custom/opencode');
  assert.equal(p.codexDir, '/custom/codex');
  assert.equal(p.copilotCliDir, '/custom/copilot');
  assert.equal(p.hermesDir, '/custom/hermes');
  assert.equal(p.cursorDir, '/custom/cursor');
  assert.equal(p.grokDir, '/custom/grok');
  assert.equal(p.piDir, '/custom/pi');
  assert.equal(p.factoryDir, '/custom/factory');
  assert.deepEqual(p.clineStorageDirs, ['/custom/cline-gs']);
  assert.deepEqual(p.openclawDirs, ['/custom/openclaw']);
});

test('under a forced non-test context, the adapter-store defaults are still the real production formula (documents the behaviour the redirect above must never change)', () => {
  const p = getPaths({}, null, notTest);
  assert.equal(p.geminiTmpDir, path.join(os.homedir(), '.gemini', 'tmp'));
  assert.equal(p.agyCliDir, path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  assert.equal(p.opencodeDir, path.join(os.homedir(), '.local', 'share', 'opencode'));
  assert.equal(p.codexDir, path.join(os.homedir(), '.codex'));
  assert.equal(p.copilotCliDir, path.join(os.homedir(), '.copilot'));
  assert.equal(p.cursorDir, path.join(os.homedir(), '.cursor'));
  assert.equal(p.grokDir, path.join(os.homedir(), '.grok'));
  assert.equal(p.piDir, path.join(os.homedir(), '.pi', 'agent'));
  assert.equal(p.factoryDir, path.join(os.homedir(), '.factory'));
  assert.deepEqual(p.openclawDirs, [path.join(os.homedir(), '.openclaw'), path.join(os.homedir(), '.clawdbot')]);
  assert.ok(p.clineStorageDirs.length > 0 && p.clineStorageDirs.every(d => d.startsWith(os.homedir()) || d.includes('Cursor') || d.includes('Code')));
});

test('alertAcksFile derives from stateDir (state/alert-acks.json)', () => {
  const p = getPaths({ GLMPS_STATE_DIR: '/tmp/mc-state' });
  assert.equal(p.alertAcksFile, path.join('/tmp/mc-state', 'state', 'alert-acks.json'));
});

test('alertSeenFile derives from stateDir (state/alert-seen.json)', () => {
  const p = getPaths({ GLMPS_STATE_DIR: '/tmp/mc-state' });
  assert.equal(p.alertSeenFile, path.join('/tmp/mc-state', 'state', 'alert-seen.json'));
});

test('internalSessionsFile derives from stateDir (state/internal-sessions.json)', () => {
  const p = getPaths({ GLMPS_STATE_DIR: '/tmp/mc-state' });
  assert.equal(p.internalSessionsFile, path.join('/tmp/mc-state', 'state', 'internal-sessions.json'));
});

test('scutChannelHealthDir derives from stateDir (state/scut-channel-health), and matches channel-health.js#channelHealthDir', async () => {
  const p = getPaths({ GLMPS_STATE_DIR: '/tmp/mc-state' });
  assert.equal(p.scutChannelHealthDir, path.join('/tmp/mc-state', 'state', 'scut-channel-health'));
  // channel-server.js (a separate process) derives the SAME path from
  // GLMPS_STATE_DIR without importing paths.js (see channel-health.js's header
  // comment); this pins the two derivations to agree so they cannot drift
  // apart silently.
  const { channelHealthDir } = await import('../lib/scut/channel-health.js');
  assert.equal(p.scutChannelHealthDir, channelHealthDir({ GLMPS_STATE_DIR: '/tmp/mc-state' }));
});

test('getPaths: agyCliDir defaults to ~/.gemini/antigravity-cli', () => {
  const P = getPaths({}, null, notTest);
  const home = os.homedir();
  assert.equal(P.agyCliDir, path.join(home, '.gemini', 'antigravity-cli'));
});

test('getPaths: agyCliDir overridden by GLMPS_AGY_CLI_DIR', () => {
  const P = getPaths({ GLMPS_AGY_CLI_DIR: '/custom/agy-cli' });
  assert.equal(P.agyCliDir, '/custom/agy-cli');
});

test('assetsDir honors GLMPS_ASSETS_DIR override', () => {
  const P = getPaths({ GLMPS_ASSETS_DIR: '/tmp/custom-assets' });
  assert.equal(P.assetsDir, '/tmp/custom-assets');
});

test('addonsDir honors GLMPS_ADDONS_DIR and a profile, and defaults to a non-existent temp dir in a test process', () => {
  assert.equal(getPaths({ GLMPS_ADDONS_DIR: '/tmp/custom-addons' }).addonsDir, '/tmp/custom-addons');
  assert.equal(getPaths({}, { addonsDir: '/eng/addons' }).addonsDir, '/eng/addons');
  const p = getPaths({});
  assert.ok(!fs.existsSync(p.addonsDir), 'must not point at a real directory');
  assert.ok(path.resolve(p.addonsDir).startsWith(path.resolve(os.tmpdir())));
  assert.equal(getPaths({}, null, notTest).addonsDir, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'addons'));
});

// Phase K final review I1: the adapter-store redirect above left the four
// dirs every server-booting test actually depends on still pointing at real
// data in a test process: claudeDir and memoryDir under the real home, and
// assetsDir at the sibling production assets checkout. 27 of 84
// server-booting tests omit GLMPS_CLAUDE_DIR, so poll() tailed the operator's
// real ~/.claude/projects transcripts. Path assertions only; nothing read.
test('I1: under test-process detection, unset claudeDir/stateDir/assetsDir/memoryDir resolve to non-existent temp paths', () => {
  const p = getPaths({}); // ambient test process, no GLMPS_* overrides at all
  const tmpRoot = path.resolve(os.tmpdir());
  for (const [name, dir] of [
    ['claudeDir', p.claudeDir], ['stateDir', p.stateDir], ['assetsDir', p.assetsDir], ['memoryDir', p.memoryDir],
    ['legacyStateDir', p.legacyStateDir],
  ]) {
    assert.ok(!fs.existsSync(dir), `${name} (${dir}) must not point at a real, existing directory`);
    assert.ok(path.resolve(dir).startsWith(tmpRoot), `${name} (${dir}) must resolve under the system tmp dir`);
  }
});

test('I1: explicit GLMPS_CLAUDE_DIR/GLMPS_STATE_DIR/GLMPS_ASSETS_DIR/GLMPS_MEMORY_DIR and a profile still win under test-process detection', () => {
  const p = getPaths({ GLMPS_CLAUDE_DIR: '/c', GLMPS_STATE_DIR: '/s', GLMPS_ASSETS_DIR: '/a', GLMPS_MEMORY_DIR: '/m' });
  assert.equal(p.claudeDir, '/c');
  assert.equal(p.stateDir, '/s');
  assert.equal(p.assetsDir, '/a');
  assert.equal(p.memoryDir, '/m');
  const q = getPaths({ GLMPS_CLAUDE_DIR: '/c' });
  assert.equal(q.memoryDir, path.join('/c', 'projects', claudeProjectDirName(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')), 'memory'),
    'with GLMPS_CLAUDE_DIR set, memoryDir still derives from it (already a caller-chosen dir)');
  const r = getPaths({}, { stateDir: '/eng/state', assetsDir: '/eng/assets', harness: { claudeDir: '/eng/claude' } });
  assert.equal(r.stateDir, '/eng/state');
  assert.equal(r.claudeDir, '/eng/claude');
  assert.equal(r.assetsDir, '/eng/assets');
});

test('I1: the shared helper module exports the same isTestProcess predicate', async () => {
  const mod = await import('../lib/test-process.js');
  assert.equal(mod.isTestProcess, isTestProcess, 'paths.js re-exports the one shared helper, not a second copy');
  assert.equal(mod.isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'server.js'] }), false);
  assert.equal(mod.isTestProcess({ env: { GLMPS_TEST: '1' }, processEnv: {}, argv: ['node', 'server.js'] }), true);
});

test('assetsDir defaults to the repo-local assets dir (launch-env independent)', () => {
  const P = getPaths({}, null, notTest); // no GLMPS_ASSETS_DIR - must NOT fall back to the home dir
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const expected = path.join(repoRoot, 'assets');
  assert.equal(P.assetsDir, expected);
  assert.equal(P.agentsDir, path.join(expected, 'agents'));
});

test('agentsDir honors GLMPS_AGENTS_DIR override', () => {
  const P = getPaths({ GLMPS_AGENTS_DIR: '/tmp/custom-agents' });
  assert.equal(P.agentsDir, '/tmp/custom-agents');
});

test('doneGateDir honors GLMPS_DONE_GATE_DIR override', () => {
  const P = getPaths({ GLMPS_DONE_GATE_DIR: '/tmp/dg' });
  assert.equal(P.doneGateDir, '/tmp/dg');
});

test('doneGateDir defaults under stateDir', () => {
  const P = getPaths({ GLMPS_STATE_DIR: '/tmp/st' });
  assert.equal(P.doneGateDir, path.join('/tmp/st', 'done-gate'));
});

test('env overrides win and ensureStateDirs creates subdirs', () => {
  const tmp = mkTmp();
  const p = getPaths({ GLMPS_STATE_DIR: tmp, GLMPS_CLAUDE_DIR: 'X:\\c', GLMPS_ANTIGRAVITY_DIR: 'X:\\a' });
  assert.equal(p.stateDir, tmp);
  assert.equal(p.claudeDir, 'X:\\c');
  assert.equal(p.antigravityDir, 'X:\\a');
  // env override yields a one-element array
  assert.deepEqual(p.antigravityDirs, ['X:\\a']);
  ensureStateDirs(p);
  // 'requests' (the companion's drained request file's
  // parent dir) is gone with the companion - D20 deleted requestsFile from
  // the path table itself; ensureStateDirs must not keep making an orphan dir.
  for (const d of ['state', 'status', 'undo'])
    assert.ok(fs.existsSync(path.join(tmp, d)), d);
  assert.equal(fs.existsSync(path.join(tmp, 'requests')), false);
});

test('profile supplies stateDir/claudeDir/repoRoots when env is absent', () => {
  const profile = {
    stateDir: '/eng/state', assetsDir: '/eng/assets',
    repoRoots: ['/eng/api', '/eng/web'],
    harness: { claudeDir: '/eng/claude', antigravityDir: null, opencodeDir: null, codexDir: null, hermesDir: null, vscodeStorageDir: null },
  };
  const P = getPaths({}, profile);
  assert.equal(P.stateDir, '/eng/state');
  assert.equal(P.claudeDir, '/eng/claude');
  assert.deepEqual(P.repoRoots, ['/eng/api', '/eng/web']);
  assert.equal(P.assetsDir, '/eng/assets');
});

test('env overrides profile (env wins)', () => {
  const profile = { stateDir: '/eng/state', harness: { claudeDir: '/eng/claude' } };
  const P = getPaths({ GLMPS_STATE_DIR: '/env/state', GLMPS_CLAUDE_DIR: '/env/claude' }, profile);
  assert.equal(P.stateDir, '/env/state');
  assert.equal(P.claudeDir, '/env/claude');
});

// Folder names Claude Code itself created under ~/.claude/projects. The old
// munge kept dots, so the live 2.0 kernel read D--glmps-2.0-runtime/memory,
// which never exists (glmps-2-0-37: recall 0 of 95).
test('claudeProjectDirName matches the folder names Claude Code creates', () => {
  assert.equal(claudeProjectDirName('D:\\glmps-2.0-runtime'), 'D--glmps-2-0-runtime');
  assert.equal(claudeProjectDirName('D:\\glmps'), 'D--glmps');
  assert.equal(claudeProjectDirName('D:\\glmps\\.claude\\worktrees\\glmps2-ds'), 'D--glmps--claude-worktrees-glmps2-ds');
  assert.equal(claudeProjectDirName('C:\\Users\\op\\.glmps\\runner\\worktrees\\glmps-2.0\\glmps-2-0-35'),
    'C--Users-op--glmps-runner-worktrees-glmps-2-0-glmps-2-0-35');
});

test("memoryDir defaults to this repo's own project memory dir under claudeDir/projects", () => {
  const P = getPaths({}, null, notTest);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(P.memoryDir, path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(repoRoot), 'memory'));
  assert.doesNotMatch(path.basename(path.dirname(P.memoryDir)), /[^a-zA-Z0-9-]/);
});

test('memoryDir honors GLMPS_MEMORY_DIR override', () => {
  const P = getPaths({ GLMPS_MEMORY_DIR: '/tmp/custom-memory' });
  assert.equal(P.memoryDir, '/tmp/custom-memory');
});

test('no profile => identical behavior to before (repoRoots empty)', () => {
  const P = getPaths({}, null, notTest);
  assert.deepEqual(P.repoRoots, []);
  assert.equal(P.profile, null);
  assert.ok(P.claudeDir.endsWith(path.join('.claude')) || P.claudeDir.includes('.claude'));
});

// Phase K final review (minors wave): noRealAdapterDataDir was keyed by the
// bare pid alone and never cleaned up, so a reused OS pid could find a
// leftover dir from an earlier run and wrongly pass "does not exist yet"
// checks (this file's own redirect assertions above). Exported so this run
// identifier can be reused by the other call sites that need the identical
// redirect without going through a full getPaths() call (openclaw.js,
// wiki-agy.js, adapters/index.js's detect-only tools).
test('noRealAdapterDataDir is stable within one process but keyed by more than the bare pid, so a reused pid cannot collide with a leftover run', () => {
  const a = noRealAdapterDataDir('foo');
  const b = noRealAdapterDataDir('bar');
  // Same run segment (the parent dir) for every call within this process.
  assert.equal(path.dirname(a), path.dirname(b));
  const runSegment = path.basename(path.dirname(a));
  assert.ok(runSegment.startsWith(String(process.pid)), `expected the pid to prefix the run segment, got ${runSegment}`);
  assert.notEqual(runSegment, String(process.pid), 'run segment must carry more than the bare pid (pid reuse would otherwise collide)');
});

test('configFileFor: GLMPS_CONFIG_FILE wins (the packaged shell keeps config outside the install dir), else <repo>/config.json', () => {
  const repo = path.join(os.tmpdir(), 'some-repo');
  assert.equal(configFileFor({ env: {}, repoRoot: repo }), path.join(repo, 'config.json'));
  assert.equal(configFileFor({ env: { GLMPS_CONFIG_FILE: '' }, repoRoot: repo }), path.join(repo, 'config.json'));
  const custom = path.join(os.tmpdir(), 'elsewhere', 'config.json');
  assert.equal(configFileFor({ env: { GLMPS_CONFIG_FILE: custom }, repoRoot: repo }), custom);
});

test('assetsWriteDir comes from GLMPS_ASSETS_WRITE_DIR and is null when unset', () => {
  assert.equal(getPaths({}, null, notTest).assetsWriteDir, null);
  assert.equal(getPaths({ GLMPS_ASSETS_WRITE_DIR: '/w/dev-clone' }, null, notTest).assetsWriteDir, '/w/dev-clone');
  assert.equal(getPaths({ GLMPS_ASSETS_WRITE_DIR: '' }, null, notTest).assetsWriteDir, null);
});

test('GROK_HOME and PI_CODING_AGENT_DIR feed grokDir and piDir; GLMPS_* overrides win over them', () => {
  assert.equal(getPaths({ GROK_HOME: '/g/home' }).grokDir, '/g/home');
  assert.equal(getPaths({ GROK_HOME: '/g/home', GLMPS_GROK_DIR: '/mc/g' }).grokDir, '/mc/g');
  assert.equal(getPaths({ PI_CODING_AGENT_DIR: '/p/agent' }).piDir, '/p/agent');
  assert.equal(getPaths({ PI_CODING_AGENT_DIR: '/p/agent', GLMPS_PI_DIR: '/mc/p' }).piDir, '/mc/p');
});

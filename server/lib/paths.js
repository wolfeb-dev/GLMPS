// server/lib/paths.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DEFAULT_ZONE_CONFIG } from './zones.js';
import { workspaceStorageDirs, globalStorageDirs } from './adapters/editor-roots.js';
import { fileURLToPath } from 'node:url';
import { isTestProcess } from './test-process.js';
import { envStateDirOverride, homeStateDir, legacyStateDirFor, stateSubdirs } from './state-dir.js';

export * from './state-dir.js';

// The assets (agents, CLAUDE.global.md) are vendored in this repo's own
// assets/ dir, so 2.0 has no dependency on a sibling assets repo. Derive the
// default from THIS module's location (server/lib/paths.js) so the server
// resolves the assets dir regardless of how it was launched (e.g. a
// companion-spawned process without GLMPS_ASSETS_DIR in its env). GLMPS_ASSETS_DIR
// still overrides.
const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ASSETS_DIR = path.join(_repoRoot, 'assets');
const DEFAULT_ADDONS_DIR = path.join(_repoRoot, 'addons');

// The checkout this process runs from. Anything that must name "the deployed
// checkout" (the approvals registry) derives it here instead of a literal.
export const REPO_ROOT = _repoRoot;

// Windows' own schtasks.exe, resolved from the system root so a non-C: install
// still works. The fallback keeps the result absolute on a host without it.
export function schtasksExe(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'schtasks.exe');
}

// This project's own curated memory dir: Claude Code's per-project memory
// convention is <claudeDir>/projects/<munged repo path>/memory. Derived from
// THIS module's own on-disk location for the same launch-env-independence
// reason as DEFAULT_ASSETS_DIR above. GLMPS_MEMORY_DIR overrides (tests, or a
// differently-launched profile).
// Claude Code turns every non-alphanumeric character into '-', dots included
// (D:\my-app-2.0 -> D--my-app-2-0); keeping the dot pointed the
// live 2.0 kernel at a folder that never exists (glmps-2-0-37).
export function claudeProjectDirName(p) { return String(p).replace(/[^a-zA-Z0-9]/g, '-'); }
const DEFAULT_MEMORY_DIR_NAME = claudeProjectDirName(_repoRoot);

// isTestProcess lives in its own module so paths.js, claude-model.js and the
// hook installer all ask
// the one predicate. Re-exported here for existing importers.
export { isTestProcess };

// noRealAdapterDataDir: a path that does not exist, used as the default for
// a non-Claude adapter store's directory whenever isTestProcess() is true
// and that adapter's own env override is unset. Closes the leak where a
// server-booting test with a fresh GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR still read the
// operator's REAL Antigravity/Gemini/VS Code/agy-cli/Codex/Copilot CLI/
// OpenCode/Hermes/Cline session stores, purely because those adapters'
// defaults derive from the real os.homedir() below, which GLMPS_STATE_DIR/
// GLMPS_CLAUDE_DIR never touch. Scoped per adapter (its own subpath) only so
// two adapters' "missing dir" never collide into looking like the same
// source on disk.
//
// Scoped per RUN, not per bare pid:
// the run segment is the pid plus a random suffix, generated once on first
// call and memoized for the rest of this process's life, so every call
// within one process keeps agreeing on the same dir (needed for a booted
// server to write its state subdirs once and read them back) while a LATER
// process that happens to reuse the same OS pid never lands on an earlier
// run's leftover dir and wrongly finds it "already exists". Exported so the
// handful of call sites that need this exact redirect but have no env/
// profile to hand getPaths() (wiki-agy.js, adapters/index.js's
// detect-only tools) can reuse it directly instead of re-deriving their own
// copy of this path.
let _noRealDataRunId = null;
export function noRealAdapterDataDir(name) {
  if (!_noRealDataRunId) _noRealDataRunId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(os.tmpdir(), 'mc-test-no-real-adapter-data', _noRealDataRunId, name);
}

export function getPaths(env = process.env, profile = null, { processEnv = process.env, argv = process.argv } = {}) {
  const home = os.homedir();
  const testProcess = isTestProcess({ env, processEnv, argv });
  // Phase K final review I1: claudeDir, stateDir, assetsDir and memoryDir
  // follow the same test-process redirect as the adapter stores below. A
  // server-booting test that omits GLMPS_CLAUDE_DIR used to tail the operator's
  // real ~/.claude/projects transcripts; one that omits GLMPS_ASSETS_DIR used
  // the sibling production assets checkout. An explicit override or a
  // profile still wins; production (no test signal) is unchanged.
  const claudeDir = env.GLMPS_CLAUDE_DIR ?? profile?.harness?.claudeDir ?? (testProcess ? noRealAdapterDataDir('claude') : path.join(home, '.claude'));
  const antigravityDirs = env.GLMPS_ANTIGRAVITY_DIR
    ? [env.GLMPS_ANTIGRAVITY_DIR]
    : profile?.harness?.antigravityDir
      ? [profile.harness.antigravityDir]
      : testProcess
        ? [noRealAdapterDataDir('antigravity')]
        : [
            path.join(home, '.gemini', 'antigravity-ide'),
            path.join(home, '.gemini', 'antigravity-cli'),
            path.join(home, '.gemini', 'antigravity'),
          ];
  const antigravityDir = antigravityDirs[0]; // primary (kept for backward compat)
  const stateDir = envStateDirOverride(env) ?? profile?.stateDir ?? (testProcess ? noRealAdapterDataDir('state') : homeStateDir(home));
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  // Hermes agent home: $HERMES_HOME (a persisted user var on Windows), else platform default
  // (%LOCALAPPDATA%\hermes on Windows, ~/.hermes on POSIX). GLMPS_HERMES_DIR overrides (tests).
  const hermesDir = env.GLMPS_HERMES_DIR ?? env.HERMES_HOME
    ?? profile?.harness?.hermesDir
    ?? (testProcess ? noRealAdapterDataDir('hermes') : (process.platform === 'win32' ? path.join(localAppData, 'hermes') : path.join(home, '.hermes')));
  const geminiTmpDir = env.GLMPS_GEMINI_TMP_DIR ?? (testProcess ? noRealAdapterDataDir('gemini-tmp') : path.join(home, '.gemini', 'tmp'));
  // Copilot Chat workspaceStorage roots: every VS Code-family editor on this
  // platform (Code/Insiders/Cursor/VSCodium/Windsurf/Trae + GLMPS_EXTRA_EDITORS),
  // via the shared editor-roots helper. Single-path overrides win (tests).
  const extraEditors = (env.GLMPS_EXTRA_EDITORS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const vscodeStorageDirs = env.GLMPS_VSCODE_STORAGE_DIR
    ? [env.GLMPS_VSCODE_STORAGE_DIR]
    : profile?.harness?.vscodeStorageDir
      ? [profile.harness.vscodeStorageDir]
      : testProcess
        ? [noRealAdapterDataDir('vscode-storage')]
        : workspaceStorageDirs({ env, home, extra: extraEditors }).map(e => e.dir);
  const agyCliDir = env.GLMPS_AGY_CLI_DIR ?? (testProcess ? noRealAdapterDataDir('agy-cli') : path.join(home, '.gemini', 'antigravity-cli'));

  // OpenCode base: $OPENCODE_HOME, else $XDG_DATA_HOME/opencode, else ~/.local/share/opencode.
  // GLMPS_OPENCODE_DIR overrides all of the above (used by tests).
  const opencodeDir = env.GLMPS_OPENCODE_DIR
    ?? env.OPENCODE_HOME
    ?? profile?.harness?.opencodeDir
    ?? (env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode') : (testProcess ? noRealAdapterDataDir('opencode') : path.join(home, '.local', 'share', 'opencode')));

  // Codex base: $CODEX_HOME, else ~/.codex. GLMPS_CODEX_DIR overrides (tests).
  const codexDir = env.GLMPS_CODEX_DIR ?? env.CODEX_HOME ?? profile?.harness?.codexDir ?? (testProcess ? noRealAdapterDataDir('codex') : path.join(home, '.codex'));

  // GitHub Copilot CLI base: ~/.copilot (sessions live under session-state/<id>/events.jsonl).
  // GLMPS_COPILOT_CLI_DIR overrides (tests).
  const copilotCliDir = env.GLMPS_COPILOT_CLI_DIR ?? profile?.harness?.copilotCliDir ?? (testProcess ? noRealAdapterDataDir('copilot-cli') : path.join(home, '.copilot'));

  // Cursor CLI home (~/.cursor): transcripts under projects/, chat meta under chats/. GLMPS_CURSOR_DIR overrides.
  const cursorDir = env.GLMPS_CURSOR_DIR ?? (testProcess ? noRealAdapterDataDir('cursor') : path.join(home, '.cursor'));

  // Grok home: $GROK_HOME, else ~/.grok (sessions live under sessions/). GLMPS_GROK_DIR overrides.
  const grokDir = env.GLMPS_GROK_DIR ?? env.GROK_HOME ?? (testProcess ? noRealAdapterDataDir('grok') : path.join(home, '.grok'));

  // Pi agent dir: $PI_CODING_AGENT_DIR, else ~/.pi/agent (sessions live under sessions/). GLMPS_PI_DIR overrides.
  const piDir = env.GLMPS_PI_DIR ?? env.PI_CODING_AGENT_DIR ?? (testProcess ? noRealAdapterDataDir('pi') : path.join(home, '.pi', 'agent'));

  // Factory Droid home (~/.factory): sessions/ and projects/. GLMPS_FACTORY_DIR overrides.
  const factoryDir = env.GLMPS_FACTORY_DIR ?? (testProcess ? noRealAdapterDataDir('factory') : path.join(home, '.factory'));

  // Cline / Roo extension state lives in each VS Code-family editor's User/globalStorage.
  const clineStorageDirs = env.GLMPS_CLINE_STORAGE_DIR
    ? [env.GLMPS_CLINE_STORAGE_DIR]
    : testProcess
      ? [noRealAdapterDataDir('cline-storage')]
      : globalStorageDirs({ env, home, extra: extraEditors }).map(e => e.dir);

  // OpenClaw state dir, current name first then the legacy one. GLMPS_OPENCLAW_DIR overrides.
  const openclawDirs = env.GLMPS_OPENCLAW_DIR
    ? [env.GLMPS_OPENCLAW_DIR]
    : testProcess
      ? [noRealAdapterDataDir('openclaw')]
      : [path.join(home, '.openclaw'), path.join(home, '.clawdbot')];

  const assetsDir = env.GLMPS_ASSETS_DIR ?? profile?.assetsDir ?? (testProcess ? noRealAdapterDataDir('assets') : DEFAULT_ASSETS_DIR);
  const addonsDir = env.GLMPS_ADDONS_DIR ?? profile?.addonsDir ?? (testProcess ? noRealAdapterDataDir('addons') : DEFAULT_ADDONS_DIR);
  const memoryDir = env.GLMPS_MEMORY_DIR ?? path.join(claudeDir, 'projects', DEFAULT_MEMORY_DIR_NAME, 'memory');

  return {
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    activeSessionsFile: path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    claudeSessionsDir: path.join(claudeDir, 'sessions'),
    cmTap: path.join(claudeDir, '.claude-manager', 'statusline-tap.js'),
    settingsFile: path.join(claudeDir, 'settings.json'),
    credentialsFile: path.join(claudeDir, '.credentials.json'),
    cmStatuslineFile: path.join(claudeDir, '.claude-manager', 'statusline.json'),
    pluginsCacheDir: path.join(claudeDir, 'plugins', 'cache'),
    antigravityDirs,
    antigravityDir, // first entry; kept for consumers that need a single root
    brainDir: path.join(antigravityDir, 'brain'),
    geminiTmpDir,
    vscodeStorageDirs,
    stateDir,
    legacyStateDir: env.GLMPS_LEGACY_STATE_DIR ? env.GLMPS_LEGACY_STATE_DIR : testProcess ? noRealAdapterDataDir('legacy-state') : legacyStateDirFor(home),
    stateSubdirs: stateSubdirs(stateDir),
    offsetsFile: path.join(stateDir, 'state', 'offsets.json'),
    indexFile: path.join(stateDir, 'state', 'index.json'),
    alertAcksFile: path.join(stateDir, 'state', 'alert-acks.json'),
    adapterHealthFile: path.join(stateDir, 'state', 'adapter-health.json'),
    graphSyncHealthFile: path.join(stateDir, 'state', 'graph-sync-health.json'),
    graphIntegrityFile: path.join(stateDir, 'state', 'graph-integrity.json'),
    // The Settings panel's machine-scan switch and per-repo opt-ins, layered
    // over config.json's graph block (observability/graph-machine.js).
    graphMachineFile: path.join(stateDir, 'state', 'graph-machine.json'),
    // One small file per SCUT Slack channel that currently cannot read its own
    // thread (glmps-44); written by the channel-server.js child
    // process, read fresh here on every /api/alerts pass. server/lib/scut/
    // channel-health.js#channelHealthDir derives this exact suffix from
    // GLMPS_STATE_DIR independently (that child does not import paths.js) - keep
    // the two literal segments identical or the writer and the reader silently
    // stop agreeing on where the data lives.
    scutChannelHealthDir: path.join(stateDir, 'state', 'scut-channel-health'),
    alertSeenFile: path.join(stateDir, 'state', 'alert-seen.json'),
    internalSessionsFile: path.join(stateDir, 'state', 'internal-sessions.json'),
    outcomesDir: env.GLMPS_OUTCOME_DIR ?? path.join(stateDir, 'outcomes'),
    // Durable append-only event-log NDJSON dir (server/lib/observability/event-log.js).
    // GLMPS_EVENT_LOG_DIR overrides (tests).
    eventLogDir: env.GLMPS_EVENT_LOG_DIR ?? path.join(stateDir, 'events'),
    statusDir: path.join(stateDir, 'status'),
    undoDir: path.join(stateDir, 'undo'),
    worktreesDir: env.GLMPS_WORKTREES_DIR ?? path.join(stateDir, 'runner', 'worktrees'),
    doneGateDir: env.GLMPS_DONE_GATE_DIR ?? path.join(stateDir, 'done-gate'),
    workspaceDir: env.GLMPS_WORKSPACE_DIR ?? path.join(stateDir, 'workspace'),
    agyCliDir,
    opencodeDir,
    codexDir,
    copilotCliDir,
    cursorDir,
    grokDir,
    piDir,
    factoryDir,
    clineStorageDirs,
    openclawDirs,
    // GitHub Copilot CLI OTel file-exporter output dir (tailed for token/credit/latency).
    // GLMPS_COPILOT_OTEL_DIR overrides (tests).
    copilotOtelDir: env.GLMPS_COPILOT_OTEL_DIR ?? path.join(stateDir, 'otel', 'copilot'),
    hermesDir,
    assetsDir,
    // Where approved lessons are committed and pushed (the dev clone, dev/prod T5); null keeps the read dir.
    assetsWriteDir: env.GLMPS_ASSETS_WRITE_DIR || null,
    addonsDir,
    memoryDir,
    agentsDir: env.GLMPS_AGENTS_DIR ?? path.join(assetsDir, 'agents'),
    zoneConfig: (() => {
      if (!env.GLMPS_ZONE_CONFIG) return DEFAULT_ZONE_CONFIG;
      try { return JSON.parse(env.GLMPS_ZONE_CONFIG); } catch { return DEFAULT_ZONE_CONFIG; }
    })(),
    repoRoots: profile?.repoRoots ?? [],
    profile: profile ?? null,
  };
}

export function configFileFor({ env = process.env, repoRoot = _repoRoot } = {}) {
  return env.GLMPS_CONFIG_FILE || path.join(repoRoot, 'config.json');
}

export function graphPathFor(projectRoot) {
  if (!projectRoot) return null;
  for (const rel of ['graphify-out/graph.json', 'server/graphify-out/graph.json']) {
    const f = path.join(projectRoot, rel);
    try { if (fs.existsSync(f)) return f; } catch {}
  }
  return null;
}

export function ensureStateDirs(p) {
  // 'requests' was the companion's drained request file's
  // parent dir; D20 deleted requestsFile from the path table, so making this
  // dir unconditionally on every boot is now an orphan with no reader.
  for (const d of ['state', 'status', 'undo'])
    fs.mkdirSync(path.join(p.stateDir, d), { recursive: true });
}

// Reports whether state data should be migrated from the legacy location.
// Returns { migrateFrom: string } when the legacy dir exists and the active
// stateDir does not; returns { migrateFrom: null } in all other cases.
// Does NOT move or modify any files.
// fsmod is injectable for testing (default: the module's fs).
export function stateDirMigration({ stateDir, legacyStateDir }, fsmod = fs) {
  try {
    if (legacyStateDir && fsmod.existsSync(legacyStateDir) && !fsmod.existsSync(stateDir))
      return { migrateFrom: legacyStateDir };
  } catch {}
  return { migrateFrom: null };
}

// server/lib/chassis/setup-status.js
// The desktop setup wizard's health report: what is installed and signed in on
// this machine, as one JSON-able object. Pure assembly: every probe (run,
// readFile, exists, loadCreds) is injected so it tests without claude, gh,
// winget or a disk. scripts/setup/setup-status.mjs wires the real ones.
// Fail open: a probe that throws degrades its own section to "not there".
import { checkDeps, planDeps } from './deps.js';
import { validateCreds } from '../scut/config.js';
import { TARGET_IDS, TARGET_LABELS } from '../orchestration/editor-targets.js';
import { editorCommand, companionInstalled } from '../orchestration/editor-detect.js';

export const REQUIRED_GH_SCOPES = Object.freeze(['repo', 'workflow', 'read:org']);

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

// `gh auth status` prints "Token scopes: 'a', 'b'" (older versions: bare names).
// Returns null when there is no such line, which means "cannot tell".
export function parseGhScopes(text) {
  const m = /Token scopes:\s*(.*)/i.exec(String(text ?? ''));
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function claudeStatus(run, installed) {
  if (!installed) return { installed: false, signedIn: false };
  const r = safe(() => run(['claude', 'auth', 'status', '--json']), null);
  let signedIn = r?.status === 0;
  try {
    const parsed = JSON.parse(r?.stdout ?? '');
    if (typeof parsed?.loggedIn === 'boolean') signedIn = parsed.loggedIn;
  } catch { /* not JSON: the exit code stands */ }
  return { installed: true, signedIn };
}

function githubStatus(run, installed) {
  if (!installed) return { installed: false, signedIn: false, scopes: [], missingScopes: [] };
  const r = safe(() => run(['gh', 'auth', 'status']), null);
  const signedIn = r?.status === 0;
  const scopes = signedIn ? parseGhScopes(`${r.stdout ?? ''}\n${r.stderr ?? ''}`) : null;
  return {
    installed: true,
    signedIn,
    scopes: scopes ?? [],
    missingScopes: scopes ? REQUIRED_GH_SCOPES.filter((s) => !scopes.includes(s)) : [],
  };
}

function hooksInstalled(readFile, file) {
  const rec = safe(() => JSON.parse(readFile(file)), null);
  return Boolean(rec && ((rec.entries?.length ?? 0) > 0 || (rec.added?.length ?? 0) > 0));
}

// Every launch target with whether it is installed and has the GLMPS companion.
// native-terminal needs neither, so it always reads installed.
function editorRows({ home, programFiles, exists, readdir }) {
  return TARGET_IDS.map((id) => ({
    id,
    label: TARGET_LABELS[id],
    installed: id === 'native-terminal' || safe(() => editorCommand(id, { home, programFiles, exists }) !== null, false),
    companion: safe(() => companionInstalled(id, { home, readdir }), false),
  }));
}

// slackLive: the probe script's checkSlackTokens result on the saved tokens, or
// null when it did not run (the offline first probe, or no tokens saved).
// home, programFiles, editorExists, readdir and runnerConfig feed the Default
// IDE step; all are optional so a caller that does not pass them still works.
export function buildSetupStatus({ run, latest = {}, loadCreds, exists, readFile, hooksRecordFile, profilePath, slackLive = null,
  home = null, programFiles = [], editorExists = exists, readdir, runnerConfig = null }) {
  const results = safe(() => checkDeps(run).results, []);
  const present = (name) => results.find((r) => r.name === name)?.present === true;
  return {
    deps: planDeps(results, latest),
    claude: claudeStatus(run, present('claude')),
    github: githubStatus(run, present('gh')),
    slack: {
      saved: safe(() => validateCreds(loadCreds()).ok, false),
      ...(slackLive ? { live: {
        ok: slackLive.ok === true,
        error: slackLive.ok === true ? null : String(slackLive.error ?? 'unknown'),
        ...(slackLive.unreachable ? { unreachable: true } : {}),
      } } : {}),
    },
    hooks: { installed: hooksInstalled(readFile, hooksRecordFile) },
    profile: { path: profilePath ?? null, exists: profilePath ? safe(() => exists(profilePath), false) : false },
    editors: editorRows({ home, programFiles, exists: editorExists, readdir }),
    editorPick: { lastTarget: runnerConfig?.lastTarget ?? null, openTarget: runnerConfig?.openTarget ?? null },
  };
}

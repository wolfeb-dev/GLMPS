// server/lib/governance/private-text-scan.js
// The private-text scan (card glmps-2-0-193). One home for the patterns the
// release builder uses to keep personal paths and dev history out of anything
// that ships, so the wiki build can apply the same rules to the pages it writes.
// It lives under server/ because the kernel ships and scripts/release-* does not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A build run by the kernel service reports LocalSystem's name ("SYSTEM") as
// the account; that name, its two service siblings and a machine account
// (HOST$) identify no person, and matching them flags the plain word "system".
const BUILTIN_ACCOUNT = /^(system|local service|network service|.*\$)$/i;

// The public-flip scan (the PII gate the public mirror runs before a push):
// a public artifact may not name a local drive or home path, a .gemini brain
// dir, or the building user's own account name.
export function publicScanPatterns(privateNames = []) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Each pattern matches the whole token (the path, not just its drive letter),
  // so an exception can pin the exact text it excuses.
  return [
    { name: 'drive path', re: /\b[A-Za-z]:[\\/][^\s"'`<>)\],;|]*/g },
    { name: 'home path', re: /(?<![\w.])\/(?:Users|home)\/[^/\s"]+/g },
    { name: '.gemini dir', re: /\.gemini[\\/][^\s"'`<>)\],;|]*/g },
    ...privateNames.filter((n) => typeof n === 'string' && n.length >= 3 && !BUILTIN_ACCOUNT.test(n.trim()))
      .map((n) => ({ name: `name ${n}`, re: new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'gi') })),
  ];
}

// Every distinct match of every pattern, not just the first: a second private
// path in a file must not hide behind the first.
export function publicScanHits(text, patterns) {
  const out = [];
  for (const { name, re } of patterns) {
    const g = re.global ? re : new RegExp(re.source, re.flags + 'g');
    const seen = new Set();
    for (const m of text.matchAll(g)) {
      // Trailing sentence dots are not part of the path.
      const token = m[0].replace(/\.+$/, '') || m[0];
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ pattern: name, match: token, sample: text.slice(Math.max(0, m.index - 40), m.index + 60) });
    }
  }
  return out;
}

// Ticket ids and a GLMPS memory block are dev
// history; none belongs in an instruction or agent file a customer reads.
export const HISTORY_PATTERNS = [
  { name: 'ticket id', re: /\b(glmps-2-0-(runtime-)?\d+|mc-\d{1,3})\b/ },
  { name: 'memory block', re: /GLMPS-managed cross-agent memory|^## Cross-Agent Memory/m },
];

// What the installer stage refuses in a shipped file (card glmps-2-0-199). The
// wiki checker and the code map apply the same set, so a build that publishes is
// a build the stage accepts.
export function shipTextPatterns(privateNames = []) {
  return [...publicScanPatterns(privateNames), ...HISTORY_PATTERNS];
}

// Built-in accounts are not a person's name, and words like "system" or "admin"
// are ordinary prose: the GLMPS2 service runs as SYSTEM, and treating that as
// private failed every wiki rebuild.
const BUILTIN_ACCOUNTS = new Set(['system', 'localsystem', 'local service', 'localservice', 'network service',
  'networkservice', 'root', 'administrator', 'admin', 'guest', 'default', 'defaultuser0', 'runner', 'nobody', 'public']);

// The building account's name plus the user folder each path sits under, so a
// service build whose state dir is in the operator's profile still knows his name.
export function personalAccountNames({ username = null, paths = [] } = {}) {
  const out = new Map();
  const add = (n) => {
    if (typeof n !== 'string') return;
    const t = n.trim();
    if (t.length < 3 || BUILTIN_ACCOUNTS.has(t.toLowerCase()) || BUILTIN_ACCOUNT.test(t)) return;
    if (!out.has(t.toLowerCase())) out.set(t.toLowerCase(), t);
  };
  add(username);
  for (const p of paths) {
    const m = /[\\/](?:Users|home)[\\/]([^\\/]+)/i.exec(String(p ?? ''));
    if (m) add(m[1]);
  }
  return [...out.values()];
}

// The names of the account running this process and of the profile its state
// dir lives in. Fail open (no OS name) when the OS will not say.
export function buildingAccountNames(stateDir = null) {
  let username = null;
  try { username = os.userInfo().username; } catch { username = null; }
  return personalAccountNames({ username, paths: [stateDir, os.homedir()] });
}

// The product's own names (and its runner worktrees) are not private.
const PRODUCT_NAME = /^(glmps|mission[-_ ]?control|scut)([-_. ]|$)/i;

// The building machine's other projects: board project names and the folder
// name of every repo the agent sessions are allowed into. A shipped file that
// names one leaks what the maintainer works on (card glmps-2-0-220), so the
// scan learns them here instead of anyone writing them into source.
export function projectNames({ projects = [], dirs = [] } = {}) {
  const out = new Map();
  const add = (n) => {
    if (typeof n !== 'string') return;
    const t = n.trim();
    // The board files unassigned cards under "default", an ordinary word.
    if (t.length < 3 || PRODUCT_NAME.test(t) || BUILTIN_ACCOUNTS.has(t.toLowerCase())) return;
    if (!out.has(t.toLowerCase())) out.set(t.toLowerCase(), t);
  };
  for (const p of projects) add(p);
  for (const d of dirs) add(String(d ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop());
  return [...out.values()];
}

// The Slack settings name the installation's projects (card glmps-2-0-220 moved
// them out of code), and a project can live only there (card glmps-2-0-225).
function slackSettingsProjects(stateDir) {
  if (!stateDir) return [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'scut-settings.json'), 'utf8'));
    const systems = s?.projectSystems && typeof s.projectSystems === 'object' && !Array.isArray(s.projectSystems) ? Object.keys(s.projectSystems) : [];
    return [...systems, ...(Array.isArray(s?.defaultProjects) ? s.defaultProjects : [])];
  } catch { return []; }
}

// Reads the board, the agent settings' additionalDirectories and the Slack
// settings. Fail open: a missing or unreadable source names fewer projects,
// never throws.
export function buildingProjectNames({ stateDir = null, claudeSettingsFile = null, loadBoard = null } = {}) {
  let projects = [];
  try { projects = (loadBoard?.(stateDir)?.items ?? []).map((i) => i?.project); } catch { projects = []; }
  projects = [...projects, ...slackSettingsProjects(stateDir)];
  let dirs = [];
  try {
    const d = claudeSettingsFile ? JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8'))?.permissions?.additionalDirectories : null;
    if (Array.isArray(d)) dirs = d;
  } catch { dirs = []; }
  return projectNames({ projects, dirs });
}

// Everything a public build must not name: the building account and its projects.
export function buildingPrivateNames(opts = {}) {
  return [...new Set([...buildingAccountNames(opts.stateDir ?? null), ...buildingProjectNames(opts)])];
}

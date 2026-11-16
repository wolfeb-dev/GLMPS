// server/lib/governance/role-permissions.js
//
// Role-scoped session permissions for the merge queue. The GLMPS server merges
// PRs itself, so a Claude session must never merge or land work on an
// integration branch. A runner-launched session has a role: 'worker' (every
// card session) or 'reviewer' (one per merge request, may push only the PR's
// own head branch). The runner passes the role as a per-role --settings file
// (permissions.deny plus an env block that carries GLMPS_ROLE to the session
// and its hooks); the push-lease-guard hook calls checkRoleCommand on every
// Bash command as the second layer.
//
// Pure except writeRoleSettings. No role means no restriction (interactive
// sessions behave as before), and anything unparseable is allowed: fail open.
import fs from 'node:fs';
import path from 'node:path';
import { simpleCommands } from './shell-commands.js';
import { isFullSuiteRun, FULL_SUITE_REASON } from './full-suite-guard.js';

export const DEFAULT_INTEGRATION_BRANCHES = ['main', 'master', 'glmps2/main'];
const ROLES = ['worker', 'reviewer'];
const MERGE_DENY = ['Bash(gh pr merge:*)', 'Bash(gh pr merge *)'];

export function normalizeRole(role) {
  const r = String(role ?? '').trim().toLowerCase();
  return ROLES.includes(r) ? r : null;
}

export function roleSettings({ role, reviewHead, integrationBranches, cardId } = {}) {
  const r = normalizeRole(role);
  if (!r) return null;
  const env = { GLMPS_ROLE: r };
  // hooks/lib/card-context.js falls back to GLMPS_CARD_ID once the session leaves
  // its runner branch for a feature worktree.
  if (r === 'worker' && cardId) env.GLMPS_CARD_ID = String(cardId);
  if (r === 'reviewer' && reviewHead) env.GLMPS_REVIEW_HEAD = String(reviewHead);
  if (Array.isArray(integrationBranches) && integrationBranches.length) {
    env.GLMPS_INTEGRATION_BRANCHES = integrationBranches.join(',');
  }
  return { permissions: { deny: [...MERGE_DENY] }, env };
}

// A file rather than inline JSON: the launch command is re-parsed by cmd.exe,
// PowerShell and POSIX sh, and JSON quotes do not survive all three.
export function writeRoleSettings(stateDir, { role, reviewHead, integrationBranches, cardId, key = '' } = {}) {
  const settings = roleSettings({ role, reviewHead, integrationBranches, cardId });
  if (!settings) return null;
  const safe = String(key || normalizeRole(role)).replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = path.join(stateDir, 'role-settings', `${normalizeRole(role)}-${safe}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

export function parseIntegrationBranches(raw) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_INTEGRATION_BRANCHES;
}

// Global git options that consume the following token.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
// push options that consume the following token.
const PUSH_WITH_VALUE = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec', '--signed']);

function parseGitPush(tokens) {
  if (tokens[0] !== 'git') return null;
  let i = 1;
  let dir = null;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '-C') { dir = tokens[i + 1] ?? null; i += 2; continue; }
    i += GIT_GLOBAL_WITH_VALUE.has(t) ? 2 : 1;
  }
  if (tokens[i] !== 'push') return null;
  i += 1;
  const pos = [];
  let all = false;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--all' || t === '--mirror') { all = true; continue; }
    if (t.startsWith('-')) {
      if (PUSH_WITH_VALUE.has(t)) i += 1;
      continue;
    }
    pos.push(t);
  }
  return { dir, all, remote: pos[0] ?? null, specs: pos.slice(1) };
}

function dstOf(spec) {
  const s = spec.replace(/^\+/, '');
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return dst.replace(/^refs\/heads\//, '');
}

function pushTargets(push, resolve) {
  if (push.all) return { all: true, targets: [] };
  let ctx = null;
  const ctxOf = () => { ctx ??= resolve(push.dir) ?? {}; return ctx; };
  if (!push.specs.length) {
    const c = ctxOf();
    return { all: false, targets: [c.upstream || c.branch].filter(Boolean) };
  }
  const targets = push.specs.map((spec) => {
    const dst = dstOf(spec);
    return dst === 'HEAD' ? ctxOf().branch : dst;
  }).filter(Boolean);
  return { all: false, targets };
}

const GH_PR_MERGE = /^gh(\s.*)?\s+pr\s+merge(\s|$)/;
const GH_API_MERGE = /\/pulls\/[^\s/"']+\/merge\b|\bmergePullRequest\b/;

const FILE_MR = 'File a merge request through the GLMPS server instead; sessions do not merge or push to integration branches.';

/**
 * @param {{ command: string, role?: string, reviewHead?: string, integrationBranches?: string[],
 *           resolve?: (dir: string|null) => { branch?: string, upstream?: string } }} p
 * @returns {{ block: boolean, reason?: string }}
 */
export function checkRoleCommand({ command, role, reviewHead, integrationBranches, resolve = () => ({}) } = {}) {
  const r = normalizeRole(role);
  if (!r) return { block: false };
  try {
    const integration = integrationBranches?.length ? integrationBranches : DEFAULT_INTEGRATION_BRANCHES;
    for (const { tokens, seg } of simpleCommands(command)) {
      if (GH_PR_MERGE.test(seg)) {
        return { block: true, reason: `a ${r} session may not merge a pull request. ${FILE_MR}` };
      }
      if (/^gh\s+api\b/.test(seg) && GH_API_MERGE.test(seg)) {
        return { block: true, reason: `a ${r} session may not merge a pull request through the API. ${FILE_MR}` };
      }
      if (isFullSuiteRun(tokens)) return { block: true, reason: `a ${r} ${FULL_SUITE_REASON}` };
      const push = parseGitPush(tokens);
      if (!push) continue;
      const { all, targets } = pushTargets(push, resolve);
      if (all) {
        return { block: true, reason: `a ${r} session may not push all branches. ${FILE_MR}` };
      }
      if (r === 'worker') {
        const hit = targets.find((t) => integration.includes(t));
        if (hit) return { block: true, reason: `a worker session may not push to the integration branch '${hit}'. ${FILE_MR}` };
      } else {
        const bad = targets.find((t) => !reviewHead || t !== reviewHead);
        if (bad || (!targets.length && push.specs.length)) {
          return {
            block: true,
            reason: `a reviewer session may push only the pull request head branch '${reviewHead || '(unset)'}', not '${bad ?? 'HEAD'}'.`,
          };
        }
      }
    }
  } catch {
    return { block: false };
  }
  return { block: false };
}

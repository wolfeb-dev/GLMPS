#!/usr/bin/env node
// PreToolUse/PostToolUse hook: serialize agent sessions on a repo's shared
// integration ref (main), so two sessions cannot concurrently advance it.
//
// Why this exists: on 2026-07-22 two sessions in <repo> collided
// while BOTH were correctly isolated -- own branch, own worktree. Session B
// integrated with `git push origin HEAD:main` from a worktree; session A merged
// into local main in the primary tree. 12 pushes to origin/main in 3 hours,
// alternating. Every existing control is scoped to EDITS, so nothing objected.
// Decision logic is in the pure cores (server/lib/governance/push-lease*.js);
// this entry holds I/O, git lookups and the override.
//
// It also enforces runner roles (GLMPS_ROLE=worker|reviewer): see
// server/lib/governance/role-permissions.js. No role set = no change.
//
// Stdin: Claude Code hook JSON { tool_name, tool_input, cwd, session_id, hook_event_name }.
// PreToolUse : exit 0 = allow; exit 2 + stderr = block, reason fed back to the agent.
// PostToolUse: releases the lease after a push to the protected ref.
//
// Config:
//   GLMPS_PUSH_LEASE_TTL_MS   lease lifetime, default 15 min.
//   GLMPS_PORT                GLMPS port for the liveness check (default 8123).
// Bypass, for a deliberate operator override (D30 item 2: the hook's OWN environment only):
//   GLMPS_ALLOW_PUSH_LEASE=1 in the hook's environment (settings.json hook env or the
//   operator's shell). A 'push-lease.allow' file in the cwd is NOT honoured, since
//   the guarded agent could create it; when present it is ignored with a one-line
//   stderr notice.
// Opt out per repo:
//   a 'push-lease.off' file in the repo root.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRefIntent, evaluateLease, DEFAULT_TTL_MS } from '../server/lib/governance/push-lease.js';
import { readLease, writeLease, clearLease } from '../server/lib/governance/push-lease-store.js';
import { checkRoleCommand, parseIntegrationBranches } from '../server/lib/governance/role-permissions.js';

const PORT = process.env.GLMPS_PORT || '8123';
const HTTP_TIMEOUT_MS = Number(process.env.GLMPS_HOOK_HTTP_TIMEOUT_MS) || 3000;

// Cheap pre-filter so the overwhelming majority of Bash calls cost nothing:
// no git subprocess, no fetch, no file I/O.
const MAYBE_ADVANCES = /\bgit\b[\s\S]*\b(push|merge|commit)\b/;
const ROLE_PREFILTER = /\bgit\b[\s\S]*\bpush\b|\bgh\b/;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// The ref this repo integrates on. origin/HEAD is authoritative; fall back to
// whichever of main/master actually exists.
function protectedRefFor(cwd) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (head) return head.replace(/^[^/]+\//, '');
  for (const c of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${c}`], cwd)) return c;
  }
  return '';
}

function upstreamRefFor(cwd) {
  const u = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  return u ? u.replace(/^[^/]+\//, '') : '';
}

async function liveSessionIds() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions/live`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data?.sessions) ? data.sessions : null;
    return list ? list.map((s) => s.id ?? s.sessionId).filter(Boolean) : null;
  } catch {
    return null; // unknown liveness. NOT "everyone is dead" -- see evaluateLease.
  }
}

function bypassed(cwd) {
  if (process.env.GLMPS_ALLOW_PUSH_LEASE === '1') return true;
  try {
    if (fs.existsSync(path.join(cwd, 'push-lease.allow'))) {
      process.stderr.write("[push-lease-guard] 'push-lease.allow' in the working directory is ignored; set GLMPS_ALLOW_PUSH_LEASE=1 in the hook's environment.\n");
    }
  } catch { /* notice only */ }
  return false;
}

function optedOut(repoRoot) {
  try { return !!repoRoot && fs.existsSync(path.join(repoRoot, 'push-lease.off')); } catch { return false; }
}

async function main(inp) {
  if (inp.tool_name !== 'Bash') return 0;
  const command = String(inp.tool_input?.command ?? '');
  const cwd = inp.cwd || process.cwd();

  // Role refusal runs first and ignores the lease bypasses: a worker or reviewer
  // must not be able to lift it by dropping a file in its own worktree.
  if (inp.hook_event_name !== 'PostToolUse' && ROLE_PREFILTER.test(command)) {
    const verdict = checkRoleCommand({
      command,
      role: process.env.GLMPS_ROLE,
      reviewHead: process.env.GLMPS_REVIEW_HEAD,
      integrationBranches: parseIntegrationBranches(process.env.GLMPS_INTEGRATION_BRANCHES),
      resolve: (dir) => {
        const at = dir ? path.resolve(cwd, dir) : cwd;
        return { branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], at), upstream: upstreamRefFor(at) };
      },
    });
    if (verdict.block) {
      process.stderr.write(`[push-lease-guard] BLOCKED (${process.env.GLMPS_ROLE} role): ${verdict.reason}\n`);
      return 2;
    }
  }

  if (!MAYBE_ADVANCES.test(command)) return 0;

  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!commonDir) return 0; // not a git repo
  const repoRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (optedOut(repoRoot)) return 0;

  const protectedRef = protectedRefFor(cwd);
  if (!protectedRef) return 0;

  const intent = parseRefIntent({
    command,
    currentBranch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    protectedRef,
    upstreamRef: upstreamRefFor(cwd),
  });
  if (!intent.advances) return 0;

  const selfId = inp.session_id || inp.sessionId || null;
  const isPost = inp.hook_event_name === 'PostToolUse';

  // Release after the push completes so holds stay short; the TTL is the backstop.
  if (isPost) {
    const lease = readLease(commonDir);
    if (intent.kind === 'push' && lease && lease.sessionId === selfId) clearLease(commonDir);
    return 0;
  }

  if (bypassed(cwd)) return 0;

  const decision = evaluateLease({
    intent,
    lease: readLease(commonDir),
    selfId,
    liveSessionIds: await liveSessionIds(),
    nowMs: Date.now(),
    ttlMs: Number(process.env.GLMPS_PUSH_LEASE_TTL_MS) || DEFAULT_TTL_MS,
  });

  if (decision.action === 'block') {
    process.stderr.write(
      `[push-lease-guard] BLOCKED: another session holds '${protectedRef}' in this repo.\n` +
      `  ${decision.reason}\n` +
      `Two sessions advancing one integration ref is the 2026-07-22 collision: 12 alternating\n` +
      `pushes to origin/main in 3 hours and a main that went stale under an active merge.\n` +
      `Wait for the holder to finish (the lease self-releases on push, or expires), integrate\n` +
      `into your own branch instead, or override deliberately with GLMPS_ALLOW_PUSH_LEASE=1.\n`,
    );
    return 2;
  }

  const now = Date.now();
  const prior = decision.action === 'renew' ? readLease(commonDir) : null;
  writeLease(commonDir, {
    ref: protectedRef,
    sessionId: selfId,
    cwd,
    acquiredAt: prior?.acquiredAt ?? now,
    renewedAt: now,
  });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', async () => {
    let code = 0;
    try {
      code = await main(JSON.parse(raw || '{}'));
    } catch {
      code = 0; // fail open: a broken guard must not brick every Bash call
    }
    process.exit(code);
  });
  process.stdin.on('error', () => process.exit(0));
}

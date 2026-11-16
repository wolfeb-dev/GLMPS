// server/lib/governance/push-lease.js
//
// Pure decision core for the push-lease guard. Two agent sessions must not
// concurrently hold the shared integration ref (main). The 2026-07-22 collision:
// both sessions were correctly isolated (own branch, own worktree) and still
// fought, because every existing control is scoped to EDITS and nothing guards
// INTEGRATION. `git push origin HEAD:main` from an isolated worktree violates no
// rule and is exactly what broke.
//
// No I/O. The hook resolves currentBranch/upstreamRef/protectedRef and owns the
// lease file; this module only classifies commands and decides.

import { simpleCommands } from './shell-commands.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// Only simple commands that actually invoke git are classified, so `echo "git
// push origin main"` cannot trip the guard. simpleCommands sees through
// separators, subshells, env/command/exec and bash -c style wrappers, since
// sessions here chain constantly.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// Positional args of a git invocation, with global options (and their values) dropped.
function positionals(tokens) {
  const out = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (GIT_OPTS_WITH_VALUE.has(t)) i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

// Does this push land on protectedRef?
function pushHitsRef(tokens, protectedRef, upstreamRef) {
  const pos = positionals(tokens); // e.g. ['push','origin','HEAD:main']
  if (pos[0] !== 'push') return false;
  const refspecs = pos.slice(2); // everything after the remote
  if (!refspecs.length) {
    // Bare `git push`: lands wherever the upstream points.
    return String(upstreamRef ?? '') === protectedRef;
  }
  return refspecs.some((spec) => {
    const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    return dst.replace(/^refs\/heads\//, '') === protectedRef;
  });
}

/**
 * Classify a Bash command as advancing the protected ref.
 * @returns {{ advances: boolean, kind: 'push'|'merge'|'commit'|null, target: string|null }}
 */
export function parseRefIntent({ command, currentBranch, protectedRef, upstreamRef } = {}) {
  const ref = String(protectedRef ?? '');
  const miss = { advances: false, kind: null, target: null };
  if (!ref) return miss;

  const cmds = simpleCommands(command).map((c) => c.tokens).filter((t) => t[0] === 'git');
  if (!cmds.length) return miss;

  const onProtected = String(currentBranch ?? '') === ref;
  let found = null;

  for (const tokens of cmds) {
    const pos = positionals(tokens);
    const verb = pos[0];
    if (verb === 'push' && pushHitsRef(tokens, ref, upstreamRef)) {
      found = 'push'; // strongest signal; stop looking
      break;
    }
    // merge/commit only contend when the protected ref is checked out here.
    if (onProtected && (verb === 'merge' || verb === 'commit') && !found) found = verb;
  }

  return found ? { advances: true, kind: found, target: ref } : miss;
}

function heldSince(lease) {
  return Number(lease?.renewedAt) || Number(lease?.acquiredAt) || 0;
}

/**
 * Decide what to do about the lease for this intent.
 *
 * liveSessionIds may be an array of live session ids, or null when liveness is
 * unknown (dashboard unreachable). Null must NOT be read as "everyone is dead" --
 * that would turn an outage into a free-for-all, which is the exact failure mode
 * that made concurrency-warn useless.
 *
 * @returns {{ action: 'allow'|'acquire'|'renew'|'block', reason?: string }}
 */
export function evaluateLease({ intent, lease, selfId, liveSessionIds, nowMs, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!intent?.advances) return { action: 'allow' };
  if (!lease || !lease.sessionId) return { action: 'acquire', reason: 'no lease held' };

  if (intent.target && lease.ref && lease.ref !== intent.target) {
    return { action: 'acquire', reason: `lease held for a different ref (${lease.ref})` };
  }
  if (lease.sessionId === selfId) return { action: 'renew' };

  const ageMs = Number(nowMs) - heldSince(lease);
  if (ageMs > ttlMs) {
    return { action: 'acquire', reason: `lease expired (stale by ${Math.round((ageMs - ttlMs) / 1000)}s)` };
  }
  if (Array.isArray(liveSessionIds) && !liveSessionIds.includes(lease.sessionId)) {
    return { action: 'acquire', reason: `holder ${lease.sessionId} is not live (dead session)` };
  }

  const mins = Math.max(0, Math.round(ageMs / 60000));
  return {
    action: 'block',
    reason: `session ${lease.sessionId} holds ${intent.target} (held ${mins}m, cwd ${lease.cwd || 'unknown'})`,
  };
}

export { DEFAULT_TTL_MS };

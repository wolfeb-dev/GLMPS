#!/usr/bin/env node
// PermissionDenied hook: every auto-mode classifier denial lands on the owning
// card's devlog, so the operator sees blocks live instead of scanning logs.
//
// The event fires only in auto mode, when the classifier denies a tool call.
// Exit code and stderr are ignored by Claude Code and the only output it reads
// is hookSpecificOutput.retry, which this hook must never set, so it writes
// nothing at all. No card, a board that is down, bad stdin: all silent exit 0.
//
// Card resolution is the same as the K7 hooks (hooks/lib/card-context.js): the
// runner branch glmps-runner/<project>/<card>, else GLMPS_CARD_ID.
// Config: GLMPS_BOARD_URL / GLMPS_PORT (board address), GLMPS_DENIAL_FEED_TIMEOUT_MS
// (default 2000).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCardId, boardUrl } from './lib/card-context.js';
import { denialLine } from '../server/lib/governance/denial-feed.js';

function branchOf(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export async function feedDenial(inp, { env = process.env } = {}) {
  if (inp?.hook_event_name !== 'PermissionDenied') return;
  const cardId = resolveCardId({ branch: branchOf(inp.cwd || process.cwd()), env });
  if (!cardId) return;
  try {
    await fetch(`${boardUrl(env)}/api/backlog/${encodeURIComponent(cardId)}/devlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'denial-feed', text: denialLine(inp) }),
      signal: AbortSignal.timeout(Number(env.GLMPS_DENIAL_FEED_TIMEOUT_MS) || 2000),
    });
  } catch { /* board down or slow: the denial just goes unrecorded */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', async () => {
    try { await feedDenial(JSON.parse(raw || '{}')); } catch { /* fail open */ }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

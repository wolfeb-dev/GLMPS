// server/lib/orchestration/terminal-request.js
// Pure logic for the new-terminal launcher (POST /api/terminal).
// Resolves a requested terminal against the configured list and validates
// cwd, returning a record for server.js to open directly in a native
// terminal via launchNative (D20: the companion this record used to be
// queued for is gone).
import fs from 'node:fs';

// buildTerminalRequest({ terminal, cwd, isolate }, terminals, { now, fsImpl })
//   terminal  - the chosen terminal's label (server resolves the command itself;
//               an arbitrary command string from the client is never trusted)
//   cwd       - optional working directory; if given it must be an existing dir
//   isolate   - optional; when exactly `true`, asks the caller to provision a
//               private git worktree for this session (glmps-71). This module
//               stays pure (no git here) - it just passes the flag through on
//               the record for server.js to act on. Anything other than the
//               boolean `true` is ignored so the record shape never surprises
//               existing consumers.
// Returns { record } on success, or { error } on failure.
export function buildTerminalRequest({ terminal, cwd = null, isolate } = {}, terminals, { now = Date.now(), fsImpl = fs } = {}) {
  const list = Array.isArray(terminals) ? terminals : [];
  const match = list.find(t => t && t.label === terminal);
  if (!match) return { error: 'unknown terminal' };

  let validCwd = null;
  if (cwd != null) {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    try {
      if (!fsImpl.statSync(cwd).isDirectory()) return { error: 'cwd is not a directory' };
    } catch {
      return { error: 'cwd not found' };
    }
    validCwd = cwd;
  }

  const record = {
    type: 'terminal',
    command: typeof match.command === 'string' ? match.command : '',
    cwd: validCwd,
    location: 'editor',
    ts: now,
  };
  if (isolate === true) record.isolate = true;

  return { record };
}

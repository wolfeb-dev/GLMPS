#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): an agent session may not delete local
// files; it copies or renames to <name>.old, and the kernel's old-cleanup loop
// deletes .old files in tracked git repos on a schedule. Operator decision 5,
// 2026-11-01 (card glmps-2-0-runtime-127). Decision logic is in
// server/lib/governance/deletion-guard.js; this entry holds stdin and exit codes.
//
// Who is guarded: a session whose hook environment carries GLMPS_ROLE (every
// runner worker and reviewer). GLMPS_DELETION_GUARD=all in the hook's environment
// guards every session; GLMPS_DELETION_GUARD=off turns the guard off.
//
// Stdin: Claude Code hook JSON { tool_name, tool_input: { command } }.
// Exit 0 = allow; exit 2 + stderr = block, reason fed back to the agent.
// Fails open: a broken guard must not brick every Bash call.
import { fileURLToPath } from 'node:url';
import { checkDeleteCommand, isGuardedSession } from '../server/lib/governance/deletion-guard.js';

const TOOLS = new Set(['Bash', 'PowerShell']);

export function decide(inp, env = process.env) {
  if (!TOOLS.has(inp?.tool_name)) return { code: 0 };
  if (!isGuardedSession(env)) return { code: 0 };
  const verdict = checkDeleteCommand(String(inp.tool_input?.command ?? ''));
  if (!verdict.block) return { code: 0 };
  return { code: 2, message: `[deletion-guard] BLOCKED: ${verdict.matched}\n${verdict.reason}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let code = 0;
    try {
      const r = decide(JSON.parse(raw || '{}'));
      if (r.message) process.stderr.write(r.message);
      code = r.code;
    } catch (e) {
      process.stderr.write(`[deletion-guard] failed open: ${e?.message ?? e}\n`);
      code = 0;
    }
    process.exit(code);
  });
  process.stdin.on('error', () => process.exit(0));
}

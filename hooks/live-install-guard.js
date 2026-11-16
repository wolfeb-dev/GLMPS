#!/usr/bin/env node
// PreToolUse hook: block writes into a live-trading install path so a poisoned
// or autonomous (queue-runner) agent job cannot push changes straight into the
// running trading system. All decision logic is in the pure, tested core
// (server/lib/governance/live-install-guard.js); this entry holds I/O and the override.
//
// Stdin: Claude Code PreToolUse JSON { tool_name, tool_input, cwd, session_id }.
// Exit 0 = allow; exit 2 + stderr = block and feed the reason back to the agent.
//
// Config:
//   GLMPS_LIVE_INSTALL_PATHS  ';'/','/newline-separated live-install path prefixes.
//                          REQUIRED to enable the guard - no path is hardcoded.
//                          Unset/empty = guard disabled. Point it at your live
//                          install root (e.g. in the hook's settings.json env).
// Explicit operator approval (bypass), for a deliberate human deploy:
//   GLMPS_ALLOW_LIVE_INSTALL=1 in the hook's own environment. (F10: a
//   'live-install.allow' file in the cwd is no longer honoured; the guarded
//   agent could create it.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardLiveWrite, parseLivePaths, liveInstallApproved } from '../server/lib/governance/live-install-guard.js';

const DEFAULT_LIVE_PATHS = ''; // no personal path baked in; configure GLMPS_LIVE_INSTALL_PATHS

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const inp = JSON.parse(raw || '{}');
      const cwd = inp.cwd || process.cwd();
      const livePaths = parseLivePaths(process.env.GLMPS_LIVE_INSTALL_PATHS ?? DEFAULT_LIVE_PATHS);
      if (!livePaths.length || liveInstallApproved(process.env)) process.exit(0);
      try {
        if (fs.existsSync(path.join(cwd, 'live-install.allow'))) {
          process.stderr.write("[live-install-guard] 'live-install.allow' in the working directory is ignored; set GLMPS_ALLOW_LIVE_INSTALL=1 in the hook's environment.\n");
        }
      } catch { /* notice only */ }
      const r = guardLiveWrite({ tool_name: inp.tool_name, tool_input: inp.tool_input, livePaths, home: os.homedir(), cwd });
      if (r.blocked) {
        process.stderr.write(
          `[live-install-guard] BLOCKED: ${r.reason}\n` +
          `This is a live-trading install. To allow a deliberate deploy, the operator sets ` +
          `GLMPS_ALLOW_LIVE_INSTALL=1 in the hook's environment.\n`,
        );
        process.exit(2);
      }
      process.exit(0);
    } catch {
      process.exit(0); // fail open: never break tool use on a hook error
    }
  });
}

#!/usr/bin/env node
// Sync ~/.claude/settings.json permissions.additionalDirectories from the git
// repos under GLMPS_PROJECT_ROOTS (path.delimiter-separated, e.g. "D:/" or
// "D:/;E:/work"). No roots set => no-op. Intended to run on session start and
// before launching, so new repos are picked up automatically.
//
// glmps-32: this runs as a global SessionStart hook, which fires on
// EVERY `claude` invocation regardless of mode -- including a headless
// `claude -p ... --output-format json` spawn whose caller parses stdout as a
// single JSON document (e.g. server/lib/plugins/claude-model.js's runClaude,
// the shared model call every D23 loop plugin uses; the original repro was
// the pre-D23 session memory distiller's own such spawn, since retired at
// the D23/D24 cutover). Status output therefore belongs on stderr, never
// stdout: stdout is the CLI's own output channel and any consumer of
// --output-format json is entitled to assume it carries nothing but the
// JSON envelope. Printing here used to go to stdout and silently broke that
// assumption, producing 16 days of 'unparseable' failures in the session
// memory distiller before the consumer side was also hardened to tolerate
// stray stdout lines.
import os from 'node:os';
import path from 'node:path';
import { syncProjectDirs } from '../server/lib/orchestration/project-dirs.js';
import { loadPrivateDirs } from '../server/lib/private-dirs.js';

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const roots = (process.env.GLMPS_PROJECT_ROOTS || '')
  .split(path.delimiter).map((s) => s.trim()).filter(Boolean);

if (!roots.length) {
  console.error('sync-project-dirs: GLMPS_PROJECT_ROOTS not set; nothing to do.');
  process.exit(0);
}

// Private dirs are usable as a job cwd but must never be handed to every
// session (see server/lib/private-dirs.js). The list lives in the state dir,
// never in this repo, so a public mirror never carries the names.
const privateDirs = loadPrivateDirs();

const r = syncProjectDirs({ settingsFile, roots, privateDirs });
if (!r.ok) { console.error('sync-project-dirs: ' + r.reason); process.exit(1); }
const priv = privateDirs.length ? `, ${privateDirs.length} private dir(s) excluded` : '';
console.error(`sync-project-dirs: ${r.changed ? 'updated' : 'unchanged'} (${r.dirs.length} dir(s)${priv})`);

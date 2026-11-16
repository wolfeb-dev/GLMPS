// Prompt-version cohort tag: a short hash of the instruction files that govern
// a session (global + project CLAUDE.md). The guardrail loop mutates these; the
// improvement loop compares outcomes across their revisions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// claudeDir, when given, takes priority over homeDir and is read directly
// (no '.claude' join): a caller that already has getPaths()'s own claudeDir
// (itself redirected off the real home in a test process - Phase K final
// review minors wave) can pass it straight through, instead of reconstructing
// it from homeDir + '.claude', which would re-derive the WRONG dir whenever
// claudeDir isn't literally `${homeDir}/.claude` (an GLMPS_CLAUDE_DIR override,
// or that same test-process redirect).
export function promptVersionFor({ cwd, homeDir, claudeDir } = {}) {
  const globalClaudeMd = claudeDir
    ? path.join(claudeDir, 'CLAUDE.md')
    : (homeDir ? path.join(homeDir, '.claude', 'CLAUDE.md') : null);
  const parts = [];
  for (const f of [
    globalClaudeMd,
    cwd ? path.join(cwd, 'CLAUDE.md') : null,
  ]) {
    if (!f) continue;
    try { parts.push(fs.readFileSync(f, 'utf-8')); } catch { /* absent is fine */ }
  }
  if (!parts.length) return 'prompt-none';
  return 'prompt-' + crypto.createHash('sha256').update(parts.join('\n \n')).digest('hex').slice(0, 8);
}

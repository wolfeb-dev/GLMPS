// server/lib/governance/write-path-guard.js
// The single write-path guard: one rule for what the server may write into
// vendor instruction files inside the repo. Both vendor-file writers (the
// cross-agent-memory push and the governance policy push) target the same
// SUPPORTED_VENDORS files, so the rule is deliberately implemented once - two
// hand-synced copies of a security rule drift, and the stale copy becomes the
// bypass path. The reason strings are part of the interface (they surface in
// push results over HTTP); do not reword them casually.
import path from 'node:path';
import { classifyPath } from '../zones.js';
import { isSecretPath } from './egress-detect.js';
import { guardLiveWrite, parseLivePaths } from './live-install-guard.js';
import { isInsideReal } from './real-path.js';

/**
 * Build the guard callback that distributeMemory()/applyPush() inject as
 * `guard`. Pure over its inputs: no I/O, config resolved once at construction.
 *
 * @param {{ repoRoot: string, liveInstallPaths?: string }} opts
 *   `liveInstallPaths` is the raw config string (';'/','/newline separated).
 * @returns {(targetPath: string) => { allowed: boolean, reason?: string }}
 */
export function makeWritePathGuard({ repoRoot, liveInstallPaths } = {}) {
  const rootResolved = path.resolve(repoRoot);
  const livePaths = parseLivePaths(liveInstallPaths ?? '');
  return (targetPath) => {
    if (path.isAbsolute(targetPath) || targetPath.includes('..'))
      return { allowed: false, reason: 'Path must be relative with no ".." components' };
    const abs = path.resolve(repoRoot, targetPath);
    if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved)
      return { allowed: false, reason: 'Path escapes REPO_ROOT' };
    if (!isInsideReal(abs, rootResolved))
      return { allowed: false, reason: 'Path escapes REPO_ROOT' };
    if (isSecretPath(abs))
      return { allowed: false, reason: 'Secret / credential file' };
    const zone = classifyPath(abs, { projectRoot: repoRoot });
    if (zone.protected || zone.env === 'prod')
      return { allowed: false, reason: `Protected or prod-zone path (zone: ${zone.zone})` };
    const lg = guardLiveWrite({ tool_name: 'Write', tool_input: { file_path: abs }, livePaths });
    if (lg.blocked)
      return { allowed: false, reason: lg.reason };
    return { allowed: true };
  };
}

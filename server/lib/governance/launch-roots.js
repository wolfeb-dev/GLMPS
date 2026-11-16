// server/lib/governance/launch-roots.js
// F15/F16 (Default, operator may overrule): a terminal, resume or editor
// launch runs as the operator, so its cwd must be inside a root the operator
// CONFIGURED (kernel repo, permissions.additionalDirectories, editableRoots,
// launchRoots, the worktrees dir). Session-index cwds do not count: any
// loopback client can write them through /api/otel. Compared by real path
// as well as lexically, so a junction out of a root is refused and a root
// configured as an 8.3 short name or a junction still matches.
import fs from 'node:fs';
import path from 'node:path';

const UNC_OR_DEVICE = /^[\\/]{2}/;

function fold(p, platform) {
  const r = path.resolve(String(p)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? r.toLowerCase() : r;
}

function insideAny(p, roots, platform) {
  const c = fold(p, platform);
  return roots.some((root) => {
    const r = fold(root, platform);
    return c === r || c.startsWith(r + path.sep);
  });
}

export function launchCwdCheck(dir, roots, opts) {
  return launchCwdChecker(roots, opts)(dir);
}

// Resolves the roots once, for a caller checking many dirs against the same
// roots (/api/config checks every known project dir, card glmps-2-0-runtime-86).
export function launchCwdChecker(roots, { platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  const list = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r && !UNC_OR_DEVICE.test(r));
  const refuseOutside = { ok: false, reason: 'cwd is not inside a configured project root (add it to permissions.additionalDirectories in settings.json or to launchRoots in config.json)' };
  if (!list.length) return () => refuseOutside;
  const realRoots = list.map((r) => { try { return realpath(path.resolve(r)); } catch { return r; } });
  return (dir) => checkOne(dir, list, realRoots, refuseOutside, platform, realpath);
}

function checkOne(dir, list, realRoots, refuseOutside, platform, realpath) {
  let real = null;
  try { real = realpath(path.resolve(String(dir))); }
  catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return { ok: false, reason: `cwd could not be resolved (${e.code ?? 'error'})` };
  }
  if (real === null) return insideAny(dir, list, platform) || insideAny(dir, realRoots, platform) ? { ok: true } : refuseOutside;
  if (insideAny(real, realRoots, platform) || insideAny(real, list, platform)) return { ok: true };
  if (insideAny(dir, list, platform)) return { ok: false, reason: 'cwd resolves (through a link) outside every configured project root' };
  return refuseOutside;
}

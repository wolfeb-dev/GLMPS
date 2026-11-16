// server/lib/adapters/antigravity.js
// Adapter wrapping existing antigravity discovery logic.
import { discoverAgSessions } from '../observability/sessions.js';
import { extractAgEvents } from '../observability/extract-antigravity.js';
import { isDirectory } from './fs-util.js';

export const id = 'antigravity';
export const displayName = 'Antigravity IDE';
export const controllable = false;

export function detect(P) {
  const installed = P.antigravityDirs.some(isDirectory);
  return { installed, dataDirs: P.antigravityDirs };
}

/** Returns session descriptors for the adapter registry generic loop. */
export function discover(P) {
  const sessions = discoverAgSessions({ antigravityDirs: P.antigravityDirs });
  return sessions.map(s => ({
    id: s.id,
    tool: id,
    kind: s.format === 'log' ? 'jsonl-tail' : 'pb-only',
    file: s.logPath ?? null,
    cwd: null,
    label: null,
    mtimeMs: s.mtimeMs,
    extra: { format: s.format, logPath: s.logPath, pbPath: s.pbPath, dir: s.dir },
  }));
}

export { extractAgEvents as extractLine };

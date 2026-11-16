// server/lib/kernel/cutover-marker.js
// D30 cutover markers. `node scripts/cutover.mjs config` writes
// <production state dir>/cutover/active.json when it retargets the runtime
// checkout at port 8123 and ~/.glmps; the 2.0 guard hooks
// (hooks/lib/card-context.js) and the 2.0 shadow watchdog read it to know
// cutover happened. Restoring the cold backup on rollback (runbook section 7)
// removes it with the rest of the state dir, so a rollback flips them back
// with no code change. backup.json beside it is written by
// `cutover.mjs backup-verify` (scripts/cutover/guard.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeStateDir } from '../state-dir.js';

export const CUTOVER_SUBDIR = 'cutover';
export const ACTIVE_MARKER_NAME = 'active.json';
export const BACKUP_MARKER_NAME = 'backup.json';

export function productionStateDir(home = os.homedir()) {
  return homeStateDir(home);
}

export function cutoverDir(stateDir) {
  return path.join(stateDir, CUTOVER_SUBDIR);
}

export function cutoverActiveFile(home = os.homedir()) {
  return path.join(cutoverDir(productionStateDir(home)), ACTIVE_MARKER_NAME);
}

/**
 * True once cutover config ran: the marker must be a regular file (a
 * directory of that name does not count). Its content is not parsed. Any
 * failure to check reads as false (the shadow defaults).
 */
export function isCutoverActive(home = os.homedir(), statFn = fs.statSync) {
  try {
    return statFn(cutoverActiveFile(home)).isFile() === true;
  } catch {
    return false;
  }
}

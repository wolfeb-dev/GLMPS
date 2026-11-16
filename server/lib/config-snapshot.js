// server/lib/config-snapshot.js
// The one way a script keeps the previous config.json before rewriting it
// (card glmps-2-0-runtime-152). Copies go under <stateDir>/backups/config so a
// broad `git add` in a checkout root can never pick one up.
import fs from 'node:fs';
import path from 'node:path';
import { stateSubdir } from './state-dir.js';

export function configSnapshotDir(stateDir) {
  return path.join(stateSubdir(stateDir, 'backups'), 'config');
}

/** Copy `file` to <stateDir>/backups/config/<name>.<stamp>.bak; null when there is no file. */
export function snapshotConfig(file, { stateDir, now = () => new Date() }) {
  if (!fs.existsSync(file)) return null;
  const dir = configSnapshotDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now().toISOString().replace(/[-:.]/g, '');
  const base = `${path.basename(file)}.${stamp}`;
  for (let n = 0; ; n += 1) {
    const dest = path.join(dir, `${base}${n ? `-${n}` : ''}.bak`);
    try { fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); return dest; } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  }
}

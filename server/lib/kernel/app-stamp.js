// server/lib/kernel/app-stamp.js
// Records which apps/shell tree the installed desktop app was built from, so
// Restart rebuilds the app only when its code changed (card glmps-2-0-170).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STAMP_FILE = 'app-build-stamp.json';

export function readAppTreeId(repoDir, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('git', ['rev-parse', 'HEAD:apps/shell'], { cwd: repoDir, windowsHide: true, timeout: 10_000 }, (err, out) => {
      const id = String(out ?? '').trim();
      resolve(!err && /^[0-9a-f]{7,}$/.test(id) ? id : null);
    });
  });
}

export function readAppStamp(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, STAMP_FILE), 'utf8'));
    return typeof j?.treeId === 'string' && j.treeId ? j : null;
  } catch { return null; }
}

export function writeAppStamp(stateDir, treeId, now = Date.now) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, STAMP_FILE), JSON.stringify({ treeId, ts: now() }) + '\n');
}

export function appIsStale(stateDir, treeId) {
  if (!treeId) return true;
  return readAppStamp(stateDir)?.treeId !== treeId;
}

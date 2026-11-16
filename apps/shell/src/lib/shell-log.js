// %APPDATA%\GLMPS2\logs\shell.log, one JSON object per line. A log that
// cannot be written falls back to stderr with the reason, never silently.
import fs from 'node:fs';
import path from 'node:path';

export function createShellLog({ dir, fsImpl = fs, maxBytes = 1_000_000, now = () => new Date(),
  fallback = (s) => process.stderr.write(s) }) {
  const file = path.join(dir, 'shell.log');
  function log(level, msg, data = null) {
    const line = JSON.stringify({ ts: now().toISOString(), level, msg, ...(data ? { data } : {}) }) + '\n';
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      try { if (fsImpl.statSync(file).size > maxBytes) fsImpl.renameSync(file, `${file}.1`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      fsImpl.appendFileSync(file, line);
    } catch (e) {
      fallback(`shell log write failed (${e.message}): ${line}`);
    }
  }
  log.file = file;
  return log;
}

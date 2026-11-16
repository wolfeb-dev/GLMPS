// server/lib/observability/append-log.js
// a small ndjson append-only log with size-based
// rotation, shared by every guard/fail-open writer (server.js's
// POST /api/guards/refusal route, hooks/plan-gate.js's fail-open log) so
// growth is bounded the same way in both places. A torn/corrupt line is
// skipped on read, never treated as corrupting the rest of the log.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_LINES = 1000;

/**
 * Append one JSON object as an ndjson line. Rotates the file (keeping only
 * the newest `maxLines` lines) once it grows past `maxBytes`, so a
 * long-running board never lets this file grow without bound. Rotation
 * itself is atomic (temp file plus rename); a rotation failure never
 * THROWS (the append already landed, and a guard log must never be the
 * reason a caller's own decision fails), but it is logged to stderr with a
 * named reason rather than silently swallowed -
 * round 1's catches here gave no way to ever notice a rotation had stopped
 * working.
 */
export function appendCapped(file, obj, { maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
  let st;
  try { st = fs.statSync(file); }
  catch (e) {
    process.stderr.write(`append-log: could not stat ${file} for rotation (${e.code || e.message}); skipping this rotation check\n`);
    return;
  }
  if (st.size <= maxBytes) return;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch (e) {
    process.stderr.write(`append-log: could not read ${file} for rotation (${e.code || e.message}); skipping this rotation\n`);
    return;
  }
  const kept = lines.slice(-maxLines);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort cleanup only */ }
    process.stderr.write(`append-log: rotation of ${file} failed (${e.code || e.message}); the file is left over its cap until the next successful rotation\n`);
  }
}

/**
 * Read up to the last `limit` valid ndjson entries. Missing file: empty
 * array. A line that fails to parse is skipped, not treated as corrupting
 * every other line in the file. Phase K final review (silent-failure): any
 * read failure OTHER than ENOENT throws a named ReadCappedError, so a caller
 * can say "unreadable" instead of showing an empty list that reads as
 * "nothing happened".
 */
export function readCapped(file, { limit = 50 } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e?.code === 'ENOENT') return [];
    const err = new Error(`${path.basename(file)} is unreadable (${e?.code || e?.message})`);
    err.name = 'ReadCappedError';
    err.code = e?.code;
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line: skip, never blank the rest */ }
  }
  return out.slice(-limit);
}

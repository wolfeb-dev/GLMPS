// server/lib/json-store.js
// One JSON-file store helper. The rule it exists to enforce: a read that fails
// must never become an empty store that a later write puts back on disk.
//
//   - ENOENT means "no store yet": the fallback is returned.
//   - A parse error or EBUSY/EPERM may be a torn read (another process mid
//     rename, an AV scanner holding the file on Windows), so it is retried a
//     few times over ~150 ms.
//   - Still failing after the retries: throw a JsonStoreError. The caller
//     decides whether to degrade (a pure reader) or abort (any read-modify-write).
//   - Writes go to a unique temp file and are renamed into place.
//
// Zero runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';

export class JsonStoreError extends Error {
  constructor(message, { file, code, cause } = {}) {
    super(message);
    this.name = 'JsonStoreError';
    this.file = file;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES']);

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fallbackValue(fallback) {
  return typeof fallback === 'function' ? fallback() : fallback;
}

/**
 * Read and parse a JSON file strictly.
 * @param {string} file
 * @param {{fallback?: any|(() => any), retries?: number, delayMs?: number, validate?: (v:any) => boolean}} [opts]
 *   `fallback` is returned only for ENOENT. `validate` rejecting a parsed value
 *   throws (no retry: a well-formed wrong-shaped file is not a torn read).
 */
export function readJsonStore(file, { fallback = null, retries = 3, delayMs = 50, validate } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) sleepSync(delayMs);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') return fallbackValue(fallback);
      lastErr = e;
      if (TRANSIENT.has(e?.code)) continue;
      throw new JsonStoreError(`cannot read ${file}: ${e?.message ?? e}`, { file, code: e?.code ?? 'EREAD', cause: e });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (validate && !validate(parsed)) {
      throw new JsonStoreError(`unexpected shape in ${file}`, { file, code: 'ESHAPE' });
    }
    return parsed;
  }
  // JSON.parse quotes the bad text in its message, and a store can hold
  // secrets (the Slack creds file), so a parse failure is named, never echoed.
  const why = lastErr instanceof SyntaxError ? 'not valid JSON' : (lastErr?.message ?? lastErr);
  throw new JsonStoreError(`cannot read ${file}: ${why}`, {
    file,
    code: lastErr?.code ?? 'EPARSE',
    cause: lastErr,
  });
}

/**
 * Lenient read for callers that only read and may degrade: logs and returns
 * the fallback on a failed read. Its result must never be written back.
 */
export function readJsonStoreOrDegrade(file, opts = {}) {
  try {
    return readJsonStore(file, opts);
  } catch (e) {
    (opts.log ?? ((m) => console.error(m)))(`[json-store] degraded read: ${e.message}`);
    return fallbackValue(opts.fallback ?? null);
  }
}

/**
 * Atomic write: temp file then rename. `backup` keeps the previous file as
 * `<file>.bak` first. `space` is the JSON indent (default 2); `trailingNewline`
 * appends "\n".
 */
export function writeJsonStore(file, value, { space = 2, trailingNewline = false, mode, backup = false, retries = 3, delayMs = 50 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, space) + (trailingNewline ? '\n' : '');
  try {
    fs.writeFileSync(tmp, text, mode != null ? { mode } : undefined);
    if (backup) {
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* no previous file, or a busy one: the backup is best effort */ }
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (!TRANSIENT.has(e?.code) || attempt >= retries) throw e;
        sleepSync(delayMs);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

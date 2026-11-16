// server/lib/governance/baseline-store.js
// Thin IO wrapper for governance-baseline.json.
// Imported by server.js (policy push) and cross-agent-memory.js (memory drift baseline).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the absolute path to governance-baseline.json.
 * Respects config.governanceBaseline (absolute or root-relative), else defaults to
 * path.join(root, 'governance-baseline.json').
 */
export function resolveBaselinePath(root, config = {}) {
  const raw = config?.governanceBaseline;
  if (raw && typeof raw === 'string') {
    return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  }
  return path.join(root, 'governance-baseline.json');
}

/**
 * Read and parse the baseline manifest.
 * Returns null if the file is missing or contains invalid JSON.
 */
export function readBaseline(baselinePath) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write the baseline manifest as pretty JSON (2-space) with a trailing newline.
 * Creates parent directories if needed.
 */
export function writeBaseline(baselinePath, obj) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(obj, null, 2) + '\n');
}

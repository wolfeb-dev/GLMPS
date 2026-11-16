// server/lib/personality/credentials.js
// The Personality page lists credential and token files by name only. This is a
// pure decision on the path string, made before anything is stat-ed or read, so
// a withheld file's bytes never enter this process.
import path from 'node:path';

const NAME_PATTERNS = [
  /^\.env/i,
  /token/i,
  /secret/i,
  /\.(key|pem)$/i,
  /^credentials/i,
  /^oauth/i,
  /^google_accounts/i,
];

const lower = (s) => s.toLowerCase();

function underGemini(resolved, geminiDir) {
  if (!geminiDir) return null;
  const rel = path.relative(lower(path.resolve(geminiDir)), lower(resolved));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

export function isWithheld(p, { geminiDir = null } = {}) {
  if (typeof p !== 'string' || !p) return true;
  const resolved = path.resolve(p);
  if (NAME_PATTERNS.some((re) => re.test(path.basename(resolved)))) return true;
  const segs = underGemini(resolved, geminiDir);
  if (!segs) return false;
  if (segs.length === 1 && segs[0] === 'settings.json') return false;
  if (segs.length === 2 && segs[0] === 'config' && segs[1] === 'config.json') return false;
  return !segs.includes('skills');
}

export const isCredentialName = (name) => NAME_PATTERNS.some((re) => re.test(name));

// server/lib/observability/decision-log-config.js
//
// Structural diffing of ~/.claude/settings.json for the decision log (glmps-143).
//
// WHY THIS EXISTS: ~/.claude is not a git repo, so settings.json has zero
// version history anywhere on the machine. It is the one surface the git spine
// cannot see, and it is exactly what forced the manual archaeology this feature
// eliminates. (The global CLAUDE.md looks similar but is NOT a problem: it is a
// symlink into this repo's assets/ dir, so git already covers it.)
//
// SECRET SAFETY (binding): settings.json can carry env values. Only key NAMES,
// counts, and hashes are ever recorded. No raw value enters the store, ever.
// server/test/decision-log-config.test.js enforces this with a leak assertion
// rather than trusting this comment.
import crypto from 'node:crypto';

const basename = (cmd) => {
  const s = String(cmd ?? '');
  // Commands are quoted Windows paths as often as bare POSIX ones; take the
  // last path-ish segment and drop a trailing quote.
  const m = s.match(/([^\\/"'\s]+\.(?:js|mjs|cjs|ps1|sh|py))/g);
  return m && m.length ? m[m.length - 1] : s.trim().slice(0, 80);
};

function hookNames(hooksForEvent) {
  const out = [];
  for (const group of Array.isArray(hooksForEvent) ? hooksForEvent : []) {
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      out.push(basename(h?.command));
    }
  }
  return out.sort();
}

/**
 * Reduce a settings object to the structure worth tracking.
 * @param {object} settingsObj parsed settings.json
 * @returns {{sections: Record<string,string[]>, sha256: string}}
 */
export function summarize(settingsObj) {
  const sections = {};
  const s = settingsObj && typeof settingsObj === 'object' ? settingsObj : {};

  const hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  for (const [event, val] of Object.entries(hooks)) {
    sections[`hooks.${event}`] = hookNames(val);
  }

  const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  for (const [kind, val] of Object.entries(perms)) {
    // Not every permissions field is a list: defaultMode is a bare string.
    // Coercing a scalar to [] would make a change to it invisible, which is
    // the opposite of the point (caught against the real settings.json).
    const list = Array.isArray(val)
      ? val.map(String)
      : (val === null || val === undefined ? [] : [String(val)]);
    sections[`permissions.${kind}`] = list.slice().sort();
  }

  // KEY NAMES ONLY. The values are the secret-bearing part.
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  sections.env = Object.keys(env).sort();

  const sha256 = crypto.createHash('sha256')
    .update(JSON.stringify(sections))
    .digest('hex');
  return { sections, sha256 };
}

function diffLists(prev = [], next = []) {
  const p = new Set(prev);
  const n = new Set(next);
  const added = next.filter((x) => !p.has(x));
  const removed = prev.filter((x) => !n.has(x));
  return { added, removed, changed: Math.min(added.length, removed.length) };
}

/**
 * Compare two summaries. Reports only sections that actually moved, so an
 * unchanged file produces an empty object rather than a wall of zeroes.
 *
 * @param {{sections:object}|null} prevSummary null on first run
 * @param {{sections:object}} nextSummary
 * @returns {{changed: boolean, sections: Record<string, {added:string[], removed:string[], changed:number}>}}
 */
export function diffSettings(prevSummary, nextSummary) {
  const prev = prevSummary?.sections ?? {};
  const next = nextSummary?.sections ?? {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  const sections = {};
  for (const k of keys) {
    const d = diffLists(prev[k] ?? [], next[k] ?? []);
    if (d.added.length || d.removed.length) sections[k] = d;
  }
  return { changed: Object.keys(sections).length > 0, sections };
}

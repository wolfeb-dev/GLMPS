// server/lib/observability/decision-log-hook-core.js
//
// Pure core of the decision-log Stop hook (glmps-143). Kept separate from
// hooks/decision-log.js so the decisions are testable without a Stop payload,
// matching how the rest of the hooks in this repo are structured.
import { diffSettings } from './decision-log-config.js';

// A body under this many characters carries no explanation worth keeping.
// Calibrated against real history: 'merge(followups): glmps-140/141/142' has a
// 0-char body and needs enrichment; the glmps-147 merge body is 251 chars and
// must be left alone, because a hand-written why beats an inferred one.
export const THIN_BODY_CHARS = 80;

/**
 * @param {Array<{commit:string, why:string}>} commits
 * @param {{thinChars?:number}} opts
 */
export function selectThinCommits(commits, { thinChars = THIN_BODY_CHARS } = {}) {
  if (!Array.isArray(commits)) return [];
  return commits.filter((c) => String(c?.why ?? '').trim().length < thinChars);
}

/**
 * Turn a settings.json summary change into one row, or null when nothing moved.
 * Carries key names and counts only: the diff never contains a raw value.
 *
 * A null `prev` means this is the first ever run. That is a BASELINE, not a
 * change: diffing against nothing reports every hook, permission and env key as
 * "added", which on a fresh install wrote one enormous meaningless entry
 * (observed when first exercising the hook). Establish the snapshot silently
 * and report only what moves after it.
 *
 * @param {{prev:object|null, next:object, ts:number}} opts
 */
export function buildConfigRow({ prev, next, ts }) {
  if (!prev) return null;
  const d = diffSettings(prev, next);
  if (!d.changed) return null;
  const touched = Object.keys(d.sections).sort();
  return {
    ts,
    repo: '~/.claude/settings.json',
    source: 'config',
    what: `settings.json changed: ${touched.join(', ')}`,
    why: '',
    sections: d.sections,
    sha256: next?.sha256 ?? null,
  };
}

// server/lib/observability/wiki-git-dates.js
// Real created/updated dates for a wiki section, sourced from GIT history of the
// section's files -- the actual version-control record -- instead of a synthetic
// "first time we stamped it" ledger (which made every page created == updated on
// the first build). created = the section's earliest commit; updated = its latest.
// Pure + injectable: the git runner is passed in, so this is fully unit-testable
// with no real repo.

/**
 * Parse the stdout of `git log --format=%ct -- <files>` (unix SECONDS, one per
 * line, newest-first) into {createdTs, updatedTs} in MILLISECONDS. Robust to
 * blank lines / stray whitespace. No commits -> {null, null}.
 */
export function datesFromGitLog(stdout) {
  const times = String(stdout ?? '')
    .split(/\r?\n/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((sec) => sec * 1000);
  if (!times.length) return { createdTs: null, updatedTs: null };
  return { createdTs: Math.min(...times), updatedTs: Math.max(...times) };
}

/**
 * Compute a section's created/updated timestamps from git.
 * @param {{files?: Array<{path:string}>}} section
 * @param {(files:string[]) => string} runGitLog  injected; returns raw
 *   `git log --format=%ct -- <files>` stdout. Should never throw (the CLI wraps
 *   it in try/catch), but a throw here degrades safely to the fallback.
 * @param {number} nowMs  fallback when a section has no git history yet -- i.e.
 *   brand-new, uncommitted files, which ARE new, so "created/updated = now" is
 *   correct, not a lie.
 * @param {string[]} [extraFiles]  additional repo-relative paths to fold into the
 *   git-date window WITHOUT listing them as the section's own files. For curated
 *   TOPIC pages this is the topic-definition file (wiki-topics.js): the page's
 *   narrative is a function of its `angle`, so an angle rewrite there is a real
 *   content update even when the cited source files (CLAUDE.md, README, ...) did
 *   not change. Without this a rewritten topic keeps a misleadingly-old date.
 * @returns {{createdTs:number, updatedTs:number}}
 */
export function sectionGitDates(section, runGitLog, nowMs, extraFiles = []) {
  const files = Array.isArray(section?.files)
    ? section.files.map((f) => f && f.path).filter((p) => typeof p === 'string' && p)
    : [];
  const extras = Array.isArray(extraFiles) ? extraFiles.filter((p) => typeof p === 'string' && p) : [];
  const all = [...files, ...extras];
  if (!all.length) return { createdTs: nowMs, updatedTs: nowMs };
  let out = '';
  try { out = runGitLog(all); } catch { out = ''; }
  const { createdTs, updatedTs } = datesFromGitLog(out);
  return { createdTs: createdTs ?? nowMs, updatedTs: updatedTs ?? nowMs };
}

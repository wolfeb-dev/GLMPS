// server/lib/observability/decision-log-git.js
//
// Pure parsing for the architectural decision log's git spine (glmps-143).
// No fs, no child_process: the caller injects git output, matching
// wiki-git-dates.js's shape for the same reason (the subprocess side is
// untestable without spawning, the parsing side is where the bugs live).
//
// The unit of significance is a MERGE to the default branch, not a path
// heuristic. Measured 2026-07-22 over 14 days: the path heuristic proposed in
// glmps-4 kept 151 of 299 glmps commits (51%) because
// server/lib/ is the codebase, which yields a changelog. Merges yield 33.

// Commit bodies are multi-line and subjects contain colons, so neither newline
// nor ':' can delimit anything. \x1f (unit separator) between fields, \x1e
// (record separator) between commits: both are control characters that cannot
// occur in a commit message.
export const FORMAT = '%H%x1f%ct%x1f%s%x1f%b%x1e';

/**
 * Parse `git log --format=FORMAT` stdout.
 * Fail-open per record: a malformed record is skipped, never thrown, so one bad
 * commit cannot blank an entire repo's history.
 *
 * @param {string} stdout
 * @returns {Array<{commit:string, ts:number, what:string, why:string}>} ts in epoch ms
 */
export function parseMergeLog(stdout) {
  if (typeof stdout !== 'string' || !stdout) return [];
  const out = [];
  for (const raw of stdout.split('\x1e')) {
    // git puts a newline between records; strip the one it adds, not the ones
    // that belong to the previous record's body.
    const record = raw.replace(/^\r?\n/, '');
    if (!record.trim()) continue;
    const fields = record.split('\x1f');
    if (fields.length < 4) continue;
    const [commit, tsRaw, what, ...rest] = fields;
    const seconds = Number(tsRaw);
    if (!commit || !Number.isFinite(seconds)) continue;
    // rest rejoined: a body can theoretically contain \x1f only if someone
    // pasted a control char, but rejoining is still the lossless choice.
    out.push({
      commit: commit.trim(),
      ts: seconds * 1000,
      what: (what ?? '').trim(),
      why: rest.join('\x1f').trim(),
    });
  }
  return out;
}

/**
 * Choose which entries represent "what landed" for a repo.
 * Merges are the signal where the repo uses branch-per-change; repos that
 * commit straight to the default branch have none, and must not silently
 * report an empty history, so they fall back to plain commits.
 *
 * @param {{merges: Array, commits: Array}} opts
 */
export function selectEntries({ merges = [], commits = [] } = {}) {
  const m = Array.isArray(merges) ? merges : [];
  if (m.length) return m;
  return Array.isArray(commits) ? commits : [];
}

/**
 * Resolve a repo's default branch.
 *
 * NOT `git symbolic-ref --short HEAD`: that reports the CHECKED-OUT branch,
 * which during this very session was a feature branch. Prefer the remote's
 * recorded HEAD, then conventional names, then null so the caller skips the
 * repo with a logged reason rather than guessing.
 *
 * @param {string} symbolicRefOut stdout of `git symbolic-ref --short refs/remotes/origin/HEAD`
 * @param {string[]} branchList local branch names
 * @returns {string|null}
 */
export function resolveDefaultBranch(symbolicRefOut, branchList = []) {
  const branches = Array.isArray(branchList) ? branchList : [];
  const ref = String(symbolicRefOut ?? '').trim();
  if (ref) {
    const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
    // origin/HEAD can name a branch that does not exist locally. The export
    // mirror glmps_prod is exactly this: origin/HEAD is origin/main while the
    // only local branch is master, so trusting the remote blindly produced a
    // `git log ... main` that could not resolve and skipped the repo.
    if (name && branches.includes(name)) return name;
  }
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  return null;
}

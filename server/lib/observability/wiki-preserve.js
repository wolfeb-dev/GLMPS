// server/lib/observability/wiki-preserve.js
// Guards the no-downgrade invariant for the codebase wiki: a structural
// (no --llm) rebuild must NEVER overwrite an existing narrative page with a
// bare Tier-1 stub just because that section's contentHash changed (a cache
// miss). This repeatedly destroyed committed prose in practice: the on-disk
// LLM cache (.cache.json) is gitignored, so a no-llm rebuild against a fresh
// checkout is a guaranteed cache miss on every section, and the CLI used to
// fall straight through to Tier-1 on a miss regardless of what was already
// on disk. Only a real --llm attempt is allowed to (re)author narrative;
// every other cache-miss path must leave existing narrative alone.
//
// Pure: no I/O. scripts/wiki-build-cli.mjs calls this to decide whether to
// read the PRIOR rendered HTML + manifest entry back off disk and carry them
// forward unchanged instead of writing a fresh structural stub.

/**
 * @param {{slug?:string}|null} freshSection - the section this build just computed
 * @param {boolean} realLlmAttempt - true iff this run will actually try to call an LLM backend
 *   for cache-miss sections (i.e. --llm was passed AND a backend is available)
 * @param {{slug?:string, llm?:boolean}|null|undefined} priorEntry - this slug's entry from the
 *   PRIOR manifest.json, if any
 * @returns {boolean} true if the fresh section must be frozen at its prior narrative state
 */
export function shouldPreserveNarrative(freshSection, realLlmAttempt, priorEntry) {
  if (!freshSection) return false;
  // A real --llm run is allowed to (re)author or replace narrative; only the
  // no-attempt paths (no --llm, or --llm requested with no backend available)
  // must preserve.
  if (realLlmAttempt) return false;
  return !!(priorEntry && priorEntry.llm);
}

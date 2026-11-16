// server/lib/evaluation/memory-working-set.js
//
// Picks the per-session working set: which memory facts are likely to matter
// for THIS session, so they can be promoted to a mid-depth excerpt at
// SessionStart instead of every session receiving a byte-identical index.
//
// The three depths (glmps-156)
//
//   L1  ~32 tokens   every fact, always resident   the MEMORY.md index line
//   L2  ~150-250 t   top-k predicted relevant      THIS MODULE
//   L3  full body    only on an explicit fault     memory-fault.js (glmps-157)
//
// L2 is the missing middle. Bodies average 6KB against a 12KB total index, so
// promoting whole bodies costs more than the entire cache; that is precisely
// what an excerpt tier avoids.
//
// Why "salience" and not "importance"
//
// The canonical prior art (Generative Agents, 2023) scores retrieval on
// recency + importance + relevance, and gets importance by asking an LLM to
// rate each memory 1-10 at write time. We deliberately do not: that score is
// frozen at write time, assigned without knowledge of how the fact is later
// used, and drifts as the codebase moves. It also comes from the same
// mechanism that, run over this exact corpus, rewrote a verdict and dropped a
// load-bearing parameter.
//
// The structural alternative recomputes from current state on every call and
// is auditable. But it must be named honestly: it measures CONNECTEDNESS and
// CONSTRAINT-NESS, not importance. A heavily-linked fact is well integrated,
// which is not the same thing, and a genuinely critical fact written in
// isolation scores low. Hence `salience`.

const WIKILINK_RE = /\[\[\s*([^\]]+?)\s*\]\]/g;

/**
 * Inbound [[wikilink]] counts, keyed by `<slug>.md`.
 * Self-links and links to nonexistent facts are ignored: neither is evidence
 * that other facts depend on this one.
 */
export function inboundLinks(bodies) {
  const known = new Set(Object.keys(bodies || {}));
  const counts = new Map();
  for (const [source, body] of Object.entries(bodies || {})) {
    const seen = new Set();
    for (const m of String(body ?? '').matchAll(WIKILINK_RE)) {
      const target = `${m[1].replace(/\.md$/i, '')}.md`;
      if (target === source) continue; // self-link proves nothing
      if (!known.has(target)) continue; // dangling link, not a dependency
      if (seen.has(target)) continue; // count each source once, not per mention
      seen.add(target);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

const PIN_WEIGHT = 3;
const INBOUND_CAP = 4;

/**
 * Structural salience. Inbound links are BOTH log-damped and hard-capped: a
 * log alone still let a 40-inbound hub fact outscore project affinity
 * entirely, which would make every session's working set the same handful of
 * cross-cutting notes. The cap is what makes it a contributing signal rather
 * than the deciding one.
 */
export function salience({ pinned = false, inbound = 0 } = {}) {
  return (pinned ? PIN_WEIGHT : 0)
    + Math.min(INBOUND_CAP, Math.log2(1 + Math.max(0, inbound)));
}

// Normalize a path for comparison: lowercase, both separators to '/', no
// trailing slash. Windows paths and POSIX paths must compare the same way.
function normPath(p) {
  return String(p ?? '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Does this fact concern the current project? The cheapest and highest-value
 * predictor: a Harbor-App session currently carries every GLMPS fact and vice
 * versa. Matches either the full path or the directory basename.
 */
export function projectAffinity(body, cwd) {
  const dir = normPath(cwd);
  if (!dir) return 0;
  const hay = normPath(body);
  if (!hay) return 0;
  if (hay.includes(dir)) return 2; // full path named: strong signal
  const base = dir.split('/').filter(Boolean).pop();
  if (base && base.length >= 3 && hay.includes(base)) return 1;
  return 0;
}

// Every term is bounded, so no single signal can decide the working set alone:
//   affinity 0..8  (dominant by design)
//   salience 0..7
//   usage    0..2.25
// Usage is capped hardest. A frequently-read fact from another project is
// still the wrong fact, and an uncapped read count made exactly that mistake
// in testing (a 50-read GLMPS note outranked the project's own gotcha).
const AFFINITY_WEIGHT = 4;
const USAGE_WEIGHT = 0.75;
const USAGE_CAP = 3;

/**
 * Rank facts for this session and return the top k.
 *
 * Weighting intent: project affinity dominates, because an irrelevant fact is
 * worthless no matter how often it has been read. Usage is a tiebreak among
 * facts that are already plausible, deliberately damped (log) so one
 * frequently-read fact cannot outrank the whole project-relevant set.
 *
 * @returns {Array<{target,score,affinity,salience,reads}>} auditable components
 */
export function selectWorkingSet({
  bodies, cwd, usage = {}, pinned = new Set(), k = 10, requireAffinity = false,
}) {
  const inb = inboundLinks(bodies);
  let scored = Object.entries(bodies || {}).map(([target, body]) => {
    const affinity = projectAffinity(body, cwd);
    const sal = salience({ pinned: pinned.has(target), inbound: inb.get(target) ?? 0 });
    const reads = Number(usage[target]?.reads) || 0;
    return {
      target,
      affinity,
      salience: sal,
      reads,
      score: affinity * AFFINITY_WEIGHT
        + sal
        + Math.min(USAGE_CAP, Math.log2(1 + reads)) * USAGE_WEIGHT,
    };
  });
  // Promoting a fact with no project relevance just re-states what the index
  // already carries, at ~6x the tokens. With requireAffinity the working set
  // is empty in a repo no memory mentions, which is the correct cost: zero.
  if (requireAffinity) scored = scored.filter((s) => s.affinity > 0);
  scored.sort((a, b) => b.score - a.score || (a.target < b.target ? -1 : 1));
  return scored.slice(0, Math.max(0, k));
}

/**
 * The L2 payload: body text without frontmatter, bounded, cut on a word
 * boundary. Frontmatter is metadata (name/description already surfaced by the
 * L1 index line), so including it would spend the excerpt budget on a
 * duplicate.
 */
export function excerptFor(body, maxChars = 800) {
  const text = String(body ?? '')
    .replace(/^---[\s\S]*?\n---\s*/, '') // frontmatter block
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars - 3);
  const cut = window.lastIndexOf(' ');
  return `${window.slice(0, cut > 0 ? cut : window.length).replace(/[\s,;:.]+$/, '')}...`;
}

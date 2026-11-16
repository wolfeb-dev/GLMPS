// server/lib/evaluation/semantic-dedup.js
//
// Zero-dependency lexical near-duplicate detection for governance guard
// lines and memory facts. No embeddings, no network, no tokenizer library - 
// pure string math so it stays inside the project's zero-runtime-deps rule.
//
// Metric choice: character-trigram cosine similarity (NOT word-level Jaccard).
//
// Guard lines are short, single-sentence rules. The near-duplicates this
// module exists to catch are lines produced by a headless "compose ONE
// concise guard line" hand run repeatedly for the same underlying gap: they
// differ by swapping a handful of content words (a skill name, a verb, a
// connective, "3+" vs "three or more") while the rest of the sentence's
// *shape* stays put.
//
// Word-level Jaccard (as already used for memory facts in
// memory-distill-core.js's lexicalSimilar) treats every token as an atomic,
// equally-weighted unit. Swapping one content word for a synonym costs a
// full token out of BOTH sides' sets, which can swing a short sentence's
// score more than the rewording actually warrants, and it sees zero credit
// between morphological variants ("invoke" vs "invoking") or compound
// swaps ("frontend-design" vs "design-skill-alias" inside an otherwise-identical
// sentence).
//
// Character trigrams are more forgiving of exactly this kind of rewording:
// shared substrings ("efore any ui", "ui/css", " skill.", "efore the first")
// keep contributing similarity regardless of which exact words carry them
// or how the clauses are reordered. Using cosine similarity over trigram
// *term-frequency* vectors (rather than plain Jaccard-over-trigram-sets)
// means the long common "stopword skeleton" (the, a, before, of...) - which
// every English sentence shares - contributes proportionally rather than
// dominating a raw overlap-count metric, so genuinely distinct guards still
// separate cleanly (see semantic-dedup.test.js for the tuned threshold).

// lowercase, strip a leading markdown bullet / ordinal, strip punctuation,
// collapse whitespace. Deterministic and side-effect free.

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^\s*[-*\u2022]\s+/, '') // leading "- " / "* " / "- " bullet
    .replace(/^\s*\d+[.)]\s+/, '') // leading "1. " / "1) " ordinal
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Bag of character 3-grams over a normalized string, as a Map<gram, count>.
// Strings shorter than 3 chars degrade to a single whole-string "gram" so
// they still compare (rather than producing an empty, always-zero vector).

function trigramCounts(s) {
  const counts = new Map();
  if (s.length === 0) return counts;
  if (s.length < 3) {
    counts.set(s, 1);
    return counts;
  }
  for (let i = 0; i <= s.length - 3; i++) {
    const gram = s.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// Cosine similarity between the two strings' normalized trigram
// term-frequency vectors. 1 = identical after normalization, 0 = no shared
// trigrams (or either side is empty).

export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return na === '' ? 0 : 1;

  const ca = trigramCounts(na);
  const cb = trigramCounts(nb);
  if (ca.size === 0 || cb.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of ca.values()) normA += v * v;
  for (const v of cb.values()) normB += v * v;
  for (const [gram, va] of ca) {
    const vb = cb.get(gram);
    if (vb) dot += va * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Tuned against real guard-paraphrase fixtures in semantic-dedup.test.js:
// high enough that two independent, topically-unrelated guards never
// cross it, low enough that every observed LLM-composed rewording of the
// SAME guard does.

export const DEFAULT_SIM_THRESHOLD = 0.5;

// Returns { item, score } for the closest existing entry at or above
// threshold, else null. Ties keep the first-seen (stable) match.

export function findNearest(candidate, existingList, threshold = DEFAULT_SIM_THRESHOLD) {
  let best = null;
  let bestScore = -1;
  for (const item of existingList ?? []) {
    const score = similarity(candidate, item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best === null || bestScore < threshold) return null;
  return { item: best, score: bestScore };
}

// Default 'single' linkage: union-find over all pairs scoring >= threshold.
// Returns only clusters with 2+ members (singletons, i.e. items with no
// near-dup, are dropped). Clustering is transitive: if A~B and B~C both
// clear the threshold, A/B/C land in one cluster even if A~C alone would
// not have. This is the long-standing default and every existing caller
// depends on this exact behavior when it omits the options argument.
//
// 'complete' linkage: an item is admitted to a cluster only if it clears
// the threshold against EVERY current member of that cluster, not just one.
// This does not chain: known bug G4 is that single linkage at the default
// 0.5 threshold collapses the whole real corpus into one giant cluster via
// exactly this A~B~C transitivity. Complete linkage is used by
// memory-distilled-dedup.js for that reason.

export function clusterNearDups(list, threshold = DEFAULT_SIM_THRESHOLD, { linkage = 'single' } = {}) {
  const items = Array.isArray(list) ? list : [];
  const n = items.length;
  const sim = (i, j) => similarity(items[i], items[j]);

  if (linkage === 'complete') {
    // Agglomerate greedily, admitting an item to a cluster only if it is
    // within threshold of EVERY current member. No transitive chaining.
    const clusters = [];
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (const cl of clusters) {
        if (cl.every((j) => sim(i, j) >= threshold)) {
          cl.push(i);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([i]);
    }
    return clusters.filter((c) => c.length > 1).map((c) => c.map((i) => items[i]));
  }

  // Default: single-linkage union-find (unchanged from prior behavior).
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x, y) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim(i, j) >= threshold) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  return Array.from(groups.values()).filter((g) => g.length > 1);
}

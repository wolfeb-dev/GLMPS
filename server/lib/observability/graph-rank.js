// Personalized PageRank over a graphify graph (glmps-2.0 upgrade plan item 3).
//
// Raw degree lets many unimportant callers outrank a few very important ones:
// a helper called from forty tests beats the module those tests exist for.
// PageRank weights a link by the rank of the node it comes from, and a
// personalization vector biases the random restart toward the identifiers the
// conversation names, which is what Aider's repo map ships. Links are followed
// source to target (caller to callee, importer to imported, file to the
// symbols it contains), so rank flows toward definitions.
//
// No source publishes task-success numbers for PageRank over degree; the
// before/after on our own queries is scripts/graph-rank-bench.mjs.
//
// Pure: no fs, no clock.

const MIN_TOKEN = 4;
// A token matching more nodes than this is a common word ("index", "test"),
// not a name the conversation is pointing at.
const MAX_SEED_MATCHES = 25;

/**
 * pageRank(nodes, links, { personalization, damping, iterations, tol })
 * -> Map<nodeId, score>, scores summing to 1.
 *
 * `personalization` is an optional Map or object of nodeId -> weight; absent
 * or empty means a uniform restart (plain PageRank). Dangling nodes (no
 * out-links) restart along the same vector, so rank is never lost.
 */
export function pageRank(nodes, links, { personalization = null, damping = 0.85, iterations = 100, tol = 1e-10, undirected = false } = {}) {
  const ids = (Array.isArray(nodes) ? nodes : []).map(n => n.id);
  const N = ids.length;
  const out = new Map();
  if (!N) return out;
  const index = new Map(ids.map((id, i) => [id, i]));

  const outWeight = new Float64Array(N);
  const edges = [];
  for (const l of Array.isArray(links) ? links : []) {
    const s = index.get(l.source), t = index.get(l.target);
    if (s === undefined || t === undefined || s === t) continue;
    const w = typeof l.weight === 'number' && l.weight > 0 ? l.weight : 1;
    edges.push([s, t, w]);
    outWeight[s] += w;
    if (undirected) { edges.push([t, s, w]); outWeight[t] += w; }
  }

  const restart = new Float64Array(N);
  let pSum = 0;
  const entries = personalization instanceof Map ? [...personalization] : Object.entries(personalization || {});
  for (const [id, w] of entries) {
    const i = index.get(id);
    if (i === undefined || !(w > 0)) continue;
    restart[i] += w;
    pSum += w;
  }
  if (pSum > 0) for (let i = 0; i < N; i++) restart[i] /= pSum;
  else restart.fill(1 / N);

  let rank = Float64Array.from(restart);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(N);
    let dangling = 0;
    for (let i = 0; i < N; i++) if (outWeight[i] === 0) dangling += rank[i];
    for (const [s, t, w] of edges) next[t] += damping * rank[s] * (w / outWeight[s]);
    const spread = damping * dangling + (1 - damping);
    let delta = 0;
    for (let i = 0; i < N; i++) {
      next[i] += spread * restart[i];
      delta += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (delta < tol) break;
  }
  for (let i = 0; i < N; i++) out.set(ids[i], rank[i]);
  return out;
}

function normLabel(label) {
  return String(label ?? '').toLowerCase().replace(/\(\)$/, '');
}

function stem(name) {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

// Only names shaped like code count: camelCase, snake_case, kebab-case, a
// file name, or a call. Plain words ("plan", "gate", "skills") match dozens
// of unrelated symbols; the first bench run seeded on them and personalized
// rank came out worse than degree. Aider weights the same distinction.
const IDENT_SHAPE = /[a-z][A-Z]|_|[A-Za-z0-9]-[A-Za-z]|\.[a-z0-9]{1,4}$|\(\)$/;

/** Identifier-shaped tokens from free text, lowercased, deduplicated. */
export function identifierTokens(text) {
  const seen = new Set();
  for (const raw of String(text ?? '').match(/[A-Za-z0-9_.\-/]+(?:\(\))?/g) ?? []) {
    const parts = raw.includes('/') ? raw.split('/') : [raw];
    for (const p of parts) {
      const t = p.replace(/^[.\-]+|[.\-]+$/g, '');
      if (t.length < MIN_TOKEN || !IDENT_SHAPE.test(t)) continue;
      seen.add(t.replace(/\(\)$/, '').toLowerCase());
    }
  }
  return [...seen];
}

/**
 * seedsFromText(nodes, text) -> Map<nodeId, 1>
 *
 * Nodes whose label (a symbol name, or a file basename for file nodes)
 * matches a token named in the text, either exactly or by file stem
 * ("graph-status" names graph-status.js). Tokens that match too many nodes
 * are dropped as noise.
 */
export function seedsFromText(nodes, text) {
  const byKey = new Map();
  const add = (k, id) => { if (!k) return; let a = byKey.get(k); if (!a) byKey.set(k, a = []); a.push(id); };
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const l = normLabel(n.label);
    add(l, n.id);
    const s = stem(l);
    if (s !== l) add(s, n.id);
  }
  const seeds = new Map();
  for (const t of identifierTokens(text)) {
    const hits = byKey.get(t) ?? byKey.get(stem(t));
    if (!hits || hits.length > MAX_SEED_MATCHES) continue;
    for (const id of hits) seeds.set(id, 1);
  }
  return seeds;
}

/**
 * Rank a graph, personalized toward `focus` text when it names any node.
 * Undirected: on the fixed query set, rank that flows only caller to callee
 * never reaches the tests and wiring that import a named module, and scored
 * below degree (recall@10 0.211 vs 0.276 undirected, MRR 0.398 vs 0.547).
 */
export function rankGraph(nodes, links, { focus = '' } = {}) {
  const seeds = focus ? seedsFromText(nodes, focus) : new Map();
  return { rank: pageRank(nodes, links, { personalization: seeds, undirected: true }), seeds };
}

/**
 * Focus text from a session's recent events: what the user asked (prompt
 * labels) and the files the agent touched (tool paths). Backslashes become
 * slashes so a Windows path splits into its file name.
 */
export function focusFromEvents(events, { limit = 200 } = {}) {
  const recent = Array.isArray(events) ? events.slice(-limit) : [];
  const parts = [];
  for (const e of recent) {
    if (!e) continue;
    if (e.kind === 'prompt' || e.tool === 'user') parts.push(String(e.label ?? ''));
    if (typeof e.path === 'string' && e.path) parts.push(e.path.replace(/\\/g, '/'));
  }
  return parts.join('\n');
}

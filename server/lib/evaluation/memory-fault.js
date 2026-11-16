// server/lib/evaluation/memory-fault.js
//
// The page-fault path for evicted memory facts (glmps-157).
//
// Why this exists
//
// memory-evict.js gives the index a cache's eviction policy, but the analogy
// to virtual memory breaks at exactly one point: THERE IS NO FAULT. In real
// virtual memory a miss traps and the OS pages the data in. Here the model
// cannot trap, because once an index line is gone the model has no idea the
// fact exists, so it never asks. An unfaultable miss is silent permanent loss.
//
// That makes eviction safe only while nothing is actually evicted. This module
// is what makes a miss recoverable, and it has three parts:
//
//   1. indexFooter()  - the SIGNAL. A line in MEMORY.md stating how many facts
//                       are hidden. Without it nothing else here is reachable,
//                       because the model never learns a miss is possible.
//   2. lookupFacts()  - the HANDLER. Lexical search over every body file,
//                       including evicted ones.
//   3. faultIn()      - the PAGE-IN. Restores the evicted index line verbatim
//                       and records the fact so it is never evicted again.
//
// Prior art: Letta's archival_memory_search, claude-mem's
// search/timeline/get_observations. Both pair layered retrieval with a
// model-callable search; we shipped eviction first, which was backwards.
//
// Retrieval is the existing zero-dep lexical retriever from wiki-ask.js. At
// this corpus size (under 100 facts) embeddings are not justified: see the
// memsearch evaluation, where a hybrid vector index was judged premature.

import fs from 'node:fs';
import path from 'node:path';
import { retrieveSections, stripHtml } from '../observability/wiki-ask.js';

const INDEX_FILE = 'MEMORY.md';
const LOOKUP_CMD = 'node scripts/memory-lookup.mjs "<query>"';

export function faultedFile(stateDir) {
  return path.join(stateDir, 'memory', 'faulted.json');
}

/**
 * The fault signal appended to MEMORY.md. Empty when nothing is hidden, so
 * the index gains no noise in the steady state.
 *
 * Single line by construction: the index parser is line-based, and a
 * multi-line footer could be mistaken for entries.
 */
export function indexFooter(hiddenCount) {
  const n = Number(hiddenCount) || 0;
  if (n <= 0) return '';
  return `_${n} older memor${n === 1 ? 'y is' : 'ies are'} not listed above. `
    + `To search them (including anything evicted): ${LOOKUP_CMD}_`;
}

// D23/D24 cutover (glmps-159 task 6): the pre-D23 L3 "distilled" pool this
// used to also scan (a machine-distilled tier under this subdirectory) is
// retired -- Mem0 is the machine-derived tier now (memory-plugin.js's
// lookup() fuses it with THIS function's curated-only result at the caller,
// not in here). The constant survives only because the migration route
// still needs to find the pre-D23 pool's files on disk to import them
// (memory-plugin.js's readDistilledFacts).
export const DISTILLED_SUBDIR = 'distilled';

// Body text of every curated memory fact, as the {slug,tier,title,body}
// shape the wiki-ask retriever expects. Reads bodies from disk rather than
// the index, so evicted facts (which have no index line) are still
// searchable - that is the point.
function factSections(memoryDir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(memoryDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name === INDEX_FILE) continue; // the index is not a fact
    let raw;
    try {
      raw = fs.readFileSync(path.join(memoryDir, name), 'utf8');
    } catch {
      continue;
    }
    // Frontmatter `description:` makes a better title than the slug, when present.
    const desc = /^---[\s\S]*?\bdescription:\s*(.+)$/m.exec(raw);
    out.push({
      slug: name,
      tier: 'curated',
      title: desc ? desc[1].trim() : name.replace(/\.md$/, '').replace(/-/g, ' '),
      body: raw,
    });
  }
  return out;
}

/**
 * Lexical search over every curated memory body, evicted or not. `tier` is
 * accepted for backward compatibility with callers built for the two-pool
 * era (the recall gate passes 'curated' explicitly) but only `null` or
 * 'curated' are valid now - a caller asking for the retired 'distilled' tier
 * gets a loud error, not a silently empty result.
 * @returns {Array<{ target:string, title:string, score:number, excerpt:string, tier:'curated' }>}
 */
export function lookupFacts(memoryDir, query, { k = 5, tier = null } = {}) {
  // Fail LOUD on an unrecognized tier rather than silently scanning nothing and
  // returning [] - a typo'd or externally-supplied tier should surface as an
  // error, not a fail-safe-looking empty result (silent-extraction-failure-gotcha).
  if (tier !== null && tier !== 'curated') {
    throw new Error(`lookupFacts: unknown tier ${JSON.stringify(tier)} (expected null or 'curated')`);
  }
  const sections = factSections(memoryDir);
  if (!sections.length) return [];
  const bySlug = new Map(sections.map((s) => [s.slug, s]));
  return retrieveSections(query, sections, { k }).map((hit) => {
    const section = bySlug.get(hit.slug);
    // An excerpt makes a hit actionable without a second file read, which is
    // the whole economy of a layered fetch.
    const text = stripHtml(String(section?.body ?? '').replace(/^---[\s\S]*?---/, ''));
    return {
      target: hit.slug,
      title: hit.title,
      score: hit.score,
      excerpt: text.slice(0, 240),
      tier: 'curated',
    };
  });
}

/** Targets that have ever been faulted back in. */
export function faultedTargets(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(faultedFile(stateDir), 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function recordFaulted(stateDir, target) {
  try {
    const set = faultedTargets(stateDir);
    if (set.has(target)) return;
    set.add(target);
    const file = faultedFile(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...set], null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Fail open: failing to record must not fail the restore.
  }
}

function readEvicted(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(
      path.join(stateDir, 'memory', 'evicted.json'), 'utf8',
    ));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Page a fact's index line back in. Restores the line VERBATIM from the
 * eviction record, so nothing is re-summarized or rewritten.
 *
 * A resolved fault is evidence the eviction was wrong, so the target is
 * recorded and thereafter pinned (see memory-evict-runner's pinnedTargets).
 * This is the second-chance rule that prevents evict/fault thrash.
 *
 * @returns {{ restored: boolean, line?: string }}
 */
export function faultIn({ memoryDir, stateDir, target }) {
  const record = readEvicted(stateDir).filter((r) => r && r.target === target).pop();
  if (!record || typeof record.line !== 'string') return { restored: false };

  const indexPath = path.join(memoryDir, INDEX_FILE);
  let content;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return { restored: false };
  }
  // Already present (a second fault, or a manual restore): record the evidence
  // but do not duplicate the line.
  if (content.includes(`(${target})`)) {
    recordFaulted(stateDir, target);
    return { restored: false, line: record.line };
  }

  const lines = content.split(/\r?\n/);
  // Insert after the last existing entry so the footer, if any, stays last.
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^- \[[^\]]+\]\([^)]+\.md\)/.test(lines[i])) { at = i + 1; break; }
  }
  lines.splice(at, 0, record.line);
  fs.writeFileSync(indexPath, lines.join('\n'));
  recordFaulted(stateDir, target);
  return { restored: true, line: record.line };
}

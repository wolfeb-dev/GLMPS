// server/lib/evaluation/memory-consolidate.js
//
// Pure, propose-only "GC" pass for near-duplicate memory facts and guard
// lines. Mirrors guard-retire.js's shape exactly: pure functions returning
// candidate arrays, never mutating or deleting anything - a human reviews
// every proposal before any file is touched. This module is the missing
// production call site for semantic-dedup.js's clusterNearDups(), which
// was fully implemented and unit-tested but had zero callers.
//
// CANONICAL PICK heuristic (deterministic - no LLM, no clock, no randomness;
// Date.now()/Math.random are never used here)
//
// For each cluster of near-duplicate entries, one member is proposed as the
// "canonical" survivor a human would keep when collapsing the rest into it:
//
//   1. Longest text length wins (the most complete version of the fact/guard
//      is assumed to subsume the shorter near-duplicates).
//   2. Tie -> most inbound [[wikilinks]] referencing the entry's id (with the
//      .md extension stripped, if present), counted across the FULL entries
//      corpus passed in (not just the cluster) - a fact other memory already
//      links to is a better merge target than an orphan.
//   3. Tie -> lexicographically smallest id wins, purely for stable,
//      reproducible output across runs.
//
// Domain readers
//
// consolidateCandidates() itself only ever sees { id, text } entries - it has
// no opinion on where they came from. Two thin readers turn the project's
// two consolidation domains into that shape:
//   - memoryEntriesFromDir(dir): the per-topic memory .md files (MEMORY.md,
//     the index, is excluded - it's a table of contents, not a fact).
//   - guardEntriesFromClaudeMd(content): bullet lines under a CLAUDE.md-style
//     content string's `## Learned guards` section, via learning-templates.js's
//     existing sectionBodyLines() parser (reused, not reimplemented - that
//     parser is already what server.js uses to read the current guard lines
//     for the free-form apply-command's dedup prompt).
// Both readers are thin I/O-at-the-edges wrappers so tests never touch the
// user's real ~/.claude memory dir or CLAUDE.md.

import fs from 'node:fs';
import path from 'node:path';
import { clusterNearDups, DEFAULT_SIM_THRESHOLD } from './semantic-dedup.js';
import { sectionBodyLines } from './learning-templates.js';

const DEFAULT_MIN_CLUSTER_SIZE = 2;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEntries(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.id !== 'string' || !e.id) continue;
    if (typeof e.text !== 'string' || !e.text) continue;
    out.push({ id: e.id, text: e.text });
  }
  return out;
}

// Count entries elsewhere in the corpus whose text contains a [[wikilink]]
// resolving to `id` (extension stripped, so `foo.md` matches `[[foo]]`).
function inboundWikilinkCount(id, allEntries) {
  const linkName = String(id).replace(/\.md$/i, '');
  if (!linkName) return 0;
  const re = new RegExp(`\\[\\[\\s*${escapeRegExp(linkName)}\\s*\\]\\]`, 'i');
  let count = 0;
  for (const e of allEntries) {
    if (e.id === id) continue;
    if (re.test(e.text)) count++;
  }
  return count;
}

// Pick the canonical member of one cluster per the heuristic documented above.
function pickCanonical(members, allEntries) {
  let best = null;
  for (const m of members) {
    if (!best) { best = m; continue; }
    if (m.text.length !== best.text.length) {
      if (m.text.length > best.text.length) best = m;
      continue;
    }
    const inM = inboundWikilinkCount(m.id, allEntries);
    const inBest = inboundWikilinkCount(best.id, allEntries);
    if (inM !== inBest) {
      if (inM > inBest) best = m;
      continue;
    }
    if (m.id < best.id) best = m;
  }
  return best;
}

// entries: [{ id, text }]. Runs clusterNearDups over the entries' text and
// returns one proposal per cluster of size >= minClusterSize:
//   { members: [ids...], canonicalId, reason }
// Never writes anything; a pure read of `entries` in, an array of proposals
// out. Malformed entries (missing/non-string id or text) are skipped, never
// thrown.
export function consolidateCandidates(entries, { threshold = DEFAULT_SIM_THRESHOLD, minClusterSize = DEFAULT_MIN_CLUSTER_SIZE } = {}) {
  const normalized = normalizeEntries(entries);
  if (normalized.length < 2) return [];

  const texts = normalized.map((e) => e.text);
  const rawClusters = clusterNearDups(texts, threshold);
  if (!rawClusters.length) return [];

  // clusterNearDups returns the original text VALUES (not ids/indices), grouped
  // by union-find over pairwise similarity. Recover each occurrence's id via a
  // FIFO queue per distinct text value, built in the same original array
  // order as `normalized`. This is safe even when several ids share identical
  // text: two identical strings always score similarity 1.0 (>= any threshold
  // > 0), so same-text entries can never be split across two different
  // clusters - every occurrence of a given text value is consumed from its
  // queue in the same relative order it appears in `normalized`.
  const idQueues = new Map();
  for (const e of normalized) {
    if (!idQueues.has(e.text)) idQueues.set(e.text, []);
    idQueues.get(e.text).push(e.id);
  }

  const proposals = [];
  for (const clusterTexts of rawClusters) {
    if (clusterTexts.length < minClusterSize) continue;
    const members = clusterTexts.map((text) => ({ id: idQueues.get(text).shift(), text }));
    const canonical = pickCanonical(members, normalized);
    proposals.push({
      members: members.map((m) => m.id),
      canonicalId: canonical.id,
      reason: `${members.length} near-duplicate entries (>= ${threshold} trigram-cosine similarity)`,
    });
  }
  return proposals;
}

// Reads every *.md file directly under `dir` except MEMORY.md (the index),
// strips YAML frontmatter, and returns { id: filename, text: body }. `dir`
// is always caller-supplied (server.js passes the real memory dir; tests
// pass a temp dir) - this function never guesses a path itself.
export function memoryEntriesFromDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name === 'MEMORY.md') continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    out.push({ id: name, text: stripFrontmatter(content) });
  }
  return out;
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

// Parses bullet lines under `## Learned guards` (or another `section`) out
// of a CLAUDE.md-style content string via learning-templates.js's
// sectionBodyLines(), so this module never reimplements section-scanning.
// id is a stable `guard-<line-index>` slug (position within the parsed
// section) since guard lines carry no filename/identity of their own.
export function guardEntriesFromClaudeMd(content, { section = 'Learned guards' } = {}) {
  const lines = sectionBodyLines(String(content ?? ''), section);
  return lines.map((text, i) => ({ id: `guard-${i}`, text }));
}

export { DEFAULT_MIN_CLUSTER_SIZE };

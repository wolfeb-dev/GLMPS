// Operator tool: choose which memories and learned guards ship to customers
// (card glmps-2-0-183). Two steps, so nothing ships without a human decision.
//
//   node scripts/share-memory.mjs --propose [--out review.json]
//       Reads approved, trialing and kept memory facts and active lessons from
//       the state dir, asks an LLM (agy) for a shareable flag and a generic
//       rewording of each, and writes a review file. Changes no state.
//   node scripts/share-memory.mjs --apply review.json [--seed product/seed/memory.json]
//       Takes the rows the operator set "approved": true, records the flags in
//       state, and rewrites the tracked seed (share text only, no ids). A PR
//       commits the seed; releases are built from commits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, save, setShareable } from '../server/lib/governance/cross-agent-memory-store.js';
import { lessonsCurrent, readLessonRows, setLessonShareable } from '../server/lib/evaluation/lesson-ledger.js';
import { HISTORY_PATTERNS, publicScanHits, publicScanPatterns } from './release-builder.mjs';

const SHAREABLE_STATUSES = new Set(['approved', 'trialing', 'kept']);

const PROMPT = (original) => [
  'You are a text generator. Do NOT use tools, read files or run commands. Answer with one JSON object and nothing else.',
  'Below is one working note an engineer wrote for their own AI agents. Decide whether a generic version of it would help ANY team using these agents.',
  'Set "shareable" to false when it is specific to one person, project, machine or ticket, or cannot be reworded without those details.',
  'When true, "shareText" is one or two plain sentences with no names, paths, ticket ids, URLs or dates.',
  'Format: {"shareable": true|false, "shareText": "..."}',
  '', 'NOTE:', original,
].join('\n');

export function parseProposal(answer) {
  const m = /\{[\s\S]*\}/.exec(String(answer ?? ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o?.shareable !== 'boolean') return null;
    return { shareable: o.shareable, shareText: typeof o.shareText === 'string' ? o.shareText.trim() : '' };
  } catch { return null; }
}

function candidates(stateDir) {
  const out = [];
  for (const i of load(stateDir).items) {
    if (!SHAREABLE_STATUSES.has(i.status)) continue;
    out.push({ kind: 'memory', id: i.id, original: [i.fact?.name, i.fact?.description, i.fact?.body].filter(Boolean).join('\n') });
  }
  for (const [lessonId, l] of lessonsCurrent(readLessonRows(stateDir))) {
    if (l.status === 'active') out.push({ kind: 'lesson', id: lessonId, original: l.title ?? '' });
  }
  return out;
}

/** Asks `generate(prompt)` about each candidate, one at a time. Mutates no state. */
export async function proposeShares({ stateDir, generate }) {
  const rows = [];
  for (const c of candidates(stateDir)) {
    let proposed = null;
    let error = null;
    try { proposed = parseProposal(await generate(PROMPT(c.original))); } catch (e) { error = String(e?.message ?? e); }
    if (!proposed && !error) error = 'the generator did not return the expected JSON';
    rows.push({ ...c, proposed: proposed ?? { shareable: false, shareText: '' }, ...(error ? { error } : {}), approved: false });
  }
  return rows;
}

/** Records approved rows in state and rewrites the tracked seed from every shareable item. */
export function applyShares({ stateDir, review, seedFile, privateNames = [], now = Date.now() }) {
  const patterns = [...publicScanPatterns(privateNames), ...HISTORY_PATTERNS];
  const applied = [];
  const refused = [];
  let memory = load(stateDir);
  for (const row of review ?? []) {
    if (row?.approved !== true) continue;
    const { shareable, shareText } = row.proposed ?? {};
    if (typeof shareable !== 'boolean') { refused.push({ id: row.id, why: 'no proposal to apply' }); continue; }
    if (shareable) {
      const hits = publicScanHits(String(shareText ?? ''), patterns);
      if (!String(shareText ?? '').trim()) { refused.push({ id: row.id, why: 'empty share text' }); continue; }
      if (hits.length) { refused.push({ id: row.id, why: `share text fails the scan: ${hits.map((h) => h.pattern).join(', ')}` }); continue; }
    }
    try {
      if (row.kind === 'lesson') setLessonShareable(stateDir, { lessonId: row.id, shareable, shareText: shareable ? shareText : null, now });
      else memory = setShareable(memory, row.id, { shareable, shareText: shareable ? shareText : null }).state;
      applied.push(row.id);
    } catch (e) { refused.push({ id: row.id, why: String(e?.message ?? e) }); }
  }
  if (applied.length) save(stateDir, memory);

  const items = [];
  for (const i of memory.items) if (i.shareable === true && i.shareText) items.push({ kind: 'memory', text: i.shareText });
  for (const l of lessonsCurrent(readLessonRows(stateDir)).values()) if (l.shareable === true && l.shareText) items.push({ kind: 'lesson', text: l.shareText });
  const seen = new Set();
  const seed = { version: 1, items: items.filter((i) => { const k = `${i.kind}|${i.text}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (a.kind + a.text < b.kind + b.text ? -1 : 1)) };
  if (applied.length || fs.existsSync(seedFile)) {
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2) + '\n');
  }
  return { applied, refused, seedCount: seed.items.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const { getPaths } = await import('../server/lib/paths.js');
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const stateDir = getPaths(process.env).stateDir;
  const privateNames = [os.userInfo().username];
  try {
    if (argv.includes('--propose')) {
      const { agyGenerate } = await import('../server/lib/observability/wiki-agy.js');
      const out = path.resolve(arg('--out') ?? 'share-review.json');
      const rows = await proposeShares({ stateDir, generate: (p) => agyGenerate(p) });
      fs.writeFileSync(out, JSON.stringify(rows, null, 2) + '\n');
      console.log(`share-memory: ${rows.length} proposal(s) written to ${out}; set "approved": true on the ones to ship, then --apply`);
    } else if (argv.includes('--apply') && arg('--apply')) {
      const review = JSON.parse(fs.readFileSync(path.resolve(arg('--apply')), 'utf8'));
      const seedFile = path.resolve(arg('--seed') ?? path.join(import.meta.dirname, '..', 'product', 'seed', 'memory.json'));
      const r = applyShares({ stateDir, review, seedFile, privateNames });
      console.log(`share-memory: applied ${r.applied.length}, refused ${r.refused.length}, seed now ${r.seedCount} item(s) -> ${seedFile}`);
      for (const x of r.refused) console.log(`  refused ${x.id}: ${x.why}`);
    } else {
      console.error('usage: node scripts/share-memory.mjs --propose [--out review.json] | --apply review.json [--seed path]');
      process.exit(2);
    }
  } catch (e) {
    console.error(`share-memory failed: ${e.message}`);
    process.exit(1);
  }
}

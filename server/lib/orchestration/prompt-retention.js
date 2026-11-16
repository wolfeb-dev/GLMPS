// Runner prompt retention (card glmps-2-0-runtime-152): a <stateDir>/runner
// *.prompt.md file is deleted 14 days after its card closed. Anything it
// cannot tie to a closed card with a readable close time is kept.
import fs from 'node:fs';
import path from 'node:path';
import { CLOSED_STATES } from './backlog-store.js';

export const PROMPT_RETENTION_MS = 14 * 24 * 3600 * 1000;
const SUFFIX = '.prompt.md';

// Only a review prompt names another card. Any looser prefix match would tie
// an orphaned glmps-2-0-* file to an unrelated card such as glmps-2.
const REVIEW_SUFFIX = /-review-r\d+$/;

/** The card id a prompt file belongs to: its stem, or the reviewed card for a <id>-review-rN stem. */
export function cardIdOfPrompt(name, ids) {
  if (!name.endsWith(SUFFIX)) return null;
  const stem = name.slice(0, -SUFFIX.length).toLowerCase();
  if (ids.has(stem)) return stem;
  const reviewed = stem.replace(REVIEW_SUFFIX, '');
  return reviewed !== stem && ids.has(reviewed) ? reviewed : null;
}

function closedAt(item) {
  for (const v of [item.stateEnteredAt, item.doneAt, item.updatedAt]) {
    const t = Date.parse(v ?? '');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function prunePromptFiles({ stateDir, items, now = Date.now, maxAgeMs = PROMPT_RETENTION_MS }) {
  const dir = path.join(stateDir, 'runner');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { pruned: [], kept: 0 }; }
  const byId = new Map((items ?? []).map((i) => [String(i.id).toLowerCase(), i]));
  const ids = new Set(byId.keys());
  const cutoff = now() - maxAgeMs;
  const pruned = [];
  let kept = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(SUFFIX)) continue;
    const item = byId.get(cardIdOfPrompt(e.name, ids));
    const t = item && CLOSED_STATES.has(item.state) ? closedAt(item) : null;
    if (t == null || t > cutoff) { kept += 1; continue; }
    const file = path.join(dir, e.name);
    try { fs.rmSync(file); pruned.push(file); } catch { kept += 1; }
  }
  return { pruned, kept };
}

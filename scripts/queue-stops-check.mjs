#!/usr/bin/env node
// Card glmps-2-0-107: re-measures, read-only, the three ways the queue stopped
// moving cards, against a running server's board and runner ledger.
// Usage: node scripts/queue-stops-check.mjs [--port 8123]
import { pathToFileURL } from 'node:url';
import { strandedAfterMerge } from '../server/lib/orchestration/merge-exec.js';
import { FINISHED } from '../server/lib/orchestration/queue-runner.js';

export function queueStops({ items = [], ledger = {}, now = Date.now() }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hours = (ms) => Math.round((now - ms) / 360_000) / 10;
  // Cause 1: a card the runner launched shows running, but no ledger entry tracks it.
  const untracked = items
    .filter((i) => i.state === 'in_progress' && i.runSession?.launcher && !ledger[i.id])
    .map((i) => ({ id: i.id, since: i.stateEnteredAt ?? i.updatedAt ?? null }));
  // Cause 2: a ledger entry holding a slot for a card that is not running, so
  // the runner neither picks the card nor frees the slot.
  const deadSlots = Object.entries(ledger)
    .filter(([id, e]) => e?.role !== 'reviewer' && e?.pid == null && !e?.headless && byId.get(id) && byId.get(id).state !== 'in_progress' && !FINISHED.has(byId.get(id).state))
    .map(([id, e]) => ({ id, state: byId.get(id).state, hours: hours(e.startedAt) }));
  // Cause 3: idle since before a covers merge that left criteria open.
  const stranded = strandedAfterMerge({ items, ledger }).map((s) => ({ id: s.id, open: s.open, idleHours: hours(Date.parse(byId.get(s.id).idleSince)) }));
  return { untracked, deadSlots, stranded };
}

async function main() {
  const i = process.argv.indexOf('--port');
  const base = `http://127.0.0.1:${i > 0 ? Number(process.argv[i + 1]) : 8123}`;
  const board = await (await fetch(`${base}/api/backlog`)).json();
  const runner = await (await fetch(`${base}/api/runner`)).json();
  const r = queueStops({ items: board.items ?? board, ledger: runner.ledger ?? {} });
  console.log(`runner: enabled ${runner.config?.enabled}, maxConcurrent ${runner.config?.maxConcurrent}, ledger ${Object.keys(runner.ledger ?? {}).join(', ') || 'empty'}`);
  console.log(`1 untracked running cards: ${r.untracked.length}${r.untracked.map((u) => `\n  ${u.id} (since ${u.since})`).join('')}`);
  console.log(`2 dead runner slots: ${r.deadSlots.length}${r.deadSlots.map((d) => `\n  ${d.id} (card ${d.state}, slot held ${d.hours} h)`).join('')}`);
  console.log(`3 stranded after a partial merge: ${r.stranded.length}${r.stranded.map((s) => `\n  ${s.id} (open AC-${s.open.join(', AC-')}, idle ${s.idleHours} h)`).join('')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });

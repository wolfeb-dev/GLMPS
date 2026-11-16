// server/lib/orchestration/session-cards.js
// Which backlog card a session ran for, so lists can show the card title
// instead of the runner prompt every runner session starts with (card
// glmps-2-0-53). The store is re-read only when the board changes: /api/state
// is polled after every event and the store is megabytes.
import path from 'node:path';
import * as backlogStore from './backlog-store.js';

const previousIds = (i) => (Array.isArray(i?.runSession?.previousSessionIds) ? i.runSession.previousSessionIds : []);

// Every session a card ran in, not only the latest, so an earlier run of a
// relaunched card keeps its card (glmps-190). Current sessions are indexed
// before any history, so a stale history entry never takes an id another
// card currently runs in.
export function buildSessionCardIndex(items) {
  const bySession = new Map();
  const add = (sid, i) => {
    if (!sid || bySession.has(sid)) return;
    const card = { id: i.id, title: i.title ?? '' };
    if (i.gate?.status) card.gate = i.gate.status;
    bySession.set(sid, card);
  };
  for (const i of items ?? []) add(i?.runSession?.sessionId, i);
  for (const i of items ?? []) for (const sid of previousIds(i)) add(sid, i);
  return bySession;
}

// The full card for one session's detail page (session-detail spec section 8
// item 1). Lists keep the slim row above; only the per-session response pays
// for criteria and merge-queue state.
export function sessionCardDetail(i) {
  const g = i.gate?.status ? i.gate : null;
  const mr = i.mergeRequest ?? null;
  return {
    id: i.id, title: i.title ?? '', state: i.state ?? null,
    acceptanceCriteria: (Array.isArray(i.acceptanceCriteria) ? i.acceptanceCriteria : []).map((a) => ({ text: a.text, done: !!a.done })),
    gate: g ? { status: g.status, risk: g.risk ?? null, evidenceCount: Array.isArray(g.evidence) ? g.evidence.length : 0, ts: g.ts ?? null } : null,
    prUrl: i.prUrl ?? mr?.prUrl ?? null,
    mergeQueue: mr ? { stage: mr.stage, round: mr.round ?? 1, prUrl: mr.prUrl ?? null, number: mr.number ?? null,
      interim: !!mr.interim, covers: mr.covers ?? null, final: !!mr.final, mergeSha: mr.mergeSha ?? null } : null,
  };
}

export function createSessionCardLookup(stateDir, { load = backlogStore.load, stat = null } = {}) {
  const file = path.join(stateDir, 'backlog', 'store.json');
  let key = null;
  let index = new Map();
  let items = [];
  const refresh = () => {
    let k;
    // The store's own version, not store.json's stat: most writes only append
    // to the change log and leave the snapshot file untouched.
    if (!stat) k = `v${backlogStore.boardVersion(stateDir)}`;
    else { try { const s = stat(file); k = `${s.mtimeMs}:${s.size}`; } catch { k = 'missing'; } }
    if (k !== key) { items = load(stateDir).items ?? []; index = buildSessionCardIndex(items); key = k; }
  };
  const lookup = () => { refresh(); return index; };
  // Same first-match rule as the index, so a list row and its detail page name the same card.
  lookup.detail = (sid) => {
    refresh();
    const id = sid ? index.get(sid)?.id : null;
    const item = id ? items.find((i) => i?.id === id && (i.runSession?.sessionId === sid || previousIds(i).includes(sid))) : null;
    return item ? sessionCardDetail(item) : null;
  };
  return lookup;
}

// Returns new rows; a row with no card is returned as is.
export function withCards(rows, index) {
  return (rows ?? []).map((r) => { const card = r?.id ? index.get(r.id) : null; return card ? { ...r, card } : r; });
}

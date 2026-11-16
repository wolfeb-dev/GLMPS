// server/lib/kernel/gate-reconcile.js
// glmps-2-0-39: ties judge verdicts back to the card whose gate obligation
// they close. A card records its session durably in runSession.sessionId; the
// runner ledger (the older lookup) is often gone by judge time.

export function ticketIdForSession(items, sid) {
  if (!sid || !Array.isArray(items)) return null;
  return items.find((i) => i?.runSession?.sessionId === sid)?.id ?? null;
}

// Queue (or refresh) the judge.session job that can close an open gate row.
// Same job shape finalizeAndQueueJudge writes, so the two upsert onto one job
// per session. No runSession on the card means nothing to judge: the row is
// left to escalate and the operator closes it.
export function reconcileGateObligation({ row, loadItems, retryQueue }) {
  if (row?.kind !== 'gate.independent-verdict') return { queued: false };
  const item = (loadItems() || []).find((i) => i?.id === row.subject);
  const sid = item?.runSession?.sessionId;
  if (!sid) return { queued: false };
  retryQueue.upsert(
    (j) => j.kind === 'judge.session' && j.sessionId === sid,
    { kind: 'judge.session', sessionId: sid, rowId: `session-${sid}`, ticketId: row.subject },
  );
  return { queued: true, sessionId: sid };
}

export function reconcileOpenGateRows({ store, loadItems, retryQueue }) {
  let queued = 0;
  for (const row of store.listOpen()) {
    if (row.kind !== 'gate.independent-verdict') continue;
    if (reconcileGateObligation({ row, loadItems, retryQueue }).queued) queued++;
  }
  return { queued };
}

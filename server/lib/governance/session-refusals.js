// server/lib/governance/session-refusals.js
// The guard refusals one session hit, for the Touching band of its detail page
// (session-detail spec section 8 item 6). Records written before the hooks
// sent sessionId carry a card only; those join on the session's own card and
// say so (`by: 'card'`), since a requeued card's runs cannot be told apart.
export function sessionRefusals(records, sid, cardId) {
  const items = [];
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    let by = null;
    if (r.sessionId) { if (r.sessionId === sid) by = 'session'; }
    else if (cardId && r.cardId === cardId) by = 'card';
    if (!by) continue;
    items.push({
      ts: r.ts ?? null, hook: r.hook ?? null, tool: r.tool ?? null, path: r.path ?? null,
      reason: r.reason ?? '', failOpen: r.failOpen === true,
      cardId: r.cardId ?? null, sessionId: r.sessionId ?? null, by,
    });
  }
  const failOpen = items.filter((r) => r.failOpen).length;
  return { items, count: items.length, refused: items.length - failOpen, failOpen };
}

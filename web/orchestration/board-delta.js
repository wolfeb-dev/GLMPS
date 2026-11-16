// web/orchestration/board-delta.js - keeps the board's card list current from
// 'backlog' SSE events without refetching the whole board per event (card
// glmps-2-0-runtime-65). An event names the changed card ids and the board
// version; this fetches only those cards and merges them. Anything it cannot
// reason about (unnamed change, a missed event) falls back to one full fetch.
// Events that arrive while a fetch is in flight, or within `waitMs` of the last one, are merged
// into one round trip.

export function createBoardDelta({ fetchFull, fetchIds, paint, waitMs = 300, schedule = setTimeout }) {
  let items = null;          // Map id -> card
  let version = null;        // board version the map is complete up to
  let epoch = null;          // server boot id the version belongs to
  let queued = null;         // { ids:Set|null, first:event, last:event }
  let timer = null;
  let running = false;
  let lastFlushTs = 0;

  const setFull = (res) => {
    items = new Map((res.items ?? []).map((i) => [i.id, i]));
    version = res.version ?? null;
    epoch = res.epoch ?? null;
  };

  async function full() {
    const res = await fetchFull();
    setFull(res);
    paint([...items.values()], res);
  }

  async function flush() {
    if (running || !queued) return;
    running = true;
    const q = queued; queued = null; timer = null;
    try {
      const gap = q.ids === null || items === null || version === null || q.first.prev > version;
      if (gap) await full();
      else {
        const ids = [...q.ids];
        if (ids.length) {
          const res = await fetchIds(ids);
          for (const i of res.items ?? []) items.set(i.id, i);
          for (const id of res.removed ?? []) items.delete(id);
        }
        version = Math.max(version, q.last.version);
        paint([...items.values()], null);
      }
    } catch (e) {
      items = null; // next event starts from a full fetch
      console.error('board delta', e);
    } finally {
      running = false;
      lastFlushTs = Date.now();
      if (queued) arm();
    }
  }

  function arm() {
    if (timer != null || running) return;
    // The first event after a quiet spell goes out at once; a burst is merged.
    timer = schedule(flush, Date.now() - lastFlushTs >= waitMs ? 0 : waitMs);
  }

  return {
    /** Record the result of a full fetch made elsewhere (the board's own refresh). */
    seed(res) { setFull(res); },
    onEvent(p) {
      // Versions restart with the server, so another epoch means nothing here is comparable.
      const stale = (p.epoch ?? null) !== epoch;
      // An empty id list is a non-card change (the runner ledger): repaint, no board fetch.
      if (!stale && p.ids?.length && version != null && p.version != null && p.version <= version) return;
      if (!queued) queued = { ids: p.ids == null || stale ? null : new Set(p.ids), first: p, last: p };
      else {
        if (p.ids == null || stale) queued.ids = null;
        else if (queued.ids) for (const id of p.ids) queued.ids.add(id);
        queued.last = p;
      }
      arm();
    },
    flush,
  };
}

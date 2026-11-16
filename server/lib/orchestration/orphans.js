// Pure selectors for card glmps-2-0-171: a card with no open host and nobody
// steering it is an orphan, and a host whose cards have all closed can close.
import { hostOpen } from './queue-runner.js';
import { CLOSED_STATES } from './backlog-store.js';

export const ORPHAN_QUIET_MS = 24 * 3600_000;
export const ORPHAN_POST_MAX = 20;
export const HOST_READY_TEXT = 'all hosted cards are closed; this card can close';
const STALLED = new Set(['held', 'idle', 'queued']);
const LAST_LINE_MAX = 120;

const lastLine = (card) => {
  const t = String(card.devLog?.at(-1)?.text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > LAST_LINE_MAX ? `${t.slice(0, LAST_LINE_MAX - 3)}...` : t;
};

// `live` is ids with a runner session, `parked` ids with an open park.
export function selectOrphans({ items = [], live = [], parked = [], now = Date.now(), quietMs = ORPHAN_QUIET_MS } = {}) {
  const liveSet = new Set(live);
  const parkSet = new Set(parked);
  const out = [];
  for (const card of items) {
    if (card.quarantined || CLOSED_STATES.has(card.state) || hostOpen(card, items)) continue;
    const headless = card.mode === 'headless';
    const touched = Date.parse(card.updatedAt ?? '');
    const quiet = !Number.isFinite(touched) || now - touched >= quietMs;
    const stalled = STALLED.has(card.state) && !liveSet.has(card.id) && !parkSet.has(card.id) && quiet;
    if (!stalled && !headless) continue;
    out.push({ id: card.id, title: card.title ?? '', state: card.state, last: lastLine(card), headless, touched: Number.isFinite(touched) ? touched : 0 });
  }
  return out.sort((a, b) => a.touched - b.touched);
}

export function orphanPost(orphans, { max = ORPHAN_POST_MAX } = {}) {
  const shown = orphans.slice(0, max);
  const rows = shown.map((o) => {
    const tail = o.last ? ` | ${o.last}` : '';
    const tag = o.headless ? ' (headless, no host)' : '';
    return `${o.id} ${o.title} [${o.state}]${tag}${tail} | reply \`run ${o.id}\` or \`drop ${o.id}\``;
  });
  if (orphans.length > shown.length) rows.push(`and ${orphans.length - shown.length} more`);
  const n = orphans.length;
  return [`${n} card${n === 1 ? '' : 's'} with no host or steering:`, ...rows].join('\n');
}

// One notice per set of hosted cards: the ids are part of the text, so a card
// adopted later earns a fresh notice and a repeat sweep stays quiet.
export function hostsReadyToClose(items = []) {
  const out = [];
  for (const host of items) {
    if (CLOSED_STATES.has(host.state)) continue;
    const kids = items.filter((i) => i.parentId === host.id);
    if (!kids.length || kids.some((k) => !CLOSED_STATES.has(k.state))) continue;
    const text = `${HOST_READY_TEXT} (${kids.map((k) => k.id).join(', ')})`;
    if ((host.devLog ?? []).some((d) => d.text === text)) continue;
    out.push({ id: host.id, text });
  }
  return out;
}

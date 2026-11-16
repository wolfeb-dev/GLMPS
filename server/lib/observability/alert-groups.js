// server/lib/observability/alert-groups.js
// The one grouping of alerts into what needs attention. GET /api/alerts returns
// it as `attention` and the Surface Alerts dock renders that; the alert-digest
// loop posts the new rows of the same grouping to Slack once a morning.
// Pure: no I/O.

const SOURCE_LABELS = Object.freeze({
  'kernel-health': 'Kernel health',
  'capture-health': 'Capture health',
  integrity: 'Integrity',
  'unmerged-branch': 'Unmerged branches',
  injection: 'Injection',
  poison: 'Poison',
});

/** Readable label for an alert source; unknown sources are de-kebabed. */
export function sourceLabel(source) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  const s = String(source ?? 'other').replace(/[-_]+/g, ' ').trim() || 'other';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// An obligation expiry is one alert per card ("Obligation expired: <rule> <card>");
// the finding is the rule, so eleven cards missing one gate are one row.
const OBLIGATION_RULE = /^(Obligation expired: \S+)/;

/** The finding an alert belongs to: its source, or its rule for obligation expiries. */
export function findingKey(a) {
  const source = a?.source ?? 'other';
  if (source === 'obligation') {
    const m = OBLIGATION_RULE.exec(a.title ?? '');
    if (m) return `obligation:${m[1]}`;
  }
  return source;
}

function findingLabel(key, source) {
  return key.startsWith('obligation:') ? key.slice('obligation:'.length) : sourceLabel(source);
}

const byNewest = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);

/**
 * Every critical alert on its own (newest first); every warning folded into
 * one group per finding, biggest group first (ties by label), ids newest
 * first. Info and acknowledged alerts are not attention. Rows carry ids, not
 * copies: the alerts themselves are in the same response.
 * @returns {{ critical: string[], groups: { key, source, label, count, ids: string[] }[] }}
 */
export function groupAlerts(alerts) {
  const critical = [];
  const byKey = new Map();
  for (const a of alerts ?? []) {
    if (!a || a.acknowledged || a.severity === 'info') continue;
    if (a.severity === 'critical') { critical.push(a); continue; }
    const key = findingKey(a);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }
  const groups = [...byKey].map(([key, rows]) => {
    const source = rows[0].source ?? 'other';
    return { key, source, label: findingLabel(key, source), count: rows.length, ids: rows.sort(byNewest).map((a) => a.id) };
  });
  groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { critical: critical.sort(byNewest).map((a) => a.id), groups };
}

// An expired independent-review obligation opens on every finished card and
// nothing the operator does closes it, so in Slack it was pure volume (card
// glmps-2-0-219). It stays on the dashboard.
const REVIEW_BOOKKEEPING = /^Obligation expired: gate\.independent-verdict\b/;

export function isReviewBookkeeping(a) {
  return a?.source === 'obligation' && REVIEW_BOOKKEEPING.test(a.title ?? '');
}

function localClock(nowMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The once-a-morning Slack digest (card glmps-2-0-219). Due on the first call
 * at or after `hour` in `timeZone` on a local day not yet posted. `ids` is
 * every alert the digest now counts as seen; `text` lists only the ones
 * missing from `prev.ids`, and is null when nothing is new. A `prev` from the
 * old every-change digest has no `ids`: it is seeded without a post, so the
 * switch-over does not repeat the whole list once more.
 * @returns {{ due: false } | { due: true, day: string, ids: string[], text: string|null }}
 */
export function morningDigest({ alerts, prev, nowMs, timeZone, hour = 8, maxCritical = 10 }) {
  const clock = localClock(nowMs, timeZone);
  if (clock.hour < hour || prev?.day === clock.day) return { due: false };
  const eligible = (alerts ?? []).filter((a) => a && !a.acknowledged && a.severity !== 'info' && !isReviewBookkeeping(a));
  const ids = eligible.map((a) => a.id);
  if (prev && !Array.isArray(prev.ids)) return { due: true, day: clock.day, ids, text: null };
  const seen = new Set(prev?.ids ?? []);
  const fresh = eligible.filter((a) => !seen.has(a.id));
  if (!fresh.length) return { due: true, day: clock.day, ids, text: null };
  const { critical, groups } = groupAlerts(fresh);
  const warned = groups.reduce((n, g) => n + g.count, 0);
  const counts = [critical.length && `${critical.length} critical`, warned && plural(warned, 'warning')].filter(Boolean).join(', ');
  const lines = [`Alerts: ${fresh.length} new since the last digest (${counts}). Full list in the dashboard Alerts panel.`];
  const byId = new Map(fresh.map((a) => [a.id, a]));
  if (critical.length) {
    lines.push('*Critical*');
    for (const id of critical.slice(0, maxCritical)) lines.push(`- ${byId.get(id).title ?? id} (${sourceLabel(byId.get(id).source)})`);
    if (critical.length > maxCritical) lines.push(`- +${critical.length - maxCritical} more critical`);
  }
  if (groups.length) {
    lines.push('*Warnings*');
    for (const g of groups) lines.push(`- ${g.label}: ${g.count}`);
  }
  return { due: true, day: clock.day, ids, text: lines.join('\n') };
}

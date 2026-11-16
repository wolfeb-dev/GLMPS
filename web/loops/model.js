// web/loops/model.js
// The Loops lens's classification, grouping, filtering and number formats.
// Pure: no DOM, so it is importable under node:test.

export const GROUPS = Object.freeze([
  ['ship', 'Ship work'],
  ['learn', 'Learn'],
  ['graphs', 'Graphs and docs'],
  ['feeds', 'Feeds and housekeeping'],
]);
export const NOT_DESCRIBED = 'Not described';

export const SCOPES = Object.freeze([['all', 'All'], ['attn', 'Needs attention'], ['llm', 'Steered by Personality']]);

export const STATUS_LABEL = Object.freeze({ ok: 'ok', idle: 'idle', failing: 'failing', never: 'never ran', stale: 'stale' });

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function trim1(n) { return String(Math.round(n * 10) / 10); }

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  const v = Math.max(0, ms);
  if (v < MIN) return `${Math.round(v / 1000)} s`;
  if (v < HOUR) return `${Math.round(v / MIN)} min`;
  if (v < DAY) return `${trim1(v / HOUR)} h`;
  return `${trim1(v / DAY)} d`;
}

export function cadence(trigger) {
  if (!trigger || typeof trigger !== 'object') return '-';
  if (trigger.everyMs != null) return `every ${fmtDuration(trigger.everyMs)}`;
  if (trigger.onEvent != null) return `on ${trigger.onEvent}`;
  if (trigger.external != null) return 'external';
  return '-';
}

// Age in seconds at render time: the age the server reported when it answered,
// plus the time since, so a loop that stops running goes stale on screen
// without another fetch.
export function ageNowS(loop, elapsedMs = 0) {
  return loop.ageS == null ? null : loop.ageS + Math.max(0, elapsedMs) / 1000;
}

export function statusOf(loop, elapsedMs = 0) {
  const failing = (loop.consecutiveFailures ?? 0) > 0 || String(loop.lastOutcome ?? '').startsWith('failed');
  if (failing) return 'failing';
  if (loop.lastRunTs == null) return 'never';
  const max = loop.sla?.maxAgeMs;
  const age = ageNowS(loop, elapsedMs);
  if (max > 0 && age != null && age * 1000 > max) return 'stale';
  return loop.lastOutcome === 'done' ? 'ok' : 'idle';
}

// One chip per Personality card: reads and writes of the same card merge, and a
// card reached only indirectly is marked so.
export function mergeSteers(steers) {
  const byCard = new Map();
  for (const s of Array.isArray(steers) ? steers : []) {
    const card = typeof s === 'string' ? s : s?.card;
    if (!card) continue;
    const mode = typeof s === 'string' ? 'reads' : s.mode;
    const e = byCard.get(card) ?? { card, direct: false, reads: false, writes: false };
    if (mode === 'indirect') { /* leaves direct as it was */ } else e.direct = true;
    if (mode === 'writes') e.writes = true;
    else if (mode !== 'indirect') e.reads = true;
    byCard.set(card, e);
  }
  return [...byCard.values()];
}

export function modeLabel(c) {
  if (!c.direct) return 'indirect';
  return c.reads && c.writes ? 'reads and writes' : (c.writes ? 'writes' : 'reads');
}

export function usesLlm(loop) { return mergeSteers(loop.about?.steers).length > 0; }

export function needsAttention(kind) { return kind === 'failing' || kind === 'never' || kind === 'stale'; }

export function summarize(loops, elapsedMs = 0) {
  const s = { total: loops.length, ok: 0, idle: 0, failing: 0, never: 0, stale: 0, steered: 0, mechanical: 0 };
  for (const l of loops) {
    s[statusOf(l, elapsedMs)] += 1;
    if (usesLlm(l)) s.steered += 1;
    else if (l.about) s.mechanical += 1;
  }
  return s;
}

export function loopMatches(loop, { scope = 'all', q = '' }, nameOf, elapsedMs = 0) {
  if (scope === 'attn' && !needsAttention(statusOf(loop, elapsedMs))) return false;
  if (scope === 'llm' && !usesLlm(loop)) return false;
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const cards = mergeSteers(loop.about?.steers).map((c) => nameOf(c.card)).join(' ');
  return `${loop.name} ${cards}`.toLowerCase().includes(needle);
}

// Groups in the fixed order; a group key the lens does not know follows them,
// and a loop with no about record lands last under "Not described".
export function groupLoops(loops) {
  const known = new Map(GROUPS.map(([id, title]) => [id, { id, title, loops: [] }]));
  const extra = new Map();
  const undescribed = { id: 'undescribed', title: NOT_DESCRIBED, loops: [] };
  for (const l of loops) {
    const key = l.about?.group;
    if (!l.about) undescribed.loops.push(l);
    else if (known.has(key)) known.get(key).loops.push(l);
    else {
      const k = key ?? 'other';
      if (!extra.has(k)) extra.set(k, { id: k, title: String(k), loops: [] });
      extra.get(k).loops.push(l);
    }
  }
  return [...known.values(), ...extra.values(), undescribed].filter((g) => g.loops.length);
}

export function slaFraction(ageS, maxAgeMs) {
  if (ageS == null || !(maxAgeMs > 0)) return null;
  return Math.min(1, (ageS * 1000) / maxAgeMs);
}

export function nextRunText(loop, now) {
  const t = loop.trigger ?? {};
  if (t.onEvent != null) return { text: `When ${t.onEvent} fires` };
  if (t.external != null) return { text: 'Started from outside, no schedule' };
  if (loop.nextRunTs == null) return { text: 'Not scheduled' };
  const d = loop.nextRunTs - now;
  return { text: d <= 0 ? 'Due now' : `In ${fmtDuration(d)}`, ts: loop.nextRunTs };
}

// web/surface/heartbeat.js
// The live-motion (heartbeat) model (no DOM): what one arriving event means, each
// session's last 60 seconds as dial ticks, calls per minute and the 5-minute
// sparkline, and which provider a session's model turns go to. The Surface
// layers draw from it; nothing here moves.
export const DIAL_TICKS = 60;
export const SPARK_BUCKETS = 15; // 5 minutes in 20 s buckets
const SPARK_BUCKET_MS = 20_000;
export const FAIL_MS = 30_000;
const KEEP_MS = 6 * 60_000;
const KEEP_MAX = 600;
const RANK = { info: 1, ok: 2, err: 3 };
// Kinds that are a call the agent made, as against bookkeeping (token counts,
// thinking, context and memory reads, the user's own prompt).
const CALL_KINDS = new Set(['tool', 'command', 'mcp', 'file-edit', 'git', 'skill', 'agent']);

export function classifyEvent(ev) {
  const kind = ev?.kind ?? null;
  const call = CALL_KINDS.has(kind);
  if (kind === 'git' && ev.gitOp === 'commit') return { tone: 'ok', kind: 'commit', call };
  if (kind === 'git' && ev.gitOp === 'push') return { tone: 'ok', kind: 'push', call };
  return { tone: 'info', kind: 'activity', call };
}

// Player ids as in players.json. A tool with no entry draws no arc.
export function providerFor(tool) {
  const t = String(tool ?? '');
  if (/^claude/.test(t)) return 'anthropic';
  if (/^(gemini|antigravity|agy)/.test(t)) return 'gcp';
  return null;
}

// Held is a state; "idle with a question" has no field of its own, so the
// card's last devlog line ending in a question mark stands for it.
export function needsYou(card) {
  if (!card) return false;
  if (card.state === 'held') return true;
  if (card.state !== 'idle') return false;
  const last = Array.isArray(card.devLog) ? card.devLog.at(-1) : null;
  return typeof last?.text === 'string' && /\?\s*$/.test(last.text.trim());
}

const stamp = (ev, now) => {
  const raw = typeof ev?.ts === 'number' ? ev.ts : Date.parse(ev?.ts);
  return Number.isFinite(raw) ? Math.min(raw, now) : now;
};

export function createPulseStore() {
  const sessions = new Map();
  const get = (id) => {
    let s = sessions.get(id);
    if (!s) { s = { events: [], failUntil: 0, waiting: null }; sessions.set(id, s); }
    return s;
  };
  const trim = (s, now) => {
    const cut = now - KEEP_MS;
    let i = 0;
    while (i < s.events.length && s.events[i].ts < cut) i++;
    if (s.events.length - i > KEEP_MAX) i = s.events.length - KEEP_MAX;
    if (i > 0) s.events.splice(0, i);
  };
  const lastOf = (s, pick) => { for (let i = s.events.length - 1; i >= 0; i--) { const e = s.events[i]; if (!e.mark && pick(e)) return e; } return null; };

  return {
    // What the caller should animate for this batch.
    push(id, events, now) {
      const s = get(id);
      const pings = []; let push = false;
      for (const ev of events ?? []) {
        const c = classifyEvent(ev);
        s.events.push({ ts: stamp(ev, now), tone: c.tone, call: c.call, git: ev?.kind === 'git' ? ev.gitOp ?? null : null, label: typeof ev?.label === 'string' ? ev.label : null });
        pings.push(c.tone);
        if (c.kind === 'push') push = true;
      }
      s.events.sort((a, b) => a.ts - b.ts);
      trim(s, now);
      return { pings, push };
    },
    // A verdict, not an agent call: a red mark also makes the session failing for FAIL_MS.
    mark(id, tone, now) {
      const s = get(id);
      s.events.push({ ts: now, tone, call: false, mark: true });
      s.events.sort((a, b) => a.ts - b.ts);
      if (tone === 'err') s.failUntil = Math.max(s.failUntil, now + FAIL_MS);
      trim(s, now);
    },
    setWaiting(id, waiting) { get(id).waiting = waiting; },
    ticks(id, now) {
      const out = new Array(DIAL_TICKS).fill(null);
      for (const e of sessions.get(id)?.events ?? []) {
        const age = Math.floor((now - e.ts) / 1000);
        if (age < 0 || age >= DIAL_TICKS) continue;
        if (out[age] == null || RANK[e.tone] > RANK[out[age]]) out[age] = e.tone;
      }
      return out;
    },
    callsPerMinute(id, now) {
      return (sessions.get(id)?.events ?? []).filter((e) => e.call && now - e.ts < 60_000).length;
    },
    series(id, now) {
      const out = new Array(SPARK_BUCKETS).fill(0);
      for (const e of sessions.get(id)?.events ?? []) {
        if (!e.call) continue;
        const age = Math.floor((now - e.ts) / SPARK_BUCKET_MS);
        if (age >= 0 && age < SPARK_BUCKETS) out[SPARK_BUCKETS - 1 - age]++;
      }
      return out;
    },
    summary(id, now) {
      const s = sessions.get(id);
      if (!s) return { lastTs: null, lastLabel: null, lastGitTs: null, failing: false, waiting: null };
      const last = lastOf(s, () => true);
      const git = lastOf(s, (e) => e.git === 'commit' || e.git === 'push');
      return { lastTs: last?.ts ?? null, lastLabel: last?.label ?? null, lastGitTs: git?.ts ?? null, failing: s.failUntil > now, waiting: s.waiting };
    },
    status(id, now, { staleMs, lastTs = 0 }) {
      const s = sessions.get(id);
      if (s?.waiting) return 'waiting';
      if (s && s.failUntil > now) return 'fail';
      const last = Math.max(lastTs ?? 0, s ? (lastOf(s, () => true)?.ts ?? 0) : 0);
      return last > 0 && now - last <= staleMs ? 'active' : 'idle';
    },
    has: (id) => sessions.has(id),
    forget: (id) => sessions.delete(id),
  };
}

// web/observability/session-model.js
// What the session page says, decided without a DOM (session-detail spec
// sections 3 to 5, card glmps-2-0-runtime-60): the state, the sentence, the
// band order, the verdict slots, the file groups, the learning rows and the
// feed filter. session-bands.js draws these; nothing here touches a node.

export function tsMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : 0;
  if (typeof ts === 'string') { const d = Date.parse(ts); return Number.isFinite(d) ? d : 0; }
  return 0;
}

export function fmtSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

const GATE_TONE = { PASS: 'ok', CONCERNS: 'warn', FAIL: 'danger', WAIVED: 'neutral' };

// The tool keeps no local log for this session (newer Antigravity stores
// conversations in its cloud backend), or the events aged out.
export function hasNoLog(summary, data) {
  const total = data?.page?.total ?? (data?.events ?? []).length;
  if (total > 0) return false;
  if (summary?.tool === 'antigravity') return true;
  return summary?.state !== 'working';
}

// Five states (spec section 4). `working` is the server's live liveness word.
export function sessionState(summary, data) {
  if (hasNoLog(summary, data)) return { key: 'nolog', word: 'NO LOG', tone: 'neutral' };
  const st = summary?.state;
  if (st === 'working') return { key: 'live', word: 'LIVE', tone: 'info' };
  if (st === 'idle') return { key: 'idle', word: 'IDLE', tone: 'neutral' };
  const card = data?.card ?? null;
  if (data?.outcome?.outcomeClass === 'abandoned' || (card && !card.gate)) {
    return { key: 'abandoned', word: 'ABANDONED', tone: 'warn' };
  }
  const gate = card?.gate?.status ?? null;
  return { key: 'finished', word: 'FINISHED', tone: gate ? (GATE_TONE[gate] ?? 'neutral') : 'neutral' };
}

export const BAND_IDS = ['touching', 'learning', 'doing'];

export function bandOrder(key) {
  if (key === 'finished') return ['touching', 'learning', 'doing'];
  if (key === 'nolog') return [];
  return ['doing', 'touching', 'learning'];
}

export function sessionTitle(summary, data, sessionId) {
  const card = data?.card;
  if (card?.id) return { id: card.id, text: card.title || '' };
  const wtParent = typeof summary?.worktree?.parent === 'string' ? summary.worktree.parent : '';
  const cwdSeg = summary?.cwd ? summary.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() : '';
  return { id: null, text: summary?.title || wtParent || cwdSeg || String(sessionId ?? '').slice(0, 8) };
}

const MQ_TONE = { merged: 'ok', bounced: 'danger', held: 'warn', closed: 'neutral' };

function prSlot(card) {
  if (!card) return { word: 'no PR', tone: 'neutral', detail: 'not a card session' };
  const mq = card.mergeQueue;
  const url = card.prUrl ?? mq?.prUrl ?? null;
  const num = mq?.number ?? (url ? (String(url).match(/\/pull\/(\d+)/)?.[1] ?? null) : null);
  const name = num ? `PR #${num}` : 'PR';
  if (mq?.stage) {
    const tone = MQ_TONE[mq.stage] ?? 'info';
    return { word: mq.stage.toUpperCase(), tone, detail: `${name}${mq.round > 1 ? ` round ${mq.round}` : ''}`, url };
  }
  if (url) return { word: 'OPEN', tone: 'info', detail: `${name}, not in the merge queue`, url };
  return { word: 'no PR', tone: 'neutral', detail: null };
}

function approvalsSlot(card, approvals) {
  if (!card) return { word: 'none', tone: 'neutral', detail: 'not a card session' };
  if (approvals == null) return { word: 'unavailable', tone: 'neutral', detail: 'approvals could not be read' };
  const mine = (approvals.requests ?? []).filter((r) => r?.ticketId === card.id && r.status === 'pending');
  if (!mine.length) return { word: 'none pending', tone: 'neutral', detail: null };
  return { word: `${mine.length} WAITING`, tone: 'warn', detail: mine.map((r) => r.action).filter(Boolean).join(', ') || null };
}

// Every slot is always drawn; an absent verdict says why (spec 3.1). The
// done-gate slot is drawn by session-verdicts.js and is not repeated here.
export function verdictSlots(data, stateKey, approvals) {
  const card = data?.card ?? null;
  const ended = stateKey === 'finished' || stateKey === 'abandoned' || stateKey === 'nolog';
  let gate;
  if (!card) gate = { word: 'no gate', tone: 'neutral', detail: 'not a card session' };
  else if (!card.gate) gate = ended
    ? { word: 'MISSING', tone: 'warn', detail: `no gate recorded on ${card.id}` }
    : { word: 'pending', tone: 'neutral', detail: 'no gate recorded yet' };
  else {
    const acs = card.acceptanceCriteria ?? [];
    const parts = [card.gate.risk, acs.length ? `AC ${acs.filter((a) => a.done).length}/${acs.length} done` : null,
      `${card.gate.evidenceCount} evidence`].filter(Boolean);
    gate = { word: card.gate.status, tone: GATE_TONE[card.gate.status] ?? 'neutral', detail: parts.join('  ') };
  }

  const j = data?.outcome?.judge ?? null;
  let judge;
  if (!j || j.status === 'pending') judge = { word: 'pending', tone: 'neutral', detail: ended ? 'no judge record yet' : 'runs after idle' };
  else if (j.status === 'pass') judge = { word: 'PASS', tone: 'ok', detail: j.by ?? null, comment: j.comment || null };
  else if (j.status === 'concerns') judge = { word: 'CONCERNS', tone: 'warn', detail: j.by ?? null, comment: j.comment || null };
  else judge = { word: 'SKIPPED', tone: 'neutral', detail: j.reason || (typeof j.skipped === 'string' ? j.skipped : null) };

  return [
    { id: 'gate', label: 'GATE', ...gate },
    { id: 'judge', label: 'JUDGE', ...judge },
    { id: 'pr', label: 'PR', ...prSlot(card) },
    { id: 'approvals', label: 'APPROVALS', ...approvalsSlot(card, approvals) },
  ];
}

export function costStrip(summary, data, stateKey) {
  const usd = summary?.status?.cost?.totalUsd;
  const ctx = summary?.status?.context?.usedPercent;
  const span = data?.touch?.span ?? {};
  const wallMs = span.firstTs != null && span.lastTs != null ? tsMs(span.lastTs) - tsMs(span.firstTs) : NaN;
  const ended = stateKey === 'finished' || stateKey === 'abandoned';
  return [
    { id: 'spend', label: 'SPEND', value: Number.isFinite(usd) ? `$${Number(usd).toFixed(2)}` : 'not recorded' },
    { id: 'ctx', label: ended ? 'CTX LAST' : 'CTX', value: Number.isFinite(ctx) ? `${Math.round(ctx)}%` : 'not recorded' },
    { id: 'wall', label: 'WALL', value: fmtSpan(wallMs) ?? 'not recorded' },
    // No TOKENS card: no session summary carries a token total, and a card
    // that can only ever say "not recorded" is noise (card glmps-2-0-137).
  ].map((c) => ({ ...c, missing: c.value === 'not recorded' }));
}

function plusMinus(files) {
  let add = 0; let del = 0;
  for (const f of files ?? []) { add += f.add ?? 0; del += f.del ?? 0; }
  return { add, del };
}

// One generated sentence, never assembled by the reader (spec 3.1).
export function stateSentence(state, summary, data, now = Date.now()) {
  const touch = data?.touch;
  const lastMs = tsMs(touch?.span?.lastTs ?? summary?.lastTs);
  const ago = lastMs ? fmtSpan(now - lastMs) : null;
  const { add, del } = plusMinus(touch?.files?.filter((f) => f.writes));
  const written = touch?.counts?.written ?? 0;
  const filesPart = written ? `${written} file${written === 1 ? '' : 's'} written, +${add} -${del}.` : 'No files written.';
  const usd = summary?.status?.cost?.totalUsd;
  const costPart = Number.isFinite(usd) ? ` $${Number(usd).toFixed(2)}.` : '';
  const slots = verdictSlots(data, state.key, null);
  const gate = slots[0]; const judge = slots[1]; const pr = slots[2];
  switch (state.key) {
    case 'live': {
      const loop = data?.loop;
      const stage = loop?.key ? ` in ${loop.key.toUpperCase()}${Number.isFinite(loop.enteredTs) ? ` for ${fmtSpan(now - loop.enteredTs)}` : ''}` : '';
      return `Live${stage}. ${filesPart}${costPart}`;
    }
    case 'idle':
      // The server calls a running session idle when it has stopped writing,
      // so name the last event's age rather than an idle duration it does not know.
      return `Idle, not ended${ago ? `; last event ${ago} ago` : ''}. ${filesPart}${costPart}`;
    case 'abandoned':
      // A run the judge classed abandoned can belong to a card a later run gated.
      if (data?.card && !data.card.gate) return `Ended${ago ? ` ${ago} ago` : ''} with no gate on ${data.card.id}. ${filesPart}${costPart}`;
      return `Ended${ago ? ` ${ago} ago` : ''}; the judge classed this run abandoned${data?.card?.gate ? ` (${data.card.id} was gated ${data.card.gate.status} by another run)` : ''}. ${filesPart}${costPart}`;
    case 'nolog':
      return summary?.tool === 'antigravity'
        ? 'No local event log: newer Antigravity stores conversations in its cloud backend. Title and workspace only.'
        : 'No events recorded for this session: the log is missing or aged out.';
    default: {
      const verdicts = data?.card
        ? `Gate ${gate.word}, judge ${judge.word.toLowerCase()}${pr.url ? `, ${pr.detail?.split(',')[0] ?? 'PR'} ${pr.word.toLowerCase()}` : ''}. `
        : `Judge ${judge.word.toLowerCase()}. `;
      return `Finished${ago ? ` ${ago} ago` : ''}. ${verdicts}${filesPart}${costPart}`;
    }
  }
}

// The primary action fits the state (spec section 4).
export function primaryAction(state, data) {
  const card = data?.card ?? null;
  if (state.key === 'live') return { id: 'steer', label: 'Steer' };
  if (state.key === 'idle') return { id: 'resume', label: 'Resume' };
  if (state.key === 'abandoned') return card ? (card.gate ? { id: 'card', label: 'Open card' } : { id: 'requeue', label: 'Requeue card' }) : null;
  if (state.key === 'finished') {
    if (card?.gate?.status === 'FAIL') return { id: 'requeue', label: 'Requeue card' };
    const url = card?.prUrl ?? card?.mergeQueue?.prUrl;
    return url ? { id: 'pr', label: 'Open PR', url } : null;
  }
  return card ? { id: 'card', label: 'Open card' } : null;
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/');

// Files grouped by directory relative to the session's root, writes first
// (spec 3.2). A path outside the root keeps its full directory.
export function groupFiles(files, root) {
  const base = root ? norm(root).replace(/\/+$/, '') + '/' : '';
  const groups = new Map();
  for (const f of files ?? []) {
    const p = norm(f.path);
    const rel = base && p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : p;
    const cut = rel.lastIndexOf('/');
    const dir = cut >= 0 ? rel.slice(0, cut + 1) : './';
    const name = cut >= 0 ? rel.slice(cut + 1) : rel;
    if (!groups.has(dir)) groups.set(dir, { dir, files: [], add: 0, del: 0, writes: 0 });
    const g = groups.get(dir);
    g.files.push({ ...f, name });
    g.add += f.add ?? 0; g.del += f.del ?? 0;
    if (f.writes) g.writes++;
  }
  return [...groups.values()].sort((a, b) => (b.writes > 0) - (a.writes > 0) || b.writes - a.writes || a.dir.localeCompare(b.dir));
}

const INSTRUCTION_FILE = /(^|\/)(CLAUDE|AGENTS|GEMINI)(\.global)?\.md$/i;

// Memory and instruction-file writes, read off the touch rollup.
export function memoryWrites(touch) {
  return (touch?.files ?? []).filter((f) => f.writes && (f.kind === 'memory' || INSTRUCTION_FILE.test(norm(f.path))))
    .map((f) => ({ path: f.path, name: norm(f.path).split('/').pop(), kind: f.kind === 'memory' ? 'memory' : 'instructions', writes: f.writes }));
}

// The Learning band's ledger (spec 3.3): gaps keep their own actions; guards,
// other learning items, memory writes, lessons and measurables are rows.
export function learningLedger(data) {
  const gaps = data?.gaps ?? [];
  const gapIds = new Set(gaps.map((g) => g.id).filter(Boolean));
  const items = data?.learning?.items ?? [];
  const guards = items.filter((i) => i.rule).map((i) => ({ id: i.id, status: i.status, rule: i.rule, title: i.title }));
  const others = items.filter((i) => !i.rule && !gapIds.has(i.id) && i.source !== 'gap')
    .map((i) => ({ id: i.id, source: i.source, status: i.status, title: i.title }));
  const memory = memoryWrites(data?.touch);
  const lessons = (data?.learning?.lessons ?? []).map((l) => ({ id: l.lessonId, status: l.status, title: l.title, reflex: l.reflex }));
  const fit = data?.fitness;
  const measurables = fit?.tracked ? Object.entries(fit.byKind ?? {}).map(([kind, n]) => ({ kind, n })) : [];
  const byStatus = {};
  for (const g of gaps) byStatus[g.status ?? 'pending'] = (byStatus[g.status ?? 'pending'] ?? 0) + 1;
  const summary = {
    gaps: gaps.length, gapsByStatus: byStatus,
    guards: guards.length, memory: memory.length, lessons: lessons.length,
    measurables: fit?.tracked ?? 0, others: others.length,
  };
  const empty = !gaps.length && !guards.length && !others.length && !memory.length && !lessons.length && !summary.measurables;
  return { gaps, guards, others, memory, lessons, measurables, summary, empty };
}

export function learningSummaryText(s) {
  const st = Object.entries(s.gapsByStatus).map(([k, n]) => `${n} ${k}`).join(', ');
  return [
    `${s.gaps} gap${s.gaps === 1 ? '' : 's'}${st ? ` (${st})` : ''}`,
    `${s.guards} guard${s.guards === 1 ? '' : 's'}`,
    `${s.memory} memory write${s.memory === 1 ? '' : 's'}`,
    `${s.lessons} lesson${s.lessons === 1 ? '' : 's'}`,
    `${s.measurables} measurable${s.measurables === 1 ? '' : 's'}`,
  ].join('  ');
}

export function touchingSummaryText(data) {
  const c = data?.touch?.counts ?? { written: 0, read: 0, commits: 0 };
  const zones = data?.scope?.zones?.length ?? 0;
  const refusals = data?.refusals?.count ?? 0;
  const div = data?.workspace?.divergence?.level ?? null;
  return [
    `${c.written} written`, `${c.read} read`, `${c.commits} commit${c.commits === 1 ? '' : 's'}`,
    `${zones} zone${zones === 1 ? '' : 's'}`, `${refusals} refusal${refusals === 1 ? '' : 's'}`,
    `divergence ${div ?? 'not assessed'}`,
  ].join('  ');
}

// Kind chips are the workflow-state filter (persisted); search is transient.
export const KIND_CHIPS = ['context', 'all', 'tool', 'skill', 'agent', 'git', 'gate'];
const NOT_TOOL = new Set(['skill', 'agent', 'git', 'done-gate']);

export function matchesKind(ev, chip) {
  if (!ev) return false;
  switch (chip) {
    case 'all': return ev.kind !== 'done-gate';
    case 'context': return ev.lane === 'context' && ev.kind !== 'done-gate';
    case 'gate': return ev.kind === 'done-gate';
    case 'tool': return !NOT_TOOL.has(ev.kind);
    default: return ev.kind === chip;
  }
}

export function filterEvents(events, chip, query) {
  const q = String(query ?? '').trim().toLowerCase();
  return (events ?? []).filter((ev) => matchesKind(ev, chip)
    && (!q || [ev.label, ev.path, ev.tool, ev.kind].some((v) => v && String(v).toLowerCase().includes(q))));
}

export function backLabel(lensLabel) {
  return lensLabel ? `< ${lensLabel}` : '< Back';
}

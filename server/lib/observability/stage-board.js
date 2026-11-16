// server/lib/observability/stage-board.js
// Pure, zero-dependency ESM. Assembles the "stage board" data model for the
// Overview stage-board view: 6 stage columns (Orchestrate, Execute, Adversarial,
// Gate, Commit, Learning) and one trajectory row per session.
//
// The 5-stage loop machine (loop-stage.js) has no Commit stage - we insert it as
// board stage 5 and derive its per-session state from git (dirty = not yet
// committed). loop stage 5 (learning) therefore maps to board stage 6.
//
// Kept pure/injected: the caller (server.js) resolves per-session phase
// (work-phase.js), git status (git-status.js), and follow-up counts (backlog),
// and passes them in as Maps keyed by session id, so this module has no I/O.
// The one import is a constant (the kernel-health id list, Phase K final I4).
import { KERNEL_HEALTH_IDS } from '../adapters/health.js';

const BOARD_STAGES = [
  { key: 'orchestrate', name: 'Orchestrate' },
  { key: 'execute',     name: 'Execute' },
  { key: 'adversarial', name: 'Adversarial' },
  { key: 'gate',        name: 'Gate' },
  { key: 'commit',      name: 'Commit' },
  { key: 'learning',    name: 'Learning' },
];

// loop-stage.js stage (1-5) -> board column position (1-6). Commit (5) is not a
// loop stage, so learning (loop 5) lands on board 6.
const LOOP_TO_BOARD = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6 };

const STAGE_DETAIL = {
  orchestrate: 'planning & scan',
  execute: 'writing code',
  adversarial: 'critic + skeptic',
  gate: 'validating',
  learning: 'adopt \u00B7 measure \u00B7 keep',
};

function lastSeg(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

const asMap = (m) => (m instanceof Map ? m : new Map());

/**
 * @param {object[]} sessions  sessionSummaries() rows (need id, cwd, tool, live, loop{stage,enteredTs}).
 * @param {object}   opts
 * @param {number}   opts.now                 epoch ms, for elapsed-in-stage (null -> elapsedMs null).
 * @param {Map}      opts.phaseBySession       id -> { phase, label, doing }
 * @param {Map}      opts.gitBySession         id -> { dirty, ahead, behind, branch } | null
 * @param {Map}      opts.followupsBySession   id -> count
 * @param {number}   [opts.stalledMs]          stall threshold, default 10 minutes.
 * @returns {{ stages: {key,name,count,detail}[], rows: object[] }}
 */
export function buildBoard(sessions = [], opts = {}) {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : null;
  const phaseBy = asMap(opts.phaseBySession);
  const gitBy = asMap(opts.gitBySession);
  const followBy = asMap(opts.followupsBySession);
  const stalledMs = typeof opts.stalledMs === 'number' ? opts.stalledMs : STALLED_MS_DEFAULT;

  const rows = (Array.isArray(sessions) ? sessions : []).map((s) => {
    const loop = s && s.loop && typeof s.loop === 'object' ? s.loop : null;
    const pos = loop && LOOP_TO_BOARD[loop.stage] ? LOOP_TO_BOARD[loop.stage] : 1;
    const bs = BOARD_STAGES[pos - 1];
    const git = gitBy.get(s.id) ?? null;
    const enteredTs = loop && typeof loop.enteredTs === 'number' ? loop.enteredTs : null;
    return {
      id: s.id,
      project: lastSeg(s.cwd),
      tool: s.tool ?? null,
      stage: pos,
      stageKey: bs.key,
      stageName: bs.name,
      phase: phaseBy.get(s.id) ?? null,
      enteredTs,
      elapsedMs: (enteredTs != null && now != null) ? Math.max(0, now - enteredTs) : null,
      git,
      // committed = working tree clean (nothing to commit). null when git unknown.
      committed: git ? git.dirty === 0 : null,
      followups: followBy.get(s.id) ?? 0,
      live: !!(s && s.live),
      // glmps-151: the Stalled vitals tile was the only flow tile that could not
      // filter, because the stall signal existed ONLY inside buildVitals (derived
      // from raw session summaries, which never reach the client). Carrying it on
      // the row makes it click-to-filter like the others.
      //
      // isStalled() is shared with buildStalledVital rather than restated, so the
      // tile's count and the rows it filters to can never disagree. Note an
      // unknown lastTs is deliberately NOT stalled: absence of a heartbeat does
      // not prove a stall, same discipline as the null-vs-zero rule above.
      lastTs: typeof s?.lastTs === 'number' ? s.lastTs : null,
      stalled: !!(s && s.live) && isStalled(s, now, stalledMs),
    };
  });

  const uncommitted = rows.filter((r) => r.git && r.git.dirty > 0).length;
  const unpushed = rows.reduce((a, r) => a + (r.git?.ahead ?? 0), 0);

  const stages = BOARD_STAGES.map((bs, idx) => {
    const boardPos = idx + 1;
    if (bs.key === 'commit') {
      return { key: bs.key, name: bs.name, count: uncommitted, detail: `${uncommitted} uncommitted \u00B7 ${unpushed} unpushed` };
    }
    return { key: bs.key, name: bs.name, count: rows.filter((r) => r.stage === boardPos).length, detail: STAGE_DETAIL[bs.key] };
  });

  return { stages, rows };
}

// Convenience: count follow-up backlog items per session id from a backlog item
// list (items carry a `sessionId` once capability-feed stamps them). Returns a Map.
export function followupsBySession(items = []) {
  const m = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const sid = it && typeof it.sessionId === 'string' ? it.sessionId : null;
    if (!sid) continue;
    m.set(sid, (m.get(sid) ?? 0) + 1);
  }
  return m;
}

// Ported verbatim from web/overview/stage-board.js's updateVitals(),
// updateDerivedVitals() and toolMixLabel(), so the client renders `board.vitals`
// instead of re-deriving it (docs/superpowers/specs/2026-07-22-vitals-trends-design.md,
// Step 1). Budget, Open alerts and Queue stay client-polled, out of scope here.
//
// Null discipline is load-bearing throughout: a field whose input is missing
// or unknown is `null`, never `0`. Number(null) is `0` (not NaN), so a bare
// Number.isFinite() guard would silently accept a missing value as a real
// zero, so every accumulator below checks `== null` before treating a value
// as present, rather than coercing first.

const STALLED_MS_DEFAULT = 10 * 60_000;

// Active sessions' tool mix, e.g. [{tool:'claude-code',count:3},{tool:'agy-cli',count:1}].
// Rows without a `tool` bucket under 'unknown' once at least one row DOES carry
// a real tool; when NO row carries one at all, returns [] so the caller can
// fall back to a plain "N live" reading instead of an all-"unknown" list.
function byToolCounts(rows) {
  const counts = new Map();
  let anyTool = false;
  for (const r of rows) {
    if (r.tool) anyTool = true;
    const key = r.tool || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!anyTool) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => ({ tool, count }));
}

function buildActiveVital(rows) {
  return { count: rows.length, byTool: byToolCounts(rows) };
}

function buildUncommittedVital(rows) {
  const dirtyRows = rows.filter((r) => r.committed === false);
  const dirtyFiles = dirtyRows.reduce((a, r) => a + (r.git?.dirty ?? 0), 0);
  // Worst offender: the row with the highest dirty-file count. First row wins
  // on a tie (strict `>`, matching the original reduce()'s left-to-right scan).
  let worst = null;
  for (const r of dirtyRows) {
    const dirty = r.git?.dirty ?? 0;
    if (worst == null || dirty > worst.dirty) worst = { project: r.project, dirty };
  }
  return { count: dirtyRows.length, dirtyFiles, worst };
}

function buildFollowupsVital(rows) {
  return { count: rows.reduce((a, r) => a + (r.followups ?? 0), 0) };
}

function buildGateVital(rows) {
  const gateRows = rows.filter((r) => r.stage === 3 || r.stage === 4);
  let longestMs = null;
  for (const r of gateRows) {
    if (r.elapsedMs == null) continue; // unknown, never treated as 0
    if (longestMs == null || r.elapsedMs > longestMs) longestMs = r.elapsedMs;
  }
  return { count: gateRows.length, longestMs };
}

// The single stall rule, shared by buildBoard's per-row `stalled` flag and
// buildStalledVital's count (glmps-151). An absent lastTs reads as "now", i.e.
// not stalled: a missing heartbeat is unknown, not evidence of a stall.
function stallGapMs(session, now) {
  if (now == null) return null;
  const lastTs = typeof session?.lastTs === 'number' ? session.lastTs : now;
  return now - lastTs;
}

function isStalled(session, now, stalledMs) {
  const gap = stallGapMs(session, now);
  return gap != null && gap > stalledMs;
}

function buildStalledVital(sessions, now, stalledMs) {
  // now is required to compute a gap; with no valid `now`, report "unknown"
  // rather than reaching for Date.now() (buildVitals must stay pure, no I/O).
  if (now == null) return { count: 0, oldestMs: null };
  let count = 0;
  let oldestMs = null;
  for (const s of sessions) {
    if (!s?.live) continue;
    if (!isStalled(s, now, stalledMs)) continue;
    count++;
    const gap = stallGapMs(s, now);
    if (oldestMs == null || gap > oldestMs) oldestMs = gap;
  }
  return { count, oldestMs };
}

function buildCaptureVital(adapterHealth) {
  const health = adapterHealth && typeof adapterHealth === 'object' ? adapterHealth : {};
  // Phase K final review I4: kernel-health ids share the adapterHealth
  // registry but are not capture tools; they alert as "Kernel health" instead.
  const degraded = Object.entries(health).filter(([id, v]) => v?.degraded === true && !KERNEL_HEALTH_IDS.has(id));
  let worst = null;
  if (degraded.length) {
    const [id, info] = degraded[0];
    worst = { adapter: id, reason: info?.lastReason ?? null };
  }
  // The full list rides along so the Pulse Capture row can show which adapters
  // it counts without the client restating the kernel-health exclusions.
  const adapters = degraded.map(([id, info]) => ({ adapter: id, reason: info?.lastReason ?? null }));
  return { degraded: degraded.length, worst, adapters };
}

/**
 * Derives every state-backed vital tile shown on the Stage Board's vitals row.
 * Pure: no I/O, no Date.now(), never mutates its inputs.
 *
 * @param {object[]} rows          board.rows from buildBoard(), NOT raw sessions.
 * @param {object[]} sessions      raw sessionSummaries() rows (stalled needs the
 *                                 full list incl. non-live, to check `live` itself).
 * @param {object}   adapterHealth adapterHealth() snapshot, keyed by adapter id.
 * @param {number}   now           epoch ms.
 * @param {number}   [stalledMs]   stall threshold in ms, default 10 minutes.
 * @returns {{
 *   active:      { count:number, byTool:{tool:string,count:number}[] },
 *   uncommitted: { count:number, dirtyFiles:number, worst:{project:string,dirty:number}|null },
 *   followups:   { count:number },
 *   gate:        { count:number, longestMs:number|null },
 *   stalled:     { count:number, oldestMs:number|null },
 *   capture:     { degraded:number, worst:{adapter:string,reason:string|null}|null, adapters:{adapter:string,reason:string|null}[] },
 * }}
 */
export function buildVitals({ rows, sessions, adapterHealth, now, stalledMs = STALLED_MS_DEFAULT } = {}) {
  const rs = Array.isArray(rows) ? rows : [];
  const ss = Array.isArray(sessions) ? sessions : [];
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : null;
  return {
    active: buildActiveVital(rs),
    uncommitted: buildUncommittedVital(rs),
    followups: buildFollowupsVital(rs),
    gate: buildGateVital(rs),
    stalled: buildStalledVital(ss, nowMs, stalledMs),
    capture: buildCaptureVital(adapterHealth),
  };
}

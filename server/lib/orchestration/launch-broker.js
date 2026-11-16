// Launches the kernel cannot open itself. As a Windows service it runs in
// session 0 and has no desktop, so terminals are queued here and the desktop
// shell (which runs in the operator's session) claims and opens them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGY_MODELS, AGY_PROMPT_MAX } from '../huddle/agy-models.js';
import { validClientId } from '../kernel/tap-mirror.js';

// 'agy' is not a terminal: it is one model call the desktop shell runs in the
// operator's session (the service cannot hold the operator's sign-in), carrying
// model and prompt, and answering with text.
//
// 'gitops' is one git, gh or test run for the merge queue: the service has no
// GitHub sign-in, so the shell runs it (strict allowlist on its side) and
// answers with { status, stdout, stderr }. It carries `op` and gets `result`.
//
// 'editor' opens one file in an editor app. Untargeted, it carries only `path`
// and the desktop shell spawns it (the service has no desktop), building the
// argv from the editor settings the kernel advertises on its poll. With a
// `targetClient` it carries `action` { kind: 'open', path } instead and only
// that client's tap claims it (card glmps-2-0-runtime-45). 'file' exists only
// for a paired client's tap: it reads, saves or undoes a file under that
// machine's project roots and gets `result` { status, body }. Any record may
// carry `targetClient`; the desktop shell never sees or claims one.
export const LAUNCH_ORIGINS = Object.freeze(['runner', 'resume', 'terminal', 'learning', 'agy', 'gitops', 'editor', 'file']);
const FILE_OPS = new Set(['read', 'save', 'undo']);
const validTarget = (v) => validClientId(v) && /^cli_./.test(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function actionIssue(origin, a) {
  if (!isObj(a) || typeof a.path !== 'string' || !a.path) return 'action must be an object with a path';
  if (origin === 'editor' && a.kind !== 'open') return 'editor action.kind must be open';
  if (origin === 'file' && !FILE_OPS.has(a.op)) return `file action.op must be one of ${[...FILE_OPS].join(', ')}`;
  return null;
}
const GITOPS_KINDS = new Set(['git', 'gh', 'test', 'review', 'card', 'vendor-card', 'release']);
const STATES = new Set(['pending', 'claimed', 'done', 'failed']);
const ID_RE = /^ln_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_DONE = 200;

// queue.json is read back exactly as readily as it is
// written - a hand edit, a bug, or corruption reaches here the same way a
// real record does. Six fields are load-bearing enough to refuse the whole
// row over: an id that is not shaped like this module's own ids, an origin
// outside LAUNCH_ORIGINS, a command that is not one non-empty line, a cwd
// that is not a non-empty string, a ts that does not parse to a finite
// number (a broken ts would make oldestPendingAgeMs() NaN - NaN > 120_000
// is false, silently disabling the launch-queue loop's own staleness
// check), or a state outside the four this module ever writes.
function schemaIssue(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'id is not shaped like ln_<uuid>';
  if (!LAUNCH_ORIGINS.includes(r.origin)) return `origin not one of ${LAUNCH_ORIGINS.join(', ')}`;
  if (typeof r.command !== 'string' || !r.command || /[\r\n]/.test(r.command)) return 'command is not one non-empty line';
  if (typeof r.cwd !== 'string' || !r.cwd) return 'cwd is not a non-empty string';
  if (!Number.isFinite(r.ts)) return 'ts is not a finite number';
  if (!STATES.has(r.state)) return `state not one of ${[...STATES].join(', ')}`;
  return null;
}
// The remaining fields are sanitized rather than used to reject the whole
// row: each is set by this module itself (never by a request body) and a
// wrong type here is a cosmetic corruption, not a structural one.
function sanitizeRow(r) {
  return {
    ...(r.origin === 'agy' ? {
      model: typeof r.model === 'string' ? r.model : null,
      prompt: typeof r.prompt === 'string' ? r.prompt : '',
      text: typeof r.text === 'string' ? r.text : null,
    } : {}),
    ...(r.origin === 'editor' ? { path: typeof r.path === 'string' ? r.path : '' } : {}),
    ...(r.origin === 'gitops' ? {
      op: r.op && typeof r.op === 'object' && !Array.isArray(r.op) ? r.op : null,
      result: r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : null,
      ...(r.cancelRequested === true ? { cancelRequested: true } : {}),
    } : {}),
    ...(r.origin === 'editor' || r.origin === 'file' ? { action: isObj(r.action) ? r.action : null } : {}),
    ...(r.origin === 'file' ? { result: isObj(r.result) ? r.result : null } : {}),
    targetClient: validTarget(r.targetClient) ? r.targetClient : null,
    id: r.id, command: r.command, cwd: r.cwd, origin: r.origin, state: r.state, ts: r.ts,
    claimedBy: typeof r.claimedBy === 'string' ? r.claimedBy : null,
    claimedTs: Number.isFinite(r.claimedTs) ? r.claimedTs : null,
    pid: Number.isInteger(r.pid) ? r.pid : null,
    error: typeof r.error === 'string' ? r.error : null,
    doneTs: Number.isFinite(r.doneTs) ? r.doneTs : null,
  };
}

// Fix round 2, m-a: an unreadable/corrupt queue.json is renamed aside
// instead of being silently discarded - so a hand-edit mistake or real
// corruption is still there to inspect, and the next write (a fresh
// queue.json) can never collide with the file that failed to load.
// Returns null on success, or the rename's own error (fix round 3, M-6: a
// failed rename used to be swallowed here with no way for the caller to
// tell, which let the very next persist() write straight over the
// CORRUPT file at the original path - the evidence this function exists
// to preserve; fix round 4, F6: the error itself is returned so the miss
// can name its code).
function quarantine(file, now) {
  try { fs.renameSync(file, `${file}.corrupt-${now()}`); return null; } catch (e) { return e; }
}

// Fix round 2, R2-3 groundwork: `now = Date.now` as a bare default would
// capture that FUNCTION REFERENCE once, at construction time - immune to
// a test mocking the Date.now PROPERTY afterward (t.mock.method(Date,
// 'now', ...), used to fast-forward the launch-queue loop's own
// claimed-timeout sweep without a real wait). Wrapped in a closure instead,
// so every call looks up the CURRENT Date.now property fresh.
export function createLaunchBroker({ file, now = () => Date.now(), reportMiss = () => {} }) {
  let rows = [];
  // if quarantine() fails to rename the corrupt
  // original aside, that original must never be touched (overwritten) by
  // anything this broker does afterward.
  // round 3 then persisted to a fresh .recovered-* file,
  // which no later boot ever read (each boot re-reads the same corrupt
  // queue.json and fails the same way), so it only accumulated orphan
  // files while implying a durability it did not have. The broker now
  // runs memory-only instead (persist() writes nothing), and the miss -
  // re-reported on every boot that hits it - names the rename's own error
  // code and says the queue will not survive a restart.
  let memoryOnly = false;
  const quarantineOrGoMemoryOnly = () => {
    const err = quarantine(file, now);
    if (!err) return;
    memoryOnly = true;
    reportMiss('launch-broker-quarantine', `could not rename the corrupt queue aside (${err.code || err.message}: ${file}); running with an empty, memory-only queue that will not survive a restart, so the corrupt original is preserved, not overwritten - move or fix that file to restore persistence`);
  };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) {
      for (const r of raw) {
        const issue = schemaIssue(r);
        if (issue) { reportMiss('launch-broker-load', `dropped a malformed queue row (${r?.id ?? 'no id'}): ${issue}`); continue; }
        rows.push(sanitizeRow(r));
      }
    } else {
      reportMiss('launch-broker-load', 'queue.json root is not an array; starting a fresh queue');
      quarantineOrGoMemoryOnly();
    }
  } catch (e) {
    rows = [];
    // ENOENT (no queue.json yet - every first boot) is normal, never a
    // miss. Anything else (corrupt JSON, a permissions error) is a real,
    // unexplained problem and must surface by name.
    if (e.code !== 'ENOENT') {
      reportMiss('launch-broker-load', `queue.json unreadable or corrupt (${e.code ?? e.message}); starting a fresh queue`);
      quarantineOrGoMemoryOnly();
    }
  }

  // Fix round 1, I3/m5: enqueue/claim/complete must never leave `rows`
  // (the committed in-memory state every other method reads) mutated when
  // the write itself fails - a caller that got the exception believes
  // nothing happened, so nothing may have happened. persist() always
  // operates on, and returns, a NEW array; the caller only assigns it to
  // `rows` AFTER persist() returns successfully, so a thrown write leaves
  // `rows` exactly as it was (save-before-commit).
  function persist(nextRows) {
    const done = nextRows.filter((r) => r.state === 'done' || r.state === 'failed');
    const pruned = done.length > KEEP_DONE
      ? (() => { const drop = new Set(done.slice(0, done.length - KEEP_DONE).map((r) => r.id)); return nextRows.filter((r) => !drop.has(r.id)); })()
      : nextRows;
    if (memoryOnly) return pruned;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pruned));
    fs.renameSync(tmp, file);
    return pruned;
  }
  const find = (id) => rows.find((r) => r.id === id) || null;
  return {
    enqueue({ command, cwd, origin, model, prompt, op, path: filePath, targetClient = null, action }) {
      if (!LAUNCH_ORIGINS.includes(origin)) throw new TypeError(`launch origin must be one of ${LAUNCH_ORIGINS.join(', ')}: ${origin}`);
      if (typeof command !== 'string' || !command || /[\r\n]/.test(command)) throw new TypeError('launch command must be one non-empty line');
      if (origin === 'agy') {
        if (!AGY_MODELS.includes(model)) throw new TypeError(`agy model must be one of the allowlist: ${model}`);
        if (typeof prompt !== 'string' || !prompt || prompt.length >= AGY_PROMPT_MAX) throw new TypeError(`agy prompt must be a string under ${AGY_PROMPT_MAX} chars`);
      }
      if (origin === 'gitops' && !(op && typeof op === 'object' && !Array.isArray(op) && GITOPS_KINDS.has(op.kind))) {
        throw new TypeError(`gitops op.kind must be one of ${[...GITOPS_KINDS].join(', ')}`);
      }
      if (targetClient !== null && !validTarget(targetClient)) throw new TypeError(`targetClient must be a cli_ client id: ${targetClient}`);
      if (origin === 'file' && targetClient === null) throw new TypeError('file launches need a targetClient');
      const clientAction = targetClient !== null && (origin === 'editor' || origin === 'file');
      if (clientAction) {
        const bad = actionIssue(origin, action);
        if (bad) throw new TypeError(bad);
      } else if (origin === 'editor' && (typeof filePath !== 'string' || !filePath || /[\r\n]/.test(filePath))) {
        throw new TypeError('editor path must be one non-empty line');
      }
      const r = { ...(origin === 'editor' && !clientAction ? { path: filePath } : {}), ...(clientAction ? { action: { ...action } } : {}), ...(origin === 'file' ? { result: null } : {}), targetClient, ...(origin === 'agy' ? { model, prompt, text: null } : {}), ...(origin === 'gitops' ? { op, result: null } : {}), id: `ln_${crypto.randomUUID()}`, command, cwd: String(cwd), origin, state: 'pending', ts: now(), claimedBy: null, claimedTs: null, pid: null, error: null, doneTs: null };
      rows = persist([...rows, r]);
      return { id: r.id };
    },
    // No `client` is the desktop shell's view: records aimed at a client are not its to open.
    pending: ({ client = null } = {}) => rows.filter((r) => r.state === 'pending' && (r.targetClient ?? null) === client).map((r) => ({ ...r })),
    claim(id, by, { client = null } = {}) {
      const r = find(id);
      if (!r || r.state !== 'pending' || (r.targetClient ?? null) !== client) return null;
      const updated = { ...r, state: 'claimed', claimedBy: String(by), claimedTs: now() };
      rows = persist(rows.map((x) => (x.id === id ? updated : x)));
      return { ...updated };
    },
    complete(id, { pid = null, error = null, text = null, result = null } = {}) {
      const r = find(id);
      if (!r || r.state !== 'claimed') return null;
      const updated = { ...r, state: error ? 'failed' : 'done', pid, error, doneTs: now(), ...(r.origin === 'agy' ? { text: error ? null : text } : {}), ...(r.origin === 'gitops' || r.origin === 'file' ? { result: error ? null : result } : {}) };
      rows = persist(rows.map((x) => (x.id === id ? updated : x)));
      return { ...updated };
    },
    get: (id) => { const r = find(id); return r ? { ...r } : null; },
    // Ask for a gitops run to stop. A record nobody has claimed fails at once;
    // a claimed one is flagged and the shell, which polls, kills its process.
    requestCancel(id) {
      const r = find(id);
      if (!r || r.origin !== 'gitops' || (r.state !== 'pending' && r.state !== 'claimed')) return null;
      if (r.state === 'pending') return this.fail(id, 'cancelled before the desktop app claimed it');
      const updated = { ...r, cancelRequested: true };
      rows = persist(rows.map((x) => (x.id === id ? updated : x)));
      return { ...updated };
    },
    cancelRequested: () => rows.filter((r) => r.state === 'claimed' && r.cancelRequested === true).map((r) => r.id),
    gitopsRecords: () => rows.filter((r) => r.origin === 'gitops').map((r) => ({ ...r })),
    // A finished gitops record keeps no output: a diff can be 200 KB and the
    // whole queue is rewritten on every change.
    scrub(id) {
      const r = find(id);
      if (!r || (r.origin !== 'gitops' && r.origin !== 'file') || (r.state !== 'done' && r.state !== 'failed')) return null;
      const { content, ...action } = r.action ?? {};
      const updated = r.origin === 'file' ? { ...r, action: r.action ? action : null, result: null } : { ...r, op: null, result: null };
      rows = persist(rows.map((x) => (x.id === id ? updated : x)));
      return { ...updated };
    },
    oldestPendingAgeMs() { const p = rows.filter((r) => r.state === 'pending' && !r.targetClient); return p.length ? now() - Math.min(...p.map((r) => r.ts)) : 0; },
    // a record claimed but never completed (the shell quit
    // mid-tick, or an earlier record's result POST in the same batch threw)
    // is invisible to oldestPendingAgeMs() alone, which only ever sees
    // 'pending' rows - the launch-queue loop's maker checks this too.
    oldestClaimedAgeMs() { const c = rows.filter((r) => r.state === 'claimed'); return c.length ? now() - Math.min(...c.map((r) => r.claimedTs ?? r.ts)) : 0; },
    // a pending record never expires on its own - a
    // stale-refused claim (the job it belonged to was relaunched under a
    // new launchId) must not be left pending forever, retried every poll
    // and eventually mis-reported by the loop as "the desktop shell is not
    // running". fail() moves ANY non-terminal record straight to failed;
    // a terminal (done/failed) record is left alone (a no-op, not a second
    // transition).
    fail(id, error) {
      const r = find(id);
      if (!r || r.state === 'done' || r.state === 'failed') return null;
      const updated = { ...r, state: 'failed', error, doneTs: now() };
      rows = persist(rows.map((x) => (x.id === id ? updated : x)));
      return { ...updated };
    },
    // a claimed record with no result (the shell quit
    // mid-tick, or its result POST was lost) must not keep the
    // launch-queue loop red forever by itself - actively resolved here,
    // once per record, rather than merely alerted on. Returns the records
    // just moved, so the caller can emit one launch.failed event each.
    // `exempt(record)` keeps a claim out of the sweep: a gitops test run
    // legitimately outlasts the threshold, and its caller times it out itself.
    failStaleClaims(thresholdMs, error, exempt = () => false) {
      const t = now();
      const staleIds = new Set(rows.filter((r) => r.state === 'claimed' && !exempt(r) && (t - (r.claimedTs ?? r.ts)) > thresholdMs).map((r) => r.id));
      if (staleIds.size === 0) return [];
      rows = persist(rows.map((r) => (staleIds.has(r.id) ? { ...r, state: 'failed', error, doneTs: t } : r)));
      return rows.filter((r) => staleIds.has(r.id)).map((r) => ({ ...r }));
    },
    // Fix round 2, m-e: a pending record (never even claimed) never
    // expired on its own either. resume/terminal/learning are bounded by
    // a fixed idle-too-long time; a runner record by the job's own
    // remaining runtime budget - which only the caller (server.js, with
    // the runner ledger/config) knows, so this takes a per-record
    // predicate instead of a single fixed threshold. `isExpired(record,
    // nowMs)` decides; only PENDING records (never claimed) are ever this
    // sweep's concern.
    expirePending(isExpired, error) {
      const t = now();
      const expiredIds = new Set(rows.filter((r) => r.state === 'pending' && isExpired(r, t)).map((r) => r.id));
      if (expiredIds.size === 0) return [];
      rows = persist(rows.map((r) => (expiredIds.has(r.id) ? { ...r, state: 'failed', error, doneTs: t } : r)));
      return rows.filter((r) => expiredIds.has(r.id)).map((r) => ({ ...r }));
    },
  };
}

// the launch-queue loop's own staleness decision, pulled
// out as a pure function of the broker so it is unit-testable with an
// injected clock (same as every other broker method) instead of needing a
// live wait through the real loop registry.
//
// this used to ALSO flag a claimed-but-unresolved
// record past its own threshold - superseded now that failStaleClaims()
// actively resolves that case (moves it to failed) instead of merely
// alerting on it; the loop's maker runs that sweep BEFORE this check, so
// a claimed record is never stale by the time this function would see it
// anyway. This is left watching only the PENDING side: nothing has
// claimed the launch at all (the desktop shell is not running or not
// polling).
//
// glmps-2-0-61: "not running or not claiming" could not tell a shell that
// had been gone for 90 minutes from one polling but refusing. shellPolledAt
// is the kernel's own record of the shell's last authenticated poll (in
// memory, so null after a kernel restart until the shell polls again);
// bootedAt lets the reason say how long it has gone unseen even then.
export function launchQueueStaleness(broker, { pendingThresholdMs = 120_000, shellPolledAt = null, bootedAt = null, now = Date.now } = {}) {
  const pendingAge = broker.oldestPendingAgeMs();
  if (pendingAge > pendingThresholdMs) {
    const s = (ms) => Math.round(ms / 1000);
    const shell = shellPolledAt !== null
      ? `the desktop shell last polled ${s(now() - shellPolledAt)} s ago${now() - shellPolledAt > 30_000 ? ' (not running or not reaching the kernel)' : ' (running but not claiming)'}`
      : `the desktop shell has not polled since the kernel started${bootedAt !== null ? ` ${s(now() - bootedAt)} s ago` : ''} (not running or not reaching the kernel)`;
    return { stale: true, reason: `${broker.pending().length} launch(es) waiting ${s(pendingAge)} s: ${shell}` };
  }
  return { stale: false, reason: null };
}

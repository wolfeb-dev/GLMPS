// server/lib/scut/approvals.js
// Operator-approved actions (spec docs/specs/2026-10-17-slack-approved-actions.md).
// The server, never an agent, runs a pre-registered action when the operator
// replies the configured phrase in the request's Slack thread. A message is
// only ever COMPARED to the phrase: no part of it is passed to an action, a
// session, a steer note or a ticket.
//
// State is a fold over an append-only log, so a restart mid-run (deploy-glmps2
// restarts this very server) loses nothing: resume() picks the run back up.
import { win32, posix } from 'node:path';
import { REPO_ROOT, schtasksExe } from '../paths.js';
import { stateFile, appendLedger, readLedgerText, opsTaskName } from '../state-dir.js';
import { formatTime } from '../../../web/shared/time-format.js';
import { clearMaintenance } from '../kernel/maintenance.js';

export const REQUEST_TTL_MS = 15 * 60_000;
const ALERT_WINDOW_MS = 24 * 3_600_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const REFUSAL_TEXT = {
  'bot-sender': 'the message came from the bot, not the operator',
  'not-operator': 'only the operator can approve',
  'phrase-mismatch': 'the reply is not the approval phrase',
  'no-request': 'there is no approval request in this thread',
  'unknown-action': 'that action is not registered',
  'already-used': 'this request was already approved once',
  expired: 'this request has expired; ask for a new one',
  'action-running': 'that action is already running',
  'another-action-running': 'another registered action is running; one runs at a time',
  'not-agent-runnable': 'that action is not open to agents',
  cooldown: 'that action ran recently and is cooling down',
  'no-phrase': 'no approval phrase is configured',
  'no-room': 'the ticket has no Slack thread to ask in',
  'already-pending': 'this thread already has a pending request',
  'post-failed': 'the request could not be posted to Slack',
};

// Shipped registry. config.json `approvals.actions` merges over it per action,
// so the setup script can add only `logFile` without restating the rest.
export const DEFAULT_ACTIONS = {
  'deploy-glmps2': {
    description: `fast-forward ${REPO_ROOT} to origin/main and restart the kernel (the GLMPS2 service, or the desktop app where there is none)`,
    file: schtasksExe(),
    args: ['/Run', '/TN', opsTaskName('deploy-glmps2')],
    scheduledTask: opsTaskName('deploy-glmps2'),
    cooldownMinutes: 30,
    timeoutMinutes: 10,
    healthUrl: 'http://127.0.0.1:8123/healthz',
    // /healthz must then report this checkout's HEAD (glmps-2-0-58).
    repoDir: REPO_ROOT,
    restartOnlyIfHeadMoved: true,
    agentMayRun: true,
  },
  // Restart only: no fast-forward, no rollback (glmps-2-0-124).
  'restart-glmps2': {
    description: `restart the kernel from ${REPO_ROOT} without deploying anything new`,
    file: schtasksExe(),
    args: ['/Run', '/TN', opsTaskName('restart-glmps2')],
    scheduledTask: opsTaskName('restart-glmps2'),
    cooldownMinutes: 10,
    timeoutMinutes: 5,
    healthUrl: 'http://127.0.0.1:8123/healthz',
    repoDir: REPO_ROOT,
    agentMayRun: true,
  },
  // The one Restart (glmps-2-0-170): runs the three actions above in order from
  // inside the server (restart-all.js). `file` is never executed for it; the
  // registry just requires one.
  'restart-all': {
    description: `update ${REPO_ROOT} to the tested commit if one is waiting, rebuild the desktop app if its code changed, and make sure the running kernel is new`,
    file: schtasksExe(),
    composite: 'restart-all',
    cooldownMinutes: 5,
    timeoutMinutes: 45,
    healthUrl: 'http://127.0.0.1:8123/healthz',
    agentMayRun: true,
  },
  'rebuild-app': {
    description: 'rebuild the GLMPS 2.0 desktop app and reinstall it over the existing install',
    file: schtasksExe(),
    args: ['/Run', '/TN', opsTaskName('rebuild-app')],
    scheduledTask: opsTaskName('rebuild-app'),
    cooldownMinutes: 30,
    timeoutMinutes: 30,
    healthUrl: 'http://127.0.0.1:8123/healthz',
    agentMayRun: true,
  },
};

/** cfg.approvals -> { phrase, registry, errors }. The phrase comes only from here. */
export function approvalsConfig(raw = {}) {
  const merged = { ...DEFAULT_ACTIONS };
  for (const [name, def] of Object.entries(raw?.actions || {})) merged[name] = { ...(DEFAULT_ACTIONS[name] || {}), ...(def || {}) };
  const { registry, errors } = normalizeRegistry(merged);
  return { phrase: typeof raw?.phrase === 'string' ? raw.phrase : null, registry, errors };
}

/** Keep only well-formed actions: a fixed absolute executable and string args. */
export function normalizeRegistry(actions = {}) {
  const registry = {};
  const errors = [];
  for (const [name, def] of Object.entries(actions || {})) {
    if (!NAME.test(name)) { errors.push(`${name}: name must be lowercase letters, digits and dashes`); continue; }
    if (!def || typeof def.file !== 'string' || !(win32.isAbsolute(def.file) || posix.isAbsolute(def.file))) { errors.push(`${name}: file must be an absolute path`); continue; }
    const args = def.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) { errors.push(`${name}: args must be a list of strings`); continue; }
    registry[name] = {
      name,
      description: String(def.description ?? name),
      file: def.file,
      args: [...args],
      scheduledTask: typeof def.scheduledTask === 'string' && def.scheduledTask ? def.scheduledTask : null,
      cooldownMs: Math.max(0, Number(def.cooldownMinutes ?? 30)) * 60_000,
      timeoutMs: Math.max(1, Number(def.timeoutMinutes ?? 10)) * 60_000,
      healthUrl: typeof def.healthUrl === 'string' && def.healthUrl ? def.healthUrl : null,
      logFile: typeof def.logFile === 'string' && def.logFile ? def.logFile : null,
      repoDir: typeof def.repoDir === 'string' && def.repoDir ? def.repoDir : null,
      composite: typeof def.composite === 'string' && def.composite ? def.composite : null,
      restartOnlyIfHeadMoved: def.restartOnlyIfHeadMoved === true,
      agentMayRun: def.agentMayRun === true,
    };
  }
  return { registry, errors };
}

function normalizeText(s) {
  return String(s ?? '').replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An empty or missing phrase matches nothing, so an unset phrase disables approvals. */
export function phraseMatches(text, phrase) {
  const want = normalizeText(phrase);
  return want.length > 0 && normalizeText(text) === want;
}

const LOG_NAME = 'approvals.jsonl';

// New entries go to ledgers/; the old root file is still read for one release.
export function logPath(stateDir) {
  return stateFile(stateDir, 'ledgers', LOG_NAME).path;
}

export function appendLog(stateDir, entry) {
  appendLedger(stateDir, LOG_NAME, JSON.stringify(entry) + '\n');
}

export function readLog(stateDir) {
  const out = [];
  for (const line of readLedgerText(stateDir, LOG_NAME).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
  }
  return out;
}

/** Requests by id, each with its approval and run folded in. */
export function foldRequests(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (e.type === 'request') byId.set(e.id, { ...e, approvedTs: null, approvedBy: null, run: null, steps: [] });
    const r = e.id ? byId.get(e.id) : null;
    if (!r) continue;
    if (e.type === 'approved') { r.approvedTs = e.ts; r.approvedBy = e.user ?? null; }
    if (e.type === 'step') r.steps.push({ step: e.step, status: e.status, ts: e.ts, detail: e.detail });
    if (e.type === 'run-started') r.run = { startedTs: e.ts, finishedTs: null, result: null };
    if (e.type === 'run-finished' && r.run) { r.run.finishedTs = e.ts; r.run.result = e.result ?? null; }
  }
  return byId;
}

export function requestStatus(r, now) {
  if (r.approvedTs != null) return 'used';
  return now >= r.expiresAt ? 'expired' : 'pending';
}

// A run that never logged its finish (the host died for good) stops counting
// as running once its timeout has passed, so it cannot wedge the action. Any
// running action blocks every other (a rebuild must not build from a checkout
// a deploy is fast-forwarding); `registry` supplies the other actions' timeouts.
export function actionBusy(requests, def, now, registry = {}) {
  let lastStart = null;
  let same = false;
  let other = false;
  for (const r of requests.values()) {
    if (!r.run) continue;
    if (r.action === def.name && (lastStart == null || r.run.startedTs > lastStart)) lastStart = r.run.startedTs;
    const timeoutMs = (r.action === def.name ? def : registry[r.action])?.timeoutMs ?? def.timeoutMs;
    if (r.run.finishedTs == null && now - r.run.startedTs < timeoutMs) { if (r.action === def.name) same = true; else other = true; }
  }
  if (same) return 'action-running';
  if (other) return 'another-action-running';
  if (lastStart != null && now - lastStart < def.cooldownMs) return 'cooldown';
  return null;
}

// `wholeTicketChannel` widens the match to every request of the channel's
// ticket. Only the request side wants that (one pending request per ticket); an
// approval must come from the request's own thread.
function latestInThread(requests, { channel, thread_ts, channelTicket }, { wholeTicketChannel = false } = {}) {
  let best = null;
  for (const r of requests.values()) {
    if (r.channel !== channel) continue;
    const here = r.thread_ts === thread_ts || (wholeTicketChannel && channelTicket != null && r.ticketId === channelTicket);
    if (here && (!best || r.ts > best.ts)) best = r;
  }
  return best;
}

/**
 * Decide what one Slack message means for approvals. Pure.
 * Returns { attempt:false } for a message that is not an approval attempt,
 * else { attempt:true, consume, ok, reason?, request? }. A phrase-matching
 * message is always consumed so the phrase never travels further.
 */
export function decideApproval({ msg, phrase, allowedUsers = [], registry = {}, entries = [], now }) {
  const matches = phraseMatches(msg.text, phrase);
  const fromBot = msg.fromBot === true;
  const isOperator = !fromBot && Boolean(msg.user) && allowedUsers.includes(msg.user);
  const requests = foldRequests(entries);
  const request = latestInThread(requests, msg);
  const pendingHere = request && requestStatus(request, now) === 'pending';
  if (!matches && !(pendingHere && isOperator)) return { attempt: false };
  const refuse = (reason) => ({ attempt: true, consume: matches, ok: false, reason, request: request ?? null });
  if (fromBot) return refuse('bot-sender');
  if (!isOperator) return refuse('not-operator');
  if (!matches) return refuse('phrase-mismatch');
  if (!request) return refuse('no-request');
  const def = registry[request.action];
  if (!def) return refuse('unknown-action');
  const status = requestStatus(request, now);
  if (status === 'used') return refuse('already-used');
  if (status === 'expired') return refuse('expired');
  const busy = actionBusy(requests, def, now, registry);
  if (busy) return refuse(busy);
  return { attempt: true, consume: true, ok: true, request, def };
}

export function requestText(def, expiresAt) {
  const until = formatTime(expiresAt, { date: false });
  return `:lock: approval requested: \`${def.name}\` - ${def.description}.\n` +
    `To run it, reply in this thread with the approval phrase before ${until} (15 minutes). ` +
    'It runs once; nothing in your reply is executed.';
}

export function outcomeText(def, result) {
  const health = result.health?.error
    ? `health check failed (${result.health.error})`
    : result.health ? `${def.healthUrl ? new URL(def.healthUrl).pathname : 'health'} ${result.health.status}${result.health.summary ? ` (${result.health.summary})` : ''}` : 'no health check';
  const head = result.ok ? `:white_check_mark: \`${def.name}\` finished` : `:x: \`${def.name}\` FAILED`;
  const exit = result.exitCode == null ? 'no exit status' : `exit ${result.exitCode}`;
  const why = result.error ? `: ${result.error}` : '';
  const log = !result.ok && def.logFile ? ` Log: ${def.logFile}` : '';
  const steps = result.stepsLine ? ` Steps: ${result.stepsLine}.` : '';
  return `${head}${why}. ${exit}, ${health}.${steps}${log}`;
}

/**
 * Which cards get a devlog note when a run finishes. A run with a Slack thread
 * already posted its outcome there, so only a thread-less run (a merge-queue
 * deploy of a headless card) writes one: to its own card, and on failure also
 * to the nearest ancestor card that has a Slack room, since a headless card's
 * devlog reaches nobody. Six failed deploys went unseen for 7 hours that way.
 * @returns {{id:string, text:string}[]}
 */
export function finishedRunNotes({ ticketId, posted, ok, text, items = [], hasRoom = () => false }) {
  if (!ticketId || posted) return [];
  const plain = String(text).replace(/^:[a-z_]+: /, '');
  const notes = [{ id: ticketId, text: plain }];
  if (ok) return notes;
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set([ticketId]);
  for (let id = byId.get(ticketId)?.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
    seen.add(id);
    if (hasRoom(id)) { notes.push({ id, text: `card ${ticketId}: ${plain}` }); break; }
  }
  return notes;
}

const SEVERITY = { refused: 'warn', request: 'info', approved: 'info', 'run-started': 'info' };

/** Recent log lines as /api/alerts rows. Never carries message text. */
export function approvalAlerts(entries, now) {
  const rows = [];
  for (const e of entries) {
    if (now - (e.ts ?? 0) > ALERT_WINDOW_MS) continue;
    const severity = e.type === 'run-finished' ? (e.result?.ok ? 'info' : 'error') : SEVERITY[e.type];
    if (!severity) continue;
    const what = e.action ? `\`${e.action}\`` : 'an action';
    const title = {
      request: `approval requested for ${what}`,
      approved: `operator approved ${what}`,
      refused: `approval refused for ${what}: ${REFUSAL_TEXT[e.reason] ?? e.reason}`,
      'run-started': `${what} started`,
      'run-finished': `${what} ${e.result?.ok ? 'finished' : 'failed'} (exit ${e.result?.exitCode ?? 'none'})`,
    }[e.type];
    rows.push({ source: 'approvals', severity, title, detail: e.ticketId ? `ticket ${e.ticketId}` : null, target: e.ticketId ?? null, ts: e.ts });
  }
  return rows;
}

/**
 * The stateful seam server.js wires. Every dependency is injected.
 * @param {object} deps
 * @param {string} deps.stateDir
 * @param {() => {phrase:string|null, registry:object}} deps.getConfig
 * @param {() => string[]} deps.getAllowedUsers - the SCUT operator allowlist
 * @param {(ticketId:string) => {channel:string, thread_ts?:string}|null} deps.findRoomByTicket
 * @param {(channel:string) => string|null} [deps.ticketForChannel]
 * @param {(msg:{channel:string, thread_ts?:string, text:string}) => Promise<{ts?:string}|any>} deps.post
 * @param {(def:object, opts:{startedTs:number, resume:boolean}) => Promise<object>} deps.runAction
 * @param {(key:string, reason:string) => any} [deps.reportMiss]
 * @param {(run:{ticketId:string|null, posted:boolean, ok:boolean, text:string}) => any} [deps.onFinished]
 */
export function makeApprovals({ stateDir, getConfig, getAllowedUsers, findRoomByTicket, ticketForChannel = () => null, post, runAction, reportMiss = () => {}, onFinished = () => {}, now = Date.now }) {
  const inFlight = new Map(); // request id -> run promise
  const asking = new Set(); // threads with a request being posted
  const log = (entry) => appendLog(stateDir, { ts: now(), ...entry });
  const say = (where, text) => Promise.resolve()
    .then(() => post({ channel: where.channel, thread_ts: where.thread_ts, text }))
    .then((r) => r ?? {})
    .catch((e) => { reportMiss('approvals-post', `${e?.message ?? e}`); return null; });
  const finished = (ticketId, posted, def, result) => {
    try { onFinished({ ticketId: ticketId ?? null, posted, ok: !!result.ok, text: outcomeText(def, result) }); }
    catch (e) { reportMiss('approvals-finished', `${e?.message ?? e}`); }
  };

  async function request({ action, ticketId } = {}) {
    const { phrase, registry } = getConfig();
    const name = String(action ?? '').slice(0, 64);
    const ticket = String(ticketId ?? '').slice(0, 128) || null;
    const refuse = (reason) => { log({ type: 'refused', stage: 'request', reason, action: name, ticketId: ticket }); return { ok: false, reason }; };
    if (!registry[name]) return refuse('unknown-action');
    if (!String(phrase ?? '').trim()) return refuse('no-phrase');
    const room = ticket ? findRoomByTicket(ticket) : null;
    if (!room?.channel) return refuse('no-room');
    const entries = readLog(stateDir);
    const t = now();
    const channelTicket = ticketForChannel(room.channel);
    const open = latestInThread(foldRequests(entries), { channel: room.channel, thread_ts: room.thread_ts ?? null, channelTicket }, { wholeTicketChannel: true });
    const lock = `${room.channel}:${room.thread_ts ?? ''}`;
    if (asking.has(lock) || (open && requestStatus(open, t) === 'pending')) return refuse('already-pending');
    const expiresAt = t + REQUEST_TTL_MS;
    asking.add(lock);
    let posted;
    try { posted = await say(room, requestText(registry[name], expiresAt)); } finally { asking.delete(lock); }
    if (!posted) return refuse('post-failed');
    const id = `apr-${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    log({ type: 'request', id, action: name, ticketId: ticket, channel: room.channel, thread_ts: room.thread_ts ?? posted.ts ?? null, expiresAt });
    return { ok: true, id, expiresAt };
  }

  // A composite action gets its run id, the steps its ledger already holds
  // (a resume continues from them) and a recorder that appends to it.
  function compositeOpts(req, { startedTs, resume }) {
    const steps = foldRequests(readLog(stateDir)).get(req.id)?.steps ?? [];
    return { startedTs, resume, runId: req.id, steps, recordStep: (e) => log({ type: 'step', id: req.id, ...e }) };
  }

  function execute(req, def, { startedTs, resume }) {
    const where = { channel: req.channel, thread_ts: req.thread_ts };
    const run = Promise.resolve()
      .then(() => runAction(def, def.composite ? compositeOpts(req, { startedTs, resume }) : { startedTs, resume }))
      .catch((e) => ({ ok: false, exitCode: null, error: e?.message ?? String(e), health: null }))
      .then(async (result) => {
        log({ type: 'run-finished', id: req.id, action: def.name, ticketId: req.ticketId, result });
        const posted = where.channel ? !!(await say(where, outcomeText(def, result))) : false;
        finished(req.ticketId, posted, def, result);
      })
      .finally(() => inFlight.delete(req.id));
    inFlight.set(req.id, run);
    return run;
  }

  /** Offered every Slack message first; true means it stops here. */
  async function onMessage(msg) {
    const { phrase, registry } = getConfig();
    const t = now();
    const decision = decideApproval({
      msg: { ...msg, channelTicket: msg.channel ? ticketForChannel(msg.channel) : null },
      phrase, allowedUsers: getAllowedUsers(), registry, entries: readLog(stateDir), now: t,
    });
    if (!decision.attempt) return false;
    const req = decision.request;
    const where = { channel: msg.channel, thread_ts: msg.thread_ts };
    if (!decision.ok) {
      log({ type: 'refused', stage: 'approval', reason: decision.reason, id: req?.id ?? null, action: req?.action ?? null, ticketId: req?.ticketId ?? null, user: msg.user ?? null, channel: msg.channel, thread_ts: msg.thread_ts });
      if (decision.reason !== 'phrase-mismatch' && !msg.fromBot) await say(where, `approval refused: ${REFUSAL_TEXT[decision.reason]}.`);
      return decision.consume;
    }
    // Marked used before anything async, so a second phrase in flight is
    // already 'already-used' when it is decided.
    log({ type: 'approved', id: req.id, action: req.action, ticketId: req.ticketId, user: msg.user });
    log({ type: 'run-started', id: req.id, action: req.action, ticketId: req.ticketId });
    await say(where, `approved: running \`${req.action}\` now. The outcome posts here.`);
    execute(req, decision.def, { startedTs: t, resume: false });
    return true;
  }

  /**
   * Run a registered action on a server event (glmps-2-0-66: a merge-queue
   * merge), with no phrase and no message involved. Logged as a request
   * approved by its trigger, so the run, its outcome post and resume() after
   * the restart a deploy causes all follow the phrase path.
   */
  async function runRegistered({ action, ticketId, trigger, requireAgent = false } = {}) {
    const { registry } = getConfig();
    const name = String(action ?? '').slice(0, 64);
    const ticket = String(ticketId ?? '').slice(0, 128) || null;
    const by = String(trigger ?? 'server').slice(0, 64);
    const refuse = (reason) => { log({ type: 'refused', stage: 'trigger', reason, action: name, ticketId: ticket, trigger: by }); return { ok: false, reason }; };
    const def = registry[name];
    if (!def) return refuse('unknown-action');
    if (requireAgent && !def.agentMayRun) return refuse('not-agent-runnable');
    const t = now();
    const busy = actionBusy(foldRequests(readLog(stateDir)), def, t, registry);
    if (busy) return refuse(busy);
    const room = ticket ? findRoomByTicket(ticket) : null;
    const id = `apr-${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const req = { id, action: name, ticketId: ticket, channel: room?.channel ?? null, thread_ts: room?.thread_ts ?? null };
    log({ type: 'request', ...req, trigger: by, expiresAt: t });
    log({ type: 'approved', id, action: name, ticketId: ticket, user: by });
    log({ type: 'run-started', id, action: name, ticketId: ticket });
    if (req.channel) await say(req, `running \`${name}\` (${by}). The outcome posts here.`);
    execute(req, def, { startedTs: t, resume: false });
    return { ok: true, id };
  }

  /** After a restart: finish waiting on any run the old process started. */
  function resume() {
    const { registry } = getConfig();
    const t = now();
    const out = [];
    for (const r of foldRequests(readLog(stateDir)).values()) {
      if (!r.run || r.run.finishedTs != null || inFlight.has(r.id)) continue;
      const def = registry[r.action];
      if (!def) {
        const result = { ok: false, exitCode: null, error: 'action no longer registered', health: null };
        log({ type: 'run-finished', id: r.id, action: r.action, ticketId: r.ticketId, result });
        clearMaintenance(stateDir, r.id);
        finished(r.ticketId, false, { name: r.action }, result);
        continue;
      }
      if (t - r.run.startedTs > def.timeoutMs * 2) {
        const result = { ok: false, exitCode: null, error: 'outcome unknown: the server was down past the timeout', health: null };
        log({ type: 'run-finished', id: r.id, action: r.action, ticketId: r.ticketId, result });
        // A Restart run ended here never reaches its own finally (restart-all.js).
        clearMaintenance(stateDir, r.id);
        finished(r.ticketId, false, def, result);
        continue;
      }
      out.push(execute(r, def, { startedTs: r.run.startedTs, resume: true }));
    }
    return Promise.all(out);
  }

  function view() {
    const entries = readLog(stateDir);
    const t = now();
    const requests = [...foldRequests(entries).values()].map((r) => ({ ...r, status: requestStatus(r, t) }));
    return { requests: requests.slice(-50), log: entries.slice(-100) };
  }

  return { request, runRegistered, onMessage, resume, view, alerts: () => approvalAlerts(readLog(stateDir), now()), settled: () => Promise.all([...inFlight.values()]) };
}

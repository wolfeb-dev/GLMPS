// Tests for operator-approved actions (server/lib/scut/approvals.js).
// The phrase here is a fixture; the real one lives only in config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeApprovals, approvalsConfig, normalizeRegistry, finishedRunNotes, phraseMatches, readLog, logPath, approvalAlerts, REQUEST_TTL_MS, requestText, REFUSAL_TEXT, outcomeText,
} from '../lib/scut/approvals.js';
import { REPO_ROOT, schtasksExe } from '../lib/paths.js';
import { beginMaintenance, readMaintenance, releaseOrphanedMaintenance } from '../lib/kernel/maintenance.js';

const PHRASE = 'fixture phrase alpha';
const OPERATOR = 'UOPERATOR';
const ROOM = { channel: 'C1', thread_ts: '100.1' };
const ACTION = {
  'test-action': { description: 'does a test thing', file: '/bin/true', args: ['--fixed'], cooldownMinutes: 30, timeoutMinutes: 10 },
};

function setup({ phrase = PHRASE, actions = ACTION, result = { ok: true, exitCode: 0, health: { status: 200, summary: 'up' } }, rooms = { T1: ROOM } } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const clock = { t: 1_000_000 };
  const posts = [];
  const runs = [];
  let cfg = approvalsConfig({ phrase, actions });
  const a = makeApprovals({
    stateDir,
    getConfig: () => cfg,
    getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: (id) => rooms[id] ?? null,
    post: async (m) => { posts.push(m); return { ts: `post-${posts.length}` }; },
    runAction: async (def, opts) => { runs.push({ def, opts }); return result; },
    now: () => clock.t,
  });
  return { a, stateDir, clock, posts, runs, setConfig: (c) => { cfg = c; } };
}

const reply = (over = {}) => ({ channel: ROOM.channel, thread_ts: ROOM.thread_ts, user: OPERATOR, fromBot: false, text: PHRASE, ...over });
const refusals = (stateDir) => readLog(stateDir).filter((e) => e.type === 'refused');

test('deploy-glmps2 is in the shipped registry and starts the scheduled task with fixed args', () => {
  const { registry, errors } = approvalsConfig({});
  assert.deepEqual(errors, []);
  const d = registry['deploy-glmps2'];
  assert.ok(d);
  assert.match(d.file, /schtasks\.exe$/i);
  assert.deepEqual(d.args, ['/Run', '/TN', '\\GLMPS\\deploy-glmps2']);
  assert.equal(d.scheduledTask, '\\GLMPS\\deploy-glmps2');
  assert.equal(d.cooldownMs, 30 * 60_000);
});

test('config merges over a shipped action per field, and the phrase comes only from config', () => {
  const c = approvalsConfig({ phrase: PHRASE, actions: { 'deploy-glmps2': { logFile: 'C:\\x.log' } } });
  assert.equal(c.registry['deploy-glmps2'].logFile, 'C:\\x.log');
  assert.equal(c.registry['deploy-glmps2'].file, 'C:\\Windows\\System32\\schtasks.exe');
  assert.equal(c.phrase, PHRASE);
  assert.equal(approvalsConfig({}).phrase, null);
});

test('a malformed action is dropped with a reason', () => {
  const { registry, errors } = normalizeRegistry({
    'rel-path': { file: 'schtasks.exe' },
    'bad-args': { file: '/bin/x', args: [1] },
    'Bad Name': { file: '/bin/x' },
    ok: { file: '/bin/x' },
  });
  assert.deepEqual(Object.keys(registry), ['ok']);
  assert.equal(errors.length, 3);
});

test('phrase match ignores case, spacing and mentions; an empty phrase matches nothing', () => {
  assert.equal(phraseMatches(`<@UBOT>  Fixture   PHRASE alpha `, PHRASE), true);
  assert.equal(phraseMatches(`${PHRASE} please`, PHRASE), false);
  assert.equal(phraseMatches('', ''), false);
  assert.equal(phraseMatches('anything', null), false);
});

test('a request posts the action, its description and expiry, never the phrase', async () => {
  const { a, stateDir, posts } = setup();
  const r = await a.request({ action: 'test-action', ticketId: 'T1' });
  assert.equal(r.ok, true);
  assert.equal(r.expiresAt - 1_000_000, REQUEST_TTL_MS);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread_ts, ROOM.thread_ts);
  assert.match(posts[0].text, /test-action/);
  assert.match(posts[0].text, /does a test thing/);
  assert.match(posts[0].text, /15 minutes/);
  assert.equal(posts[0].text.toLowerCase().includes(PHRASE), false);
  assert.equal(readLog(stateDir).filter((e) => e.type === 'request').length, 1);
});

test('an unknown action name is refused at request time and logged', async () => {
  const { a, stateDir, posts } = setup();
  const r = await a.request({ action: 'rm -rf /', ticketId: 'T1' });
  assert.deepEqual(r, { ok: false, reason: 'unknown-action' });
  assert.equal(posts.length, 0);
  const [e] = refusals(stateDir);
  assert.equal(e.stage, 'request');
  assert.equal(e.reason, 'unknown-action');
  assert.equal(e.action, 'rm -rf /');
});

test('a request is refused with no phrase configured, no room, or one already pending', async () => {
  const none = setup({ phrase: '' });
  assert.equal((await none.a.request({ action: 'test-action', ticketId: 'T1' })).reason, 'no-phrase');
  const s = setup();
  assert.equal((await s.a.request({ action: 'test-action', ticketId: 'NOPE' })).reason, 'no-room');
  assert.equal((await s.a.request({ action: 'test-action', ticketId: 'T1' })).ok, true);
  assert.equal((await s.a.request({ action: 'test-action', ticketId: 'T1' })).reason, 'already-pending');
  assert.deepEqual(refusals(s.stateDir).map((e) => e.reason), ['no-room', 'already-pending']);
});

test('the operator replying the phrase runs the action once and posts the outcome', async () => {
  const { a, stateDir, posts, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  assert.equal(await a.onMessage(reply()), true);
  await a.settled();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].def.args, ['--fixed']);
  assert.equal(runs[0].opts.resume, false);
  assert.deepEqual(readLog(stateDir).map((e) => e.type), ['request', 'approved', 'run-started', 'run-finished']);
  const outcome = posts.at(-1).text;
  assert.match(outcome, /finished/);
  assert.match(outcome, /exit 0/);
  assert.match(outcome, /200/);
  assert.equal(readFileSync(logPath(stateDir), 'utf8').toLowerCase().includes(PHRASE), false);
  assert.equal(posts.some((p) => p.text.toLowerCase().includes(PHRASE)), false);
});

test('refused: the bot posting the phrase (logged, consumed, no thread reply)', async () => {
  const { a, stateDir, posts, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  assert.equal(await a.onMessage(reply({ user: 'UBOT', fromBot: true })), true);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'bot-sender');
  assert.equal(posts.length, 1); // only the request
});

test('refused: someone other than the operator replying the phrase', async () => {
  const { a, stateDir, posts, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  assert.equal(await a.onMessage(reply({ user: 'USOMEONE' })), true);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'not-operator');
  assert.match(posts.at(-1).text, /only the operator/);
});

test('refused: the operator replying something else in a pending thread (logged, not consumed)', async () => {
  const { a, stateDir, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  assert.equal(await a.onMessage(reply({ text: 'what does this do?' })), false);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'phrase-mismatch');
  assert.equal(JSON.stringify(readLog(stateDir)).includes('what does this do'), false);
});

test('a non-phrase message outside any pending thread is not an approval attempt', async () => {
  const { a, stateDir } = setup();
  assert.equal(await a.onMessage(reply({ text: 'hello' })), false);
  assert.equal(await a.onMessage(reply({ user: 'USOMEONE', text: 'hello' })), false);
  assert.deepEqual(readLog(stateDir), []);
});

test('refused: the phrase in a thread with no request (consumed, so it is never routed)', async () => {
  const { a, stateDir, runs } = setup();
  assert.equal(await a.onMessage(reply({ thread_ts: '999.9' })), true);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'no-request');
});

test('refused: an expired request', async () => {
  const { a, stateDir, clock, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  clock.t += REQUEST_TTL_MS;
  assert.equal(await a.onMessage(reply()), true);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'expired');
});

test('refused: a request already used', async () => {
  const { a, stateDir, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  await a.onMessage(reply());
  await a.settled();
  assert.equal(await a.onMessage(reply()), true);
  await a.settled();
  assert.equal(runs.length, 1);
  assert.equal(refusals(stateDir)[0].reason, 'already-used');
});

test('refused: an action unregistered after it was requested', async () => {
  const { a, stateDir, runs, setConfig } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  setConfig(approvalsConfig({ phrase: PHRASE, actions: {} }));
  assert.equal(await a.onMessage(reply()), true);
  assert.equal(runs.length, 0);
  assert.equal(refusals(stateDir)[0].reason, 'unknown-action');
});

test('refused: a second approval of the same action within its cooldown', async () => {
  const { a, stateDir, clock, runs } = setup();
  await a.request({ action: 'test-action', ticketId: 'T1' });
  await a.onMessage(reply());
  await a.settled();
  clock.t += 5 * 60_000;
  assert.equal((await a.request({ action: 'test-action', ticketId: 'T1' })).ok, true);
  assert.equal(await a.onMessage(reply()), true);
  assert.equal(runs.length, 1);
  assert.equal(refusals(stateDir)[0].reason, 'cooldown');
  clock.t += 30 * 60_000;
  assert.equal((await a.request({ action: 'test-action', ticketId: 'T1' })).ok, true);
  await a.onMessage(reply());
  await a.settled();
  assert.equal(runs.length, 2);
});

test('refused: an approval while the same action is still running', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  let release;
  const gate = new Promise((r) => { release = r; });
  const rooms = { T1: ROOM, T2: { channel: 'C2', thread_ts: '200.2' } };
  const a = makeApprovals({
    stateDir,
    getConfig: () => approvalsConfig({ phrase: PHRASE, actions: { 'test-action': { ...ACTION['test-action'], cooldownMinutes: 0 } } }),
    getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: (id) => rooms[id],
    post: async () => ({}),
    runAction: async () => { await gate; return { ok: true, exitCode: 0, health: null }; },
  });
  await a.request({ action: 'test-action', ticketId: 'T1' });
  await a.request({ action: 'test-action', ticketId: 'T2' });
  await a.onMessage(reply());
  assert.equal(await a.onMessage(reply({ channel: 'C2', thread_ts: '200.2' })), true);
  assert.equal(refusals(stateDir)[0].reason, 'action-running');
  release();
  await a.settled();
});

test('in a ticket channel only a reply in the request thread approves, not any message in the channel', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const runs = [];
  const a = makeApprovals({
    stateDir,
    getConfig: () => approvalsConfig({ phrase: PHRASE, actions: ACTION }),
    getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => ({ channel: 'CT' }),
    ticketForChannel: (c) => (c === 'CT' ? 'T9' : null),
    post: async () => ({ ts: '300.3' }),
    runAction: async (def) => { runs.push(def); return { ok: true, exitCode: 0, health: null }; },
  });
  await a.request({ action: 'test-action', ticketId: 'T9' });
  assert.equal(readLog(stateDir)[0].thread_ts, '300.3');
  // Elsewhere in the same ticket channel: the phrase is consumed and refused.
  assert.equal(await a.onMessage({ channel: 'CT', thread_ts: '400.4', user: OPERATOR, text: PHRASE }), true);
  await a.settled();
  assert.equal(runs.length, 0);
  assert.ok(readLog(stateDir).some((e) => e.type === 'refused' && e.reason === 'no-request'));
  // In the request's own thread: approved.
  assert.equal(await a.onMessage({ channel: 'CT', thread_ts: '300.3', user: OPERATOR, text: PHRASE }), true);
  await a.settled();
  assert.equal(runs.length, 1);
});

test('a failed run posts FAILED with its exit status', async () => {
  const { a, posts } = setup({ result: { ok: false, exitCode: 1, health: { status: 200, summary: '' } } });
  await a.request({ action: 'test-action', ticketId: 'T1' });
  await a.onMessage(reply());
  await a.settled();
  assert.match(posts.at(-1).text, /FAILED/);
  assert.match(posts.at(-1).text, /exit 1/);
});

test('resume finishes a run the previous process started, without relaunching', async () => {
  const first = setup();
  await first.a.request({ action: 'test-action', ticketId: 'T1' });
  // The first process logs the start, then dies before the run finishes.
  const entries = readLog(first.stateDir);
  const id = entries[0].id;
  const { appendLog } = await import('../lib/scut/approvals.js');
  appendLog(first.stateDir, { ts: 1_000_000, type: 'approved', id, action: 'test-action', ticketId: 'T1', user: OPERATOR });
  appendLog(first.stateDir, { ts: 1_000_000, type: 'run-started', id, action: 'test-action', ticketId: 'T1' });
  const runs = [];
  const posts = [];
  const second = makeApprovals({
    stateDir: first.stateDir,
    getConfig: () => approvalsConfig({ phrase: PHRASE, actions: ACTION }),
    getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => ROOM,
    post: async (m) => { posts.push(m); return {}; },
    runAction: async (def, opts) => { runs.push(opts); return { ok: true, exitCode: 0, health: { status: 200, summary: 'up' } }; },
    now: () => 1_000_000 + 60_000,
  });
  await second.resume();
  assert.deepEqual(runs, [{ startedTs: 1_000_000, resume: true }]);
  assert.match(posts[0].text, /exit 0/);
  await second.resume();
  assert.equal(runs.length, 1);
});

test('alerts: refusals warn, a failed run errors, nothing carries message text', async () => {
  const { a, stateDir, clock } = setup({ result: { ok: false, exitCode: 2, health: null } });
  await a.request({ action: 'test-action', ticketId: 'T1' });
  await a.onMessage(reply({ user: 'USOMEONE' }));
  await a.onMessage(reply());
  await a.settled();
  const rows = a.alerts();
  assert.ok(rows.every((r) => r.source === 'approvals'));
  assert.equal(rows.find((r) => /refused/.test(r.title)).severity, 'warn');
  assert.equal(rows.find((r) => /failed/.test(r.title)).severity, 'error');
  assert.equal(JSON.stringify(rows).toLowerCase().includes(PHRASE), false);
  assert.deepEqual(approvalAlerts(readLog(stateDir), clock.t + 25 * 3_600_000), []);
});

// glmps-2-0-66 F3: the merge queue runs a registered action with no phrase.
test('runRegistered runs the action without a phrase, logs it as approved by its trigger, and posts the outcome', async () => {
  const { a, stateDir, posts, runs } = setup();
  const r = await a.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'merge-queue' });
  assert.equal(r.ok, true);
  await a.settled();
  assert.equal(runs.length, 1);
  const types = readLog(stateDir).map((e) => e.type);
  assert.deepEqual(types, ['request', 'approved', 'run-started', 'run-finished']);
  const req = readLog(stateDir)[0];
  assert.equal(req.trigger, 'merge-queue');
  assert.equal(readLog(stateDir)[1].user, 'merge-queue');
  assert.ok(posts.some((p) => p.channel === ROOM.channel && /finished/.test(p.text)), 'outcome posted in the ticket thread');
});

test('runRegistered refuses an unknown or busy action and runs with no room', async () => {
  const { a, runs, clock } = setup({ rooms: {} });
  assert.equal((await a.runRegistered({ action: 'nope', ticketId: 'T1', trigger: 'merge-queue' })).reason, 'unknown-action');
  assert.equal((await a.runRegistered({ action: 'test-action', ticketId: 'T9', trigger: 'merge-queue' })).ok, true, 'no Slack room still runs');
  await a.settled();
  clock.t += 60_000;
  assert.equal((await a.runRegistered({ action: 'test-action', ticketId: 'T9', trigger: 'merge-queue' })).reason, 'cooldown');
  assert.equal(runs.length, 1);
});

test('a run started by runRegistered is finished by resume() after a restart', async () => {
  const { stateDir, clock } = setup();
  const cfg = approvalsConfig({ phrase: PHRASE, actions: ACTION });
  const mk = (runAction) => makeApprovals({ stateDir, getConfig: () => cfg, getAllowedUsers: () => [OPERATOR], findRoomByTicket: () => ROOM, post: async () => ({}), runAction, now: () => clock.t });
  const first = mk(() => new Promise(() => {})); // the process dies mid-run
  await first.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'merge-queue' });
  const resumed = [];
  const second = mk(async (def, opts) => { resumed.push(opts); return { ok: true, exitCode: 0, health: null }; });
  await second.resume();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].resume, true);
  assert.equal(readLog(stateDir).at(-1).type, 'run-finished');
});

test('the shipped deploy action takes its checkout and schtasks path from paths.js, not literals', () => {
  const d = approvalsConfig({}).registry['deploy-glmps2'];
  assert.equal(d.repoDir, REPO_ROOT);
  assert.equal(d.file, schtasksExe());
  assert.ok(d.description.includes(REPO_ROOT), d.description);
});

test('schtasksExe follows SystemRoot and falls back to C:\\Windows', () => {
  assert.equal(schtasksExe({ SystemRoot: 'E:\\WinNT' }), 'E:\\WinNT\\System32\\schtasks.exe');
  assert.equal(schtasksExe({}), 'C:\\Windows\\System32\\schtasks.exe');
});

test('the Slack approval request names its deadline in the operator zone, never UTC (card glmps-2-0-runtime-66)', async () => {
  const { setDisplayTimeZone, displayTimeZone } = await import('../../web/shared/time-format.js');
  const before = displayTimeZone();
  try {
    setDisplayTimeZone('America/Los_Angeles');
    const text = requestText({ name: 'deploy', description: 'pull and restart' }, Date.parse('2026-10-26T23:37:00Z'));
    assert.match(text, /before 4:37 PM PT \(15 minutes\)/);
    assert.equal(/UTC|\dZ\b/.test(text), false);
  } finally { setDisplayTimeZone(before); }
});

// glmps-2-0-124: agents may start restart, deploy and rebuild; one action at a time.
test('the shipped registry holds the three agent-runnable ops actions', () => {
  const { registry, errors } = approvalsConfig({});
  assert.deepEqual(errors, []);
  for (const n of ['deploy-glmps2', 'restart-glmps2', 'rebuild-app']) assert.equal(registry[n].agentMayRun, true, n);
  assert.deepEqual(registry['restart-glmps2'].args, ['/Run', '/TN', '\\GLMPS\\restart-glmps2']);
  assert.equal(registry['restart-glmps2'].scheduledTask, '\\GLMPS\\restart-glmps2');
  assert.equal(registry['restart-glmps2'].cooldownMs, 10 * 60_000);
  assert.equal(registry['restart-glmps2'].timeoutMs, 5 * 60_000);
  assert.equal(registry['restart-glmps2'].repoDir, REPO_ROOT);
  assert.deepEqual(registry['rebuild-app'].args, ['/Run', '/TN', '\\GLMPS\\rebuild-app']);
  assert.equal(registry['rebuild-app'].cooldownMs, 30 * 60_000);
  assert.equal(registry['rebuild-app'].timeoutMs, 30 * 60_000);
  assert.equal(registry['rebuild-app'].repoDir, null);
  assert.equal(registry['rebuild-app'].healthUrl, registry['deploy-glmps2'].healthUrl);
});

test('normalizeRegistry keeps agentMayRun and defaults it to false', () => {
  const { registry } = normalizeRegistry({ a: { file: '/bin/x', agentMayRun: true }, b: { file: '/bin/x' }, c: { file: '/bin/x', agentMayRun: 'yes' } });
  assert.deepEqual([registry.a.agentMayRun, registry.b.agentMayRun, registry.c.agentMayRun], [true, false, false]);
});

const TWO = { ...ACTION, 'other-action': { description: 'another', file: '/bin/true', cooldownMinutes: 0, timeoutMinutes: 10, agentMayRun: true } };

test('actionBusy: any running action blocks, a finished one does not, cooldown stays per action', async () => {
  const { a, clock, setConfig } = setup({ actions: TWO });
  setConfig(approvalsConfig({ phrase: PHRASE, actions: TWO }));
  let release;
  const gate = new Promise((r) => { release = r; });
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const b = makeApprovals({
    stateDir, getConfig: () => approvalsConfig({ phrase: PHRASE, actions: TWO }), getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => ROOM, post: async () => ({}), runAction: async () => { await gate; return { ok: true, exitCode: 0, health: null }; }, now: () => clock.t,
  });
  assert.equal((await b.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'x' })).ok, true);
  assert.equal((await b.runRegistered({ action: 'other-action', ticketId: 'T1', trigger: 'x' })).reason, 'another-action-running');
  assert.equal((await b.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'x' })).reason, 'action-running');
  release();
  await b.settled();
  assert.equal((await b.runRegistered({ action: 'other-action', ticketId: 'T1', trigger: 'x' })).ok, true, 'a finished action does not block; other has no cooldown');
  await b.settled();
  assert.equal((await b.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'x' })).reason, 'cooldown');
  assert.ok(a);
});

test('runRegistered with requireAgent refuses an unflagged action and runs a flagged one as trigger agent', async () => {
  const { a, stateDir, runs } = setup({ actions: TWO });
  const no = await a.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'agent', requireAgent: true });
  assert.deepEqual(no, { ok: false, reason: 'not-agent-runnable' });
  assert.equal(refusals(stateDir)[0].reason, 'not-agent-runnable');
  const yes = await a.runRegistered({ action: 'other-action', ticketId: 'T1', trigger: 'agent', requireAgent: true });
  assert.equal(yes.ok, true);
  await a.settled();
  assert.equal(runs.length, 1);
  const log = readLog(stateDir).filter((e) => e.type !== 'refused');
  assert.deepEqual(log.map((e) => e.type), ['request', 'approved', 'run-started', 'run-finished']);
  assert.equal(log[0].trigger, 'agent');
  assert.equal(log[1].user, 'agent');
});

test('the new refusal reasons have operator text', () => {
  assert.ok(REFUSAL_TEXT['another-action-running']);
  assert.ok(REFUSAL_TEXT['not-agent-runnable']);
});

// Card glmps-2-0-135: six merge-queue deploys of a headless card failed with
// nothing posted anywhere, because the run had no Slack thread.
test('a finished run hands its outcome to onFinished, saying whether Slack already got it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const seen = [];
  const failing = makeApprovals({
    stateDir, getConfig: () => approvalsConfig({ phrase: PHRASE, actions: ACTION }), getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => null, post: async () => ({}),
    runAction: async () => ({ ok: false, exitCode: 1, error: 'old server still serving', health: null }),
    onFinished: (r) => seen.push(r), now: () => 1_000_000,
  });
  await failing.runRegistered({ action: 'test-action', ticketId: 'HEADLESS', trigger: 'merge-queue' });
  await failing.settled();
  assert.equal(seen.length, 1);
  assert.deepEqual({ ticketId: seen[0].ticketId, posted: seen[0].posted, ok: seen[0].ok }, { ticketId: 'HEADLESS', posted: false, ok: false });
  assert.match(seen[0].text, /FAILED: old server still serving/);
  const stateDir2 = mkdtempSync(join(tmpdir(), 'approvals-'));
  const withRoom = makeApprovals({
    stateDir: stateDir2, getConfig: () => approvalsConfig({ phrase: PHRASE, actions: ACTION }), getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => ROOM, post: async () => ({}), runAction: async () => ({ ok: true, exitCode: 0, health: null }),
    onFinished: (r) => seen.push(r), now: () => 1_000_000,
  });
  await withRoom.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'merge-queue' });
  await withRoom.settled();
  assert.equal(seen.at(-1).posted, true, 'a run with a thread already posted its outcome');
});

// Batched review glmps-2-0-runtime-145: a rejected outcome post must not count as delivered.
test('a run whose Slack outcome post fails reports posted:false so the devlog fallback runs', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const seen = [];
  const misses = [];
  const a = makeApprovals({
    stateDir, getConfig: () => approvalsConfig({ phrase: PHRASE, actions: ACTION }), getAllowedUsers: () => [OPERATOR],
    findRoomByTicket: () => ROOM,
    post: async ({ text }) => { if (/finished|FAILED/.test(text)) throw new Error('channel_not_found'); return {}; },
    runAction: async () => ({ ok: false, exitCode: 1, error: 'old server still serving', health: null }),
    reportMiss: (...m) => misses.push(m), onFinished: (r) => seen.push(r), now: () => 1_000_000,
  });
  await a.runRegistered({ action: 'test-action', ticketId: 'T1', trigger: 'merge-queue' });
  await a.settled();
  assert.equal(seen.length, 1);
  assert.deepEqual({ ticketId: seen[0].ticketId, posted: seen[0].posted, ok: seen[0].ok }, { ticketId: 'T1', posted: false, ok: false });
  assert.ok(misses.some(([code]) => code === 'approvals-post'), 'the failed post is still reported as a miss');
});

test('finishedRunNotes: a thread-less failure notes the card and its nearest ancestor with a Slack room', () => {
  const items = [{ id: 'child' , parentId: 'mid' }, { id: 'mid', parentId: 'host' }, { id: 'host' }];
  const hasRoom = (id) => id === 'host';
  assert.deepEqual(finishedRunNotes({ ticketId: 'child', posted: false, ok: false, text: ':x: `deploy` FAILED: x.', items, hasRoom }), [
    { id: 'child', text: '`deploy` FAILED: x.' },
    { id: 'host', text: 'card child: `deploy` FAILED: x.' },
  ]);
  assert.deepEqual(finishedRunNotes({ ticketId: 'child', posted: false, ok: true, text: ':white_check_mark: `deploy` finished.', items, hasRoom }), [
    { id: 'child', text: '`deploy` finished.' },
  ], 'a success stays on its own card');
  assert.deepEqual(finishedRunNotes({ ticketId: 'child', posted: true, ok: false, text: 'x', items, hasRoom }), [], 'Slack already has it');
  assert.deepEqual(finishedRunNotes({ ticketId: null, posted: false, ok: false, text: 'x', items, hasRoom }), [], 'a lesson push has no card');
  const loop = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
  assert.deepEqual(finishedRunNotes({ ticketId: 'a', posted: false, ok: false, text: 'x', items: loop, hasRoom: () => false }), [{ id: 'a', text: 'x' }], 'a parent cycle ends');
});

// Card glmps-2-0-170: the one Restart action.
test('restart-all is registered, open to agents, and sized for a rebuild plus a deploy', () => {
  const d = approvalsConfig({}).registry['restart-all'];
  assert.equal(d.agentMayRun, true);
  assert.equal(d.composite, 'restart-all');
  assert.equal(d.cooldownMs, 5 * 60_000);
  assert.equal(d.timeoutMs, 45 * 60_000);
});

function restartAllSetup(runAction) {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  const clock = { t: 1_000_000 };
  const cfg = approvalsConfig({ phrase: PHRASE });
  const a = makeApprovals({ stateDir, getConfig: () => cfg, getAllowedUsers: () => [OPERATOR], findRoomByTicket: () => ROOM, post: async () => ({}), runAction, now: () => clock.t });
  return { a, stateDir, clock, cfg };
}

test('an agent can run restart-all, and it excludes the single actions and itself while running', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { a } = restartAllSetup(async () => { await gate; return { ok: true, exitCode: 0, health: null }; });
  assert.equal((await a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'agent', requireAgent: true })).ok, true);
  assert.equal((await a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'agent', requireAgent: true })).reason, 'action-running');
  for (const other of ['deploy-glmps2', 'restart-glmps2', 'rebuild-app']) {
    assert.equal((await a.runRegistered({ action: other, ticketId: 'T1', trigger: 'merge-queue' })).reason, 'another-action-running', other);
  }
  release();
  await a.settled();
  assert.equal((await a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'agent', requireAgent: true })).reason, 'cooldown');
});

test('a composite run gets its run id, its finished steps and a recorder that writes the ledger', async () => {
  const seen = [];
  const { a, stateDir } = restartAllSetup(async (def, opts) => {
    seen.push(opts);
    opts.recordStep({ step: 'quiesce', status: 'started', ts: 5 });
    opts.recordStep({ step: 'quiesce', status: 'finished', ts: 6 });
    return { ok: true, exitCode: 0, health: null };
  });
  const r = await a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'agent', requireAgent: true });
  await a.settled();
  assert.equal(seen[0].runId, r.id);
  assert.deepEqual(seen[0].steps, []);
  const steps = readLog(stateDir).filter((e) => e.type === 'step');
  assert.deepEqual(steps.map((e) => [e.id, e.step, e.status]), [[r.id, 'quiesce', 'started'], [r.id, 'quiesce', 'finished']]);
});

test('resume continues a composite run from the ledger steps its previous process wrote', async () => {
  const first = restartAllSetup(async (def, opts) => { opts.recordStep({ step: 'quiesce', status: 'finished', ts: 6 }); opts.recordStep({ step: 'update', status: 'started', ts: 7 }); return new Promise(() => {}); });
  await first.a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'operator' });
  const resumed = [];
  const cfg = first.cfg;
  const second = makeApprovals({ stateDir: first.stateDir, getConfig: () => cfg, getAllowedUsers: () => [OPERATOR], findRoomByTicket: () => ROOM, post: async () => ({}), runAction: async (def, opts) => { resumed.push(opts); return { ok: true, exitCode: 0, health: null }; }, now: () => first.clock.t });
  await second.resume();
  assert.equal(resumed[0].resume, true);
  assert.deepEqual(resumed[0].steps.map((e) => [e.step, e.status]), [['quiesce', 'finished'], ['update', 'started']]);
});

test('the outcome post lists what each step did', () => {
  const def = approvalsConfig({}).registry['restart-all'];
  const text = outcomeText(def, { ok: true, exitCode: 0, health: { status: 200, summary: 'up' }, stepsLine: 'update done, rebuild skipped, restart done, verify done' });
  assert.match(text, /^:white_check_mark: `restart-all` finished/);
  assert.match(text, /Steps: update done, rebuild skipped, restart done, verify done\./);
});

// Card glmps-2-0-173: a resumed run that ends without executing still releases the box.
test('resume clears the maintenance hold when it ends a composite run without running it', async () => {
  for (const branch of ['timeout', 'unregistered']) {
    const first = restartAllSetup(async () => new Promise(() => {}));
    const r = await first.a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'operator' });
    beginMaintenance(first.stateDir, { runId: r.id, now: first.clock.t });
    const cfg = branch === 'unregistered' ? approvalsConfig({ phrase: PHRASE, actions: {} }) : first.cfg;
    if (branch === 'unregistered') delete cfg.registry['restart-all'];
    if (branch === 'timeout') first.clock.t += first.cfg.registry['restart-all'].timeoutMs * 2 + 1;
    const second = makeApprovals({ stateDir: first.stateDir, getConfig: () => cfg, getAllowedUsers: () => [OPERATOR], findRoomByTicket: () => ROOM, post: async () => ({}), runAction: async () => { throw new Error('must not run'); }, now: () => first.clock.t });
    await second.resume();
    assert.equal(readLog(first.stateDir).filter((e) => e.type === 'run-finished').length, 1, branch);
    assert.equal(readMaintenance(first.stateDir, first.clock.t), null, `${branch}: the hold is released`);
  }
});

test('an orphaned maintenance hold is released; a hold whose run can still resume is kept', async () => {
  const s = restartAllSetup(async () => new Promise(() => {}));
  const r = await s.a.runRegistered({ action: 'restart-all', ticketId: 'T1', trigger: 'operator' });
  const t = s.clock.t;
  beginMaintenance(s.stateDir, { runId: r.id, now: t });
  const entries = () => readLog(s.stateDir);
  assert.equal(releaseOrphanedMaintenance(s.stateDir, { entries: entries(), resumer: true, bootTs: t + 1, now: t }), false, 'open run, SCUT on: kept');
  assert.ok(readMaintenance(s.stateDir, t));
  assert.equal(releaseOrphanedMaintenance(s.stateDir, { entries: entries(), resumer: false, bootTs: t + 1, now: t }), true, 'no SCUT to resume it: released');
  assert.equal(readMaintenance(s.stateDir, t), null);
  beginMaintenance(s.stateDir, { runId: r.id, now: t });
  const done = [...entries(), { type: 'run-finished', id: r.id, action: 'restart-all', result: { ok: false } }];
  assert.equal(releaseOrphanedMaintenance(s.stateDir, { entries: done, resumer: true, now: t }), true, 'finished run: released');
  assert.equal(readMaintenance(s.stateDir, t), null);
  beginMaintenance(s.stateDir, { runId: 'apr-unknown', now: t });
  assert.equal(releaseOrphanedMaintenance(s.stateDir, { entries: entries(), resumer: true, bootTs: t + 1, now: t }), true, 'a run the ledger never saw: released');
});

test('a hold this process took is its own live run, whatever the ledger says', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'approvals-'));
  beginMaintenance(stateDir, { runId: 'apr-here', now: 2_000 });
  assert.equal(releaseOrphanedMaintenance(stateDir, { entries: [], resumer: false, bootTs: 1_000, now: 2_000 }), false);
  assert.ok(readMaintenance(stateDir, 2_000));
});

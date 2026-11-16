import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diagnoseLoop, streakTitle, loopStreakMessage,
  handleLoopStreak, loadDiagnosisBudget, saveDiagnosisBudget, nextDiagnosisBudget,
  diagnosisStubReason, handleFreshnessExpiry,
} from '../lib/loops/auto-diagnosis.js';
import { CeilingError } from '../lib/loops/registry.js';

const record = { name: 'wiki', consecutiveFailures: 3, lastReason: 'checker:stub build', streakStartTs: 1000,
  recentFailures: [{ ts: 1, reason: 'timeout' }, { ts: 2, reason: 'timeout' }, { ts: 3, reason: 'checker:stub build' }] };
const reply = (content) => async () => ({ choices: [{ message: { content } }] });
const tmpStateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diag-budget-'));

test('files one queued card with the diagnosis and the breach time', async () => {
  const filed = [];
  const r = await diagnoseLoop({ record, logTail: 'line a\nline b', chatCompletion: reply('Cause: X. Fix: Y.'),
    fileCard: async (input) => { filed.push(input); return { item: { id: 'mc-1' }, isNew: true }; }, now: () => 5000 });
  assert.deepEqual(r, { cardId: 'mc-1', created: true });
  assert.equal(filed[0].title, 'Loop wiki failing: checker:stub build');
  assert.equal(filed[0].source, 'loop-diagnosis');
  assert.equal(filed[0].state, 'queued');
  assert.deepEqual(filed[0].origin, { via: 'loop-diagnosis', loop: 'wiki', streakStartTs: 1000 });
  assert.match(filed[0].prompt, /Cause: X\. Fix: Y\./);
  assert.match(filed[0].prompt, /fix it on this card/);
});

test('the model prompt carries the state record, the last three reasons and the log tail', async () => {
  let body;
  await diagnoseLoop({ record, logTail: 'TAIL', chatCompletion: async (b) => { body = b; return { choices: [{ message: { content: 'ok' } }] }; },
    fileCard: async () => ({ item: { id: 'x' }, isNew: true }) });
  const text = body.messages.map((m) => m.content).join('\n');
  assert.match(text, /timeout/); assert.match(text, /checker:stub build/); assert.match(text, /TAIL/);
});

test('a model failure still files the card, saying the diagnosis failed', async () => {
  const filed = [];
  await diagnoseLoop({ record, logTail: '', chatCompletion: async () => { throw new Error('claude CLI unavailable'); },
    fileCard: async (i) => { filed.push(i); return { item: { id: 'x' }, isNew: true }; } });
  assert.match(filed[0].prompt, /Diagnosis failed: claude CLI unavailable/);
});

test('one card per streak: a second call in the same streak dedupes by title', async () => {
  const cards = new Map();
  const fileCard = async (i) => { if (cards.has(i.title)) return { item: cards.get(i.title), isNew: false }; const item = { id: `c${cards.size}` }; cards.set(i.title, item); return { item, isNew: true }; };
  const a = await diagnoseLoop({ record, logTail: '', chatCompletion: reply('x'), fileCard });
  const b = await diagnoseLoop({ record, logTail: '', chatCompletion: reply('x'), fileCard });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.cardId, b.cardId);
});

test('streak message and title are stable one-liners', () => {
  assert.equal(streakTitle(record), 'Loop wiki failing: checker:stub build');
  assert.equal(loopStreakMessage(record), 'Loop wiki failed 3 times in a row: checker:stub build. A diagnosis card is being filed for triage.');
});


test('loadDiagnosisBudget on a missing file returns a fresh budget, no throw, no log', () => {
  const logs = [];
  const budget = loadDiagnosisBudget(tmpStateDir(), { log: (m) => logs.push(m) });
  assert.deepEqual(budget, { day: '', n: 0 });
  assert.deepEqual(logs, [], 'a missing file on first boot is expected, not an error');
});

test('saveDiagnosisBudget then loadDiagnosisBudget round-trips { day, n }', () => {
  const stateDir = tmpStateDir();
  saveDiagnosisBudget(stateDir, { day: '2026-09-28', n: 4 });
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 4 });
  // the file is where the loop registry already keeps its own per-loop state
  assert.ok(fs.existsSync(path.join(stateDir, 'loops', 'diagnosis-budget.json')));
});

test('loadDiagnosisBudget on a corrupt file logs a reason and returns a fresh budget', () => {
  const stateDir = tmpStateDir();
  fs.mkdirSync(path.join(stateDir, 'loops'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'loops', 'diagnosis-budget.json'), '{ not json');
  const logs = [];
  const budget = loadDiagnosisBudget(stateDir, { log: (m) => logs.push(m) });
  assert.deepEqual(budget, { day: '', n: 0 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /diagnosis-budget/);
});

// nextDiagnosisBudget: handleLoopStreak's own
// budget-check-and-increment, extracted so a second caller (the
// obligation-sweeper's expiry diagnosis) draws from the exact same
// persisted counter rather than a second, independently-drifting one. ---

test('nextDiagnosisBudget: within the ceiling, consumes one slot and reports not-over-ceiling', () => {
  const stateDir = tmpStateDir();
  const r = nextDiagnosisBudget({ stateDir, cfg: { maxPerDay: 3 }, now: () => Date.parse('2026-09-28T12:00:00Z') });
  assert.deepEqual(r, { overCeiling: false });
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 1 });
});

test('nextDiagnosisBudget: at the ceiling, reports over-ceiling and does not consume a slot', () => {
  const stateDir = tmpStateDir();
  saveDiagnosisBudget(stateDir, { day: '2026-09-28', n: 3 });
  const r = nextDiagnosisBudget({ stateDir, cfg: { maxPerDay: 3 }, now: () => Date.parse('2026-09-28T12:00:00Z') });
  assert.deepEqual(r, { overCeiling: true });
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 3 }, 'the counter does not advance once over ceiling');
});

test('nextDiagnosisBudget: a fresh UTC day resets the counter before checking the ceiling', () => {
  const stateDir = tmpStateDir();
  saveDiagnosisBudget(stateDir, { day: '2020-01-01', n: 3 });
  const r = nextDiagnosisBudget({ stateDir, cfg: { maxPerDay: 3 }, now: () => Date.parse('2026-09-28T12:00:00Z') });
  assert.deepEqual(r, { overCeiling: false });
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 1 });
});

test('nextDiagnosisBudget: repeated calls in the same tick consume one slot each, in order', () => {
  const stateDir = tmpStateDir();
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  const results = [];
  for (let i = 0; i < 5; i++) results.push(nextDiagnosisBudget({ stateDir, cfg: { maxPerDay: 3 }, now }).overCeiling);
  assert.deepEqual(results, [false, false, false, true, true]);
});

test('nextDiagnosisBudget: a save failure is logged with the given label, never thrown', () => {
  const stateDir = tmpStateDir();
  fs.mkdirSync(path.join(stateDir, 'loops'), { recursive: true });
  // Block the write by occupying the target path with a directory.
  fs.mkdirSync(path.join(stateDir, 'loops', 'diagnosis-budget.json'));
  const logs = [];
  const r = nextDiagnosisBudget({ stateDir, cfg: { maxPerDay: 3 }, now: () => Date.parse('2026-09-28T12:00:00Z'), label: 'wiki', log: (m) => logs.push(m) });
  assert.equal(r.overCeiling, false, 'a persistence failure never blocks the diagnosis itself');
  assert.ok(logs.some((m) => /diagnosis budget save failed wiki/.test(m)));
});

// diagnosisStubReason: the shared
// three-gate decision (disabled, this run's own ceiling, the persisted
// daily budget) both the obligation-sweeper wiring and, eventually, any
// other diagnosis-triggering caller share. Returns the stub reason string
// for diagnoseLoop's chatCompletion, or null when a real call is allowed. ---

test('diagnosisStubReason: disabled short-circuits before touching the ceiling or the budget', () => {
  const stateDir = tmpStateDir();
  const ctx = { countModelCall() { throw new Error('must not be called when disabled'); } };
  const r = diagnosisStubReason({ ctx, stateDir, cfg: { enabled: false, maxPerDay: 3 } });
  assert.match(r, /disabled/);
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '', n: 0 }, 'the persisted budget is untouched when disabled');
});

test('diagnosisStubReason: a CeilingError from ctx.countModelCall() stubs without ever consulting the daily budget', () => {
  const stateDir = tmpStateDir();
  const ctx = { countModelCall() { throw new CeilingError('ceiling:model-calls'); } };
  const r = diagnosisStubReason({ ctx, stateDir, cfg: { enabled: true, maxPerDay: 3 }, now: () => Date.parse('2026-09-28T12:00:00Z') });
  assert.match(r, /ceiling/);
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '', n: 0 }, 'the daily budget slot is never spent on a run-ceiling breach');
});

test('diagnosisStubReason: never a bare catch - an unexpected (non-CeilingError) throw from ctx.countModelCall() propagates', () => {
  const stateDir = tmpStateDir();
  const ctx = { countModelCall() { throw new Error('some unrelated bug'); } };
  assert.throws(
    () => diagnosisStubReason({ ctx, stateDir, cfg: { enabled: true, maxPerDay: 3 } }),
    /some unrelated bug/,
  );
});

test('diagnosisStubReason: no ctx skips the run-ceiling check entirely and falls straight to the daily budget', () => {
  const stateDir = tmpStateDir();
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  assert.equal(diagnosisStubReason({ ctx: null, stateDir, cfg: { enabled: true, maxPerDay: 3 }, now }), null);
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 1 }, 'the daily budget still gets consumed');
});

test('diagnosisStubReason: under the daily budget, returns null (a real call is allowed) and consumes one slot', () => {
  const stateDir = tmpStateDir();
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  const ctx = { countModelCall() {} };
  assert.equal(diagnosisStubReason({ ctx, stateDir, cfg: { enabled: true, maxPerDay: 3 }, now, label: 'row1' }), null);
  assert.deepEqual(loadDiagnosisBudget(stateDir), { day: '2026-09-28', n: 1 });
});

test('diagnosisStubReason: over the daily budget, stubs with the daily-ceiling reason', () => {
  const stateDir = tmpStateDir();
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  saveDiagnosisBudget(stateDir, { day: '2026-09-28', n: 3 });
  const ctx = { countModelCall() {} };
  const r = diagnosisStubReason({ ctx, stateDir, cfg: { enabled: true, maxPerDay: 3 }, now });
  assert.match(r, /daily ceiling reached/);
});

// the daily budget must be PEEKED
// before ctx.countModelCall() is ever touched, not after. The previous
// order called ctx.countModelCall() first for every eligible row
// regardless of the budget, so a burst of budget-exhausted rows alone
// could spend the run's own ceiling with zero real model calls made. An
// already-over-budget row must never reach ctx.countModelCall() at all.
test('diagnosisStubReason: over the daily budget, ctx.countModelCall() is never called - the budget is peeked before the run ceiling', () => {
  const stateDir = tmpStateDir();
  const now = () => Date.parse('2026-09-28T12:00:00Z');
  saveDiagnosisBudget(stateDir, { day: '2026-09-28', n: 3 });
  const ctx = { countModelCall() { throw new Error('must not be called: the daily budget was already exhausted'); } };
  const r = diagnosisStubReason({ ctx, stateDir, cfg: { enabled: true, maxPerDay: 3 }, now });
  assert.match(r, /daily ceiling reached/);
});


function fixture(overrides = {}) {
  const filed = [];
  const posted = [];
  const calls = { chatCompletion: 0 };
  return {
    stateDir: tmpStateDir(),
    cfg: { enabled: true, maxPerDay: 10, project: 'glmps' },
    chatCompletion: async () => { calls.chatCompletion += 1; return { choices: [{ message: { content: 'Cause: X. Fix: Y.' } }] }; },
    fileCard: async (input) => { filed.push(input); return { item: { id: `c${filed.length}` }, isNew: true }; },
    postToOperator: async (text) => { posted.push(text); },
    log: () => {},
    now: () => Date.parse('2026-09-28T12:00:00Z'),
    filed, posted, calls,
    ...overrides,
  };
}

test('ceiling reached: no model call, but the card still files with the ceiling reason', async () => {
  const f = fixture({ cfg: { enabled: true, maxPerDay: 1, project: 'glmps' } });
  saveDiagnosisBudget(f.stateDir, { day: '2026-09-28', n: 1 }); // already at the cap for today
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.calls.chatCompletion, 0, 'the real model must never be called once over the daily ceiling');
  assert.equal(f.filed.length, 1, 'the card still files even when the diagnosis is skipped');
  assert.match(f.filed[0].prompt, /diagnosis skipped: daily ceiling reached/);
});

test('UTC day rollover resets the ceiling', async () => {
  const f = fixture({ cfg: { enabled: true, maxPerDay: 1, project: 'glmps' } });
  saveDiagnosisBudget(f.stateDir, { day: '2020-01-01', n: 1 }); // stale day, at yesterday's cap
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.calls.chatCompletion, 1, 'a new UTC day resets the counter, so the model is called again');
  assert.deepEqual(loadDiagnosisBudget(f.stateDir), { day: '2026-09-28', n: 1 });
});

test('the ceiling persists across separate calls (a restart reloads it from disk, never from memory)', async () => {
  const f = fixture({ cfg: { enabled: true, maxPerDay: 1, project: 'glmps' } });
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.calls.chatCompletion, 1, 'first call of the day: under the cap');
  // A different loop: the same loop inside the dedupe window would now be
  // one outage, one card, not a second streak.
  await handleLoopStreak({ name: 'wiki2', record: { ...record, name: 'wiki2' }, ...f });
  assert.equal(f.calls.chatCompletion, 1, 'second call: over the cap, no second model call');
  assert.equal(f.filed.length, 2, 'both streaks still file a card');
});

test('SCUT unconfigured: a logged no-op, and the diagnosis card still files', async () => {
  const logs = [];
  const f = fixture({ postToOperator: undefined, log: (m) => logs.push(m) });
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.posted.length, 0);
  assert.ok(logs.some((m) => /SCUT not configured/.test(m)), `expected a named-reason log, got: ${JSON.stringify(logs)}`);
  assert.equal(f.filed.length, 1, 'the diagnosis card is independent of the Slack post');
});

test('a Slack post failure is a named, logged miss - never a crash, and the card still files', async () => {
  const logs = [];
  const f = fixture({ postToOperator: async () => { throw new Error('no SCUT channel'); }, log: (m) => logs.push(m) });
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.ok(logs.some((m) => /no SCUT channel/.test(m)));
  assert.equal(f.filed.length, 1);
});

test('project is the configured value', async () => {
  const f = fixture({ cfg: { enabled: true, maxPerDay: 10, project: 'glmps2-runtime' } });
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.filed[0].project, 'glmps2-runtime');
});

test('diagnosis.enabled: false skips the card (and the model) entirely, but the Slack post still happens', async () => {
  const f = fixture({ cfg: { enabled: false, maxPerDay: 10, project: 'glmps' } });
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.calls.chatCompletion, 0);
  assert.equal(f.filed.length, 0);
  assert.equal(f.posted.length, 1);
});

// Phase K final review I2: a freshness expiry is not a failure streak. The
// card used to say "has failed 0 consecutive runs" for a loop that simply
// never ran; it must name the expiry instead.
test('I2: a freshness-expiry card names the expired obligation, never "failed 0 consecutive runs"', async () => {
  const filed = [];
  const fresh = { name: 'git-remote-feed', consecutiveFailures: 0, lastReason: null, streakStartTs: null, lastOkTs: null, recentFailures: [] };
  await diagnoseLoop({ record: fresh, expiry: { obligationId: 'obl_1', dueTs: Date.UTC(2026, 0, 2) }, chatCompletion: reply('Cause: X.'),
    fileCard: async (input) => { filed.push(input); return { item: { id: 'mc-9' }, isNew: true }; }, now: () => Date.UTC(2026, 0, 3) });
  assert.doesNotMatch(filed[0].prompt, /failed 0 consecutive/);
  assert.match(filed[0].prompt, /freshness obligation obl_1 expired/);
  assert.match(filed[0].prompt, /2026-01-02T00:00:00\.000Z/);
  assert.match(filed[0].prompt, /last successful run: never/);
  assert.equal(filed[0].origin.obligationId, 'obl_1');
});

const expiryCfg = { enabled: true, maxPerDay: 10, project: 'p' };
function cardSink() {
  const filed = [];
  return { filed, fileCard: async (input) => { filed.push(input); return { item: { id: `mc-${filed.length}` }, isNew: true }; } };
}
const row = (subject, id = `obl_${subject}`) => ({ id, kind: 'loop.freshness', subject, dueTs: 1000 });

test('a freshness card files into the configured project, the same column as a streak card', async () => {
  const sink = cardSink();
  await handleFreshnessExpiry({ row: row('wiki'), record, ctx: null, stateDir: tmpStateDir(), cfg: expiryCfg,
    chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 10_000 });
  assert.equal(sink.filed[0].project, 'p');
});

// Phase K final review minor: one outage of one loop files one card, whichever
// path (a failure streak or a freshness expiry) reaches it first within the
// dedupe window.
test('I2 dedupe: a streak card then a freshness expiry for the same loop within the window files one card and makes one model call', async () => {
  const stateDir = tmpStateDir(); const sink = cardSink(); let calls = 0;
  const chat = async () => { calls += 1; return { choices: [{ message: { content: 'diag' } }] }; };
  await handleLoopStreak({ name: 'wiki', record, stateDir, cfg: expiryCfg, chatCompletion: chat, fileCard: sink.fileCard, now: () => 10_000 });
  const r = await handleFreshnessExpiry({ row: row('wiki'), record: { ...record, consecutiveFailures: 0 }, ctx: null, stateDir, cfg: expiryCfg,
    chatCompletion: chat, fileCard: sink.fileCard, now: () => 20_000 });
  assert.equal(sink.filed.length, 1, 'one card for one outage');
  assert.equal(calls, 1);
  assert.equal(r.deduped, true);
});

test('I2 dedupe: a freshness card then a streak for the same loop within the window files one card', async () => {
  const stateDir = tmpStateDir(); const sink = cardSink(); const logs = [];
  await handleFreshnessExpiry({ row: row('wiki'), record, ctx: null, stateDir, cfg: expiryCfg, chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 10_000 });
  await handleLoopStreak({ name: 'wiki', record, stateDir, cfg: expiryCfg, chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 20_000, log: (m) => logs.push(m) });
  assert.equal(sink.filed.length, 1);
  assert.ok(logs.some((m) => /deduped/.test(m)), `the skipped card is logged with a reason: ${JSON.stringify(logs)}`);
});

test('I2 dedupe: outside the window, or for a different loop, a second card is filed', async () => {
  const stateDir = tmpStateDir(); const sink = cardSink();
  const cfg = { ...expiryCfg, dedupeWindowMs: 1000 };
  await handleFreshnessExpiry({ row: row('wiki'), record, ctx: null, stateDir, cfg, chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 10_000 });
  await handleFreshnessExpiry({ row: row('other'), record: { ...record, name: 'other' }, ctx: null, stateDir, cfg, chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 10_500 });
  await handleLoopStreak({ name: 'wiki', record, stateDir, cfg, chatCompletion: reply('d'), fileCard: sink.fileCard, now: () => 12_000 });
  assert.equal(sink.filed.length, 3);
});

// Phase K final review minor (sweeper ceiling vs sequential diagnoses):
// RULING TAKEN - cap real diagnoses at one per sweep. The rest file a stub
// card with no model call and keep climbing the escalation ladder, so a
// sweep's wall-clock is bounded by one claude -p call (120 s), under the
// sweeper's own timeout.
test('I2 cap: one real model diagnosis per sweep; the second expiry in the same sweep files a stub card with no model call', async () => {
  const stateDir = tmpStateDir(); const sink = cardSink(); let calls = 0;
  const chat = async () => { calls += 1; return { choices: [{ message: { content: 'diag' } }] }; };
  const ctx = { countModelCall() {} };
  await handleFreshnessExpiry({ row: row('a'), record: { ...record, name: 'a' }, ctx, stateDir, cfg: expiryCfg, chatCompletion: chat, fileCard: sink.fileCard });
  await handleFreshnessExpiry({ row: row('b'), record: { ...record, name: 'b' }, ctx, stateDir, cfg: expiryCfg, chatCompletion: chat, fileCard: sink.fileCard });
  assert.equal(calls, 1);
  assert.equal(sink.filed.length, 2);
  assert.match(sink.filed[1].prompt, /one model diagnosis per sweep/);
  const other = { countModelCall() {} };
  await handleFreshnessExpiry({ row: row('c'), record: { ...record, name: 'c' }, ctx: other, stateDir, cfg: expiryCfg, chatCompletion: chat, fileCard: sink.fileCard });
  assert.equal(calls, 2, 'a new sweep (a new ctx) gets its own one diagnosis');
});

// glmps-2-0-128: a usage-limit failure is the account, not the loop; no card, no model call, no budget.
const limitRecord = { ...record, lastReason: "You've hit your org's monthly usage limit" };

test('usage limit streak: no card, no model call, no budget spent, Slack post still sent, skip logged', async () => {
  const logs = [];
  const f = fixture({ log: (m) => logs.push(m) });
  await handleLoopStreak({ name: 'wiki', record: limitRecord, ...f });
  assert.equal(f.filed.length, 0);
  assert.equal(f.calls.chatCompletion, 0);
  assert.equal(f.posted.length, 1);
  assert.equal(loadDiagnosisBudget(f.stateDir).n, 0);
  assert.ok(logs.some((m) => /usage limit/.test(m)), JSON.stringify(logs));
});

test('usage limit freshness expiry: no card, no model call', async () => {
  const sink = cardSink(); let calls = 0;
  const chat = async () => { calls += 1; return { choices: [{ message: { content: 'd' } }] }; };
  const out = await handleFreshnessExpiry({ row: row('wiki'), record: limitRecord, ctx: null, stateDir: tmpStateDir(),
    cfg: expiryCfg, chatCompletion: chat, fileCard: sink.fileCard });
  assert.equal(sink.filed.length, 0);
  assert.equal(calls, 0);
  assert.equal(out.skipped, 'usage-limit');
});

test('usage limit in the newest recent failure also skips the card', async () => {
  const f = fixture();
  const rec = { ...record, lastReason: 'timeout', recentFailures: [{ ts: 1, reason: 'timeout' }, { ts: 2, reason: 'Claude AI usage limit: you hit your limit' }] };
  await handleLoopStreak({ name: 'wiki', record: rec, ...f });
  assert.equal(f.filed.length, 0);
});

test('a normal failure still files a card with the triage-and-fix-here line', async () => {
  const f = fixture();
  await handleLoopStreak({ name: 'wiki', record, ...f });
  assert.equal(f.filed.length, 1);
  assert.match(f.filed[0].prompt, /Confirm the cause, then fix it on this card\. File a separate card only if the fix belongs to a different repo or needs an operator decision\./);
});

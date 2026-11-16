// server/test/finalize-sweep.test.js
//
// GLMPS 2.0 shadow-instance plan, Task 1: production's Stop hook only pings
// port 8123, so a second, isolated instance (the 2.0 shadow) never receives
// POST /api/outcomes/finalize for any of its own sessions. pickSessionsToFinalize
// is the pure eligibility rule a periodic sweep uses instead: a session
// qualifies once it has gone idle idleMs past its last activity, has at least
// one event, and has neither an outcome row nor a queued judge job yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickSessionsToFinalize, runFinalizeSweep } from '../lib/evaluation/finalize-sweep.js';
import { startServer, mergeFinalizeSweepConfig } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function isolatedEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_MODEL_RUNNER: 'off',
    GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_CLAUDE_DIR: tmp('mc-fs-claude-'),
    GLMPS_ANTIGRAVITY_DIR: tmp('mc-fs-ag-'),
    GLMPS_GEMINI_TMP_DIR: tmp('mc-fs-gemini-'),
    GLMPS_VSCODE_STORAGE_DIR: tmp('mc-fs-vscode-'),
    GLMPS_AGY_CLI_DIR: tmp('mc-fs-agy-'),
    GLMPS_CODEX_DIR: tmp('mc-fs-codex-'),
    GLMPS_COPILOT_CLI_DIR: tmp('mc-fs-copilot-'),
    GLMPS_HERMES_DIR: tmp('mc-fs-hermes-'),
    GLMPS_OPENCODE_DIR: tmp('mc-fs-opencode-'),
    ...extra,
  };
}

function baseSession(overrides = {}) {
  return { sessionId: 's1', lastActivityTs: 0, eventCount: 1, ...overrides };
}

test('pickSessionsToFinalize excludes an active session (idle < idleMs)', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [baseSession({ lastActivityTs: now - idleMs + 1 })]; // idle just under the threshold
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, []);
});

test('pickSessionsToFinalize includes an idle session with no outcome row and no judge job', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [baseSession({ lastActivityTs: now - idleMs })]; // exactly at the threshold
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, ['s1']);
});

test('pickSessionsToFinalize excludes an idle session that already has an outcome row', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [baseSession({ lastActivityTs: now - idleMs })];
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs,
    hasOutcomeRow: () => true,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, []);
});

test('pickSessionsToFinalize excludes an idle session that already has a queued judge job', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [baseSession({ lastActivityTs: now - idleMs })];
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => true,
  });
  assert.deepEqual(picked, []);
});

test('pickSessionsToFinalize excludes a session with zero events', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [baseSession({ lastActivityTs: now - idleMs, eventCount: 0 })];
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, []);
});

test('pickSessionsToFinalize excludes a session older than maxAgeMs (fresh shadow state must not mass-finalize history)', () => {
  const now = 100_000_000;
  const idleMs = 10_000;
  const maxAgeMs = 1_000_000;
  const sessions = [baseSession({ lastActivityTs: now - maxAgeMs - 1 })]; // idle, but past the age cap
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs, maxAgeMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, []);
});

test('pickSessionsToFinalize includes a session within maxAgeMs (idle but not historical)', () => {
  const now = 100_000_000;
  const idleMs = 10_000;
  const maxAgeMs = 1_000_000;
  const sessions = [baseSession({ lastActivityTs: now - maxAgeMs })]; // exactly at the age-cap boundary
  const picked = pickSessionsToFinalize({
    sessions, now, idleMs, maxAgeMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
  });
  assert.deepEqual(picked, ['s1']);
});

//
// finalizeSweepTick used to wrap the whole
// per-session loop in one try/catch, so one throwing session skipped every
// later one in the tick (and could starve them forever). runFinalizeSweep
// isolates each finalizeAndQueueJudge call in its own try/catch, matching
// runRetryTick's per-job isolation in server/lib/plugins/memory-plugin.js.
test('runFinalizeSweep isolates a throwing session: a later due session still gets finalized', () => {
  const now = 100_000;
  const idleMs = 10_000;
  const sessions = [
    baseSession({ sessionId: 'a', lastActivityTs: now - idleMs }),
    baseSession({ sessionId: 'b', lastActivityTs: now - idleMs }),
  ];
  const calls = [];
  const errors = [];
  const finalizeAndQueueJudge = (sid, opts) => {
    calls.push({ sid, opts });
    if (sid === 'a') throw new Error('boom');
    return { row: { id: `session-${sid}` }, appended: true };
  };
  const due = runFinalizeSweep({
    sessions, now, idleMs,
    hasOutcomeRow: () => false,
    hasJudgeJob: () => false,
    finalizeAndQueueJudge,
    onError: (sid, e) => errors.push({ sid, message: e.message }),
  });
  assert.deepEqual(due, ['a', 'b']);
  // b was still attempted (and, per the fake, succeeded) despite a throwing first.
  assert.deepEqual(calls.map((c) => c.sid), ['a', 'b']);
  assert.deepEqual(errors, [{ sid: 'a', message: 'boom' }]);
});

//
// a config.json that sets only `outcomes.finalizeSweep.enabled`
// must not wipe the tickMs/maxAgeMs defaults out from under it (Object.assign at the
// top of startServer is shallow and would otherwise replace the whole sub-object).
// Cheap: pure function, no server boot.
test('mergeFinalizeSweepConfig: a partial finalizeSweep block (enabled only) keeps the tickMs/maxAgeMs defaults', () => {
  const merged = mergeFinalizeSweepConfig({ finalizeSweep: { enabled: true } });
  assert.deepEqual(merged.finalizeSweep, { enabled: true, tickMs: 300000, maxAgeMs: 86400000 });
});

test('mergeFinalizeSweepConfig: an explicit tickMs/maxAgeMs override is honored, not clobbered by the defaults', () => {
  const merged = mergeFinalizeSweepConfig({ finalizeSweep: { enabled: true, tickMs: 111, maxAgeMs: 222 } });
  assert.deepEqual(merged.finalizeSweep, { enabled: true, tickMs: 111, maxAgeMs: 222 });
});

test('mergeFinalizeSweepConfig: an absent outcomes block still yields full finalizeSweep defaults', () => {
  const merged = mergeFinalizeSweepConfig();
  assert.deepEqual(merged.finalizeSweep, { enabled: false, tickMs: 300000, maxAgeMs: 86400000 });
});

test('mergeFinalizeSweepConfig: sibling keys on outcomes survive alongside finalizeSweep', () => {
  const merged = mergeFinalizeSweepConfig({ otherOutcomeKey: 'x' });
  assert.equal(merged.otherOutcomeKey, 'x');
  assert.deepEqual(merged.finalizeSweep, { enabled: false, tickMs: 300000, maxAgeMs: 86400000 });
});

//
// A shadow instance (port 8124) never receives a Stop-hook ping, so this
// sweep is its ONLY path to a finalized outcome row + queued judge job. Same
// isolatedEnv/GLMPS_MODEL_RUNNER=off pattern as model-runner-disabled.test.js's
// finalize test, so the judge job's eventual failure (no real `claude -p`
// spawn) lands on plugin health instead of hanging or spawning for real.
// finalizeSweepTick is exposed on the server handle (matching the older
// runGepaOnce/pluginRetryTick "deterministic test" convention, since
// retired) so this test calls it directly rather than waiting on the real
// interval; the plugin-retry loop is driven the same way through
// h.loopRegistry.runNow('plugin-retry').
test('finalize sweep: an idle seeded session gets exactly one outcome row and one due judge job; a second tick adds nothing', async () => {
  const stateDir = tmp('mc-finalize-sweep-');
  const env = isolatedEnv(stateDir);
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    outcomes: { finalizeSweep: { enabled: true, tickMs: 25 } },
    plugins: { judge: { idleMs: 0 } }, // idle threshold: any past activity already qualifies
  }));
  const h = await startServer({ port: 0, env, configFile });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const otlp = {
      resourceSpans: [{
        resource: { attributes: [] },
        scopeSpans: [{
          spans: [{
            attributes: [
              { key: 'session.id', value: { stringValue: 'sweepme' } },
              { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
            ],
            startTimeUnixNano: String(Date.now() * 1e6),
          }],
        }],
      }],
    };
    const ingest = await fetch(base + '/api/otel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp),
    });
    assert.equal(ingest.status, 200);

    await h.finalizeSweepTick();

    const outcomesAfterFirst = await (await fetch(base + '/api/outcomes')).json();
    assert.equal(outcomesAfterFirst.outcomes.length, 1);
    assert.equal(outcomesAfterFirst.outcomes[0].id, 'session-otel:sweepme');

    const verdictsRoute = await (await fetch(base + '/api/judge/verdicts')).json();
    assert.deepEqual(verdictsRoute.verdicts, []); // not judged yet, only queued

    // Run the plugin-retry loop to confirm the queued job is
    // actually due (notBefore <= now), not just present: it takes the one
    // job and bumps it (GLMPS_MODEL_RUNNER=off fails the judge call). Fix
    // the tick itself now FAILS whenever anything was bumped,
    // naming the job's own reason - the alert stays up for the whole
    // outage, not just once the retry budget is exhausted.
    const retryResult = await h.loopRegistry.runNow('plugin-retry');
    assert.equal(retryResult.outcome, 'failed');
    assert.match(retryResult.reason, /judge\.session/);

    // Second sweep tick: the session already has an outcome row, so nothing
    // new is added (and finalize is idempotent about it).
    await h.finalizeSweepTick();
    const outcomesAfterSecond = await (await fetch(base + '/api/outcomes')).json();
    assert.equal(outcomesAfterSecond.outcomes.length, 1);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// finalizeAndQueueJudge read events only from the
// in-memory eventLog Map, which is empty for any session idle beyond
// ACTIVE_WINDOW after a restart (the exact situation the sweep exists for -
// no Stop ping ever repopulates it). That wrote a permanently empty outcome
// row, and hasOutcomeRow then locked the session out of ever being finalized
// correctly. These two tests seed ONLY the durable state a restart would
// leave behind (state/index.json + events/log.ndjson) - no OTLP ingest, so
// the in-memory eventLog genuinely has nothing for the session - matching
// the fix's real trigger exactly.
test('finalize sweep: a session with durable events but no in-memory eventLog entry gets a row built from them', async () => {
  const stateDir = tmp('mc-finalize-sweep-durable-');
  const env = isolatedEnv(stateDir);
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: { judge: { idleMs: 0 } } }));

  const ts = Date.now() - 60_000; // well past idleMs:0, comfortably inside the default 24h maxAgeMs
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'), JSON.stringify([
    { id: 'durable-only', lastTs: ts, eventCount: 1 },
  ]));
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'events', 'log.ndjson'), JSON.stringify({
    kind: 'tool', tool: 'user', label: 'User: durable hello', ts, sessionId: 'durable-only',
  }) + '\n');

  const h = await startServer({ port: 0, env, configFile });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    await h.finalizeSweepTick();
    const outcomes = await (await fetch(base + '/api/outcomes')).json();
    const row = outcomes.outcomes.find((r) => r.id === 'session-durable-only');
    assert.ok(row, 'expected a row for the durable-only session');
    // Both fields are only non-null/non-zero when the row was built from the
    // real durable event, not from an empty array (row.ts would be null and
    // row.turns would be 0 if finalizeAndQueueJudge had fallen back to []).
    assert.equal(row.ts, ts);
    assert.equal(row.turns, 1);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('finalize sweep: a session with no events anywhere (in-memory or durable) is skipped, not finalized empty', async () => {
  const stateDir = tmp('mc-finalize-sweep-noevents-');
  const env = isolatedEnv(stateDir);
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: { judge: { idleMs: 0 } } }));

  // Index claims eventCount:1 (so pickSessionsToFinalize considers it due),
  // but there is no matching durable event-log line and nothing was ever
  // ingested this boot - simulates a lost/never-flushed durable write racing
  // the sweep, which must never be papered over with an empty outcome row.
  const ts = Date.now() - 60_000;
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'), JSON.stringify([
    { id: 'ghost-session', lastTs: ts, eventCount: 1 },
  ]));

  const h = await startServer({ port: 0, env, configFile });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    await h.finalizeSweepTick();
    const outcomes = await (await fetch(base + '/api/outcomes')).json();
    assert.equal(outcomes.outcomes.find((r) => r.id === 'session-ghost-session'), undefined);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

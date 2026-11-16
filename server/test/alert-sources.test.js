// server/test/alert-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAlerts, attachEvidence } from '../lib/observability/alert-sources.js';
import { ack, applyAcks, loadAcks } from '../lib/observability/alert-acks.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// K Task 6: the pre-D23 consecutive-failure block (Mem0, embed, judge, GEPA,
// the retry queue) that used to live here is deleted. The four registered
// loops' own failures are now rendered through loopAlerts (server/lib/loops/
// loop-health.js) - see loop-health.test.js and plugin-loops.test.js. The
// signals that have no registered loop of their own (a memory lookup, a
// migrate run, gate-obligation-open, a corrupt retry-queue line, a
// finalize-sweep tick, the judge plugin failing to load, and the mem0/gepa
// quarantine + dead-letter counts) are restored below through the kernel-health block further down this file.

test('concurrent-writers groups become one warn alert per shared tree (2+ only)', () => {
  const alerts = collectAlerts({ concurrentWriters: [
    { cwd: 'D:/glmps', sessions: [{ id: 's1' }, { id: 's2' }] },
    { cwd: 'D:/mc/.claude/worktrees/agent-1', sessions: [{ id: 'x' }] }, // <2 ids -> ignored
  ] });
  const cw = alerts.filter(a => a.source === 'concurrent-writers');
  assert.equal(cw.length, 1);
  assert.equal(cw[0].severity, 'warn');
  assert.match(cw[0].title, /2 sessions sharing one working tree/);
  assert.match(cw[0].detail, /s1, s2/);
  assert.deepEqual(cw[0].target, { view: 'sessions', id: 's1' });
});

test('attachEvidence: session-linked egress alert gets the flagged file diff', () => {
  const egress = [{ path: 'D:/x/secret.env', reason: 'secret', severity: 'critical', sessionId: 's1' }];
  const [alert] = collectAlerts({ egress });
  const events = [
    { sessionId: 's1', op: 'write', path: 'D:/x/secret.env', change: { new: { text: 'KEY=1' } }, ts: 5, tool: 'claude' },
    { sessionId: 's1', op: 'write', path: 'D:/x/other.js', change: { new: { text: 'z' } }, ts: 4 },
    { sessionId: 's2', op: 'write', path: 'D:/x/secret.env', change: { new: { text: 'no' } }, ts: 3 },
  ];
  const [withEv] = attachEvidence([alert], events);
  assert.equal(withEv.evidence.length, 1, 'only the flagged path in the right session');
  assert.equal(withEv.evidence[0].path, 'D:/x/secret.env');
  assert.ok(withEv.evidence[0].change);
});

test('attachEvidence: non-session alerts get an empty evidence list', () => {
  const [alert] = collectAlerts({ quarantined: [{ id: 'q1', title: 'T', flags: ['x'] }] });
  const [withEv] = attachEvidence([alert], []);
  assert.deepEqual(withEv.evidence, []);
});


test('collectAlerts: poison-quarantined tickets -> ranked alerts (critical vs warn)', () => {
  const alerts = collectAlerts({
    quarantined: [
      { id: 'glmps-9', title: 'Do X', flags: ['exfiltration'], critical: true, ts: 5 },
      { id: 'glmps-8', title: 'Do Y', flags: ['bare-url'], critical: false, ts: 3 },
    ],
  });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].severity, 'critical'); // ranked first
  assert.equal(alerts[0].source, 'poison');
  assert.ok(alerts[0].title.includes('Do X'));
  assert.deepEqual(alerts[0].target, { view: 'kanban', id: 'glmps-9' });
  assert.equal(alerts[1].severity, 'warn');
});

test('collectAlerts: capture coverage below threshold -> warn alerts; above -> none', () => {
  const alerts = collectAlerts({
    coverage: { byTool: { 'gemini-cli': 0.44, 'claude-code': 0.94 } },
    coverageThreshold: 0.5,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'capture');
  assert.equal(alerts[0].severity, 'warn');
  assert.ok(alerts[0].title.includes('gemini-cli'));
  assert.equal(alerts[0].target.tool, 'gemini-cli');
});

test('collectAlerts: combined + ranked (critical poison before capture warn)', () => {
  const alerts = collectAlerts({
    quarantined: [{ id: 'q1', title: 'bad', flags: ['x'], critical: true, ts: 1 }],
    coverage: { byTool: { 't': 0.1 } },
    coverageThreshold: 0.5,
  });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[1].source, 'capture');
});

test('collectAlerts: uncovered tool (score 0) -> "no capture adapter" wording', () => {
  const alerts = collectAlerts({ coverage: { byTool: { 'cursor-native': 0 } }, coverageThreshold: 0.5 });
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].title.includes('No capture adapter'));
  assert.ok(alerts[0].detail.includes('not captured'));
});

test('collectAlerts: injection findings -> injection alerts (capped at warn until calibrated)', () => {
  const alerts = collectAlerts({
    injections: [
      { sessionId: 's1', code: 'instruction-override', severity: 'critical', sample: 'ignore previous', tool: 'WebFetch' },
      { sessionId: 's2', code: 'bare-url', severity: 'warn', sample: 'http://x', kind: 'tool' },
    ],
  });
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every(a => a.source === 'injection' && a.severity === 'warn'), 'injection capped at warn');
  const s1 = alerts.find(a => a.target.id === 's1');
  assert.ok(s1 && s1.title.includes('instruction-override'));
  assert.deepEqual(s1.target, { view: 'sessions', id: 's1' });
});

test('collectAlerts: egress findings -> egress alerts (secret=critical)', () => {
  const alerts = collectAlerts({
    egress: [{ sessionId: 's1', path: '/repo/.env', reason: 'secret', severity: 'critical' }],
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'egress');
  assert.equal(alerts[0].severity, 'critical');
  assert.ok(alerts[0].title.includes('.env'));
});

test('collectAlerts: no inputs -> empty', () => {
  assert.deepEqual(collectAlerts({}), []);
});


test('collectAlerts: a session-worktree finding (has sessionId) targets the session, not the kanban', () => {
  const unmerged = [{ project: 'glmps', branch: 'session/glmps/abc123', unmerged: 2, lastCommitMs: Date.now() - 5 * 86400000, sessionId: 'abc123' }];
  const alerts = collectAlerts({ unmerged });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].target, { view: 'sessions', id: 'abc123' });
  assert.ok(alerts[0].detail.includes('ended session worktree'));
  assert.ok(alerts[0].detail.includes('merge it or file a ticket'));
});

test('collectAlerts: a plain (non-session) unmerged finding still targets the kanban with the original wording', () => {
  const unmerged = [{ project: 'glmps', branch: 'feat/finished', unmerged: 3, lastCommitMs: Date.now() - 5 * 86400000 }];
  const alerts = collectAlerts({ unmerged });
  assert.deepEqual(alerts[0].target, { view: 'kanban', project: 'glmps' });
  assert.ok(!alerts[0].detail.includes('session worktree'));
  assert.ok(alerts[0].detail.includes('no open ticket references it'));
});

test('collectAlerts: the >3-per-project collapse still applies even when some findings are session worktrees', () => {
  const unmerged = [
    { project: 'p', branch: 'session/p/s1', unmerged: 1, lastCommitMs: Date.now() - 30 * 86400000, sessionId: 's1' },
    { project: 'p', branch: 'session/p/s2', unmerged: 1, lastCommitMs: Date.now() - 30 * 86400000, sessionId: 's2' },
    { project: 'p', branch: 'feat/a', unmerged: 1, lastCommitMs: Date.now() - 30 * 86400000 },
    { project: 'p', branch: 'feat/b', unmerged: 1, lastCommitMs: Date.now() - 30 * 86400000 },
  ];
  const alerts = collectAlerts({ unmerged });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].target, { view: 'kanban', project: 'p' }); // collapsed alert stays project-level, not session-level
});

// B5 says every check emits a reconciliation finding "to the existing
// Discord/phone gateway". Before this source existed the events reached the
// spine and stopped there, read only by the morning-brief hook, so the
// critical checks (ungated_reflex) never raised an alert anyone saw.

test('integrity findings raise alerts, critical stays critical, info is dropped', () => {
  const integrity = [
    { check_name: 'ungated_reflex', severity: 'critical', details: 'lesson L1 is reflex with no approved promotion' },
    { check_name: 'skipped_gates', severity: 'warn', details: 'gateName=critic, streak=3' },
    { check_name: 'orphaned_artifact', severity: 'info', details: 'a note' },
  ];
  const alerts = collectAlerts({ integrity }).filter(a => a.source === 'integrity');
  assert.equal(alerts.length, 2, 'info is not an alert');
  assert.equal(alerts.find(a => a.title.includes('ungated_reflex')).severity, 'critical');
  assert.equal(alerts.find(a => a.title.includes('skipped_gates')).severity, 'warn');
  assert.equal(alerts.find(a => a.title.includes('skipped_gates')).detail, 'gateName=critic, streak=3');
  assert.deepEqual(alerts[0].target, { view: 'learning' });
});

test('an integrity alert titles itself per check AND subject, so acking one does not ack another', () => {
  // alerts.js derives the ack id from source::title::target, so two findings
  // of the SAME check on DIFFERENT gates must not collapse into one id.
  const integrity = [
    { check_name: 'skipped_gates', severity: 'warn', details: 'x', data: { gateName: 'critic' } },
    { check_name: 'skipped_gates', severity: 'warn', details: 'x', data: { gateName: 'verifier' } },
  ];
  const alerts = collectAlerts({ integrity }).filter(a => a.source === 'integrity');
  assert.equal(alerts.length, 2);
  assert.notEqual(alerts[0].title, alerts[1].title);
});

test('no findings produce no integrity alerts, and a missing or junk key does not throw', () => {
  assert.equal(collectAlerts({ integrity: [] }).filter(a => a.source === 'integrity').length, 0);
  assert.equal(collectAlerts({}).filter(a => a.source === 'integrity').length, 0);
  assert.equal(collectAlerts({ integrity: null }).filter(a => a.source === 'integrity').length, 0);
  assert.equal(collectAlerts({ integrity: [null, {}] }).filter(a => a.source === 'integrity').length, 0);
});

// `degraded` used to reach the UI only as a vitals field on /api/state, so a
// drifting adapter sat there indefinitely without raising anything. That is
// the reason the agy-cli re-drain defect (208 false misses/s) ran unnoticed.

test('a degraded adapter raises an alert, and a storm is critical rather than warn', () => {
  const adapterHealth = {
    'gemini-cli': { degraded: true, misses: 3, missesPerMin: 1, lastReason: 'schema drift', firstMissTs: 1, lastMissTs: 2 },
    'agy-cli': { degraded: true, misses: 9000, missesPerMin: 500, lastReason: 'steps query failed', firstMissTs: 1, lastMissTs: 2 },
  };
  const alerts = collectAlerts({ adapterHealth }).filter(a => a.source === 'capture-health');
  assert.equal(alerts.length, 2);
  assert.equal(alerts.find(a => a.title.includes('gemini-cli')).severity, 'warn');
  assert.equal(alerts.find(a => a.title.includes('agy-cli')).severity, 'critical',
    'a sustained storm is a different problem from an occasional miss and must read differently');
});

test('the capture-health alert says the reason and the rate, since a bare count hid the last one', () => {
  const adapterHealth = { 'agy-cli': { degraded: true, misses: 9000, missesPerMin: 500, lastReason: 'steps query failed' } };
  const a = collectAlerts({ adapterHealth }).find(x => x.source === 'capture-health');
  assert.match(a.detail, /steps query failed/);
  assert.match(a.detail, /500/);
});

test('no degraded adapters produces no capture-health alerts, and junk does not throw', () => {
  assert.equal(collectAlerts({ adapterHealth: {} }).filter(a => a.source === 'capture-health').length, 0);
  assert.equal(collectAlerts({}).filter(a => a.source === 'capture-health').length, 0);
  assert.equal(collectAlerts({ adapterHealth: null }).filter(a => a.source === 'capture-health').length, 0);
});

// Routed through the SAME adapterHealth registry every capture adapter
// already uses, but a known kernel id renders as "Kernel health: <id>", a
// distinct source ('kernel-health'), and its own severity rule - never the
// "Capture drift"/"Capture storm" framing a third-party capture-tool schema
// mismatch would show.

test('a kernel-id adapterHealth entry renders as Kernel health, not Capture drift, and never as a source::capture-health alert', () => {
  const adapterHealth = { 'mem0-lookup': { degraded: true, misses: 1, missesPerMin: 1, lastReason: 'mem0 search down', lastMissTs: 5 } };
  const alerts = collectAlerts({ adapterHealth });
  const hit = alerts.find((a) => a.source === 'kernel-health');
  assert.ok(hit, 'expected a kernel-health alert');
  assert.equal(hit.title, 'Kernel health: mem0-lookup');
  assert.match(hit.detail, /mem0 search down/);
  assert.equal(alerts.some((a) => a.source === 'capture-health'), false, 'a kernel id never also renders as a capture-health alert');
});

test('a kernel-id entry is warn under 3 misses, critical at 3 or more - never the rate-based storm threshold', () => {
  const adapterHealth = {
    'gate-obligation-open': { degraded: true, misses: 1, missesPerMin: 500, lastReason: 'simulated disk error', lastMissTs: 1 },
    'judge-load': { degraded: true, misses: 3, missesPerMin: 1, lastReason: 'adapter failed to load', lastMissTs: 1 },
  };
  const alerts = collectAlerts({ adapterHealth }).filter((a) => a.source === 'kernel-health');
  assert.equal(alerts.find((a) => a.title.includes('gate-obligation-open')).severity, 'warn', 'a high rate alone must not read as a storm for a kernel id');
  assert.equal(alerts.find((a) => a.title.includes('judge-load')).severity, 'critical');
});

for (const id of ['mem0-lookup', 'mem0-migrate', 'gate-obligation-open', 'retry-queue', 'finalize-sweep', 'judge-load']) {
  test(`kernel-health id ${id} is recognised (I8's named list)`, () => {
    const adapterHealth = { [id]: { degraded: true, misses: 1, lastReason: 'x', lastMissTs: 1 } };
    assert.ok(collectAlerts({ adapterHealth }).find((a) => a.source === 'kernel-health' && a.title === `Kernel health: ${id}`));
  });
}

test('kernelHealth (mem0/gepa quarantine, dead-letter gave-up) renders as Kernel health, honouring an explicit level', () => {
  const kernelHealth = {
    'mem0-quarantine': { consecutive: 1, level: 'warn', lastReason: '2 quarantined', ts: 5 },
    'plugin-retry-gaveup': { consecutive: 1, level: 'critical', lastReason: '3 job(s) gave up', ts: 6 },
  };
  const alerts = collectAlerts({ kernelHealth }).filter((a) => a.source === 'kernel-health');
  assert.equal(alerts.length, 2);
  assert.equal(alerts.find((a) => a.title === 'Kernel health: mem0-quarantine').severity, 'warn');
  assert.equal(alerts.find((a) => a.title === 'Kernel health: plugin-retry-gaveup').severity, 'critical');
});

// a cleared-then-recurring miss must re-alert even after an
// earlier ack. health.js's clearMiss() deletes the registry entry on a
// success, so a later reportMiss() gets a fresh firstMissTs - this proves
// that fresh firstMissTs actually changes the alert's dedup id (baked into
// `target`), so an old ack on the FIRST episode's id never suppresses the
// SECOND episode's alert.
test('I8: a kernel-health alert from a later episode (fresh firstMissTs) is not hidden by an old ack', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-alert-acks-')), 'acks.json');
  const first = collectAlerts({ adapterHealth: { 'mem0-lookup': { degraded: true, misses: 1, lastReason: 'first outage', lastMissTs: 100, firstMissTs: 100 } } })
    .find((a) => a.source === 'kernel-health');
  ack(file, first.id); // operator dismisses the first episode
  const stampedFirst = applyAcks([first], loadAcks(file));
  assert.equal(stampedFirst[0].acknowledged, true, 'precondition: the first episode is acked');

  // A later, genuinely NEW episode (health.js's clearMiss() ran in between,
  // so this reportMiss() got a fresh firstMissTs) must not inherit that ack.
  const second = collectAlerts({ adapterHealth: { 'mem0-lookup': { degraded: true, misses: 1, lastReason: 'second outage', lastMissTs: 999, firstMissTs: 999 } } })
    .find((a) => a.source === 'kernel-health');
  assert.notEqual(second.id, first.id, 'a new episode derives a different dedup id');
  const stampedSecond = applyAcks([second], loadAcks(file));
  assert.equal(stampedSecond[0].acknowledged, false, 'the recurrence is not hidden by the old ack');
});

test('no kernelHealth or adapterHealth produces no kernel-health alerts, and junk does not throw', () => {
  assert.equal(collectAlerts({}).filter((a) => a.source === 'kernel-health').length, 0);
  assert.equal(collectAlerts({ kernelHealth: null, adapterHealth: null }).filter((a) => a.source === 'kernel-health').length, 0);
});

// A channel that cannot read its own thread used to log
// `poll failed (missing_scope)` to a child process's stderr and nothing else -
// the operator sees a healthy live session that will never hear them again,
// and the only way to find it is to know which mcp-logs directory to read.

test('a failing SCUT channel raises a scut-channel alert naming the channel and the reason', () => {
  const scutChannelHealth = {
    C123: { degraded: true, channel: 'C123', ticket: 'glmps-44', failures: 1, lastReason: 'missing_scope', lastClass: 'auth', firstFailTs: 1000, lastFailTs: 1000, critical: true },
  };
  const alerts = collectAlerts({ scutChannelHealth }).filter(a => a.source === 'scut-channel');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /C123/);
  assert.match(alerts[0].detail, /missing_scope/);
});

test('an auth-classified (config-fatal) failure is critical; a transient one under the streak threshold is warn', () => {
  const scutChannelHealth = {
    C1: { degraded: true, channel: 'C1', failures: 1, lastReason: 'missing_scope', lastClass: 'auth', firstFailTs: 1, lastFailTs: 1, critical: true },
    C2: { degraded: true, channel: 'C2', failures: 1, lastReason: 'ratelimited', lastClass: 'transient', firstFailTs: 1, lastFailTs: 1, critical: false },
  };
  const alerts = collectAlerts({ scutChannelHealth }).filter(a => a.source === 'scut-channel');
  assert.equal(alerts.find(a => a.title.includes('C1')).severity, 'critical',
    'a scope that is missing will not clear on retry');
  assert.equal(alerts.find(a => a.title.includes('C2')).severity, 'warn',
    'a single transient blip is not yet a durable failure');
});

test('the scut-channel alert title/target is stable per channel: acking one does not create a fresh id next poll', () => {
  const before = { C123: { degraded: true, channel: 'C123', ticket: 't1', failures: 1, lastReason: 'ratelimited', lastClass: 'transient', firstFailTs: 1000, lastFailTs: 1000, critical: false } };
  const after = { C123: { degraded: true, channel: 'C123', ticket: 't1', failures: 4, lastReason: 'timeout', lastClass: 'transient', firstFailTs: 1000, lastFailTs: 5000, critical: false } };
  const idBefore = collectAlerts({ scutChannelHealth: before }).find(a => a.source === 'scut-channel').id;
  const idAfter = collectAlerts({ scutChannelHealth: after }).find(a => a.source === 'scut-channel').id;
  assert.equal(idBefore, idAfter, 'the reason text changing between polls must not mint a new ackable alert');
});

test('no failing SCUT channels produces no scut-channel alerts, and junk does not throw', () => {
  assert.equal(collectAlerts({ scutChannelHealth: {} }).filter(a => a.source === 'scut-channel').length, 0);
  assert.equal(collectAlerts({}).filter(a => a.source === 'scut-channel').length, 0);
  assert.equal(collectAlerts({ scutChannelHealth: null }).filter(a => a.source === 'scut-channel').length, 0);
});

test('a refused graph sync becomes a warn alert with a stable title', () => {
  const alerts = collectAlerts({
    graphSyncHealth: {
      'D:/Harbor-App': { outcome: 'refused', nodes: 4478, existingNodes: 4479, reason: 'refused to write 4478 nodes over an existing 4479', ts: 5, consecutive: 3 },
    },
  });
  const a = alerts.find(x => x.source === 'graph-sync');
  assert.ok(a, 'expected a graph-sync alert');
  assert.equal(a.severity, 'warn');
  // Title must NOT contain the node counts: alerts.js derives the ack id from
  // source::title::target, so a volatile title mints a new alert every tick.
  assert.ok(!/4478|4479/.test(a.title), `title must be stable, got: ${a.title}`);
  assert.match(a.title, /Harbor-App/);
});

test('a repeated refusal escalates to critical', () => {
  const alerts = collectAlerts({
    graphSyncHealth: {
      'D:/x': { outcome: 'refused', nodes: 1, existingNodes: 2, reason: 'r', ts: 5, consecutive: 7 },
    },
  });
  assert.equal(alerts.find(x => x.source === 'graph-sync').severity, 'critical');
});

test('updated and noop outcomes raise no alert', () => {
  const alerts = collectAlerts({
    graphSyncHealth: {
      'D:/a': { outcome: 'updated', nodes: 10, existingNodes: null, reason: 'u', ts: 1, consecutive: 1 },
      'D:/b': { outcome: 'noop', nodes: null, existingNodes: null, reason: 'n', ts: 1, consecutive: 9 },
    },
  });
  assert.equal(alerts.filter(x => x.source === 'graph-sync').length, 0);
});

test('a collapsed graph becomes a critical alert with a stable title', () => {
  const alerts = collectAlerts({
    graphIntegrity: {
      'D:/scut-build': {
        collapsed: true, dropRatio: 0.99,
        last: { nodes: 55, edges: 80, builtAtCommit: 'c2', ts: 9 },
        baseline: { nodes: 6140, edges: 15000, builtAtCommit: 'c1', ts: 1 },
      },
      'D:/fine': { collapsed: false, last: { nodes: 10, edges: 1, ts: 1 }, baseline: { nodes: 10, edges: 1, ts: 1 } },
    },
  });
  const hits = alerts.filter(x => x.source === 'graph-integrity');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'critical');
  assert.equal(hits[0].title, 'Graph collapsed: scut-build');
  assert.match(hits[0].detail, /55 nodes .* down from 6140/);
});

// a guard hook's own fail-open log (server/lib/observability's
// caller reads the last 24h of fail-open.ndjson lines and passes them here
// verbatim, {ts, hook, cardId, reason}). One alert per hook, using the
// newest occurrence, so a standing board outage stays one ackable alert
// instead of minting a fresh one on every tool call it touched.
test('a guard fail-open becomes a warn alert naming the hook and the reason', () => {
  const alerts = collectAlerts({ guardFailOpen: [
    { ts: 100, hook: 'plan-gate', cardId: 'mc-1', reason: 'plan gate skipped: board unreachable (board unreachable); the edit is allowed and logged' },
  ] });
  const a = alerts.find((x) => x.source === 'guard');
  assert.ok(a, 'expected a guard alert');
  assert.equal(a.severity, 'warn');
  assert.equal(a.title, 'Guard failed open: plan-gate');
  assert.match(a.detail, /board unreachable/);
  // 'loops' IS a real, resolvable target - web/app.js's
  // VIEW_REDIRECTS maps it to 'substrate-loop' (K3 loop-health alerts use the
  // same redirect), and navigate() resolves it before pushing history. An
  // earlier version of this test wrongly claimed 'loops' does not exist and
  // asserted 'guardrails' instead; reverted to the brief's target.
  assert.deepEqual(a.target, { view: 'loops' });
});

test('a guard fail-open: repeated entries for one hook collapse to the newest occurrence', () => {
  const alerts = collectAlerts({ guardFailOpen: [
    { ts: 100, hook: 'plan-gate', reason: 'board unreachable' },
    { ts: 300, hook: 'plan-gate', reason: 'board did not answer within 300ms' },
    { ts: 200, hook: 'plan-gate', reason: 'unknown card' },
  ] });
  const guardAlerts = alerts.filter((x) => x.source === 'guard');
  assert.equal(guardAlerts.length, 1, 'one hook must produce exactly one alert');
  assert.equal(guardAlerts[0].detail, 'board did not answer within 300ms');
  assert.equal(guardAlerts[0].ts, 300);
});

test('a guard fail-open: distinct hooks each get their own alert', () => {
  const alerts = collectAlerts({ guardFailOpen: [
    { ts: 100, hook: 'plan-gate', reason: 'a' },
    { ts: 100, hook: 'test-file-guard', reason: 'b' },
  ] }).filter((x) => x.source === 'guard');
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.title).sort(), ['Guard failed open: plan-gate', 'Guard failed open: test-file-guard']);
});

test('no guard fail-opens produces no guard alerts, and junk does not throw', () => {
  assert.equal(collectAlerts({ guardFailOpen: [] }).filter((x) => x.source === 'guard').length, 0);
  assert.equal(collectAlerts({}).filter((x) => x.source === 'guard').length, 0);
  assert.equal(collectAlerts({ guardFailOpen: null }).filter((x) => x.source === 'guard').length, 0);
});

// Task 12b post-breaker residual N3: the launch feature's own misses
// (broker load/quarantine, token boot, ledger reads, nonce refusals, ...)
// are kernel signals, not a capture tool drifting. Every launch-* key the
// kernel reports must render as "Kernel health: <id>". The list is
// scanned from the source, so a new launch-* key that is not added to
// KERNEL_HEALTH_IDS fails here instead of surfacing as "Capture drift".
function launchMissKeysInSource() {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [path.join(root, 'server.js')];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'lib'));
  const keys = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/reportMiss\(\s*'(launch-[a-z0-9-]+)'/g)) keys.add(m[1]);
  return [...keys].sort();
}

test('N3: every launch-* miss key the kernel reports renders as Kernel health, not Capture drift', () => {
  const keys = launchMissKeysInSource();
  for (const expected of ['launch-broker-load', 'launch-broker-quarantine', 'launch-token-boot', 'launch-queue-ledger', 'launch-claim-stale-check', 'launch-result-runner-failed', 'launch-result-ledger-patch', 'launch-nonce', 'launch-job-test-guard']) {
    assert.ok(keys.includes(expected), `the source scan finds ${expected}`);
  }
  for (const id of keys) {
    const alerts = collectAlerts({ adapterHealth: { [id]: { degraded: true, misses: 1, lastReason: 'x', lastMissTs: 1 } } });
    assert.ok(alerts.find((a) => a.source === 'kernel-health' && a.title === `Kernel health: ${id}`), `${id} renders as Kernel health`);
    assert.equal(alerts.some((a) => a.source === 'capture-health'), false, `${id} never renders as capture drift`);
  }
});

test('alert prose shows times in the operator zone with the zone named; the ts field stays a number (card glmps-2-0-runtime-66)', async () => {
  const { setDisplayTimeZone, displayTimeZone } = await import('../../web/shared/time-format.js');
  const before = displayTimeZone();
  const since = Date.parse('2026-10-26T23:22:00Z');
  try {
    setDisplayTimeZone('America/Los_Angeles');
    const alerts = collectAlerts({
      tapSpoolFull: [{ clientId: 'c1', name: 'laptop', bytes: 2 * 1048576, sinceTs: since, lastTs: since, dropped: 3 }],
      usageCapture: [{ kind: 'silent', lastRecordMs: since, silentHours: 2, liveSessions: 1 }],
    });
    const spool = alerts.find((a) => a.source === 'tap-spool');
    assert.match(spool.detail, /since Oct 26(, 2026)?, 4:22 PM PT;/);
    assert.equal(spool.ts, since);
    const usage = alerts.find((a) => a.source === 'usage-capture');
    assert.match(usage.detail, /no usage record since Oct 26(, 2026)?, 4:22 PM PT \(over 2h\)/);
    for (const a of [spool, usage]) assert.equal(/\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(a.detail), false, 'no ISO stamp in prose');
  } finally { setDisplayTimeZone(before); }
});

test('a closed card with an open PR is one warn alert per card, linked to its project board', () => {
  const alerts = collectAlerts({ closedOpenPr: [
    { id: 'glmps-2-0-158', title: 'Dev channel', project: 'glmps-2.0', state: 'done', prUrl: 'https://github.com/o/r/pull/121' },
  ] });
  const a = alerts.filter((x) => x.source === 'closed-card-open-pr');
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warn');
  assert.match(a[0].title, /glmps-2-0-158/);
  assert.match(a[0].detail, /pull\/121/);
  assert.match(a[0].title, /done/);
  assert.deepEqual(a[0].target, { view: 'kanban', project: 'glmps-2.0' });
  assert.deepEqual(collectAlerts({}).filter((x) => x.source === 'closed-card-open-pr'), []);
});

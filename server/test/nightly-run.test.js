// server/test/nightly-run.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGuardrails, planRun, summarizeRun, recordGateResult } from '../lib/orchestration/nightly-run.js';
import { nightlyConfig } from '../lib/orchestration/nightly-config.js';
import { readSpineEvents } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nightly-run-')); }


test('an unset repo allowlist denies every repo', () => {
  const r = checkGuardrails({ config: nightlyConfig({ nightly: { enabled: true } }), project: 'anything' });
  assert.equal(r.ok, false);
  assert.equal(r.stop, 'allowlist');
});

test('the kill switch file stops a run before anything else is evaluated', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly', 'nightly.kill'), '');
  // repoAllowlist deliberately does NOT include 'glmps': if the
  // allowlist were checked before the kill switch this would stop as
  // 'allowlist' instead, which is the ordering this test pins.
  const enabledCfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: [] } });
  const r = checkGuardrails({ config: enabledCfg, stateDir: dir, project: 'glmps' });
  assert.equal(r.stop, 'kill-switch');
});

test('config.enabled=false stops a run as a kill switch, even with no kill file on disk', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: false, repoAllowlist: ['glmps'] } });
  const r = checkGuardrails({ config: cfg, stateDir: dir, project: 'glmps' });
  assert.equal(r.stop, 'kill-switch');
});

test('a repo not on the allowlist is denied even when the allowlist is non-empty', () => {
  const cfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['other-repo'] } });
  const r = checkGuardrails({ config: cfg, project: 'glmps' });
  assert.equal(r.stop, 'allowlist');
});

test('exceeding the budget cap stops the run', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['glmps'], budget: { maxUsd: 5 } } });
  const r = checkGuardrails({ config: cfg, stateDir: dir, project: 'glmps', spendUsd: 6 });
  assert.equal(r.stop, 'budget');
});

test('exceeding the token budget cap stops the run', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['glmps'], budget: { maxTokens: 1000 } } });
  const r = checkGuardrails({ config: cfg, stateDir: dir, project: 'glmps', tokens: 1200 });
  assert.equal(r.stop, 'budget');
});

test('a run within every guardrail passes', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['glmps'], budget: { maxUsd: 5 } } });
  const r = checkGuardrails({ config: cfg, stateDir: dir, project: 'glmps', spendUsd: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.stop, undefined);
});


const allowCfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['glmps'], maxItems: 1 } });
const now = Date.parse('2026-08-16T00:00:00Z');

test('planRun names its run id from the clock date, UTC', () => {
  const p = planRun({ backlog: [], config: allowCfg, now });
  assert.equal(p.runId, 'nightly-20260816');
});

test('planRun skips a quarantined card and says why', () => {
  const p = planRun({
    backlog: [{ id: 'x', state: 'queued', quarantined: true, project: 'glmps', order: 1 }],
    config: allowCfg, now,
  });
  assert.deepEqual(p.skipped, [{ id: 'x', reason: 'quarantined' }]);
  assert.deepEqual(p.items, []);
});

test('planRun skips a card blocked by an unresolved ticket', () => {
  const backlog = [
    { id: 'blocker', state: 'queued', project: 'glmps', order: 1 },
    { id: 'blocked', state: 'queued', project: 'glmps', order: 2, blockedBy: ['blocker'] },
  ];
  const p = planRun({ backlog, config: allowCfg, now });
  assert.deepEqual(p.skipped.find((s) => s.id === 'blocked'), { id: 'blocked', reason: 'blocked' });
});

test('planRun skips a card whose project is not allowlisted', () => {
  const p = planRun({
    backlog: [{ id: 'y', state: 'queued', project: 'some-other-repo', order: 1 }],
    config: allowCfg, now,
  });
  assert.deepEqual(p.skipped, [{ id: 'y', reason: 'not-allowlisted' }]);
});

test('planRun caps candidates at maxItems and names the overflow', () => {
  const backlog = [
    { id: 'a', state: 'queued', project: 'glmps', order: 1 },
    { id: 'b', state: 'queued', project: 'glmps', order: 2 },
  ];
  const p = planRun({ backlog, config: allowCfg, now }); // maxItems: 1
  assert.deepEqual(p.items.map((i) => i.id), ['a']);
  assert.deepEqual(p.skipped, [{ id: 'b', reason: 'over-maxItems' }]);
});

test('planRun ignores a card that is not queued, with no skip entry', () => {
  const p = planRun({
    backlog: [{ id: 'z', state: 'done', project: 'glmps', order: 1 }],
    config: allowCfg, now,
  });
  assert.deepEqual(p.items, []);
  assert.deepEqual(p.skipped, []);
});

test('planRun picks queued, unblocked, allowlisted cards in order', () => {
  const cfg = nightlyConfig({ nightly: { enabled: true, repoAllowlist: ['glmps'], maxItems: 2 } });
  const backlog = [
    { id: 'second', state: 'queued', project: 'glmps', order: 2 },
    { id: 'first', state: 'queued', project: 'glmps', order: 1 },
  ];
  const p = planRun({ backlog, config: cfg, now });
  assert.deepEqual(p.items.map((i) => i.id), ['first', 'second']);
});


test('a skipped gate is recorded, not omitted', () => {
  const dir = tmp();
  recordGateResult(dir, { runId: 'r1', gateName: 'cross-model-critic', status: 'skipped', details: 'no API key' });
  const ev = readSpineEvents(dir, { kind: 'run.gate_result' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.status, 'skipped');
  assert.equal(ev[0].payload.gateName, 'cross-model-critic');
});

test('recordGateResult accepts pass and fail statuses too', () => {
  const dir = tmp();
  recordGateResult(dir, { runId: 'r1', gateName: 'tests', status: 'pass' });
  recordGateResult(dir, { runId: 'r1', gateName: 'critic', status: 'fail', details: 'CONCERNS' });
  const statuses = readSpineEvents(dir, { kind: 'run.gate_result' }).map((e) => e.payload.status);
  assert.deepEqual(statuses, ['pass', 'fail']);
});

test('recordGateResult rejects an unrecognized status', () => {
  const dir = tmp();
  assert.throws(() => recordGateResult(dir, { runId: 'r1', gateName: 'x', status: 'maybe' }));
});


test('summarizeRun buckets gate results into passed, skipped and failed', () => {
  const payload = summarizeRun({
    runId: 'nightly-20260816',
    items: [{ id: 'a' }],
    prs: [{ url: 'https://github.com/o/r/pull/1' }],
    gateResults: [
      { gateName: 'tests', status: 'pass' },
      { gateName: 'cross-model-critic', status: 'skipped' },
      { gateName: 'lint', status: 'fail' },
    ],
    spend: { usd: 1.5, tokens: 4000 },
    blockers: ['budget'],
  });
  assert.equal(payload.cadence, 'nightly');
  assert.equal(payload.runId, 'nightly-20260816');
  assert.deepEqual(payload.itemsAttempted, ['a']);
  assert.deepEqual(payload.prsFiled, ['https://github.com/o/r/pull/1']);
  assert.deepEqual(payload.gatesPassed, ['tests']);
  assert.deepEqual(payload.gatesSkipped, ['cross-model-critic']);
  assert.deepEqual(payload.gatesFailed, ['lint']);
  assert.deepEqual(payload.blockers, ['budget']);
  assert.deepEqual(payload.spend, { usd: 1.5, tokens: 4000 });
  assert.ok('nextBacklogProposal' in payload);
});

test('summarizeRun degrades to empty buckets and zero spend with no input', () => {
  const payload = summarizeRun({ runId: 'nightly-20260816' });
  assert.deepEqual(payload.itemsAttempted, []);
  assert.deepEqual(payload.prsFiled, []);
  assert.deepEqual(payload.gatesPassed, []);
  assert.deepEqual(payload.spend, { usd: 0, tokens: 0 });
});

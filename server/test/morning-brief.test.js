// server/test/morning-brief.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, MAX_BRIEF_LINES } from '../lib/observability/morning-brief.js';

const DAY = 86400000;
const NOW = Date.parse('2026-08-16T14:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function runCompleted(over = {}) {
  return {
    kind: 'run.completed',
    ts: iso(NOW - 8 * 3600000),
    payload: {
      runId: 'nightly-20260816',
      prs: ['https://github.com/o/r/pull/7'],
      itemsDone: ['glmps-42'],
      itemsBlocked: [],
      gatesSkipped: [],
      costActual: { usd: 1.2 },
      ...over,
    },
  };
}

test('an empty world produces no lines at all', () => {
  const b = buildBrief({ runEvents: [], reviews: [], integrity: [], now: NOW });
  assert.deepEqual(b.lines, []);
  assert.equal(b.truncated, false);
});

test('the last nightly result names the run, its PRs and its item count', () => {
  const b = buildBrief({ runEvents: [runCompleted()], reviews: [], integrity: [], now: NOW });
  assert.ok(b.lines[0].includes('nightly-20260816'));
  assert.ok(b.lines.some((l) => l.includes('https://github.com/o/r/pull/7')));
});

test('skipped gates are surfaced by name, never silently omitted', () => {
  const b = buildBrief({ runEvents: [runCompleted({ gatesSkipped: ['cross-model-critic', 'adversarial-review'] })], reviews: [], integrity: [], now: NOW });
  const line = b.lines.find((l) => /skipped/i.test(l));
  assert.ok(line, 'a skipped gate must appear in the brief');
  assert.ok(line.includes('cross-model-critic'));
});

test('blockers are surfaced', () => {
  const b = buildBrief({ runEvents: [runCompleted({ itemsBlocked: ['glmps-99'] })], reviews: [], integrity: [], now: NOW });
  assert.ok(b.lines.some((l) => l.includes('glmps-99')));
});

test('a failed run reports the stage it died at', () => {
  const ev = { kind: 'run.failed', ts: iso(NOW - 3600000), payload: { runId: 'nightly-20260816', stage: 'budget', error: 'cap exceeded' } };
  const b = buildBrief({ runEvents: [ev], reviews: [], integrity: [], now: NOW });
  assert.ok(b.lines[0].toLowerCase().includes('failed'));
  assert.ok(b.lines[0].includes('budget'));
});

test('only the most recent run is reported', () => {
  const older = runCompleted({ runId: 'nightly-20260814' });
  older.ts = iso(NOW - 3 * DAY);
  const b = buildBrief({ runEvents: [older, runCompleted()], reviews: [], integrity: [], now: NOW });
  assert.ok(b.lines[0].includes('nightly-20260816'));
  assert.equal(b.lines.some((l) => l.includes('nightly-20260814')), false);
});

test('integrity findings are reported with their check name', () => {
  const findings = [{ check_name: 'skipped_gates', severity: 'warn', details: 'gateName=critic, streak=3' }];
  const b = buildBrief({ runEvents: [], reviews: [], integrity: findings, now: NOW });
  assert.ok(b.lines.some((l) => l.includes('skipped_gates') && l.includes('streak=3')));
});

test('critical findings are reported ahead of warnings', () => {
  const drift = [
    { check_name: 'orphaned_artifact', severity: 'warn' },
    { check_name: 'ungated_reflex', severity: 'critical' },
  ];
  const b = buildBrief({ runEvents: [], reviews: [], integrity: drift, now: NOW });
  const iCrit = b.lines.findIndex((l) => l.includes('ungated_reflex'));
  const iWarn = b.lines.findIndex((l) => l.includes('orphaned_artifact'));
  assert.ok(iCrit !== -1 && iCrit < iWarn);
});

test('the brief caps at MAX_BRIEF_LINES and reports truncation', () => {
  const drift = Array.from({ length: 30 }, (_, i) => ({ check_name: 'orphaned_artifact', desk: `D${i}`, severity: 'warn' }));
  const b = buildBrief({
    runEvents: [runCompleted({ gatesSkipped: ['a', 'b'], itemsBlocked: ['x', 'y'], prs: ['p1', 'p2', 'p3'] })],
    reviews: [],
    integrity: drift,
    now: NOW,
  });
  assert.ok(b.lines.length <= MAX_BRIEF_LINES, `expected <= ${MAX_BRIEF_LINES}, got ${b.lines.length}`);
  assert.equal(b.truncated, true);
});

test('no line contains an em-dash', () => {
  // Built by code point so this file does not itself trip the global
  // no-em-dash write hook.
  const EM_DASH = String.fromCharCode(0x2014);
  const b = buildBrief({
    runEvents: [runCompleted({ gatesSkipped: ['g'] })],
    reviews: [],
    integrity: [{ check_name: 'skipped_gates', severity: 'warn' }],
    now: NOW,
  });
  for (const l of b.lines) assert.equal(l.includes(EM_DASH), false, `em-dash in: ${l}`);
});


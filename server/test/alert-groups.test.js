// Alert grouping, computed once on the server (card glmps-2-0-runtime-77 AC-2):
// GET /api/alerts carries it as `attention`, the Surface Alerts dock renders it
// and the Slack digest formats it, so both show the same rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAlerts, sourceLabel, findingKey, isReviewBookkeeping, morningDigest } from '../lib/observability/alert-groups.js';

const a = (id, source, severity, ts = 0) => ({ id, source, severity, title: id, ts });

test('criticals stay individual, warnings collapse to one group per source', () => {
  const list = [
    a('k1', 'kernel-health', 'critical', 5), a('k2', 'kernel-health', 'critical', 9),
    a('c1', 'capture-health', 'warn'), a('g1', 'integrity', 'warn'),
    ...Array.from({ length: 25 }, (_, i) => a(`u${i}`, 'unmerged-branch', 'warn', i)),
    a('i1', 'injection', 'warn'), a('p1', 'poison', 'warn'), a('p2', 'poison', 'warn'),
  ];
  const { critical, groups } = groupAlerts(list);
  assert.deepEqual(critical, ['k2', 'k1']);
  assert.deepEqual(groups.map((g) => [g.source, g.count]), [
    ['unmerged-branch', 25], ['poison', 2], ['capture-health', 1], ['injection', 1], ['integrity', 1],
  ]);
  assert.equal(groups[0].label, 'Unmerged branches');
  assert.equal(groups[0].ids[0], 'u24', 'rows inside a group are newest first');
  assert.equal(groups[0].ids.length, 25);
});

test('empty and missing input give no rows and no groups', () => {
  assert.deepEqual(groupAlerts([]), { critical: [], groups: [] });
  assert.deepEqual(groupAlerts(undefined), { critical: [], groups: [] });
});

test('info and acknowledged alerts are left out; unknown sources get a readable label', () => {
  assert.equal(sourceLabel('some-new_source'), 'Some new source');
  assert.deepEqual(groupAlerts([a('x', 'some-new_source', 'info')]), { critical: [], groups: [] });
  const { critical, groups } = groupAlerts([{ ...a('y', 'poison', 'critical'), acknowledged: true }, a('z', 'some-new_source', 'warn')]);
  assert.deepEqual(critical, []);
  assert.equal(groups[0].label, 'Some new source');
});

// A per-card obligation expiry is one finding per rule, however many cards hit it.
const ob = (card, severity = 'critical', ts = 0) => ({ id: `ob-${card}-${severity}`, source: 'obligation', severity, title: `Obligation expired: gate.independent-verdict ${card}`, ts });

test('findingKey: obligation expiries share a key per rule, other sources key by source', () => {
  assert.equal(findingKey(ob('glmps-2-0-49')), findingKey(ob('glmps-2-0-45')));
  assert.notEqual(findingKey(ob('x')), findingKey({ source: 'obligation', title: 'Obligation expired: other.rule glmps-2-0-49' }));
  assert.equal(findingKey({ source: 'unmerged-branch', title: '33 unmerged branches in a' }), findingKey({ source: 'unmerged-branch', title: '33 unmerged branches in b' }));
  assert.equal(findingKey({ title: 'untyped' }), 'other');
});

test('groupAlerts folds warning obligation expiries of one rule into one row', () => {
  const { groups } = groupAlerts([ob('c1', 'warn'), ob('c2', 'warn'), ob('c3', 'warn'), a('g', 'integrity', 'warn')]);
  assert.deepEqual(groups.map((g) => [g.label, g.count]), [['Obligation expired: gate.independent-verdict', 3], ['Integrity', 1]]);
});

// card glmps-2-0-219: one morning post of what is new, nothing when nothing is.
// 2026-11-15T16:30Z is 8:30 AM in Los Angeles; 15:30Z is 7:30 AM.
const LA = 'America/Los_Angeles';
const AT_830 = Date.UTC(2026, 10, 15, 16, 30);
const AT_730 = Date.UTC(2026, 10, 15, 15, 30);

test('isReviewBookkeeping: only expired independent-review obligations', () => {
  assert.equal(isReviewBookkeeping(ob('c1')), true);
  assert.equal(isReviewBookkeeping({ source: 'obligation', title: 'Obligation expired: loop.freshness alert-digest' }), false);
  assert.equal(isReviewBookkeeping({ source: 'kernel-health', title: 'Obligation expired: gate.independent-verdict x' }), false);
});

test('morningDigest is not due before the hour or twice in one local day', () => {
  const alerts = [a('k1', 'kernel-health', 'critical')];
  assert.equal(morningDigest({ alerts, prev: null, nowMs: AT_730, timeZone: LA }).due, false);
  const first = morningDigest({ alerts, prev: null, nowMs: AT_830, timeZone: LA });
  assert.equal(first.due, true);
  assert.equal(first.day, '2026-11-15');
  const later = morningDigest({ alerts, prev: { day: first.day, ids: first.ids }, nowMs: AT_830 + 3 * 3600_000, timeZone: LA });
  assert.equal(later.due, false);
});

test('morningDigest lists only alerts not in the last digest and has no text when none are new', () => {
  const prev = { day: '2026-11-14', ids: ['k1', 'p1'] };
  const alerts = [a('k1', 'kernel-health', 'critical'), a('p1', 'poison', 'warn'), a('k2', 'kernel-health', 'critical'), a('p2', 'poison', 'warn')];
  const r = morningDigest({ alerts, prev, nowMs: AT_830, timeZone: LA });
  assert.deepEqual(r.ids.sort(), ['k1', 'k2', 'p1', 'p2']);
  assert.equal(r.text, [
    'Alerts: 2 new since the last digest (1 critical, 1 warning). Full list in the dashboard Alerts panel.',
    '*Critical*',
    '- k2 (Kernel health)',
    '*Warnings*',
    '- Poison: 1',
  ].join('\n'));
  const quiet = morningDigest({ alerts: alerts.slice(0, 2), prev, nowMs: AT_830, timeZone: LA });
  assert.equal(quiet.due, true);
  assert.equal(quiet.text, null);
});

test('morningDigest leaves out review bookkeeping, info and acknowledged rows, and caps critical lines', () => {
  const crit = Array.from({ length: 12 }, (_, i) => a(`c${i}`, 'kernel-health', 'critical', i));
  const alerts = [...crit, ob('glmps-2-0-1'), a('i1', 'poison', 'info'), { ...a('x1', 'poison', 'warn'), acknowledged: true }];
  const r = morningDigest({ alerts, prev: { day: '2026-11-14', ids: [] }, nowMs: AT_830, timeZone: LA });
  assert.equal(r.ids.length, 12);
  const lines = r.text.split('\n');
  assert.equal(lines[0], 'Alerts: 12 new since the last digest (12 critical). Full list in the dashboard Alerts panel.');
  assert.equal(lines.filter((l) => l.startsWith('- c')).length, 10);
  assert.equal(lines.at(-1), '- +2 more critical');
  assert.doesNotMatch(r.text, /independent-verdict/);
});

test('a digest state from before the morning digest is seeded silently', () => {
  const r = morningDigest({ alerts: [a('k1', 'kernel-health', 'critical')], prev: { fingerprint: 'old' }, nowMs: AT_830, timeZone: LA });
  assert.equal(r.due, true);
  assert.deepEqual(r.ids, ['k1']);
  assert.equal(r.text, null);
});

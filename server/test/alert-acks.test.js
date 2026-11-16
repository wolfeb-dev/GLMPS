// server/test/alert-acks.test.js
// glmps-70: persisted operator acknowledge/dismiss store for the alert center.
// Acking suppresses an alert by its stable dedup id (source::title::target JSON);
// fresh evidence (new session/path/target) derives a NEW id, so it is NOT
// suppressed by an old ack - that's the re-alert guarantee, proven below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAcks, ack, unack, applyAcks } from '../lib/observability/alert-acks.js';
import { normalizeAlert } from '../lib/observability/alerts.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-acks-'));
  tmpDirs.push(d);
  return path.join(d, 'state', 'alert-acks.json');
}

test('loadAcks: missing file -> {}', () => {
  const f = mkFile();
  assert.deepEqual(loadAcks(f), {});
});

test('ack: persists id -> ts, creates parent dir, atomic write', () => {
  const f = mkFile();
  assert.ok(!fs.existsSync(path.dirname(f)));
  const acks = ack(f, 'alert-1', 1000);
  assert.equal(acks['alert-1'], 1000);
  assert.ok(fs.existsSync(f));
  assert.ok(!fs.existsSync(f + '.tmp'), 'tmp file renamed away, not left behind');
  const reloaded = loadAcks(f);
  assert.equal(reloaded['alert-1'], 1000);
});

test('ack: missing id is a no-op (no throw, no id key added)', () => {
  const f = mkFile();
  const acks = ack(f, '', 1000);
  assert.deepEqual(acks, {});
  assert.equal(fs.existsSync(f), false);
});

test('ack: second id accumulates alongside the first', () => {
  const f = mkFile();
  ack(f, 'a', 100);
  const acks = ack(f, 'b', 200);
  assert.deepEqual(acks, { a: 100, b: 200 });
});

test('unack: removes a previously-acked id', () => {
  const f = mkFile();
  ack(f, 'a', 100);
  ack(f, 'b', 200);
  const acks = unack(f, 'a');
  assert.deepEqual(acks, { b: 200 });
  assert.deepEqual(loadAcks(f), { b: 200 });
});

test('unack: unknown id is a no-op', () => {
  const f = mkFile();
  ack(f, 'a', 100);
  const acks = unack(f, 'nope');
  assert.deepEqual(acks, { a: 100 });
});

test('unack: missing store file -> {} (no throw)', () => {
  const f = mkFile();
  assert.deepEqual(unack(f, 'a'), {});
});

test('ack: prunes entries older than 90 days on save', () => {
  const f = mkFile();
  const now = Date.parse('2026-07-05T00:00:00Z');
  const old = now - 91 * 86400000; // 91 days ago -> pruned
  const recent = now - 10 * 86400000; // 10 days ago -> kept
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ stale: old, fresh: recent }));
  const acks = ack(f, 'new-one', now);
  assert.deepEqual(acks, { fresh: recent, 'new-one': now });
  assert.deepEqual(loadAcks(f), { fresh: recent, 'new-one': now });
});

test('loadAcks: tolerates corrupt/non-object JSON', () => {
  const f = mkFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '[1,2,3]');
  assert.deepEqual(loadAcks(f), {});
  fs.writeFileSync(f, 'not json');
  assert.deepEqual(loadAcks(f), {});
});

test('applyAcks: stamps acknowledged:true on acked ids only, pure (does not mutate input)', () => {
  const alerts = [
    normalizeAlert({ id: 'a', source: 's', title: 't1', severity: 'warn' }),
    normalizeAlert({ id: 'b', source: 's', title: 't2', severity: 'critical' }),
  ];
  const frozenCopy = alerts.map(a => ({ ...a }));
  const out = applyAcks(alerts, { a: 1000 });
  assert.equal(out[0].acknowledged, true);
  assert.equal(out[0].acknowledgedAt, 1000);
  assert.equal(out[1].acknowledged, false);
  assert.deepEqual(alerts, frozenCopy, 'input array/objects untouched');
});

test('applyAcks: empty/undefined acks map -> nothing stamped', () => {
  const alerts = [normalizeAlert({ id: 'a', source: 's', title: 't', severity: 'info' })];
  assert.equal(applyAcks(alerts, {})[0].acknowledged, false);
  assert.equal(applyAcks(alerts, undefined)[0].acknowledged, false);
  assert.equal(applyAcks(alerts, null)[0].acknowledged, false);
});

test('applyAcks: tolerates non-array input', () => {
  assert.deepEqual(applyAcks(undefined, {}), []);
  assert.deepEqual(applyAcks(null, {}), []);
});

test('re-alert guarantee: acking one target does not suppress the same title firing on a NEW target', () => {
  // Same source/title, different target (e.g. a different session id) -> different
  // derived id, because deriveId hashes JSON.stringify(target) into the id.
  const first = normalizeAlert({ source: 'egress', title: 'Sensitive data touched: .env', target: { view: 'sessions', id: 'session-A', path: '.env' } });
  const second = normalizeAlert({ source: 'egress', title: 'Sensitive data touched: .env', target: { view: 'sessions', id: 'session-B', path: '.env' } });
  assert.notEqual(first.id, second.id, 'new session -> new dedup id');

  const f = mkFile();
  ack(f, first.id, 1000);
  const acks = loadAcks(f);
  const [a1, a2] = applyAcks([first, second], acks);
  assert.equal(a1.acknowledged, true, 'the acked target stays acknowledged');
  assert.equal(a2.acknowledged, false, 'fresh evidence (new target) is NOT suppressed by the old ack');
});

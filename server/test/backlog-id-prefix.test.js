// Project-derived ticket id prefixes (was: every ticket got glmps-<seq>).
// New tickets take their id prefix from a slug of their project; "default"/
// unknown projects keep the legacy "glmps" prefix and its counter. Existing
// glmps-## ids must stay valid and resolvable everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/orchestration/backlog-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-backlog-prefix-')); }


test('projectSlug lowercases and dashes non-alphanumerics', () => {
  assert.equal(store.projectSlug('Harbor-App'), 'harbor-app');
  assert.equal(store.projectSlug('Northwind Portal'), 'northwind-portal');
  assert.equal(store.projectSlug('  glmps  '), 'glmps');
  assert.equal(store.projectSlug(''), '');
  assert.equal(store.projectSlug(null), '');
});

test('idPrefixFor falls back to glmps for default/empty/unknown projects', () => {
  assert.equal(store.idPrefixFor('default'), 'glmps');
  assert.equal(store.idPrefixFor(''), 'glmps');
  assert.equal(store.idPrefixFor(undefined), 'glmps');
  assert.equal(store.idPrefixFor('Harbor-App'), 'harbor-app');
});


test('addItem derives the id prefix from the project slug', () => {
  let s = store.emptyState();
  const r1 = store.addItem(s, { project: 'Harbor-App', title: 'roll audit' });
  assert.equal(r1.item.id, 'harbor-app-1');
  const r2 = store.addItem(r1.state, { project: 'Harbor-App', title: 'second thing' });
  assert.equal(r2.item.id, 'harbor-app-2');
});

test('addItem with a spaced project name slugs the prefix', () => {
  const r = store.addItem(store.emptyState(), { project: 'Northwind Portal', title: 'x' });
  assert.equal(r.item.id, 'northwind-portal-1');
});

test('addItem keeps the glmps prefix + legacy seq for default/missing project', () => {
  let s = { ...store.emptyState(), seq: 62 };
  const r1 = store.addItem(s, { title: 'no project' });
  assert.equal(r1.item.id, 'glmps-63');
  assert.equal(r1.item.project, 'default');
  const r2 = store.addItem(r1.state, { project: 'default', title: 'explicit default' });
  assert.equal(r2.item.id, 'glmps-64');
});


test('per-prefix counters are isolated: project adds do not consume the glmps seq', () => {
  let s = { ...store.emptyState(), seq: 62 };
  s = store.addItem(s, { project: 'Harbor-App', title: 'a' }).state;   // harbor-app-1
  s = store.addItem(s, { project: 'Harbor-App', title: 'b' }).state;   // harbor-app-2
  const r = store.addItem(s, { title: 'default one' });
  assert.equal(r.item.id, 'glmps-63', 'glmps counter must not advance for prefixed adds');
  const r2 = store.addItem(r.state, { project: 'autopilot-app', title: 'c' });
  assert.equal(r2.item.id, 'autopilot-app-1', 'new prefix starts at 1');
});

test('prefixed ids never collide with pre-existing ids in the store (counter behind)', () => {
  // Simulates a re-homed ticket present in items while seqs has no entry yet.
  let s = store.emptyState();
  s = { ...s, items: [{ ...store.addItem(s, { project: 'Harbor-App', title: 'seed' }).item, id: 'harbor-app-1' }], seqs: {} };
  const r = store.addItem(s, { project: 'Harbor-App', title: 'fresh' });
  assert.equal(r.item.id, 'harbor-app-2');
});

test('load tolerates a legacy store.json without seqs', () => {
  const dir = tmp();
  const f = path.join(dir, 'backlog', 'store.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ items: [], paused: false, seq: 62 }));
  const s = store.load(dir);
  const r = store.addItem(s, { project: 'Harbor-App', title: 'first prefixed' });
  assert.equal(r.item.id, 'harbor-app-1');
  assert.equal(store.addItem(r.state, { title: 'legacy path' }).item.id, 'glmps-63');
  fs.rmSync(dir, { recursive: true, force: true });
});


test('existing glmps-## items stay patchable/label-deltable/approvable/removable', () => {
  let s = { ...store.emptyState(), seq: 62 };
  s = store.addItem(s, { title: 'legacy' }).state; // glmps-63
  const id = 'glmps-63';
  let r = store.updateItem(s, id, { title: 'legacy renamed' });
  assert.equal(r.item.title, 'legacy renamed');
  r = store.applyLabelDelta(r.state, id, { labels: ['agent:in-progress'], comment: 'claimed' });
  assert.equal(r.item.state, 'in_progress');
  const rm = store.removeItem(r.state, id);
  assert.equal(rm.removed, true);
});

test('TICKET_ID_RE accepts both legacy glmps ids and project-prefixed ids', () => {
  assert.match('glmps-62', store.TICKET_ID_RE);
  assert.match('harbor-app-3', store.TICKET_ID_RE);
  assert.match('northwind-portal-12', store.TICKET_ID_RE);
  assert.doesNotMatch('BAD id', store.TICKET_ID_RE);
  assert.doesNotMatch('nope', store.TICKET_ID_RE);
});

test('deferredRefs/blockedBy accept a mix of legacy and prefixed ids', () => {
  const r = store.addItem(store.emptyState(), {
    project: 'Harbor-App', title: 'linked',
    deferredRefs: ['glmps-12', 'harbor-app-3', 'not an id'],
    blockedBy: ['glmps-55', 'garbage!'],
  });
  assert.deepEqual(r.item.deferredRefs, ['glmps-12', 'harbor-app-3']);
  assert.deepEqual(r.item.blockedBy, ['glmps-55']);
});


test('dedup by (project,title,source) still returns the existing item, whatever its prefix', () => {
  let s = { ...store.emptyState(), seq: 62 };
  const r1 = store.addItem(s, { project: 'Harbor-App', title: 'dup me', source: 'manual' });
  const r2 = store.addItem(r1.state, { project: 'Harbor-App', title: 'dup me', source: 'manual' });
  assert.equal(r2.isNew, false);
  assert.equal(r2.item.id, r1.item.id);
  // legacy-id item dedups too
  let s2 = store.addItem({ ...store.emptyState(), seq: 10 }, { title: 'old dup', source: 'manual' }).state; // glmps-11
  const r3 = store.addItem(s2, { title: 'old dup', source: 'manual' });
  assert.equal(r3.isNew, false);
  assert.equal(r3.item.id, 'glmps-11');
});

test('same title in different projects creates two items with different prefixes', () => {
  let s = store.emptyState();
  const r1 = store.addItem(s, { project: 'Harbor-App', title: 'shared', source: 'manual' });
  const r2 = store.addItem(r1.state, { project: 'autopilot-app', title: 'shared', source: 'manual' });
  assert.equal(r2.isNew, true);
  assert.match(r1.item.id, /^harbor-app-\d+$/);
  assert.match(r2.item.id, /^autopilot-app-\d+$/);
});


test('addItem trims the project and maps blank/non-string to default', () => {
  assert.equal(store.addItem(store.emptyState(), { project: '  Harbor-App  ', title: 'x' }).item.project, 'Harbor-App');
  assert.equal(store.addItem(store.emptyState(), { project: '   ', title: 'x' }).item.project, 'default');
  assert.equal(store.addItem(store.emptyState(), { project: 42, title: 'x' }).item.project, 'default');
});

test('seqs round-trips through disk', () => {
  const dir = tmp();
  store.addItemTo(dir, { project: 'Harbor-App', title: 'a' });
  store.addItemTo(dir, { project: 'Harbor-App', title: 'b' });
  const loaded = store.load(dir);
  assert.equal(loaded.seqs['harbor-app'], 2);
  assert.equal(store.addItem(loaded, { project: 'Harbor-App', title: 'c' }).item.id, 'harbor-app-3');
  fs.rmSync(dir, { recursive: true, force: true });
});

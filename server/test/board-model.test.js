import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bm from '../../web/orchestration/board-model.js';

test('groupByColumn buckets and sorts by order', () => {
  const items = [
    { id: 'a', state: 'queued', order: 2 },
    { id: 'b', state: 'queued', order: 1 },
    { id: 'c', state: 'done', order: 5 },
    { id: 'd', state: 'held', order: 1 },
  ];
  const g = bm.groupByColumn(items);
  assert.deepEqual(g.queued.map(i => i.id), ['b', 'a']);
  assert.deepEqual(g.done.map(i => i.id), ['c']);
  assert.deepEqual(g.held.map(i => i.id), ['d']);
});

test('nextOrder returns max+1', () => {
  assert.equal(bm.nextOrder([{ order: 3 }, { order: 7 }]), 8);
  assert.equal(bm.nextOrder([]), 1);
});

test('orderedColumns puts held first and gates cancelled on showArchived', () => {
  assert.deepEqual(bm.orderedColumns(false), ['held','queued','in_progress','in_review','idle','done']);
  assert.deepEqual(bm.orderedColumns(true), ['held','queued','in_progress','in_review','idle','done','archived','cancelled']);
});

test('filterItems by project, query, minPriority, showCancelled', () => {
  const items = [
    { id:'1', project:'a', title:'fix bug', prompt:'', state:'queued', priority:2 },
    { id:'2', project:'b', title:'new feature', prompt:'add thing', state:'queued', priority:null },
    { id:'3', project:'a', title:'old', prompt:'', state:'cancelled', priority:0 },
  ];
  assert.deepEqual(bm.filterItems(items, { project:'a' }).map(i=>i.id), ['1']); // cancelled hidden by default
  assert.deepEqual(bm.filterItems(items, { query:'thing' }).map(i=>i.id), ['2']);
  assert.deepEqual(bm.filterItems(items, { minPriority:1 }).map(i=>i.id), ['1']);
  assert.deepEqual(bm.filterItems(items, { project:'a', showCancelled:true }).map(i=>i.id), ['1','3']);
});

test('joinRunner marks ledger-tracked cards live and surfaces target as agent', () => {
  const items = [
    { id: 'glmps-1', state: 'in_progress', project: 'mc' },
    { id: 'glmps-2', state: 'queued', project: 'mc' },
  ];
  const runner = { ledger: { 'glmps-1': { pid: 4242, startedAt: 1, target: 'antigravity', retries: 0 } } };
  const out = bm.joinRunner(items, runner);
  assert.equal(out[0].live, true);
  assert.equal(out[0].agent, 'antigravity');
  assert.equal(out[1].live, undefined); // no ledger entry -> untouched
  assert.equal(out[1].agent, undefined);
});

test('joinRunner is pure and fail-soft on missing/empty runner', () => {
  const items = [{ id: 'a', state: 'queued' }];
  // No runner / no ledger -> items pass through unchanged
  assert.deepEqual(bm.joinRunner(items, null), items);
  assert.deepEqual(bm.joinRunner(items, {}), items);
  assert.deepEqual(bm.joinRunner(items, { ledger: {} }), items);
  assert.deepEqual(bm.joinRunner(undefined, { ledger: {} }), []);
  // Does not mutate the input array or its items
  const original = JSON.parse(JSON.stringify(items));
  bm.joinRunner(items, { ledger: { a: { target: 'vscode' } } });
  assert.deepEqual(items, original);
});

test('groupByLane none/project/priority', () => {
  const items = [
    { id:'1', project:'a', priority:2, state:'queued' },
    { id:'2', project:'b', priority:null, state:'queued' },
  ];
  assert.equal(bm.groupByLane(items, null).length, 1);
  assert.deepEqual(bm.groupByLane(items, 'project').map(l=>l.lane), ['a','b']);
  const byPri = bm.groupByLane(items, 'priority');
  assert.ok(byPri.find(l => l.lane === '2'));
});

test('dueStatus buckets', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  assert.equal(bm.dueStatus({}, now), null);
  assert.equal(bm.dueStatus({ dueDate: '2026-07-01' }, now), 'overdue');
  assert.equal(bm.dueStatus({ dueDate: '2026-07-04' }, now), 'soon');       // <48h
  assert.equal(bm.dueStatus({ dueDate: '2026-07-20' }, now), 'ok');
});

test('isBlocked mirrors runner semantics', () => {
  const byId = new Map([['glmps-1', { state: 'done' }], ['glmps-2', { state: 'queued' }]]);
  assert.equal(bm.isBlocked({ blockedBy: ['glmps-1'] }, byId), false);
  assert.equal(bm.isBlocked({ blockedBy: ['glmps-2'] }, byId), true);
  assert.equal(bm.isBlocked({ blockedBy: ['glmps-404'] }, byId), false);    // dangling
  assert.equal(bm.isBlocked({}, byId), false);
});

test('gateClass + archiveEta', () => {
  assert.equal(bm.gateClass(null), null);
  assert.equal(bm.gateClass({ status: 'PASS' }), 'gate-pass');
  assert.equal(bm.gateClass({ status: 'CONCERNS' }), 'gate-concerns');
  const now = Date.now();
  const DAY = 86400000;
  assert.equal(bm.archiveEta({ state: 'done', doneAt: new Date(now - 3 * DAY).toISOString() }, 7, now), 4);
  assert.equal(bm.archiveEta({ state: 'queued' }, 7, now), null);
  assert.equal(bm.archiveEta({ state: 'done', doneAt: new Date(now - 9 * DAY).toISOString() }, 7, now), 0);
  assert.equal(bm.archiveEta({ state: 'done', doneAt: 'garbage' }, 7, now), null); // malformed doneAt
});

test('archived column plumbing', () => {
  assert.deepEqual(bm.orderedColumns(true), ['held', 'queued', 'in_progress', 'in_review', 'idle', 'done', 'archived', 'cancelled']);
  assert.deepEqual(bm.orderedColumns(false), ['held', 'queued', 'in_progress', 'in_review', 'idle', 'done']);
  const g = bm.groupByColumn([{ state: 'archived', order: 1 }]);
  assert.equal(g.archived.length, 1);
  assert.deepEqual(bm.filterItems([{ state: 'archived', title: 'x' }], {}), []);
  assert.equal(bm.filterItems([{ state: 'archived', title: 'x' }], { showArchived: true }).length, 1);
});

test('idle is a first-class column between review and done', () => {
  assert.deepEqual(bm.ORDERED, ['held', 'queued', 'in_progress', 'in_review', 'idle', 'done']);
  const g = bm.groupByColumn([{ id: 'a', state: 'idle', order: 2 }, { id: 'b', state: 'idle', order: 1 }]);
  assert.deepEqual(g.idle.map((i) => i.id), ['b', 'a']);
  assert.ok(bm.orderedColumns(false).includes('idle'));
});

test('mergePauseText names a merge held on a red base, and nothing otherwise (glmps-2-0-runtime-125)', () => {
  assert.equal(bm.mergePauseText({ mergeRequest: { stage: 'requested', base: 'glmps2/main', redHold: 'abcdef1234' } }), 'merge paused: glmps2/main red at abcdef1');
  assert.equal(bm.mergePauseText({ mergeRequest: { stage: 'testing', base: 'main', redHold: 'abc' } }), null);
  assert.equal(bm.mergePauseText({ mergeRequest: { stage: 'requested', base: 'main' } }), null);
  assert.equal(bm.mergePauseText({}), null);
});

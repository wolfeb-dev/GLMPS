// server/test/request-info.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequest, listPending, resolveRequest } from '../lib/governance/request-info.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ri-'));

test('create -> list -> resolve round trip', () => {
  const state = tmp();
  const id = createRequest(state, { kind: 'test-kind', payload: { a: 1 }, actor: 'agent-1' });
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);

  const pending = listPending(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  assert.equal(pending[0].kind, 'test-kind');
  assert.deepEqual(pending[0].payload, { a: 1 });
  assert.equal(pending[0].actor, 'agent-1');
  assert.equal(pending[0].status, 'pending');

  const r = resolveRequest(state, id, { decision: 'approved', by: 'human-1' });
  assert.equal(r.resolved, true);
  assert.equal(r.id, id);
  assert.equal(r.kind, 'test-kind');
  assert.deepEqual(r.payload, { a: 1 });
  assert.equal(r.decision, 'approved');

  // resolved requests are not "pending" any more
  assert.equal(listPending(state).length, 0);
});

test('createRequest is persisted on disk as stateDir/requests/<id>.json', () => {
  const state = tmp();
  const id = createRequest(state, { kind: 'k', payload: { x: 1 } });
  assert.ok(fs.existsSync(path.join(state, 'requests', `${id}.json`)));
});

test('listPending filters by kind', () => {
  const state = tmp();
  createRequest(state, { kind: 'kind-a', payload: { v: 1 } });
  createRequest(state, { kind: 'kind-b', payload: { v: 2 } });
  assert.equal(listPending(state).length, 2);
  assert.equal(listPending(state, { kind: 'kind-a' }).length, 1);
  assert.equal(listPending(state, { kind: 'kind-a' })[0].kind, 'kind-a');
  assert.equal(listPending(state, { kind: 'nonexistent' }).length, 0);
});

test('dedup: identical (kind, payload) creates/overwrites the same pending id', () => {
  const state = tmp();
  const id1 = createRequest(state, { kind: 'dup', payload: { same: true, n: 1 } });
  const id2 = createRequest(state, { kind: 'dup', payload: { n: 1, same: true } }); // same content, different key order
  assert.equal(id1, id2);
  assert.equal(listPending(state, { kind: 'dup' }).length, 1);
});

test('an explicit id overrides the default content-address and is stable across calls', () => {
  const state = tmp();
  const id1 = createRequest(state, { kind: 'k', payload: { v: 1 }, id: 'my-fixed-id' });
  const id2 = createRequest(state, { kind: 'k', payload: { v: 2 }, id: 'my-fixed-id' }); // different payload, same explicit id
  assert.equal(id1, 'my-fixed-id');
  assert.equal(id2, 'my-fixed-id');
  const pending = listPending(state, { kind: 'k' });
  assert.equal(pending.length, 1, 'second create with the same explicit id overwrites, not duplicates');
  assert.deepEqual(pending[0].payload, { v: 2 });
});

test('restart-survival: a fresh read of the same stateDir still sees the pending request', () => {
  // The store has no in-memory cache - every call re-reads from disk, so
  // "restart" is simply calling listPending/resolveRequest against the same
  // stateDir from what is, for test purposes, a completely separate call
  // (simulating a new process that only knows the stateDir path).
  const state = tmp();
  const id = createRequest(state, { kind: 'resume-me', payload: { step: 1 } });

  // Simulate process restart: nothing survives except stateDir on disk.
  const reloaded = listPending(state, { kind: 'resume-me' });
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, id);

  const r = resolveRequest(state, id, { decision: 'approved', by: 'resumed-session' });
  assert.equal(r.resolved, true);
  assert.equal(listPending(state, { kind: 'resume-me' }).length, 0);
});

test('resolveRequest tolerates a missing id', () => {
  const state = tmp();
  const r = resolveRequest(state, 'nope', { decision: 'approved', by: 'x' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'missing');
});

test('listPending tolerates an empty/missing requests dir', () => {
  const state = tmp();
  assert.deepEqual(listPending(state), []);
});

test('listPending skips a malformed request file', () => {
  const state = tmp();
  createRequest(state, { kind: 'good', payload: { ok: true } });
  fs.mkdirSync(path.join(state, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(state, 'requests', 'broken.json'), '{ not valid json');
  const pending = listPending(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'good');
});

test('createRequest requires a kind', () => {
  const state = tmp();
  assert.throws(() => createRequest(state, { payload: {} }));
});

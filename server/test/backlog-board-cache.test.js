// Card glmps-2-0-runtime-65: a board change must not make every reader re-parse
// and re-serialize the whole board, and must say which cards changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/orchestration/backlog-store.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

import { bigBoard } from './helpers/big-board.js';

function mkState(board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bcache-')); tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backlog', 'store.json'), JSON.stringify(board));
  return dir;
}

test('readView parses once until the store changes', () => {
  const dir = mkState(bigBoard(20));
  const a = store.readView(dir);
  const b = store.readView(dir);
  assert.equal(a, b);
  store.appendDevLogIn(dir, 'glmps-3', { by: 'agent', text: 'hello' });
  const c = store.readView(dir);
  assert.notEqual(c, a);
  assert.equal(c.items.find((i) => i.id === 'glmps-3').devLog.at(-1).text, 'hello');
});

test('memoView shares one serialization between readers and drops it on a write', () => {
  const dir = mkState(bigBoard(20));
  let calls = 0;
  const make = () => { calls++; return JSON.stringify({ n: calls }); };
  const x = store.memoView(dir, 'full', make);
  const y = store.memoView(dir, 'full', make);
  assert.equal(x, y);
  assert.equal(calls, 1);
  store.appendDevLogIn(dir, 'glmps-3', { by: 'agent', text: 'x' });
  store.memoView(dir, 'full', make);
  assert.equal(calls, 2);
});

test('takeChanges names exactly the cards a save touched, and bumps the version', () => {
  const dir = mkState(bigBoard(30));
  const v0 = store.boardVersion(dir);
  store.appendDevLogIn(dir, 'glmps-3', { by: 'agent', text: 'one' });
  const first = store.takeChanges(dir);
  assert.deepEqual(first.ids, ['glmps-3']);
  assert.ok(first.version > v0);

  store.appendDevLogIn(dir, 'glmps-4', { by: 'agent', text: 'two' });
  store.appendDevLogIn(dir, 'glmps-5', { by: 'agent', text: 'three' });
  const second = store.takeChanges(dir);
  assert.deepEqual([...second.ids].sort(), ['glmps-4', 'glmps-5']);
  assert.equal(second.prev, first.version);
  assert.equal(second.version, store.boardVersion(dir));

  const none = store.takeChanges(dir);
  assert.deepEqual(none.ids, []);
  assert.equal(none.prev, none.version);

  store.removeItemIn(dir, 'glmps-6');
  assert.deepEqual(store.takeChanges(dir).ids, ['glmps-6']);
});

test('a write by another process makes the change unnameable', () => {
  const dir = mkState(bigBoard(10));
  store.appendDevLogIn(dir, 'glmps-3', { by: 'agent', text: 'one' });
  store.takeChanges(dir);
  const f = path.join(dir, 'backlog', 'store.json');
  fs.writeFileSync(f, JSON.stringify(bigBoard(11)));
  assert.equal(store.takeChanges(dir).ids, null);
});

test('itemsByIds returns the live cards and names the ones that are gone', () => {
  const dir = mkState(bigBoard(10));
  const r = store.itemsByIds(dir, ['glmps-2', 'glmps-nope']);
  assert.deepEqual(r.items.map((i) => i.id), ['glmps-2']);
  assert.deepEqual(r.removed, ['glmps-nope']);
});

test('countsByState is cached per version', () => {
  const dir = mkState(bigBoard(10));
  const a = store.countsByState(dir);
  assert.equal(a.queued, 2);
  assert.equal(store.countsByState(dir), a);
  store.updateItemIn(dir, 'glmps-1', { state: 'queued' });
  assert.equal(store.countsByState(dir).queued, 3);
});

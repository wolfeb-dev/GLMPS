import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainedJobIds, RETAIN_MS, RECORDED_RETAIN_MS } from '../lib/scut/ticket-retention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23);
const card = (id, outcome) => ({
  id, state: 'idle', stateEnteredAt: NOW - 5 * DAY,
  runSession: { worktree: { dir: `/w/${id}`, branch: `b/${id}` }, ...(outcome ? { outcome: { branch: `b/${id}`, dir: `/w/${id}` } } : {}) },
});

test('retention is 3 days once the outcome record exists, 30 before', () => {
  assert.equal(RECORDED_RETAIN_MS, 3 * DAY);
  assert.equal(RETAIN_MS, 30 * DAY);
  const kept = retainedJobIds({ items: [card('with', true), card('without', false)], now: NOW });
  assert.equal(kept.has('with'), false, 'recorded 5 days ago: past 3 days');
  assert.equal(kept.has('without'), true, 'no record: still the 30 day lease');
});

test('a recorded card inside 3 days is still retained', () => {
  const c = { ...card('fresh', true), stateEnteredAt: NOW - 1 * DAY };
  assert.equal(retainedJobIds({ items: [c], now: NOW }).has('fresh'), true);
});

// server/lib/scut/progress-store.js
//
// Where a job's declared plan and its last posted check-in live.
//
// NOT the runner ledger, and that is the whole point of this file. The first
// version of this stored both on the ledger entry, and the integration test
// caught it immediately: the runner tick does its own read-modify-write of the
// ledger every few seconds, so a declaration written by the HTTP route was
// clobbered by the next reconcile before the progress tick ever saw it. Two
// writers, one file, last write wins - the same shape as the collisions this
// project keeps re-learning.
//
// A separate small file has no such contention: the progress tick and the
// declare route are its only writers, and they are both in-process.
//
// Atomic tmp+rename, tolerant of a missing or corrupt file, mirroring
// room-mapper.js and runner-store.js.
//
// Zero runtime dependencies.
import path from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';

export function progressPath(stateDir) {
  return path.join(stateDir, 'scut', 'progress.json');
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Strict: declare/record/clear are read-modify-write, so a failed read throws
// rather than becoming an empty store that erases every ticket's plan.
function readStore(file) {
  return readJsonStore(file, { fallback: () => ({}), validate: isObject });
}

function writeStore(file, obj) {
  writeJsonStore(file, obj);
}

/** Every tracked ticket: { [ticketId]: { plan, posted } }. */
export function readProgress(stateDir) {
  return readJsonStoreOrDegrade(progressPath(stateDir), { fallback: () => ({}), validate: isObject });
}

/**
 * Declare (or re-declare) the plan a ticket's progress is measured by. Clears
 * any previously posted state so a newly declared plan reports once promptly
 * rather than inheriting the old plan's throttle.
 */
export function declarePlan(stateDir, ticketId, plan) {
  const file = progressPath(stateDir);
  const store = readStore(file);
  store[ticketId] = { plan, posted: null };
  writeStore(file, store);
  return store[ticketId];
}

/** Record what was just posted, so the next tick can throttle against it. */
export function recordPosted(stateDir, ticketId, posted) {
  const file = progressPath(stateDir);
  const store = readStore(file);
  if (!store[ticketId]) return null;
  store[ticketId] = { ...store[ticketId], posted };
  writeStore(file, store);
  return store[ticketId];
}

/** Stop tracking a ticket (its job finished). */
export function clearProgress(stateDir, ticketId) {
  const file = progressPath(stateDir);
  const store = readStore(file);
  if (!(ticketId in store)) return false;
  delete store[ticketId];
  writeStore(file, store);
  return true;
}

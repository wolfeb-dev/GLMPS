import fs from 'node:fs';
import path from 'node:path';

export function replayFile(stateDir) {
  return path.join(stateDir, 'replay', 'tasks.json');
}

export function load(stateDir) {
  try { return { tasks: [], ...JSON.parse(fs.readFileSync(replayFile(stateDir), 'utf-8')) }; }
  catch { return { tasks: [] }; }
}

export function save(stateDir, state) {
  const f = replayFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

export function addReplayTask(stateDir, { id, project = null, promptFile = null, baseline = null } = {}) {
  const state = load(stateDir);
  const existing = state.tasks.find(t => t.id === id);
  if (existing) return { task: existing, isNew: false };
  const task = { id, project, promptFile, baseline, createdAt: new Date().toISOString() };
  const next = { ...state, tasks: [...state.tasks, task] };
  save(stateDir, next);
  return { task, isNew: true };
}

export function listReplayTasks(stateDir) {
  return load(stateDir).tasks;
}

/**
 * refreshReplayBaseline(stateDir, id, baseline) - glmps-26.
 *
 * addReplayTask() only ever sets a baseline ONCE (a no-op re-call on an
 * existing id) - there was no way to re-freeze a task's baseline from a
 * later known-good run once the task existed, so a legitimately improved
 * "known good" state could never become the new comparison point; every
 * future run stayed scored against a stale baseline forever.
 *
 * Unlike addReplayTask, this REQUIRES the task to already exist (returns
 * `{ task: null }` otherwise - the route layer turns that into a 404) and
 * always overwrites `baseline`, stamping `baselineRefreshedAt` for an audit
 * trail distinct from the task's original `createdAt`.
 *
 * @param {string} stateDir
 * @param {string} id
 * @param {object} baseline  a real OutcomeRow the caller has already chosen
 *   (the route layer picks it from readOutcomes(), never accepts an
 *   arbitrary caller-supplied object as a substitute for a recorded run)
 */
export function refreshReplayBaseline(stateDir, id, baseline) {
  const state = load(stateDir);
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx === -1) return { task: null };
  const task = { ...state.tasks[idx], baseline, baselineRefreshedAt: new Date().toISOString() };
  const nextTasks = state.tasks.slice();
  nextTasks[idx] = task;
  save(stateDir, { ...state, tasks: nextTasks });
  return { task };
}

// Runner prompt files are pruned 14 days after their card closes (card
// glmps-2-0-runtime-152). Temp dirs only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prunePromptFiles, cardIdOfPrompt, PROMPT_RETENTION_MS } from '../lib/orchestration/prompt-retention.js';
import { startServer } from '../server.js';

const roots = [];
after(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } });

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);
const ago = (d) => new Date(NOW - d * DAY).toISOString();

function mkState() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prompt-ret-')));
  roots.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'runner'), { recursive: true });
  return stateDir;
}
const put = (stateDir, name, text = 'x') => fs.writeFileSync(path.join(stateDir, 'runner', name), text);
const has = (stateDir, name) => fs.existsSync(path.join(stateDir, 'runner', name));

test('retention is 14 days', () => {
  assert.equal(PROMPT_RETENTION_MS, 14 * DAY);
});

test('a prompt file maps to its card, review prompts to the reviewed card, longest id first', () => {
  const ids = new Set(['glmps-2-0-1', 'glmps-2-0-12', 'glmps-7']);
  assert.equal(cardIdOfPrompt('glmps-2-0-12.prompt.md', ids), 'glmps-2-0-12');
  assert.equal(cardIdOfPrompt('glmps-2-0-1.prompt.md', ids), 'glmps-2-0-1');
  assert.equal(cardIdOfPrompt('glmps-2-0-12-review-r2.prompt.md', ids), 'glmps-2-0-12');
  assert.equal(cardIdOfPrompt('GLMPS-7.prompt.md', ids), 'glmps-7');
  assert.equal(cardIdOfPrompt('glmps-2-0-99.prompt.md', ids), null);
  assert.equal(cardIdOfPrompt('glmps-2-0-12.txt', ids), null);
});

test('an orphaned prompt never maps to an unrelated card whose id is a prefix of its own', () => {
  const ids = new Set(['glmps-2', 'glmps-2-0-12']);
  assert.equal(cardIdOfPrompt('glmps-2-0-runtime-150.prompt.md', ids), null);
  assert.equal(cardIdOfPrompt('glmps-2-0-99.prompt.md', ids), null);
  assert.equal(cardIdOfPrompt('glmps-2-0-12-extra.prompt.md', ids), null);
  assert.equal(cardIdOfPrompt('glmps-2-review-r3.prompt.md', ids), 'glmps-2');
  assert.equal(cardIdOfPrompt('glmps-2-0-12-review-r12.prompt.md', ids), 'glmps-2-0-12');

  const stateDir = mkState();
  put(stateDir, 'glmps-2-0-runtime-150.prompt.md');
  const r = prunePromptFiles({ stateDir, items: [{ id: 'glmps-2', state: 'done', stateEnteredAt: ago(30) }], now: () => NOW });
  assert.deepEqual(r.pruned, []);
  assert.equal(has(stateDir, 'glmps-2-0-runtime-150.prompt.md'), true);
});

test('AC-1: closed cards older than 14 days lose their prompt files, open and recent cards keep theirs', () => {
  const stateDir = mkState();
  const items = [
    { id: 'c-done-old', state: 'done', doneAt: ago(15), stateEnteredAt: ago(15) },
    { id: 'c-cancel-old', state: 'cancelled', stateEnteredAt: ago(20) },
    { id: 'c-arch-old', state: 'archived', stateEnteredAt: ago(30) },
    { id: 'c-done-new', state: 'done', doneAt: ago(13), stateEnteredAt: ago(13) },
    { id: 'c-open', state: 'in_progress', updatedAt: ago(90) },
    { id: 'c-queued', state: 'queued', updatedAt: ago(90) },
    { id: 'c-idle', state: 'idle', stateEnteredAt: ago(90) },
    { id: 'c-noclose', state: 'done' },
  ];
  for (const n of ['c-done-old.prompt.md', 'c-done-old-review-r1.prompt.md', 'c-cancel-old.prompt.md', 'c-arch-old.prompt.md',
    'c-done-new.prompt.md', 'c-open.prompt.md', 'c-queued.prompt.md', 'c-idle.prompt.md', 'c-noclose.prompt.md',
    'c-unknown.prompt.md', 'config.json', 'launched.json']) put(stateDir, n);
  fs.mkdirSync(path.join(stateDir, 'runner', 'dir-old.prompt.md'));

  const r = prunePromptFiles({ stateDir, items, now: () => NOW });

  assert.deepEqual(r.pruned.map((p) => path.basename(p)).sort(),
    ['c-arch-old.prompt.md', 'c-cancel-old.prompt.md', 'c-done-old-review-r1.prompt.md', 'c-done-old.prompt.md']);
  for (const n of ['c-done-old.prompt.md', 'c-done-old-review-r1.prompt.md', 'c-cancel-old.prompt.md', 'c-arch-old.prompt.md']) assert.equal(has(stateDir, n), false, n);
  for (const n of ['c-done-new.prompt.md', 'c-open.prompt.md', 'c-queued.prompt.md', 'c-idle.prompt.md', 'c-noclose.prompt.md',
    'c-unknown.prompt.md', 'config.json', 'launched.json', 'dir-old.prompt.md']) assert.equal(has(stateDir, n), true, n);
  assert.equal(r.kept, 6);
});

test('a missing runner folder is nothing to do', () => {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prompt-ret-')));
  roots.push(stateDir);
  assert.deepEqual(prunePromptFiles({ stateDir, items: [], now: () => NOW }), { pruned: [], kept: 0 });
});

test('the retention loop is registered, prunes an aged closed card and its checker passes', async () => {
  const stateDir = mkState();
  const claudeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-')));
  roots.push(claudeDir);
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog', 'store.json'), JSON.stringify({ items: [
    { id: 'p-1', project: 'p', title: 't', prompt: 'x', state: 'done', doneAt: ago(40), stateEnteredAt: ago(40), updatedAt: ago(40), createdAt: ago(41) },
    { id: 'p-2', project: 'p', title: 't', prompt: 'x', state: 'queued', updatedAt: ago(40), createdAt: ago(41) },
  ] }));
  put(stateDir, 'p-1.prompt.md'); put(stateDir, 'p-2.prompt.md');
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, '{}');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  try {
    assert.equal(h.loopRegistry.snapshot()['runner-prompt-retention'].sla.maxAgeMs, 3 * DAY);
    const first = await h.loopRegistry.runNow('runner-prompt-retention');
    assert.equal(first.outcome, 'done', JSON.stringify(first));
    assert.equal(has(stateDir, 'p-1.prompt.md'), false);
    assert.equal(has(stateDir, 'p-2.prompt.md'), true);
    assert.equal((await h.loopRegistry.runNow('runner-prompt-retention')).outcome, 'nothing-to-do');
  } finally { await h.close?.(); }
});

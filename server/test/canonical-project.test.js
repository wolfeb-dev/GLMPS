// The canonical-project table (card glmps-2-0-runtime-151): one config entry
// decides where board intake, Slack routing, the runner's checkout lookup and
// every auto-filer send 2.0 work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CANONICAL_PROJECT_DEFAULTS, canonicalTable, resolveProject, autoFiledProject, makeAutoFiler, checkoutForProject,
} from '../lib/orchestration/canonical-project.js';
import { projectForChannelName } from '../lib/scut/channel-map.js';
import { configDefaults } from '../lib/config-defaults.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { handleLoopStreak, handleFreshnessExpiry } from '../lib/loops/auto-diagnosis.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOTS = ['D:/glmps-2.0-runtime', 'D:/glmps-2.0', 'D:/glmps', 'D:/Harbor-App'];

test('AC-1: every old 2.0 project name and the glmps channel resolve to the configured target', () => {
  const cfg = configDefaults();
  assert.equal(cfg.canonicalProject.target, 'glmps-2.0-runtime');
  const file = path.join(tmp('canon-ch-'), 'channels.json');
  for (const name of ['glmps-2.0-runtime', 'glmps-2', 'glmps-2-0', 'glmps', ' GLMPS-2 ']) {
    assert.equal(resolveProject(name, cfg.canonicalProject), 'glmps-2.0-runtime', name);
  }
  assert.equal(projectForChannelName('glmps', { file, table: cfg.canonicalProject }), 'glmps-2.0-runtime');
});

test('names match exactly, never by slug: the corpus project glmps-2.0 is not folded in before the flip', () => {
  assert.equal(resolveProject('glmps-2.0'), 'glmps-2.0');
  assert.equal(resolveProject('Harbor-App'), 'Harbor-App');
  // Built so the public mirror's rename (which turns this name into a canonical
  // one) leaves it alone: the assertion is about the legacy name itself.
  const legacy = ['mission', 'control'].join('-');
  assert.equal(resolveProject(legacy), legacy);
  assert.equal(checkoutForProject(ROOTS, 'glmps-2.0'), 'D:/glmps-2.0');
  assert.equal(checkoutForProject(ROOTS, 'harbor-app'), 'D:/Harbor-App');
});

test('a partial or malformed config keeps the shipped defaults field by field', () => {
  assert.deepEqual(canonicalTable(undefined), { target: 'glmps-2.0-runtime', names: [...CANONICAL_PROJECT_DEFAULTS.names], intakeDefault: false });
  assert.deepEqual(canonicalTable({ canonicalProject: { target: '  ' } }).target, 'glmps-2.0-runtime');
  assert.deepEqual(canonicalTable({ canonicalProject: { target: 'glmps-2.0' } }).names, [...CANONICAL_PROJECT_DEFAULTS.names]);
});

test('AC-3: no auto-filer lands in glmps or default', () => {
  for (const p of [undefined, null, '', '  ', 'default', 'glmps', 'GLMPS', 'glmps-2']) {
    assert.equal(autoFiledProject(p), 'glmps-2.0-runtime', String(p));
  }
  assert.equal(autoFiledProject('Harbor-App'), 'Harbor-App', 'another repo keeps its own project');
});

test('AC-3: the loop auto-diagnosis paths file into the target even when told glmps or nothing', async () => {
  const stateDir = tmp('canon-diag-');
  const fileCard = makeAutoFiler((input) => backlogStore.addItemTo(stateDir, input, { trust: 'operator' }));
  const record = { name: 'demo-loop', consecutiveFailures: 3, streakStartTs: Date.now(), lastReason: 'boom' };
  const chatCompletion = async () => 'diagnosis text';
  await handleLoopStreak({ name: 'demo-loop', record, stateDir, cfg: { enabled: true, maxPerDay: 10, project: 'glmps' }, chatCompletion, fileCard });
  await handleFreshnessExpiry({ row: { id: 'obl_x', dueTs: Date.now() }, record: { ...record, name: 'other-loop' }, stateDir, cfg: undefined, chatCompletion, fileCard });
  const items = backlogStore.load(stateDir).items;
  assert.equal(items.length, 2);
  for (const i of items) {
    assert.equal(i.project, 'glmps-2.0-runtime');
    assert.match(i.id, /^glmps-2-0-runtime-\d+$/);
  }
});

test('AC-4: flipping the target moves intake, routing and runner lookup together', () => {
  const file = path.join(tmp('canon-flip-'), 'channels.json');
  const flipped = canonicalTable({ canonicalProject: { ...configDefaults().canonicalProject, target: 'glmps-2.0' } });
  for (const [table, want, checkout] of [[configDefaults().canonicalProject, 'glmps-2.0-runtime', 'D:/glmps-2.0-runtime'], [flipped, 'glmps-2.0', 'D:/glmps-2.0']]) {
    const intake = backlogStore.addItem(backlogStore.emptyState(), { project: 'glmps-2', title: 't' }, { resolveProject: (p) => resolveProject(p, table) }).item;
    assert.equal(intake.project, want, 'intake');
    assert.equal(projectForChannelName('glmps', { file, table }), want, 'routing');
    assert.equal(checkoutForProject(ROOTS, 'glmps-2.0-runtime', table), checkout, 'runner lookup');
    assert.equal(makeAutoFiler((c) => c, table)({ title: 'x' }).project, want, 'auto-filer');
  }
});

test('AC-6: resolution never rewrites a stored card id or project', () => {
  let s = backlogStore.emptyState();
  s = { ...s, items: [{ ...backlogStore.addItem(s, { project: 'glmps-2', title: 'old' }).item }] };
  const before = JSON.stringify(s.items);
  const r = backlogStore.addItem(s, { project: 'glmps-2', title: 'new' }, { resolveProject: (p) => resolveProject(p) });
  assert.equal(JSON.stringify(r.state.items.slice(0, 1)), before);
  assert.equal(r.state.items[0].id, 'glmps-2-1');
  assert.match(r.item.id, /^glmps-2-0-runtime-\d+$/);
});

test('intakeDefault (cutover) sends a filing with no project to the target; off by default', () => {
  const on = canonicalTable({ canonicalProject: { target: 'glmps-2.0', intakeDefault: true } });
  for (const p of ['', '  ', 'default', 'Default']) {
    assert.equal(resolveProject(p, on), 'glmps-2.0', JSON.stringify(p));
    assert.equal(resolveProject(p), p, `off by default: ${JSON.stringify(p)}`);
  }
  assert.equal(resolveProject('Harbor-App', on), 'Harbor-App');
  assert.equal(canonicalTable({ canonicalProject: { intakeDefault: 'yes' } }).intakeDefault, false, 'only a boolean counts');
  const intake = backlogStore.addItem(backlogStore.emptyState(), { title: 'no project' }, { resolveProject: (p) => resolveProject(p, on) }).item;
  assert.equal(intake.project, 'glmps-2.0');
  assert.match(intake.id, /^glmps-2-0-\d+$/);
});

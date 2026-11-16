// server/test/huddle-bench-stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, classifyCall, isColdRow, medianWithFailures, latencyCell, summarizeModel, verdictLines, scrub } from '../../scripts/lib/huddle-bench-stats.mjs';
import { loadPersonas } from '../lib/huddle/roster.js';
import { addressedPersona } from '../lib/huddle/floor.js';
import { resolveTheme } from '../lib/scut/bobiverse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const turns = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'huddle-floor-turns.json'), 'utf8'));

test('the bar is exactly the pre-registered one', () => {
  assert.deepEqual({ ...BAR }, { nameMs: 1500, leadMs: 2500, floorOk: 8, floorOf: 10 });
});

test('fixture: unaddressed turns name nobody, addressed turns name exactly the expected persona', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fixture-'));
  const personas = loadPersonas({ agentsDir, theme: resolveTheme(false) });
  assert.equal(turns.length, 20);
  for (const t of turns) {
    const got = addressedPersona(t.text, personas);
    if (t.addressed) assert.equal(got?.id, t.expected[0], t.text);
    else assert.equal(got, null, t.text);
  }
  assert.equal(turns.filter((t) => !t.addressed).length, 10);
});

test('classifyCall: empty text and errors are failures, text is not', () => {
  assert.deepEqual(classifyCall({ text: 'Fine.' }), { failed: false, error: null });
  assert.equal(classifyCall({ text: '   ' }).failed, true);
  assert.equal(classifyCall({ text: '' }).failed, true);
  assert.equal(classifyCall(null).failed, true);
  assert.deepEqual(classifyCall(null, new Error('boom')), { failed: true, error: 'boom' });
});

test('scrub removes the api key from an error message', () => {
  assert.equal(scrub('bad key sk-secret here', 'sk-secret'), 'bad key [redacted] here');
  assert.equal(scrub('plain', ''), 'plain');
});

test('isColdRow: cold if the floor call OR the mind call was cold', () => {
  assert.equal(isColdRow({ floorCold: false, mindCold: false }), false);
  assert.equal(isColdRow({ floorCold: true, mindCold: false }), true);
  assert.equal(isColdRow({ floorCold: false, mindCold: true }), true);
});

test('medianWithFailures: a failure counts as infinite time in the denominator', () => {
  assert.equal(medianWithFailures([100, 200, 300]), 200);
  assert.equal(medianWithFailures([100, Infinity, Infinity]), Infinity);
  assert.equal(medianWithFailures([100, 200, Infinity]), 200);
  assert.ok(Number.isNaN(medianWithFailures([])));
});

const row = (o) => ({ model: 'm', path: 'name', cold: false, failed: false, total: 100, ...o });

test('latencyCell excludes cold rows but keeps failed rows, which make the cell miss', () => {
  const rows = [row({ cold: true, total: 9999 }), row({ total: 100 }), row({ total: 200 }), row({ failed: true, total: Infinity }), row({ failed: true, total: Infinity })];
  const c = latencyCell(rows, 'm', 'name', 1500);
  assert.equal(c.n, 4);
  assert.equal(c.failed, 2);
  assert.equal(c.pass, false);
  assert.equal(latencyCell([row({ total: 100 }), row({ total: 900 })], 'm', 'name', 1500).pass, true);
  assert.equal(latencyCell([], 'm', 'name', 1500).pass, false);
});

const okRows = (model, name, lead) => [row({ model, path: 'name', total: name }), row({ model, path: 'lead', total: lead })];
const floors = (model, okN) => Array.from({ length: 10 }, (_, i) => ({ model, ok: i < okN }));

test('summarizeModel: latency pass alone is not enough, the floor must also reach 8 of 10', () => {
  const rows = okRows('m', 1000, 2000);
  assert.equal(summarizeModel({ rows, floorResults: floors('m', 8), model: 'm' }).pass, true);
  const miss = summarizeModel({ rows, floorResults: floors('m', 7), model: 'm' });
  assert.equal(miss.latencyPass, true);
  assert.equal(miss.floor.pass, false);
  assert.equal(miss.pass, false);
  assert.equal(summarizeModel({ rows: okRows('m', 1600, 2000), floorResults: floors('m', 10), model: 'm' }).pass, false);
});

test('summarizeModel judges the floor per model sweep, not only the first', () => {
  const rows = [...okRows('a', 1000, 2000), ...okRows('b', 1000, 2000)];
  const fl = [...floors('a', 10), ...floors('b', 3)];
  assert.equal(summarizeModel({ rows, floorResults: fl, model: 'a' }).pass, true);
  assert.equal(summarizeModel({ rows, floorResults: fl, model: 'b' }).pass, false);
});

test('verdictLines: plan pass, plan miss naming the part, plan not run, api included', () => {
  const pass = [summarizeModel({ rows: okRows('haiku', 800, 1500), floorResults: floors('haiku', 9), model: 'haiku' })];
  const floorMiss = [summarizeModel({ rows: okRows('haiku', 800, 1500), floorResults: floors('haiku', 5), model: 'haiku' })];
  const latMiss = [summarizeModel({ rows: okRows('opus', 3000, 4000), floorResults: floors('opus', 9), model: 'opus' })];
  const text = (v) => verdictLines(v).join('\n');

  assert.match(text({ plan: pass, api: null }), /meets the bar with `haiku`/);
  const fm = text({ plan: floorMiss, api: null });
  assert.match(fm, /PLAN PATH MISSES THE BAR: stop and ask the operator/);
  assert.match(fm, /floor/);
  assert.doesNotMatch(fm, /latency \(/);
  const lm = text({ plan: latMiss, api: null });
  assert.match(lm, /PLAN PATH MISSES THE BAR/);
  assert.match(lm, /latency \(opus\)/);
  const none = text({ plan: null, api: pass });
  assert.match(none, /plan arm not run/i);
  assert.doesNotMatch(none, /PLAN PATH MISSES/);
  assert.match(none, /api arm/i);
  assert.match(text({ plan: pass, api: floorMiss }), /api arm: MISS/);
});

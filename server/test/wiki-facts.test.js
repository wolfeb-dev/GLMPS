// server/test/wiki-facts.test.js
// The facts the admin reference tables are generated from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configFacts, routeFacts, loopFacts, taskFacts, envFacts, factTable, extractFacts, FACT_KINDS,
} from '../lib/observability/wiki-facts.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('configFacts flattens one level and sorts by key', () => {
  const rows = configFacts({
    zeta: 1,
    alpha: { everyMs: 60000, nested: { deep: true } },
    list: [1, 2],
    empty: {},
    name: 'x',
    nothing: null,
  });
  assert.deepEqual(rows, [
    { key: 'alpha.everyMs', value: '60000' },
    { key: 'alpha.nested', value: '{"deep":true}' },
    { key: 'empty', value: '{}' },
    { key: 'list', value: '[1,2]' },
    { key: 'name', value: '"x"' },
    { key: 'nothing', value: 'null' },
    { key: 'zeta', value: '1' },
  ]);
});

test('configFacts shortens a long value to 80 characters', () => {
  const [row] = configFacts({ k: 'x'.repeat(200) });
  assert.equal(row.value.length, 80);
  assert.ok(row.value.endsWith('...'));
});

test('configFacts of nothing is empty', () => {
  assert.deepEqual(configFacts(undefined), []);
  assert.deepEqual(configFacts({}), []);
});

test('routeFacts finds a pathname test with the method on the same line', () => {
  assert.deepEqual(routeFacts("if (u.pathname === '/api/a' && req.method === 'GET') {"), [{ method: 'GET', path: '/api/a' }]);
});

test('routeFacts finds a pathname test with the method on a following line, or ANY without one', () => {
  const src = [
    "if (u.pathname === '/api/b') {",
    "  if (req.method === 'POST') {}",
    '}',
    '', '', '',
    "if (u.pathname === '/api/c') {",
    '  return;',
    '}',
  ].join('\n');
  assert.deepEqual(routeFacts(src), [{ method: 'POST', path: '/api/b' }, { method: 'ANY', path: '/api/c' }]);
});

test('routeFacts converts a pathname.match regex to :id form', () => {
  const src = [
    "if (u.pathname.match(/^\\/api\\/items\\/([^/]+)$/)) {",
    "  if (req.method === 'DELETE') {}",
    '}',
    "const m = u.pathname.match(/^\\/api\\/a\\/([^/]+)\\/b\\/([^/]+)$/); // req.method === 'PUT'",
  ].join('\n');
  assert.deepEqual(routeFacts(src), [
    { method: 'PUT', path: '/api/a/:id/b/:p2' },
    { method: 'DELETE', path: '/api/items/:id' },
  ]);
});

test('routeFacts finds registerRoute({ method, pattern })', () => {
  const src = "registerRoute({ method: 'GET', pattern: '/api/z' });\nregisterRoute({\n  method: 'POST', pattern: '/api/y',\n});";
  assert.deepEqual(routeFacts(src), [{ method: 'POST', path: '/api/y' }, { method: 'GET', path: '/api/z' }]);
});

test('routeFacts de-duplicates, keeps a path under each of its methods, sorts, and skips non-paths', () => {
  const src = [
    "if (u.pathname === '/api/a' && req.method === 'GET') {}",
    "if (u.pathname === '/api/a' && req.method === 'GET') {}",
    "if (u.pathname === '/api/a' && req.method === 'POST') {}",
    "registerRoute({ method: 'GET', pattern: '/api/a' });",
    "if (u.pathname === 'not-a-path' && req.method === 'GET') {}",
    "if (u.pathname === '/aaa' && req.method === 'GET') {}",
  ].join('\n');
  assert.deepEqual(routeFacts(src), [
    { method: 'GET', path: '/aaa' },
    { method: 'GET', path: '/api/a' },
    { method: 'POST', path: '/api/a' },
  ]);
});

test('routeFacts of an empty source is empty', () => {
  assert.deepEqual(routeFacts(''), []);
  assert.deepEqual(routeFacts(undefined), []);
});

function loopsDir(files) {
  const stateDir = tmp('mc-facts-loops-');
  fs.mkdirSync(path.join(stateDir, 'loops'));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(stateDir, 'loops', f), typeof body === 'string' ? body : JSON.stringify(body));
  return stateDir;
}

test('loopFacts reads name, trigger and freshness, sorted by name', () => {
  const stateDir = loopsDir({
    'wiki.json': { name: 'wiki', trigger: { everyMs: 6 * 3600000 }, sla: { maxAgeMs: 36 * 3600000 } },
    'a-minutes.json': { name: 'a-minutes', trigger: { everyMs: 120000 } },
    'seconds.json': { name: 'seconds', trigger: { everyMs: 90000 } },
    'evt.json': { name: 'evt', trigger: { onEvent: 'session.end' } },
    'ext.json': { name: 'ext', trigger: { external: 'webhook' } },
    'man.json': { name: 'man', trigger: {} },
  });
  assert.deepEqual(loopFacts(stateDir), [
    { name: 'a-minutes', trigger: 'every 2 min', sla: '' },
    { name: 'evt', trigger: 'on session.end', sla: '' },
    { name: 'ext', trigger: 'external: webhook', sla: '' },
    { name: 'man', trigger: 'manual', sla: '' },
    { name: 'seconds', trigger: 'every 90 s', sla: '' },
    { name: 'wiki', trigger: 'every 6 h', sla: 'fresh within 36 h' },
  ]);
});

test('loopFacts skips a file without a trigger, an unparsable file and a non-json file', () => {
  const stateDir = loopsDir({
    'budget.json': { name: 'budget', spent: 3 },
    'broken.json': '{ nope',
    'notes.txt': 'hello',
    'real.json': { name: 'real', trigger: { everyMs: 3600000 } },
  });
  assert.deepEqual(loopFacts(stateDir).map(r => r.name), ['real']);
});

test('loopFacts returns [] for a missing loops dir or no state dir', () => {
  assert.deepEqual(loopFacts(tmp('mc-facts-empty-')), []);
  assert.deepEqual(loopFacts(null), []);
});

test('taskFacts reads TaskName and turns -Daily/-At into plain text', () => {
  const text = [
    "param(",
    "  [string]$TaskName = 'GLMPS Nightly Run',",
    "  [string]$At       = '10pm'",
    ")",
    '$trigger = New-ScheduledTaskTrigger -Daily -At $At',
  ].join('\n');
  assert.deepEqual(taskFacts([{ path: 'scripts/n.ps1', text }]), [{ name: 'GLMPS Nightly Run', trigger: 'daily at 10pm', script: 'scripts/n.ps1' }]);
});

test('taskFacts says "daily" when no time is parameterised', () => {
  const text = "[string]$TaskName = 'T'\n$t = New-ScheduledTaskTrigger -Daily -At 3am\n";
  assert.equal(taskFacts([{ path: 'a.ps1', text }])[0].trigger, 'daily');
});

test('taskFacts turns -RepetitionInterval minutes into "every N min"', () => {
  const text = [
    "[string]$TaskName = 'GLMPS2 Watchdog'",
    '$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)',
  ].join('\n');
  assert.equal(taskFacts([{ path: 'w.ps1', text }])[0].trigger, 'every 5 min');
});

test('taskFacts keeps an unrecognised trigger as written, skips scripts without a TaskName, and sorts', () => {
  const logon = "[string]$TaskName = 'B logon'\n$t = New-ScheduledTaskTrigger   -AtLogOn   -User x\n";
  const rows = taskFacts([
    { path: 'none.ps1', text: 'Write-Host hi' },
    { path: 'b.ps1', text: logon },
    { path: 'a.ps1', text: "[string]$TaskName = 'A'\nNew-ScheduledTaskTrigger -Daily\n" },
  ]);
  assert.deepEqual(rows.map(r => r.name), ['A', 'B logon']);
  assert.equal(rows[1].trigger, '-AtLogOn -User x');
});

test('envFacts finds process.env and env names, groups the files per name, and sorts', () => {
  const rows = envFacts([
    { path: 'b.js', text: 'const a = process.env.GLMPS_STATE_DIR; const { x } = env.GLMPS_PORT;' },
    { path: 'a.js', text: 'process.env.GLMPS_STATE_DIR; process.env.lower; process.env.AB; env.NODE_ENV' },
  ]);
  assert.deepEqual(rows, [
    { name: 'GLMPS_PORT', files: 'b.js' },
    { name: 'GLMPS_STATE_DIR', files: 'a.js, b.js' },
    { name: 'NODE_ENV', files: 'a.js' },
  ]);
});

test('factTable shapes each kind with the identifier in the first column', () => {
  const facts = {
    config: [{ key: 'a.b', value: '1' }],
    routes: [{ method: 'GET', path: '/x' }],
    loops: [{ name: 'wiki', trigger: 'every 6 h', sla: 'fresh within 36 h' }],
    tasks: [{ name: 'T', trigger: 'daily', script: 's.ps1' }],
    env: [{ name: 'GLMPS_X', files: 'a.js' }],
  };
  assert.deepEqual(factTable('config', facts), { title: 'Configuration keys', columns: ['Key', 'Default'], rows: [['a.b', '1']] });
  assert.deepEqual(factTable('routes', facts), { title: 'Routes', columns: ['Path', 'Method'], rows: [['/x', 'GET']] });
  assert.deepEqual(factTable('loops', facts), { title: 'Loops', columns: ['Loop', 'Runs', 'Expected freshness'], rows: [['wiki', 'every 6 h', 'fresh within 36 h']] });
  assert.deepEqual(factTable('tasks', facts), { title: 'Windows scheduled tasks', columns: ['Task', 'Trigger', 'Registered by'], rows: [['T', 'daily', 's.ps1']] });
  assert.deepEqual(factTable('env', facts), { title: 'Environment variables', columns: ['Variable', 'Read in'], rows: [['GLMPS_X', 'a.js']] });
  for (const k of FACT_KINDS) assert.ok(factTable(k, facts), k);
});

test('factTable gives empty rows for a missing kind and null for an unknown one', () => {
  assert.deepEqual(factTable('routes', {}).rows, []);
  assert.deepEqual(factTable('routes', undefined).rows, []);
  assert.equal(factTable('nope', {}), null);
});

test('extractFacts on this checkout returns config, routes and env', async () => {
  const f = await extractFacts({ repoRoot: REPO });
  assert.ok(f.config.length > 0, 'config');
  assert.ok(f.routes.length > 0, 'routes');
  assert.ok(f.env.length > 0, 'env');
  assert.ok(f.config.some(r => r.key.startsWith('wikiLoop.')), 'the wiki loop defaults are a config fact');
  assert.ok(f.routes.some(r => r.path === '/api/wiki'), 'the wiki route is a route fact');
  assert.deepEqual(f.loops, [], 'no state dir, no loops');
  assert.ok(Array.isArray(f.tasks));
});

test('extractFacts reads the loop records from stateDir when given', async () => {
  const stateDir = loopsDir({ 'wiki.json': { name: 'wiki', trigger: { everyMs: 3600000 } } });
  const f = await extractFacts({ repoRoot: REPO, stateDir });
  assert.deepEqual(f.loops.map(r => r.name), ['wiki']);
});

test('extractFacts returns {} for a directory without server/server.js', async () => {
  assert.deepEqual(await extractFacts({ repoRoot: tmp('mc-facts-norepo-') }), {});
});

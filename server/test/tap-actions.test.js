// server/test/tap-actions.test.js
// The tap's action claimer (card glmps-2-0-runtime-45) against a fake server and a
// spawn seam. The claimer trusts nothing in a record: every refusal here is a
// result POST carrying an error (or a 403 file result), and nothing is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActionClaimer } from '../../taps/tap-actions.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const CREDS = { config: { server: 'http://100.64.0.1:8123', clientId: 'cli_me' }, token: 'tok' };
const UUID = '11111111-2222-3333-4444-555555555555';
let n = 0;
const rec = (origin, over = {}) => ({ id: `ln_${++n}`, origin, command: 'x', cwd: '.', state: 'pending', targetClient: 'cli_me', ...over });

function fakeServer(records, allowedCommands) {
  const f = { claims: [], results: {}, seen: [] };
  f.fetch = async (url, init = {}) => {
    const u = new URL(url);
    f.seen.push({ method: init.method ?? 'GET', path: u.pathname, headers: init.headers });
    if (u.pathname === '/api/launches') return { status: 200, json: async () => ({ pending: records, allowedCommands }) };
    const m = /^\/api\/launches\/([^/]+)\/(claim|result)$/.exec(u.pathname);
    if (m && m[2] === 'claim') { f.claims.push({ id: m[1], body: JSON.parse(init.body) }); return { status: 200, json: async () => ({}) }; }
    if (m && m[2] === 'result') { f.results[m[1]] = JSON.parse(init.body); return { status: 204, json: async () => null }; }
    return { status: 404, json: async () => ({}) };
  };
  return f;
}

// makeRecords(ctx) builds the pending list once the temp project root exists.
function setup(makeRecords, { allowedCommands = ['claude', 'gemini'], platform = 'linux', config = {}, noSpawnSeam = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapact-')); tmpDirs.push(work);
  const projectRoot = path.join(work, 'proj');
  const home = path.join(work, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const ctx = { projectRoot, home, work };
  const records = makeRecords(ctx);
  const spawned = [];
  const spawn = (file, args, options) => { spawned.push({ file, args, options }); return { pid: 777, unref() {}, on() {} }; };
  const server = fakeServer(records, allowedCommands);
  const claimer = createActionClaimer({
    getCreds: () => ({ ...CREDS, config: { ...CREDS.config, ...config } }), getProjectRoots: () => [projectRoot], home, fetch: server.fetch,
    ...(noSpawnSeam ? {} : { spawn }), log: () => {}, platform, env: {},
  });
  return { claimer, server, spawned, records, ...ctx };
}

test('a valid terminal is claimed, opened through the native recipe, and its pid reported', async () => {
  const s = setup((c) => [rec('terminal', { command: 'claude', cwd: c.projectRoot })]);
  const [r] = s.records;
  await s.claimer.tick();
  assert.deepEqual(s.server.claims, [{ id: r.id, body: { by: 'tap:cli_me' } }]);
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0].options.cwd, s.projectRoot);
  assert.equal(s.spawned[0].options.shell, false);
  assert.match(JSON.stringify(s.spawned[0].args), /claude/);
  assert.deepEqual(s.server.results[r.id], { pid: 777 });
  assert.equal(s.server.seen[0].headers.authorization, 'Bearer tok');
  assert.equal(s.server.seen[0].headers[TAP_PROTOCOL_HEADER], '1');
});

test('a valid resume matches <allowed command> --resume <uuid>', async () => {
  const s = setup((c) => [rec('resume', { command: `gemini --resume ${UUID}`, cwd: c.projectRoot })]);
  await s.claimer.tick();
  assert.equal(s.spawned.length, 1);
  assert.deepEqual(s.server.results[s.records[0].id], { pid: 777 });
});

test('a cwd outside the project roots is refused and nothing spawns', async () => {
  const s = setup(() => [rec('terminal', { command: 'claude', cwd: path.join(os.tmpdir(), 'not-my-root') })]);
  await s.claimer.tick();
  assert.equal(s.spawned.length, 0);
  assert.match(s.server.results[s.records[0].id].error, /project roots/);
});

test('relative, UNC and dotdot cwd values are refused', async () => {
  const s = setup((c) => [
    rec('terminal', { command: 'claude', cwd: 'rel/dir' }),
    rec('terminal', { command: 'claude', cwd: '\\\\host\\share\\x' }),
    rec('terminal', { command: 'claude', cwd: `${c.projectRoot}${path.sep}..${path.sep}..` }),
  ]);
  await s.claimer.tick();
  assert.equal(s.spawned.length, 0);
  for (const r of s.records) assert.ok(s.server.results[r.id].error, r.cwd);
});

test('a command not in the allowlist is refused, for a terminal and for a resume', async () => {
  const s = setup((c) => [
    rec('terminal', { command: 'rm -rf /', cwd: c.projectRoot }),
    rec('resume', { command: `evil --resume ${UUID}`, cwd: c.projectRoot }),
    rec('resume', { command: `claude --resume ${UUID}; calc`, cwd: c.projectRoot }),
  ]);
  await s.claimer.tick();
  assert.equal(s.spawned.length, 0);
  for (const r of s.records) assert.match(s.server.results[r.id].error, /allowlist/, r.command);
});

test('with no allowlist from the server nothing opens', async () => {
  const s = setup((c) => [rec('terminal', { command: 'claude', cwd: c.projectRoot })], { allowedCommands: [] });
  await s.claimer.tick();
  assert.equal(s.spawned.length, 0);
  assert.match(s.server.results[s.records[0].id].error, /allowlist/);
});

test('an unsupported origin is refused', async () => {
  const s = setup(() => [rec('runner', { command: 'claude' })]);
  await s.claimer.tick();
  assert.match(s.server.results[s.records[0].id].error, /origin/);
  assert.equal(s.spawned.length, 0);
});

test('an editor open uses the configured command and args, and only for a path under a root', async () => {
  const s = setup((c) => {
    const inside = path.join(c.projectRoot, 'a.js');
    const outside = path.join(os.tmpdir(), 'elsewhere.js');
    return [
      rec('editor', { command: 'open-in-editor', cwd: inside, action: { kind: 'open', path: inside } }),
      rec('editor', { command: 'open-in-editor', cwd: outside, action: { kind: 'open', path: outside } }),
    ];
  });
  await s.claimer.tick();
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0].file, 'antigravity');
  assert.deepEqual(s.spawned[0].args, ['-g', s.records[0].action.path]);
  assert.equal(s.spawned[0].options.shell, false);
  assert.deepEqual(s.server.results[s.records[0].id], { pid: 777 });
  assert.ok(s.server.results[s.records[1].id].error);
});

test('the editor command and args come from the tap config, never the record', async () => {
  const s = setup((c) => [rec('editor', { command: 'evil', cwd: c.projectRoot, action: { kind: 'open', path: path.join(c.projectRoot, 'b.js'), command: 'calc' } })],
    { config: { editorCommand: 'code', editorArgs: ['--goto', '{path}'] } });
  await s.claimer.tick();
  assert.equal(s.spawned[0].file, 'code');
  assert.deepEqual(s.spawned[0].args, ['--goto', s.records[0].action.path]);
});

test('on win32 the editor opens through the shell with the path quoted, so a .cmd shim resolves', async () => {
  const s = setup((c) => [rec('editor', { command: 'open-in-editor', cwd: c.projectRoot, action: { kind: 'open', path: path.join(c.projectRoot, 'a.js') } })], { platform: 'win32' });
  await s.claimer.tick();
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0].options.shell, true);
  assert.deepEqual(s.spawned[0].args, ['-g', `"${s.records[0].action.path}"`]);
});

test('file read, save and undo run through FileApi over the project roots', async () => {
  let file;
  const s = setup((c) => {
    file = path.join(c.projectRoot, 'note.txt');
    fs.writeFileSync(file, 'one');
    return [rec('file', { cwd: file, action: { op: 'read', path: file } })];
  });
  await s.claimer.tick();
  const read = s.server.results[s.records[0].id].result;
  assert.equal(read.status, 200); assert.equal(read.body.content, 'one');

  const next = [
    rec('file', { cwd: file, action: { op: 'save', path: file, content: 'two', hash: read.body.hash, force: false } }),
    rec('file', { cwd: file, action: { op: 'save', path: file, content: 'three', hash: 'wrong', force: false } }),
  ];
  s.records.splice(0, s.records.length, ...next);
  await s.claimer.tick();
  assert.equal(s.server.results[next[0].id].result.status, 200);
  assert.equal(s.server.results[next[1].id].result.status, 409, 'a stale hash is a conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');

  const undo = rec('file', { cwd: file, action: { op: 'undo', path: file } });
  s.records.splice(0, s.records.length, undo);
  await s.claimer.tick();
  assert.equal(s.server.results[undo.id].result.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  assert.ok(fs.existsSync(path.join(s.home, 'undo')), 'the undo copies live under the tap home');
});

test('a file action on a sensitive path, outside the roots or relative is refused and leaks nothing', async () => {
  const s = setup((c) => {
    const envFile = path.join(c.projectRoot, '.env');
    fs.writeFileSync(envFile, 'SECRET=1');
    const out = path.join(os.tmpdir(), 'x.txt');
    return [
      rec('file', { cwd: envFile, action: { op: 'read', path: envFile } }),
      rec('file', { cwd: out, action: { op: 'read', path: out } }),
      rec('file', { cwd: 'a.txt', action: { op: 'read', path: 'a.txt' } }),
    ];
  });
  await s.claimer.tick();
  for (const r of s.records) assert.equal(s.server.results[r.id].result?.status, 403, r.action.path);
  assert.equal(JSON.stringify(s.server.results).includes('SECRET'), false);
});

test('a missing file reads as 404 and an unknown op is refused', async () => {
  const s = setup((c) => {
    const f = path.join(c.projectRoot, 'nope.txt');
    return [rec('file', { cwd: f, action: { op: 'read', path: f } }), rec('file', { cwd: f, action: { op: 'delete', path: f } })];
  });
  await s.claimer.tick();
  assert.equal(s.server.results[s.records[0].id].result.status, 404);
  assert.ok(s.server.results[s.records[1].id].error);
});

test('one tick at a time; status counts what was handled; a tick with no credentials does nothing', async () => {
  const s = setup((c) => [rec('terminal', { command: 'claude', cwd: c.projectRoot })]);
  const first = s.claimer.tick();
  assert.deepEqual(await s.claimer.tick(), { skipped: 'in-flight' });
  assert.equal(s.claimer.busy(), true);
  await first;
  assert.equal(s.claimer.busy(), false);
  assert.equal(s.claimer.status().handled, 1);
  const idle = createActionClaimer({ getCreds: () => null, getProjectRoots: () => [], home: s.home, fetch: s.server.fetch, spawn: () => {}, log: () => {} });
  assert.deepEqual(await idle.tick(), { skipped: 'no-credentials' });
});

test('under a test process with no spawn seam nothing is spawned', async () => {
  const s = setup((c) => [rec('terminal', { command: 'claude', cwd: c.projectRoot })], { noSpawnSeam: true });
  await s.claimer.tick();
  assert.match(s.server.results[s.records[0].id].error, /test process/);
});

test('a server that is down or refuses the poll is a status, not a throw', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapact-')); tmpDirs.push(home);
  const base = { getCreds: () => CREDS, getProjectRoots: () => [], home, spawn: () => {}, log: () => {} };
  const down = createActionClaimer({ ...base, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match((await down.tick()).error, /ECONNREFUSED/);
  const refused = createActionClaimer({ ...base, fetch: async () => ({ status: 401, json: async () => ({}) }) });
  assert.match((await refused.tick()).error, /401/);
});

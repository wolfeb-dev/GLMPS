// server/test/sessions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeSessions, discoverAgSessions, livenessOf, isInternalSession, createStatusReader, procStartsOf, procStartsSettled } from '../lib/observability/sessions.js';
import { createClaudeDiscovery } from '../lib/observability/sessions.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

test('discoverClaudeSessions merges registry (live) with transcript scan (history)', () => {
  const tmp = mkTmp();
  const projDir = path.join(tmp, 'projects', 'D--');
  fs.mkdirSync(projDir, { recursive: true });
  const liveT = path.join(projDir, 'aaaa.jsonl');
  const oldT = path.join(projDir, 'bbbb.jsonl');
  fs.writeFileSync(liveT, '{}\n'); fs.writeFileSync(oldT, '{}\n');
  const reg = [{ sessionId: 'aaaa', ppid: process.pid, cwd: 'D:\\', transcriptPath: liveT, ts: Date.now() }];
  const regFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(regFile, JSON.stringify(reg));
  const sessions = discoverClaudeSessions({
    activeSessionsFile: regFile, projectsDir: path.join(tmp, 'projects') });
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.equal(byId['aaaa'].live, true);       // pid exists (our own)
  assert.equal(byId['bbbb'].live, false);      // not in registry
  assert.equal(byId['aaaa'].tool, 'claude-code');
  assert.equal(byId['aaaa'].cwd, 'D:\\');
});

test('dead ppid in registry is not live', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const regFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(regFile, JSON.stringify([
    { sessionId: 'cccc', ppid: 999999999, cwd: 'D:\\', transcriptPath: path.join(tmp, 'c.jsonl'), ts: Date.now() }]));
  const sessions = discoverClaudeSessions({
    activeSessionsFile: regFile, projectsDir: path.join(tmp, 'projects') });
  assert.equal(sessions.find(s => s.id === 'cccc').live, false);
});

// Card glmps-2-0-109 AC-1: Claude Code's own ~/.claude/sessions registry makes
// an open session live even when active-sessions.json never recorded it, but
// only while the pid is alive AND started at the recorded procStart.
function registryFixture(entries) {
  const tmp = mkTmp();
  const projDir = path.join(tmp, 'projects', 'D--');
  const sessionsDir = path.join(tmp, 'sessions');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const regFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(regFile, '[]');
  for (const e of entries) {
    fs.writeFileSync(path.join(projDir, `${e.sessionId}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(sessionsDir, `${e.file ?? e.pid}.json`), JSON.stringify({ kind: 'interactive', status: 'idle', cwd: 'D:\\wt', ...e }));
  }
  // A key file sits beside every entry; it must be skipped, never parsed.
  fs.writeFileSync(path.join(sessionsDir, `${process.pid}.deadbeef.key`), 'not json');
  return { activeSessionsFile: regFile, projectsDir: path.join(tmp, 'projects'), claudeSessionsDir: sessionsDir };
}
const fakeStarts = (pids) => new Map(pids.filter((p) => p === process.pid).map((p) => [p, '134375867126041777']));

test('a live ~/.claude/sessions entry with matching procStart is live without an active-sessions entry', () => {
  const P = registryFixture([{ pid: process.pid, sessionId: 'idle-open', procStart: '134375867126041777' }]);
  const s = discoverClaudeSessions({ ...P, procStarts: fakeStarts }).find((x) => x.id === 'idle-open');
  assert.equal(s.live, true);
  assert.equal(s.cwd, 'D:\\wt');
});

test('a ~/.claude/sessions entry whose pid is dead reads as dead', () => {
  const P = registryFixture([{ pid: 999999999, sessionId: 'stale-pid', procStart: '134375867126041777' }]);
  let asked = null;
  const s = discoverClaudeSessions({ ...P, procStarts: (pids) => { asked = pids; return new Map(); } }).find((x) => x.id === 'stale-pid');
  assert.equal(s.live, false);
  assert.equal(asked, null, 'a dead pid is never probed for its start time');
});

test('a ~/.claude/sessions entry whose procStart does not match (pid reused) reads as dead', () => {
  const P = registryFixture([{ pid: process.pid, sessionId: 'reused-pid', procStart: '134000000000000000' }]);
  const s = discoverClaudeSessions({ ...P, procStarts: fakeStarts }).find((x) => x.id === 'reused-pid');
  assert.equal(s.live, false);
});

test('a ~/.claude/sessions entry with no procStart, or a start time that cannot be read, reads as dead', () => {
  const P = registryFixture([
    { pid: process.pid, sessionId: 'no-start' },
    { pid: process.pid, file: 'x', sessionId: 'odd-name', procStart: '134375867126041777' },
  ]);
  const byId = Object.fromEntries(discoverClaudeSessions({ ...P, procStarts: () => new Map() }).map((s) => [s.id, s]));
  assert.equal(byId['no-start'].live, false);
  assert.equal(byId['odd-name'].live, false);
});

test('procStartsOf reads this process start time as a Windows FILETIME', { skip: process.platform !== 'win32' }, async () => {
  procStartsOf([process.pid]);
  await procStartsSettled();
  const got = procStartsOf([process.pid]).get(process.pid);
  assert.match(String(got), /^\d{17,18}$/);
  const startedMs = Number(BigInt(got) / 10_000n) - 11_644_473_600_000;
  const expectMs = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(startedMs - expectMs) < 5_000, `FILETIME ${got} -> ${new Date(startedMs).toISOString()}`);
});

test('procStartsOf reports nothing off Windows, so the registry never vouches there', () => {
  assert.equal(procStartsOf([process.pid], { platform: 'linux' }).size, 0);
});

test('procStartsOf never probes synchronously: the read returns from cache and the probe lands later', async () => {
  const pending = [];
  const execFileImpl = (_cmd, _args, _opts, cb) => { pending.push(cb); };
  const first = procStartsOf([424242], { platform: 'win32', execFileImpl, now: 1 });
  assert.equal(first.size, 0, 'an unprobed pid is unvouched, not waited on');
  assert.equal(pending.length, 1, 'one background probe started');
  procStartsOf([424242], { platform: 'win32', execFileImpl, now: 2 });
  assert.equal(pending.length, 1, 'a probe in flight is not doubled');
  pending.shift()(null, '424242 134375867126041777\r\n');
  await procStartsSettled();
  assert.equal(procStartsOf([424242], { platform: 'win32', execFileImpl, now: 3 }).get(424242), '134375867126041777');
  assert.equal(pending.length, 0, 'a cached pid is not re-probed');
  // Past the TTL the old value is still served while the refresh runs.
  const stale = procStartsOf([424242], { platform: 'win32', execFileImpl, now: 1 + 10 * 60_000 });
  assert.equal(stale.get(424242), '134375867126041777');
  assert.equal(pending.length, 1);
  pending.shift()(null, '424242 134375867126041777\r\n');
  await procStartsSettled();
  procStartsOf([], { platform: 'win32', execFileImpl, now: 4 }); // pid gone: evicted
});

test('the session poll path reads the registry without ever spawning a probe synchronously', async () => {
  const tmp = mkTmp();
  const sessionsDir = path.join(tmp, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects', 'D--'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'D--', 'poll-open.jsonl'), '{}\n');
  fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'poll-open', procStart: '134375867126041777', status: 'idle' }));
  let spawned = 0;
  let cb = null;
  const execFileImpl = (_c, _a, _o, done) => { spawned += 1; cb = done; };
  const procStarts = (pids) => procStartsOf(pids, { platform: 'win32', execFileImpl });
  const P = { activeSessionsFile: path.join(tmp, 'none.json'), projectsDir: path.join(tmp, 'projects'), claudeSessionsDir: sessionsDir, procStarts };
  const before = discoverClaudeSessions(P).find((s) => s.id === 'poll-open');
  assert.equal(before.live, false, 'unvouched on the tick that first sees it');
  assert.equal(spawned, 1);
  assert.equal(typeof cb, 'function', 'the probe was handed off, its result not awaited inline');
  cb(null, `${process.pid} 134375867126041777`);
  await procStartsSettled();
  assert.equal(discoverClaudeSessions(P).find((s) => s.id === 'poll-open')?.live, true, 'live on the next tick');
  assert.equal(spawned, 1);
  procStartsOf([], { platform: 'win32', execFileImpl });
});

test('discoverAgSessions finds brain conversations with overview logs', () => {
  const tmp = mkTmp();
  const conv = path.join(tmp, 'brain', 'dddd', '.system_generated', 'logs');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, 'overview.txt'), '{}\n');
  // legacy call via brainDir
  const sessions = discoverAgSessions({ brainDir: path.join(tmp, 'brain') });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'dddd');
  assert.equal(sessions[0].tool, 'antigravity');
  assert.ok(sessions[0].logPath.endsWith('overview.txt'));
  assert.equal(sessions[0].format, 'log');
});

test('discoverAgSessions discovers pb-only conversations', () => {
  const tmp = mkTmp();
  const convsDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convsDir, { recursive: true });
  const pbId = 'eeee1111-0000-0000-0000-000000000001';
  fs.writeFileSync(path.join(convsDir, `${pbId}.pb`), Buffer.from([0x0a, 0x01]));
  const sessions = discoverAgSessions({ antigravityDirs: [tmp] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, pbId);
  assert.equal(sessions[0].tool, 'antigravity');
  assert.equal(sessions[0].format, 'pb');
  assert.equal(sessions[0].logPath, null);
  assert.ok(sessions[0].pbPath.endsWith(`${pbId}.pb`));
});

test('discoverAgSessions deduplicates same id across two roots, keeps most recent mtime', () => {
  const tmp1 = mkTmp();
  const tmp2 = mkTmp();
  const id = 'ffffffff-0000-0000-0000-000000000001';
  // root1: pb with older mtime
  const convsDir1 = path.join(tmp1, 'conversations');
  fs.mkdirSync(convsDir1, { recursive: true });
  const pb1 = path.join(convsDir1, `${id}.pb`);
  fs.writeFileSync(pb1, Buffer.from([0x01]));
  fs.utimesSync(pb1, new Date(1000000), new Date(1000000)); // old
  // root2: pb with newer mtime
  const convsDir2 = path.join(tmp2, 'conversations');
  fs.mkdirSync(convsDir2, { recursive: true });
  const pb2 = path.join(convsDir2, `${id}.pb`);
  fs.writeFileSync(pb2, Buffer.from([0x02]));
  // pb2 mtime = now (default)
  const sessions = discoverAgSessions({ antigravityDirs: [tmp1, tmp2] });
  assert.equal(sessions.filter(s => s.id === id).length, 1, 'deduped to one entry');
  const s = sessions.find(s => s.id === id);
  const pb2Mtime = fs.statSync(pb2).mtimeMs;
  assert.equal(s.mtimeMs, pb2Mtime, 'keeps newer mtime');
});

test('discoverAgSessions same id as log+pb keeps log format with max mtime', () => {
  const tmp = mkTmp();
  const id = 'logpb111-0000-0000-0000-000000000001';
  // log entry (old)
  const logDir = path.join(tmp, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'overview.txt');
  fs.writeFileSync(logFile, '{}\n');
  fs.utimesSync(logFile, new Date(1000000), new Date(1000000));
  // pb entry (newer)
  const convsDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convsDir, { recursive: true });
  const pbFile = path.join(convsDir, `${id}.pb`);
  fs.writeFileSync(pbFile, Buffer.from([0x01]));
  // pbFile mtime = now (default)
  const sessions = discoverAgSessions({ antigravityDirs: [tmp] });
  const s = sessions.find(s => s.id === id);
  assert.ok(s, 'session found');
  assert.equal(s.format, 'log', 'log format wins over pb');
  assert.ok(s.mtimeMs >= fs.statSync(pbFile).mtimeMs - 1000, 'mtime updated to max');
});

test('livenessOf maps recency to state', () => {
  const cfg = { workingThresholdMs: 10000, idleThresholdMs: 60000 };
  const now = Date.now();
  assert.equal(livenessOf(true, now - 1000, now, cfg), 'working');
  assert.equal(livenessOf(true, now - 120000, now, cfg), 'idle');
  assert.equal(livenessOf(false, now - 1000, now, cfg), 'ended');
});

test('isInternalSession: id set match, cwd fallback, and null-cwd is not internal', () => {
  const ids = new Set(['known']);
  assert.equal(isInternalSession({ id: 'known', cwd: null }, ids), true);
  assert.equal(isInternalSession({ id: 'x', cwd: 'C:\\Temp\\mc-distill-Wth1Vw' }, ids), true);
  assert.equal(isInternalSession({ id: 'x', cwd: null }, ids), false);
  assert.equal(isInternalSession({ id: 'x', cwd: 'D:\\glmps' }, ids), false);
});

test('isInternalSession: cwd fallback also matches a forward-slash path (CI parity)', () => {
  const ids = new Set();
  assert.equal(isInternalSession({ id: 'x', cwd: '/tmp/mc-distill-ab12cd' }, ids), true);
});

// claude-model.js's runClaude (the
// shared model call every loop plugin - mem0, judge, GEPA - uses) spawns
// `claude -p` with its cwd inside a fs.mkdtempSync 'mc-model-' throwaway
// temp dir, the same class of internal spawn 'mc-distill-' already covers
// for the (retired) pre-D23 memory distiller. Without this, every plugin
// model call showed up as an apparent live external session.
test('isInternalSession: cwd fallback also matches the claude-model plugin temp dir prefix (mc-model-)', () => {
  const ids = new Set();
  assert.equal(isInternalSession({ id: 'x', cwd: 'C:\\Temp\\mc-model-Wth1Vw' }, ids), true);
  assert.equal(isInternalSession({ id: 'x', cwd: '/tmp/mc-model-ab12cd' }, ids), true);
});

// glmps-193: a liveness check per session per poll tick read <id>.json for
// every session, and most have none, so each miss was a thrown ENOENT read.
// Profiled at 16.2 s of 21 s busy CPU over a 30 s window with 1,200 sessions.
test('createStatusReader returns null for a missing status file without reading it', () => {
  const dir = mkTmp();
  let reads = 0;
  const fsSpy = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } };
  const read = createStatusReader(dir, fsSpy);
  assert.equal(read('no-such-session'), null);
  assert.equal(reads, 0);
});

test('createStatusReader reads a status file once and re-reads only after it changes', () => {
  const dir = mkTmp();
  const file = path.join(dir, 's1.json');
  fs.writeFileSync(file, JSON.stringify({ capturedAt: 111 }));
  fs.utimesSync(file, 1000, 1000);
  let reads = 0;
  const fsSpy = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } };
  const read = createStatusReader(dir, fsSpy);
  assert.equal(read('s1').capturedAt, 111);
  assert.equal(read('s1').capturedAt, 111);
  assert.equal(reads, 1);
  fs.writeFileSync(file, JSON.stringify({ capturedAt: 222 }));
  fs.utimesSync(file, 2000, 2000);
  assert.equal(read('s1').capturedAt, 222);
  assert.equal(reads, 2);
  fs.rmSync(file);
  assert.equal(read('s1'), null);
});

// glmps-2-0-runtime-86: ~2,300 of ~2,600 sessions have no status file, and
// each miss was a stat twice per poll. After indexDir() a miss costs no stat
// until the next indexDir(); a listed file is still stat'd, so edits show.
test('createStatusReader.indexDir answers a miss without a stat until the next index', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ capturedAt: 1 }));
  let stats = 0;
  const fsSpy = { ...fs, statSync: (...a) => { stats++; return fs.statSync(...a); } };
  const read = createStatusReader(dir, fsSpy);
  read.indexDir();
  assert.equal(read('nope'), null);
  assert.equal(stats, 0);
  assert.equal(read('s1').capturedAt, 1);
  assert.equal(stats, 1);
  fs.writeFileSync(path.join(dir, 's2.json'), JSON.stringify({ capturedAt: 2 }));
  assert.equal(read('s2'), null, 'not listed until the next index');
  read.indexDir();
  assert.equal(read('s2').capturedAt, 2);
});

test('createStatusReader.indexDir on an unreadable dir falls back to a stat per read', () => {
  const read = createStatusReader(path.join(mkTmp(), 'missing'));
  read.indexDir();
  assert.equal(read('x'), null);
});

test('createStatusReader treats an unparseable status file as null', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.equal(createStatusReader(dir)('bad'), null);
});

// Card glmps-198: the poll's discovery re-reads only hot dirs plus a rotating
// slice, so a steady tick is a few calls instead of one per transcript.
function countingFs() {
  const calls = { readdir: [], stat: [] };
  return {
    calls,
    reset() { calls.readdir.length = 0; calls.stat.length = 0; },
    readdirSync: (p, o) => { calls.readdir.push(p); return fs.readdirSync(p, o); },
    statSync: (p, o) => { calls.stat.push(p); return fs.statSync(p, o); },
  };
}
function projectsFixture(n) {
  const tmp = mkTmp();
  const projectsDir = path.join(tmp, 'projects');
  const old = (Date.now() - 24 * 3600_000) / 1000;
  for (let i = 0; i < n; i++) {
    const d = path.join(projectsDir, `D--p${i}`);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `s${i}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, old, old);
  }
  const activeSessionsFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(activeSessionsFile, '[]');
  return { activeSessionsFile, projectsDir };
}
const byIdOf = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('createClaudeDiscovery returns what the full scan returns', () => {
  const P = projectsFixture(5);
  fs.writeFileSync(path.join(P.projectsDir, 'D--p1', 'extra.jsonl'), '{}\n');
  const full = byIdOf(discoverClaudeSessions(P));
  const inc = byIdOf(createClaudeDiscovery({ cycleTicks: 3 })(P));
  assert.deepEqual(inc, full);
});

test('a steady tick reads only the rotating slice once every dir is cold', () => {
  const P = projectsFixture(60);
  const cfs = countingFs();
  const discover = createClaudeDiscovery({ fsImpl: cfs, cycleTicks: 30 });
  assert.equal(discover(P).length, 60);
  assert.equal(cfs.calls.stat.length, 60, 'the first call scans everything');
  cfs.reset();
  const list = discover(P);
  assert.equal(list.length, 60, 'cold transcripts are still listed from the cache');
  assert.equal(cfs.calls.readdir.length, 1 + 2, 'projects dir plus a 2-dir slice');
  assert.equal(cfs.calls.stat.length, 2);
  const seen = new Set();
  for (let i = 0; i < 30; i++) { cfs.reset(); discover(P); for (const p of cfs.calls.readdir.slice(1)) seen.add(path.basename(p)); }
  assert.equal(seen.size, 60, 'every dir is rescanned within one cycle');
});

test('a hot transcript is restatted every tick and its change is seen at once', () => {
  const P = projectsFixture(60);
  const hot = path.join(P.projectsDir, 'D--p7', 's7.jsonl');
  fs.writeFileSync(hot, '{}\n{}\n');
  const cfs = countingFs();
  const discover = createClaudeDiscovery({ fsImpl: cfs, cycleTicks: 30 });
  discover(P);
  for (let i = 0; i < 3; i++) {
    cfs.reset();
    const t = new Date(Date.now() + (i + 1) * 1000);
    fs.utimesSync(hot, t, t);
    const s = discover(P).find((x) => x.id === 's7');
    assert.equal(s.mtimeMs, fs.statSync(hot).mtimeMs);
    assert.ok(cfs.calls.stat.includes(hot));
  }
});

test('a new dir, a new file in a hot dir and a removed file show on the next tick', () => {
  const P = projectsFixture(60);
  fs.writeFileSync(path.join(P.projectsDir, 'D--p3', 's3.jsonl'), '{}\n');
  const discover = createClaudeDiscovery({ cycleTicks: 30 });
  discover(P);
  fs.mkdirSync(path.join(P.projectsDir, 'D--new'));
  fs.writeFileSync(path.join(P.projectsDir, 'D--new', 'fresh.jsonl'), '{}\n');
  fs.writeFileSync(path.join(P.projectsDir, 'D--p3', 'second.jsonl'), '{}\n');
  fs.rmSync(path.join(P.projectsDir, 'D--p3', 's3.jsonl'));
  const ids = byIdOf(discover(P));
  assert.ok(ids.fresh, 'new dir scanned');
  assert.ok(ids.second, 'new file in a hot dir');
  assert.equal(ids.s3, undefined, 'removed file dropped');
  fs.rmSync(path.join(P.projectsDir, 'D--p9'), { recursive: true });
  assert.equal(byIdOf(discover(P)).s9, undefined, 'removed dir dropped');
});

test('a live session in a cold dir is found and restatted without waiting for the slice', () => {
  const P = projectsFixture(60);
  const cwd = 'D:\\p42-live';
  const dir = path.join(P.projectsDir, 'D--p42-live');
  const discover = createClaudeDiscovery({ cycleTicks: 30 });
  fs.mkdirSync(dir);
  const t = path.join(dir, 'live1.jsonl');
  fs.writeFileSync(t, '{}\n');
  const old = (Date.now() - 24 * 3600_000) / 1000;
  fs.utimesSync(t, old, old);
  discover(P);
  fs.writeFileSync(path.join(dir, 'live2.jsonl'), '{}\n');
  fs.utimesSync(path.join(dir, 'live2.jsonl'), old, old);
  fs.writeFileSync(P.activeSessionsFile, JSON.stringify([{ sessionId: 'live2', ppid: process.pid, cwd }]));
  const s = byIdOf(discover(P)).live2;
  assert.equal(s?.live, true);
  assert.equal(s.transcriptPath, path.join(dir, 'live2.jsonl'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'live2.jsonl'), later, later);
  assert.equal(byIdOf(discover(P)).live2.mtimeMs, fs.statSync(path.join(dir, 'live2.jsonl')).mtimeMs);
});

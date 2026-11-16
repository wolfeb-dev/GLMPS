// Routes under test: server/lib/routes/learning-integrity-routes.js
// server/test/learning-sweep-loops.test.js
//
// Card glmps-2-0-runtime-15: the decay (A0.2) and revert (A0.3) sweeps are
// registered kernel loops, on by default, so the learning-write freeze has a
// legitimate path to lift. Before this they ran only inside a disabled,
// allowlisted setInterval, and the live acceptance flags could never pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { createLesson, lessonsCurrent, readLessonRows } from '../lib/evaluation/lesson-ledger.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import { LOOP_ALLOWLIST } from '../lib/loops/allowlist.js';

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }
function rmBestEffort(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* Windows EPERM on git handles */ } }

async function boot(stateDir, config = {}) {
  const claudeDir = tmp('mc-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env = {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ASSETS_DIR: tmp('mc-assets-'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  return {
    h,
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    cleanup: async () => { await h.close?.(); rmBestEffort(stateDir); rmBestEffort(claudeDir); },
  };
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

// A repo holding one commit a lesson was derived from, and git's own revert of it.
function repoWithRevert() {
  const repo = tmp('mc-revrepo-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'guard');
  const guardSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'revert', '--no-edit', 'HEAD');
  return { repo, guardSha, head: git(repo, 'rev-parse', 'HEAD') };
}

test('the decay and revert sweeps are registered loops by default, with freshness on /healthz', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const r = await s.get('/healthz');
    assert.equal(r.status, 200);
    assert.ok(r.body.loops['lesson-decay'], 'lesson-decay shows on /healthz');
    assert.ok(r.body.loops['revert-sweep'], 'revert-sweep shows on /healthz');
    const snap = s.h.loopRegistry.snapshot();
    assert.ok(snap['lesson-decay'].sla.maxAgeMs > 0, 'lesson-decay holds a freshness SLA');
    assert.ok(snap['revert-sweep'].sla.maxAgeMs > 0, 'revert-sweep holds a freshness SLA');
    assert.equal(snap['platform-autonomy'], undefined, 'the rest of the nightly tick stays opt-in');
  } finally { await s.cleanup(); }
});

test('the platform-autonomy tick is a registered loop, not an allowlisted setInterval', async () => {
  assert.equal(LOOP_ALLOWLIST.some((row) => row.match.includes('platformAutonomyTick')), false, 'the allowlist exemption is gone');
  const dir = tmp('mc-state-');
  const s = await boot(dir, { platformAutonomy: { enabled: true, tickMs: 86_400_000 } });
  try {
    const snap = s.h.loopRegistry.snapshot();
    assert.ok(snap['platform-autonomy'], 'enabled tick registers as a loop');
    assert.ok(snap['platform-autonomy'].sla.maxAgeMs > 0);
    const res = await s.h.loopRegistry.runNow('platform-autonomy');
    assert.ok(res.outcome === 'done' || res.outcome === 'nothing-to-do', JSON.stringify(res));
  } finally { await s.cleanup(); }
});

test('learningIntegrity.sweeps.enabled false registers neither sweep', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir, { learningIntegrity: { sweeps: { enabled: false } } });
  try {
    const snap = s.h.loopRegistry.snapshot();
    assert.equal(snap['lesson-decay'], undefined);
    assert.equal(snap['revert-sweep'], undefined);
  } finally { await s.cleanup(); }
});

test('lesson-decay moves a stale lesson to dormant and the acceptance flag follows', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    createLesson(dir, { lessonId: 'old', kind: 'guard', title: 'old', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: Date.now() - 400 * 86400000 });
    createLesson(dir, { lessonId: 'new', kind: 'guard', title: 'new', provenance: { scope: 'repo', derivedFromRefs: ['def'] } });
    assert.equal((await s.get('/api/learning-integrity')).body.acceptance.decay, false, 'precondition');

    const first = await s.h.loopRegistry.runNow('lesson-decay');
    assert.equal(first.outcome, 'done', JSON.stringify(first));
    const cur = lessonsCurrent(readLessonRows(dir, {}));
    assert.equal(cur.get('old').status, 'dormant');
    assert.equal(cur.get('new').status, 'active');
    assert.equal((await s.get('/api/learning-integrity')).body.acceptance.decay, true);

    const second = await s.h.loopRegistry.runNow('lesson-decay');
    assert.equal(second.outcome, 'nothing-to-do', 'idempotent');
    assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_DECAYED }).length, 1);
  } finally { await s.cleanup(); }
});

test('revert-sweep scans revertScanRepos, invalidates the reverted lesson and the acceptance flag follows', async () => {
  const { repo, guardSha, head } = repoWithRevert();
  const dir = tmp('mc-state-');
  const s = await boot(dir, { learningIntegrity: { revertScanRepos: [repo] } });
  try {
    createLesson(dir, { lessonId: 'g', kind: 'guard', title: 'g', provenance: { scope: 'repo', derivedFromRefs: [guardSha] } });
    createLesson(dir, { lessonId: 'other', kind: 'guard', title: 'other', provenance: { scope: 'repo', derivedFromRefs: ['f'.repeat(40)] } });
    const li = (await s.get('/api/learning-integrity')).body;
    assert.deepEqual(li.config.revertScanRepos, [repo]);
    assert.equal(li.acceptance.revertSweep, false, 'precondition');

    const first = await s.h.loopRegistry.runNow('revert-sweep');
    assert.equal(first.outcome, 'done', JSON.stringify(first));
    const cur = lessonsCurrent(readLessonRows(dir, {}));
    assert.equal(cur.get('g').status, 'invalidated');
    assert.equal(cur.get('other').status, 'active');
    assert.equal((await s.get('/api/learning-integrity')).body.acceptance.revertSweep, true);
    const marks = JSON.parse(fs.readFileSync(path.join(dir, 'lessons', 'revert-watermarks.json'), 'utf8'));
    assert.equal(marks[repo], head, 'watermark advanced to the scanned head');

    const second = await s.h.loopRegistry.runNow('revert-sweep');
    assert.equal(second.outcome, 'nothing-to-do', 'the watermark makes a re-run a no-op');
  } finally { await s.cleanup(); rmBestEffort(repo); }
});

test('revert-sweep fails the run when a scanned repo cannot be read', async () => {
  const dir = tmp('mc-state-');
  const missing = path.join(tmp('mc-gone-'), 'not-a-repo');
  const s = await boot(dir, { learningIntegrity: { revertScanRepos: [missing] } });
  try {
    const res = await s.h.loopRegistry.runNow('revert-sweep');
    assert.equal(res.outcome.startsWith('failed'), true, JSON.stringify(res));
  } finally { await s.cleanup(); }
});

// Tests for the deploy check (server/lib/kernel/deploy-verify.js), card glmps-2-0-58.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeployedHealthz, readRepoHead } from '../lib/kernel/deploy-verify.js';

const restartTs = Date.parse('2026-10-18T07:37:07Z');
const now = restartTs + 20_000;
const SHA = '665c591aaaabbbbccccddddeeeeffff000011112';

test('the new build, booted after the restart, passes', () => {
  assert.deepEqual(verifyDeployedHealthz({ version: '0.1.0+665c591', uptime_s: 12 }, { expectSha: SHA, restartTs, now }), { ok: true });
});

test('the 2026-10-18 incident fails on version: the orphan reported 7c5ed64 with 8 h uptime', () => {
  const r = verifyDeployedHealthz({ version: '0.1.0+7c5ed64', uptime_s: 30252 }, { expectSha: SHA, restartTs, now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0\.1\.0\+7c5ed64, expected \+665c591/);
});

test('the right commit from a process older than the restart fails on uptime', () => {
  const r = verifyDeployedHealthz({ version: '0.1.0+665c591', uptime_s: 600 }, { expectSha: SHA, restartTs, now });
  assert.equal(r.ok, false);
  assert.match(r.reason, /uptime 600 s predates the restart 20 s ago/);
});

test('uptime within the 5 s clock slack of the restart still passes', () => {
  assert.equal(verifyDeployedHealthz({ version: '0.1.0+665c591', uptime_s: 24 }, { expectSha: SHA, restartTs, now }).ok, true);
  assert.equal(verifyDeployedHealthz({ version: '0.1.0+665c591', uptime_s: 26 }, { expectSha: SHA, restartTs, now }).ok, false);
});

test('missing fields and a missing expected commit fail with a reason, never pass', () => {
  for (const [body, opts, re] of [
    [{ uptime_s: 1 }, { expectSha: SHA }, /no version/],
    [{ version: '0.1.0+unknown', uptime_s: 1 }, { expectSha: SHA }, /expected \+665c591/],
    [{ version: '0.1.0+665c591' }, { expectSha: SHA }, /no uptime/],
    [null, { expectSha: SHA }, /no version/],
    [{ version: '0.1.0+665c591', uptime_s: 1 }, { expectSha: null }, /no expected commit/],
  ]) {
    const r = verifyDeployedHealthz(body, { restartTs, now, ...opts });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
});

test('readRepoHead returns the sha, or null with the error', async () => {
  const ok = await readRepoHead('D:/x', { execFileImpl: (f, a, o, cb) => { assert.deepEqual([f, a, o.cwd], ['git', ['rev-parse', 'HEAD'], 'D:/x']); cb(null, `${SHA}\n`); } });
  assert.deepEqual(ok, { sha: SHA });
  const bad = await readRepoHead('D:/x', { execFileImpl: (f, a, o, cb) => cb(new Error('fatal: detected dubious ownership'), '') });
  assert.equal(bad.sha, null);
  assert.match(bad.error, /dubious ownership/);
});

// server/test/skill-provenance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProvenance, saveProvenance, setProvenance, checkForUpdates, updateCandidates } from '../lib/evaluation/skill-provenance.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skill-prov-'));
  tmpDirs.push(d);
  return d;
}

test('loadProvenance: missing file resolves to {}, never throws', () => {
  assert.deepEqual(loadProvenance(mkTmp()), {});
});

test('loadProvenance: corrupt/non-object JSON resolves to {}', () => {
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'provenance.json'), '[1,2]');
  assert.deepEqual(loadProvenance(dir), {});
});

test('saveProvenance + loadProvenance round-trip', () => {
  const dir = mkTmp();
  saveProvenance(dir, { 'a:b': { sourceRepo: 'https://x', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } });
  const m = loadProvenance(dir);
  assert.equal(m['a:b'].sourceRepo, 'https://x');
});

test('setProvenance: registers a new skill entry with unknown upstream status', () => {
  const dir = mkTmp();
  setProvenance(dir, 'plugin:foo', { sourceRepo: 'https://repo/foo', sourceRef: 'main', version: '1.0.0' });
  const m = loadProvenance(dir);
  assert.deepEqual(m['plugin:foo'], {
    sourceRepo: 'https://repo/foo', sourceRef: 'main', version: '1.0.0',
    checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null,
  });
});

test('setProvenance: updating an existing entry preserves prior checkedTs/latestVersion/upstreamStatus', () => {
  const dir = mkTmp();
  saveProvenance(dir, { 'plugin:foo': { sourceRepo: 'https://repo/foo', sourceRef: 'main', version: '1.0.0', checkedTs: 500, latestVersion: '1.1.0', upstreamStatus: 'update-available', lastError: null } });
  setProvenance(dir, 'plugin:foo', { sourceRepo: 'https://repo/foo', sourceRef: 'main', version: '1.1.0' });
  const m = loadProvenance(dir);
  assert.equal(m['plugin:foo'].version, '1.1.0');
  assert.equal(m['plugin:foo'].checkedTs, 500);
  assert.equal(m['plugin:foo'].latestVersion, '1.1.0');
});

test('setProvenance: malformed skillId is a no-op, never throws', () => {
  const dir = mkTmp();
  assert.doesNotThrow(() => setProvenance(dir, '', { sourceRepo: 'x' }));
  assert.doesNotThrow(() => setProvenance(dir, null, { sourceRepo: 'x' }));
  assert.deepEqual(loadProvenance(dir), {});
});


test('checkForUpdates: a fetched version different from current -> update-available', async () => {
  const manifest = { 'a:b': { sourceRepo: 'https://x', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } };
  const out = await checkForUpdates(manifest, async () => '2.0.0');
  assert.equal(out['a:b'].upstreamStatus, 'update-available');
  assert.equal(out['a:b'].latestVersion, '2.0.0');
  assert.equal(out['a:b'].lastError, null);
  assert.ok(typeof out['a:b'].checkedTs === 'number');
});

test('checkForUpdates: a fetched version matching current -> up-to-date', async () => {
  const manifest = { 'a:b': { sourceRepo: 'https://x', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } };
  const out = await checkForUpdates(manifest, async () => '1.0.0');
  assert.equal(out['a:b'].upstreamStatus, 'up-to-date');
});

test('checkForUpdates: a rejecting fetch fn -> unreachable + lastError, never throws to the caller', async () => {
  const manifest = { 'a:b': { sourceRepo: 'https://x', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } };
  const out = await checkForUpdates(manifest, async () => { throw new Error('network down'); });
  assert.equal(out['a:b'].upstreamStatus, 'unreachable');
  assert.match(out['a:b'].lastError, /network down/);
});

test('checkForUpdates: a fetch fn returning null -> unreachable, not silently treated as no-update', async () => {
  const manifest = { 'a:b': { sourceRepo: 'https://x', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } };
  const out = await checkForUpdates(manifest, async () => null);
  assert.equal(out['a:b'].upstreamStatus, 'unreachable');
});

test('checkForUpdates: an entry with sourceRepo:null is never checked (fetchImpl not called) and stays unknown', async () => {
  const manifest = { 'local:hand-authored': { sourceRepo: null, sourceRef: null, version: null, checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null } };
  let called = false;
  const out = await checkForUpdates(manifest, async () => { called = true; return '9.9.9'; });
  assert.equal(called, false);
  assert.equal(out['local:hand-authored'].upstreamStatus, 'unknown');
});

test('checkForUpdates: one broken entry does not knock out sibling entries', async () => {
  const manifest = {
    'ok:a': { sourceRepo: 'https://ok', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null },
    'bad:b': { sourceRepo: 'https://bad', sourceRef: 'main', version: '1.0.0', checkedTs: null, latestVersion: null, upstreamStatus: 'unknown', lastError: null },
  };
  const out = await checkForUpdates(manifest, async ({ sourceRepo }) => {
    if (sourceRepo === 'https://bad') throw new Error('boom');
    return '2.0.0';
  });
  assert.equal(out['ok:a'].upstreamStatus, 'update-available');
  assert.equal(out['bad:b'].upstreamStatus, 'unreachable');
});


test('updateCandidates: only update-available entries are surfaced', () => {
  const manifest = {
    'a:up-to-date': { sourceRepo: 'x', version: '1.0.0', latestVersion: '1.0.0', upstreamStatus: 'up-to-date' },
    'b:has-update': { sourceRepo: 'y', version: '1.0.0', latestVersion: '1.2.0', upstreamStatus: 'update-available' },
    'c:unreachable': { sourceRepo: 'z', version: '1.0.0', latestVersion: null, upstreamStatus: 'unreachable' },
  };
  const out = updateCandidates(manifest);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'b:has-update');
  assert.equal(out[0].latestVersion, '1.2.0');
});

test('acceptance #7: an entry with no provenance (sourceRepo:null / unknown) never appears in updateCandidates', () => {
  const manifest = {
    'local:hand-authored': { sourceRepo: null, version: null, latestVersion: null, upstreamStatus: 'unknown' },
  };
  assert.deepEqual(updateCandidates(manifest), []);
});

test('updateCandidates: empty/malformed manifest -> [], never throws', () => {
  assert.deepEqual(updateCandidates({}), []);
  assert.deepEqual(updateCandidates(null), []);
  assert.deepEqual(updateCandidates(undefined), []);
  assert.deepEqual(updateCandidates('nope'), []);
});

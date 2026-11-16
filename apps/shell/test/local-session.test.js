// apps/shell/test/local-session.test.js
// Scan 2026-10-15 F2: the shell's half of the local session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as shellSession from '../src/lib/local-session.js';
import { localSessionValue as kernelValue, LOCAL_SESSION_KEY_FILE as kernelFile, LOCAL_SESSION_HEADER as kernelHeader } from '../../../server/lib/governance/access-guard.js';

const KEY = 'b'.repeat(64);

test('the shell derives the same session value, file name and header as the kernel', () => {
  assert.equal(shellSession.localSessionValue(KEY), kernelValue(KEY));
  assert.equal(shellSession.LOCAL_SESSION_KEY_FILE, kernelFile);
  assert.equal(shellSession.LOCAL_SESSION_HEADER.toLowerCase(), kernelHeader);
});

test('readLocalSession returns the derived value, never the raw key, and names every failure', () => {
  const seen = [];
  const ok = shellSession.readLocalSession('/s', { readFile: (f) => { seen.push(f); return `${KEY}\n`; } });
  assert.deepEqual(ok, { value: kernelValue(KEY), reason: null });
  assert.equal(seen[0], path.join('/s', 'local-session-key'));
  const missing = shellSession.readLocalSession('/s', { readFile: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  assert.equal(missing.value, null);
  assert.match(missing.reason, /no local session key yet/);
  const denied = shellSession.readLocalSession('/s', { readFile: () => { const e = new Error('x'); e.code = 'EACCES'; throw e; } });
  assert.match(denied.reason, /EACCES/);
  assert.match(shellSession.readLocalSession('/s', { readFile: () => 'short' }).reason, /malformed/);
});

test('createLocalSession re-reads a missing key at most every 5 s, then caches it', () => {
  let t = 0; let reads = 0; let exists = false; const logs = [];
  const ls = shellSession.createLocalSession({ stateDir: '/s', now: () => t, log: (m) => logs.push(m),
    readFile: () => { reads++; if (!exists) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return KEY; } });
  assert.equal(ls.get(), null);
  t = 1000; assert.equal(ls.get(), null);
  assert.equal(reads, 1, 'no re-read inside 5 s');
  t = 6000; assert.equal(ls.get(), null);
  assert.equal(logs.length, 1, 'the same reason is logged once');
  exists = true; t = 12000;
  assert.equal(ls.get(), kernelValue(KEY));
  t = 12001; ls.get();
  assert.equal(reads, 3, 'cached once found');
});

test('the header goes on dashboard fetches to the kernel origin only', () => {
  assert.deepEqual(shellSession.kernelRequestFilter('http://127.0.0.1:8124'), { urls: ['http://127.0.0.1:8124/*'] });
  const v = kernelValue(KEY);
  assert.deepEqual(shellSession.withLocalSession({ a: '1' }, v), { a: '1', 'X-GLMPS-Local-Session': v });
  assert.deepEqual(shellSession.withLocalSession({ a: '1' }, null), { a: '1' });
  const want = shellSession.wantsLocalSession;
  assert.equal(want({ resourceType: 'xhr', referrer: 'http://127.0.0.1:8124/' }), true);
  assert.equal(want({ resourceType: 'xhr', referrer: '' }), true);
  for (const resourceType of ['mainFrame', 'subFrame', 'script', 'image', 'stylesheet']) {
    assert.equal(want({ resourceType, referrer: 'http://127.0.0.1:8124/' }), false, resourceType);
  }
  assert.equal(want({ resourceType: 'xhr', referrer: 'http://127.0.0.1:8124/wiki-ext/repo/core.html' }), false, 'untrusted wiki page');
  assert.equal(want({ resourceType: 'xhr', referrer: 'http://127.0.0.1:8124/wiki/server.html' }), false);
});

test('installLocalSession registers one onBeforeSendHeaders listener that applies the rule', () => {
  let filter; let listener;
  const ses = { webRequest: { onBeforeSendHeaders: (f, l) => { filter = f; listener = l; } } };
  shellSession.installLocalSession({ ses, kernelUrl: 'http://127.0.0.1:8124/', localSession: { get: () => 'v' } });
  assert.deepEqual(filter, { urls: ['http://127.0.0.1:8124/*'] });
  let out;
  listener({ resourceType: 'xhr', referrer: 'http://127.0.0.1:8124/', requestHeaders: {} }, (r) => { out = r; });
  assert.deepEqual(out, { requestHeaders: { 'X-GLMPS-Local-Session': 'v' } });
  listener({ resourceType: 'image', referrer: 'http://127.0.0.1:8124/', requestHeaders: {} }, (r) => { out = r; });
  assert.deepEqual(out, { requestHeaders: {} });
});

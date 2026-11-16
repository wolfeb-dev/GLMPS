// server/test/wiki-serve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWikiAssetRequest, resolveWikiRequest } from '../lib/observability/wiki-serve.js';
import { wikiPaths, buildIdFor, publishWikiBuild } from '../lib/observability/wiki-publish.js';

function published() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'));
  const dir = path.join(wikiPaths(stateDir).builds, buildIdFor('a'.repeat(40), 1000));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"sections":[]}');
  fs.writeFileSync(path.join(dir, 'server.html'), '<p>ok</p>');
  fs.writeFileSync(path.join(wikiPaths(stateDir).root, 'secret.html'), 'do not serve');
  publishWikiBuild({ stateDir, buildDir: dir, meta: { builtAtCommit: 'a'.repeat(40), sections: 1, llmSections: 1 } });
  return { stateDir, dir };
}

test('isWikiAssetRequest: files and suspicious paths yes; SPA routes no', () => {
  assert.equal(isWikiAssetRequest('/wiki/server.html'), true);
  assert.equal(isWikiAssetRequest('/wiki/manifest.json?v=1'), true);
  assert.equal(isWikiAssetRequest('/wiki/../secret.html'), true);
  assert.equal(isWikiAssetRequest('/wiki/%2e%2e'), true);
  assert.equal(isWikiAssetRequest('/wiki'), false);
  assert.equal(isWikiAssetRequest('/wiki/'), false);
  assert.equal(isWikiAssetRequest('/wiki/server'), false);
  assert.equal(isWikiAssetRequest('/wiki-ext/x/y.html'), false);
});

test('resolves a page and the manifest inside the current build', () => {
  const { stateDir, dir } = published();
  assert.deepEqual(resolveWikiRequest({ rawUrl: '/wiki/server.html?v=2026', stateDir }), { status: 200, file: path.join(dir, 'server.html') });
  assert.equal(resolveWikiRequest({ rawUrl: '/wiki/manifest.json', stateDir }).status, 200);
});

test('traversal in every spelling is 400', () => {
  const { stateDir } = published();
  for (const rawUrl of ['/wiki/../secret.html', '/wiki/..%2Fsecret.html', '/wiki/%2e%2e%2fsecret.html',
    '/wiki/..%5Csecret.html', '/wiki/..\\secret.html', '/wiki/a/b.html', '/wiki/.cache.json', '/wiki/%E0%A4%A.html']) {
    assert.equal(resolveWikiRequest({ rawUrl, stateDir }).status, 400, rawUrl);
  }
});

test('404 when nothing is published, and for a missing page', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'));
  assert.equal(resolveWikiRequest({ rawUrl: '/wiki/server.html', stateDir: empty }).status, 404);
  const { stateDir } = published();
  assert.equal(resolveWikiRequest({ rawUrl: '/wiki/nope.html', stateDir }).status, 404);
});

// a non-ENOENT stat error (ENAMETOOLONG, EACCES, ...) used to
// rethrow out of resolveWikiRequest, reaching the server's outer 500 handler
// with the raw fs error message AND the absolute build path in the client
// response. The name here is long enough to hit a real ENAMETOOLONG on a
// platform that enforces one; `stat` is still injectable so the assertion
// does not depend on which OS/filesystem is running the test.
test('a non-ENOENT stat error is 400 with a generic message, never the raw error or the filesystem path', () => {
  const { stateDir, dir } = published();
  const longName = `${'a'.repeat(300)}.html`;
  const err = new Error(`ENAMETOOLONG: name too long, stat '${path.join(dir, longName)}'`);
  err.code = 'ENAMETOOLONG';
  const stat = () => { throw err; };
  const r = resolveWikiRequest({ rawUrl: `/wiki/${longName}`, stateDir, stat });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.error, /ENAMETOOLONG/);
  assert.doesNotMatch(r.error, /name too long/);
  assert.doesNotMatch(r.error, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// the containment check before this fix was a
// path-STRING comparison only (path.resolve(file).startsWith(dir)), which a
// single safe path segment (NAME already refuses '/', '\\', '..') always
// passes syntactically -- even when that segment is itself a symlink/
// junction whose TARGET lives outside the build dir. stat() then follows
// the link, so a build directory containing a link named e.g. evil.html
// would serve whatever is on the other end of it. File symlinks need no
// special privilege on most platforms but DO on a locked-down Windows host
// without Developer Mode; skip with a named reason there rather than fail.
test('a file symlink inside the build dir pointing outside it is refused, not served (R-M5)', (t) => {
  const { stateDir, dir } = published();
  const secretFile = path.join(os.tmpdir(), `mc-ws-secret-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(secretFile, 'TOP SECRET, never serve this');
  const link = path.join(dir, 'evil.html');
  try {
    fs.symlinkSync(secretFile, link, 'file');
  } catch (e) {
    t.skip(`file symlink creation not permitted on this host (${e.code}): skipping this case`);
    return;
  }
  try {
    const r = resolveWikiRequest({ rawUrl: '/wiki/evil.html', stateDir });
    assert.notEqual(r.status, 200, `a symlink inside the build dir must never resolve to 200: got ${JSON.stringify(r)}`);
  } finally { fs.rmSync(secretFile, { force: true }); }
});

// readCurrentWiki throws on a malformed current.json,
// carrying the absolute <stateDir>/wiki/current.json path in its message.
// resolveWikiRequest used to let that throw straight out, uncaught, which
// reaches the server's outer 500 handler and puts that path in the client
// response. Caught here instead: a generic 500, the real reason logged
// server-side only.
test('a malformed current.json is 500 with a generic message, never the path or "malformed" detail', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'));
  fs.mkdirSync(wikiPaths(stateDir).root, { recursive: true });
  fs.writeFileSync(wikiPaths(stateDir).current, '{ not valid json');
  const r = resolveWikiRequest({ rawUrl: '/wiki/server.html', stateDir });
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.error, /malformed/);
  assert.doesNotMatch(r.error, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

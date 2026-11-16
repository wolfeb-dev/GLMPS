// server/test/wiki-publish.test.js
// atomic current.json swap and keep-the-last-3 retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wikiPaths, buildIdFor, readCurrentWiki, publishWikiBuild, pruneWikiBuilds, writeJsonAtomic } from '../lib/observability/wiki-publish.js';

const mkState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wp-'));
function mkBuild(stateDir, sha, ts) {
  const dir = path.join(wikiPaths(stateDir).builds, buildIdFor(sha, ts));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ builtAtCommit: sha, sections: [] }));
  return dir;
}
const meta = (sha) => ({ builtAtCommit: sha, sections: 2, llmSections: 2, verifierRef: `wiki-verify@${sha}` });

test('readCurrentWiki is null before anything is published', () => {
  assert.equal(readCurrentWiki(mkState()), null);
});

test('publishing two builds leaves current.json pointing at the second', () => {
  const s = mkState();
  publishWikiBuild({ stateDir: s, buildDir: mkBuild(s, 'a'.repeat(40), 1000), meta: meta('a'.repeat(40)), now: () => 1000 });
  const second = mkBuild(s, 'b'.repeat(40), 2000);
  publishWikiBuild({ stateDir: s, buildDir: second, meta: meta('b'.repeat(40)), now: () => 2000 });
  const cur = readCurrentWiki(s);
  assert.equal(cur.build, path.basename(second));
  assert.equal(cur.builtAtCommit, 'b'.repeat(40));
  assert.equal(cur.builtTs, 2000);
  assert.equal(cur.verifierRef, `wiki-verify@${'b'.repeat(40)}`);
});

test('a crash between the temp write and the rename leaves the old pointer valid', () => {
  const s = mkState();
  const first = mkBuild(s, 'a'.repeat(40), 1000);
  publishWikiBuild({ stateDir: s, buildDir: first, meta: meta('a'.repeat(40)) });
  const second = mkBuild(s, 'b'.repeat(40), 2000);
  assert.throws(() => publishWikiBuild({ stateDir: s, buildDir: second, meta: meta('b'.repeat(40)),
    rename: () => { throw new Error('simulated crash before rename'); } }), /simulated crash/);
  assert.equal(readCurrentWiki(s).build, path.basename(first));
});

test('after 4 publishes only 3 builds remain, and the current one is among them', () => {
  const s = mkState();
  let last;
  for (let i = 1; i <= 4; i++) {
    last = mkBuild(s, String(i).repeat(40), i * 1000);
    publishWikiBuild({ stateDir: s, buildDir: last, meta: meta(String(i).repeat(40)), now: () => i * 1000 });
  }
  const left = fs.readdirSync(wikiPaths(s).builds).sort();
  assert.equal(left.length, 3);
  assert.ok(left.includes(path.basename(last)));
  assert.ok(!left.includes(buildIdFor('1'.repeat(40), 1000)));
});

test('refuses to publish a directory outside <stateDir>/wiki/builds or one with no manifest', () => {
  const s = mkState();
  assert.throws(() => publishWikiBuild({ stateDir: s, buildDir: os.tmpdir(), meta: meta('a') }), /outside/);
  const empty = path.join(wikiPaths(s).builds, 'x-1');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => publishWikiBuild({ stateDir: s, buildDir: empty, meta: meta('a') }), /no manifest/);
});

test('a retention failure is reported, not swallowed, and the publish still happened', () => {
  const s = mkState();
  for (let i = 1; i <= 3; i++) mkBuild(s, String(i).repeat(40), i * 1000);
  const newest = mkBuild(s, '4'.repeat(40), 4000);
  const r = publishWikiBuild({ stateDir: s, buildDir: newest, meta: meta('4'.repeat(40)),
    rm: () => { throw new Error('EBUSY: file open'); } });
  assert.equal(readCurrentWiki(s).build, path.basename(newest));
  assert.equal(r.retentionErrors.length, 1);
  assert.match(r.retentionErrors[0], /EBUSY/);
});

test('pruneWikiBuilds keeps the current build even when it is the oldest', () => {
  const s = mkState();
  const oldest = mkBuild(s, '1'.repeat(40), 1000);
  for (let i = 2; i <= 5; i++) mkBuild(s, String(i).repeat(40), i * 1000);
  pruneWikiBuilds({ stateDir: s, keep: 3, current: path.basename(oldest) });
  const left = fs.readdirSync(wikiPaths(s).builds);
  assert.equal(left.length, 3);
  assert.ok(left.includes(path.basename(oldest)));
});

test('a malformed current.json throws instead of reading as "no wiki"', () => {
  const s = mkState();
  fs.mkdirSync(wikiPaths(s).root, { recursive: true });
  fs.writeFileSync(wikiPaths(s).current, JSON.stringify({ build: '../escape' }));
  assert.throws(() => readCurrentWiki(s), /malformed/);
});

test('a readdir failure during retention is reported, not thrown, and the publish still happened', () => {
  const s = mkState();
  const first = mkBuild(s, 'a'.repeat(40), 1000);
  publishWikiBuild({ stateDir: s, buildDir: first, meta: meta('a'.repeat(40)), now: () => 1000 });
  const second = mkBuild(s, 'b'.repeat(40), 2000);
  const r = publishWikiBuild({
    stateDir: s, buildDir: second, meta: meta('b'.repeat(40)), now: () => 2000,
    readdir: () => { const e = new Error('EPERM: operation not permitted, scandir'); e.code = 'EPERM'; throw e; },
  });
  assert.equal(readCurrentWiki(s).build, path.basename(second));
  assert.equal(r.retentionErrors.length, 1);
  assert.match(r.retentionErrors[0], /EPERM/);
});

test('invalid JSON in current.json throws the malformed error, not a raw SyntaxError', () => {
  const s = mkState();
  fs.mkdirSync(wikiPaths(s).root, { recursive: true });
  fs.writeFileSync(wikiPaths(s).current, '{not json');
  assert.throws(() => readCurrentWiki(s), /malformed/);
});

test('writeJsonAtomic removes its temp file when rename fails', () => {
  const s = mkState();
  const dir = path.join(s, 'x');
  const file = path.join(dir, 'current.json');
  assert.throws(() => writeJsonAtomic(file, { a: 1 }, { rename: () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('writeJsonAtomic appends a cleanup failure to the thrown error, not swallowing it', () => {
  const s = mkState();
  const file = path.join(s, 'y', 'current.json');
  assert.throws(
    () => writeJsonAtomic(file, { a: 1 }, {
      rename: () => { throw new Error('boom'); },
      unlink: () => { throw new Error('cleanup EPERM'); },
    }),
    (err) => /boom/.test(err.message) && /cleanup EPERM/.test(err.message),
  );
});

test('pruneWikiBuilds without an explicit current reads the published pointer', () => {
  const s = mkState();
  const oldest = mkBuild(s, '1'.repeat(40), 1000);
  publishWikiBuild({ stateDir: s, buildDir: oldest, meta: meta('1'.repeat(40)), now: () => 1000 });
  for (let i = 2; i <= 5; i++) mkBuild(s, String(i).repeat(40), i * 1000);
  pruneWikiBuilds({ stateDir: s, keep: 3 });
  const left = fs.readdirSync(wikiPaths(s).builds);
  assert.equal(left.length, 3);
  assert.ok(left.includes(path.basename(oldest)));
});

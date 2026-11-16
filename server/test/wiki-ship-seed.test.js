import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedWikiSnapshot, wikiSnapshotSha256, isInstalledBundle, wikiLoopEnabled } from '../lib/observability/wiki-ship-seed.js';
import { readCurrentWiki, wikiPaths } from '../lib/observability/wiki-publish.js';

const BUILD = 'abc123def456-1760000000000';
const BUNDLED_AT = '2025-10-09T08:53:20.000Z';

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fixture({ record = true, sha = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wiki-seed-'));
  const bundleDir = path.join(tmp, 'kernel');
  const stateDir = path.join(tmp, 'state');
  const build = path.join(bundleDir, 'wiki', BUILD);
  put(path.join(build, 'manifest.json'), JSON.stringify({ sections: [{ slug: 'a' }] }));
  put(path.join(build, 'a.html'), '<p>a</p>');
  put(path.join(bundleDir, 'wiki', 'current.json'), JSON.stringify({ build: BUILD, builtAtCommit: 'abc123def456', graphFingerprint: 'g1', sections: 1, llmSections: 1, verifierRef: 'v1', builtTs: 5 }));
  const wiki = { build: BUILD, builtAt: BUNDLED_AT, pages: 1, sha256: sha ?? wikiSnapshotSha256(build) };
  put(path.join(bundleDir, 'bundle.json'), JSON.stringify({ commit: 'abc', ...(record ? { wiki } : {}) }));
  return { tmp, bundleDir, stateDir, p: wikiPaths(stateDir) };
}

// A wiki already in the state dir, the way the loop publishes one.
function local(f, { builtTs, build = 'localbuild00-1', withBuild = true, rawCurrent = null }) {
  if (withBuild) put(path.join(f.p.builds, build, 'manifest.json'), '{}');
  put(f.p.current, rawCurrent ?? JSON.stringify({ build, builtTs, sections: 1, llmSections: 1 }));
}

const cleanup = (f) => fs.rmSync(f.tmp, { recursive: true, force: true });

test('seeds an absent wiki: the build is copied, current.json points at it, carrying the bundled meta', () => {
  const f = fixture();
  try {
    assert.deepEqual(seedWikiSnapshot(f), { seeded: true, reason: 'absent' });
    assert.equal(fs.readFileSync(path.join(f.p.builds, BUILD, 'a.html'), 'utf8'), '<p>a</p>');
    const cur = readCurrentWiki(f.stateDir);
    assert.equal(cur.build, BUILD);
    assert.equal(cur.builtTs, Date.parse(BUNDLED_AT));
    assert.equal(cur.builtAtCommit, 'abc123def456');
    assert.equal(cur.graphFingerprint, 'g1');
    assert.equal(cur.verifierRef, 'v1');
    assert.deepEqual(fs.readdirSync(f.p.builds), [BUILD], 'no staging dir left behind');
  } finally { cleanup(f); }
});

test('replaces a local wiki published before the bundled snapshot', () => {
  const f = fixture();
  try {
    local(f, { builtTs: Date.parse(BUNDLED_AT) - 1000 });
    assert.deepEqual(seedWikiSnapshot(f), { seeded: true, reason: 'older' });
    assert.equal(readCurrentWiki(f.stateDir).build, BUILD);
  } finally { cleanup(f); }
});

test('replaces a local wiki whose current.json is unreadable, or whose build is gone', () => {
  for (const over of [{ rawCurrent: 'not json', withBuild: false }, { builtTs: Date.parse(BUNDLED_AT) + 1000, withBuild: false }]) {
    const f = fixture();
    try {
      local(f, over);
      assert.equal(seedWikiSnapshot(f).seeded, true);
      assert.equal(readCurrentWiki(f.stateDir).build, BUILD);
    } finally { cleanup(f); }
  }
});

test('leaves a local wiki published at or after the bundled snapshot alone (the loop rebuilt it)', () => {
  for (const builtTs of [Date.parse(BUNDLED_AT), Date.parse(BUNDLED_AT) + 86_400_000]) {
    const f = fixture();
    try {
      local(f, { builtTs });
      assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'local wiki is current' });
      assert.equal(readCurrentWiki(f.stateDir).build, 'localbuild00-1');
      assert.equal(fs.existsSync(path.join(f.p.builds, BUILD)), false);
    } finally { cleanup(f); }
  }
});

test('a kernel with no bundle.json wiki record (a source checkout) never seeds', () => {
  const f = fixture({ record: false });
  try {
    assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'no bundled wiki' });
    assert.equal(fs.existsSync(f.p.root), false);
  } finally { cleanup(f); }
});

test('a directory with no bundle.json at all never seeds and does not throw', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.bundleDir, 'bundle.json'));
    assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'no bundled wiki' });
  } finally { cleanup(f); }
});

test('refuses a bundled wiki that does not match its bundle.json checksum', () => {
  const f = fixture({ sha: '0'.repeat(64) });
  try {
    assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'bundled wiki fails its bundle.json checksum' });
    assert.equal(fs.existsSync(f.p.current), false);
  } finally { cleanup(f); }
});

test('a page edited after staging fails the checksum', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.bundleDir, 'wiki', BUILD, 'a.html'), '<p>tampered</p>');
    assert.equal(seedWikiSnapshot(f).seeded, false);
  } finally { cleanup(f); }
});

test('a bundle.json record with the wiki files missing reports it instead of throwing', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.bundleDir, 'wiki'), { recursive: true });
    assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'bundled wiki is missing' });
  } finally { cleanup(f); }
});

test('a record whose build name is not a plain build id is refused', () => {
  const f = fixture();
  try {
    const b = JSON.parse(fs.readFileSync(path.join(f.bundleDir, 'bundle.json'), 'utf8'));
    b.wiki.build = '../escape';
    fs.writeFileSync(path.join(f.bundleDir, 'bundle.json'), JSON.stringify(b));
    assert.deepEqual(seedWikiSnapshot(f), { seeded: false, reason: 'bundled wiki names an invalid build' });
  } finally { cleanup(f); }
});

test('isInstalledBundle is true only for a readable bundle.json at the kernel root', () => {
  const f = fixture();
  try {
    assert.equal(isInstalledBundle(f.bundleDir), true);
    fs.writeFileSync(path.join(f.bundleDir, 'bundle.json'), 'not json');
    assert.equal(isInstalledBundle(f.bundleDir), false);
    fs.rmSync(path.join(f.bundleDir, 'bundle.json'));
    assert.equal(isInstalledBundle(f.bundleDir), false);
    assert.equal(isInstalledBundle(path.join(f.tmp, 'nowhere')), false);
  } finally { cleanup(f); }
});

test('the wiki loop is off by default on an installed bundle, on in a service checkout, and an explicit setting always wins', () => {
  assert.equal(wikiLoopEnabled({ configured: null, serviceMode: true, installedBundle: false }), true);
  assert.equal(wikiLoopEnabled({ configured: undefined, serviceMode: true, installedBundle: true }), false);
  assert.equal(wikiLoopEnabled({ configured: null, serviceMode: false, installedBundle: false }), false);
  assert.equal(wikiLoopEnabled({ configured: true, serviceMode: true, installedBundle: true }), true);
  assert.equal(wikiLoopEnabled({ configured: true, serviceMode: false, installedBundle: true }), true);
  assert.equal(wikiLoopEnabled({ configured: false, serviceMode: true, installedBundle: false }), false);
});

test('server.js seeds the wiki next to the other seeds and gates the loop default on the bundle', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /seedWikiSnapshot\(\{ bundleDir: REPO_ROOT, stateDir: P\.stateDir \}\)/);
  assert.match(src, /wikiLoopDefault\(\{ configured: cfg\.wikiLoop\.enabled, serviceMode: isServiceMode\(env\), installedBundle: isInstalledBundle\(REPO_ROOT\) \}\)/);
});

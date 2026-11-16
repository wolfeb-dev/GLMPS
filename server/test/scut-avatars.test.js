// Tests for SCUT avatar-URL resolution (server/lib/scut/avatars.js).
// Pure string work - no network, no filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAvatarBase, avatarUrl, AVATAR_MODES } from '../lib/scut/avatars.js';

test('normalizeAvatarBase strips trailing slashes and trims', () => {
  assert.equal(normalizeAvatarBase('https://x.dev/a/'), 'https://x.dev/a');
  assert.equal(normalizeAvatarBase('https://x.dev/a///'), 'https://x.dev/a');
  assert.equal(normalizeAvatarBase('  https://x.dev/a  '), 'https://x.dev/a');
  assert.equal(normalizeAvatarBase('https://x.dev'), 'https://x.dev');
});

test('normalizeAvatarBase refuses anything Slack cannot fetch', () => {
  // http:// and localhost are the mistakes this feature invites: Slack fetches
  // icon_url from ITS servers, so a loopback URL resolves inside Slack.
  for (const bad of ['', '   ', null, undefined, 42, {}, 'http://x.dev/a',
    'http://127.0.0.1:8123/a', 'file:///tmp/a', 'not a url', 'ftp://x.dev/a']) {
    assert.equal(normalizeAvatarBase(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('avatarUrl composes mode + slug', () => {
  assert.equal(avatarUrl('https://x.dev/a/', 'bob', 'riker'), 'https://x.dev/a/bob/riker.png');
  assert.equal(avatarUrl('https://x.dev/a', 'pro', 'bill'), 'https://x.dev/a/pro/bill.png');
});

test('avatarUrl yields null rather than a broken URL', () => {
  assert.equal(avatarUrl(null, 'pro', 'bill'), null);          // unconfigured
  assert.equal(avatarUrl('http://x.dev/a', 'pro', 'bill'), null); // unusable base
  assert.equal(avatarUrl('https://x.dev/a', 'nope', 'bill'), null); // unknown mode
  assert.equal(avatarUrl('https://x.dev/a', 'pro', ''), null);   // no slug
  assert.equal(avatarUrl('https://x.dev/a', 'pro', '../etc'), null); // not a slug
  assert.equal(avatarUrl('https://x.dev/a', 'pro', 'Bill'), null);   // slugs are lowercase
});

test('AVATAR_MODES is exactly the two theme modes', () => {
  assert.deepEqual(AVATAR_MODES, ['pro', 'bob']);
});

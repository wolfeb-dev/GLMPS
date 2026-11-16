// apps/shell/test/screen-share.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRequestDisplayMedia, displayMediaCallbackArgs, mayClaimScreenShareSlot, offerSystemAudio, isScreenShareShowing, isScreenShareAbandoned, withTimeout } from '../src/lib/screen-share.js';

test('a Slack origin may request display media', () => {
  assert.equal(mayRequestDisplayMedia({ securityOrigin: 'https://app.slack.com' }), true);
  assert.equal(mayRequestDisplayMedia({ securityOrigin: 'https://my-team.slack.com' }), true);
});

test('anything that is not a slack.com origin is refused, including a look-alike host', () => {
  for (const origin of ['https://app.slack.com.attacker.test', 'https://example.com', 'http://app.slack.com', '', null, undefined, 'not a url']) {
    assert.equal(mayRequestDisplayMedia({ securityOrigin: origin }), false, String(origin));
  }
});

const SOURCES = [
  { id: 'screen:0:0', name: 'Entire screen' },
  { id: 'window:123:0', name: 'Slack' },
];

test('choosing a known source maps to the callback shape setDisplayMediaRequestHandler expects', () => {
  assert.deepEqual(
    displayMediaCallbackArgs({ sourceId: 'screen:0:0', sources: SOURCES, includeAudio: false }),
    { video: { id: 'screen:0:0', name: 'Entire screen' } },
  );
});

test('choosing to include system audio adds the loopback audio stream', () => {
  assert.deepEqual(
    displayMediaCallbackArgs({ sourceId: 'window:123:0', sources: SOURCES, includeAudio: true }),
    { video: { id: 'window:123:0', name: 'Slack' }, audio: 'loopback' },
  );
});

test('a cancelled picker (no sourceId) denies the request', () => {
  assert.equal(displayMediaCallbackArgs({ sourceId: null, sources: SOURCES, includeAudio: false }), null);
  assert.equal(displayMediaCallbackArgs({ sourceId: undefined, sources: SOURCES, includeAudio: false }), null);
});

test('a sourceId that does not match any source offered denies the request rather than guessing', () => {
  assert.equal(displayMediaCallbackArgs({ sourceId: 'window:999:0', sources: SOURCES, includeAudio: false }), null);
});

// 2026-10-02 (PR #29 review): desktopCapturer.getSources is async, so a
// second getDisplayMedia request can arrive while the first is still loading
// sources, before the picker ever shows. The slot is claimed synchronously
// (before that await) precisely so this check sees it occupied.
test('mayClaimScreenShareSlot: only an empty slot (no request in flight) may be claimed', () => {
  assert.equal(mayClaimScreenShareSlot(null), true);
  assert.equal(mayClaimScreenShareSlot(undefined), true);
});

test('mayClaimScreenShareSlot: a slot that is loading sources, or already open with a picker, refuses a second request', () => {
  assert.equal(mayClaimScreenShareSlot({ loading: true }), false);
  assert.equal(mayClaimScreenShareSlot({ sources: [], canShareAudio: false, resolve: () => {}, requestId: 1 }), false);
});

// Looping system audio back into the huddle is exactly what it sounds like to
// every other participant too, so it is only ever offered when the web
// content actually asked for an audio stream, and only where Electron
// documents loopback support (session.md: Windows only).
test('offerSystemAudio: only on win32, and only when the request itself asked for audio', () => {
  assert.equal(offerSystemAudio({ platform: 'win32', audioRequested: true }), true);
  assert.equal(offerSystemAudio({ platform: 'win32', audioRequested: false }), false);
  assert.equal(offerSystemAudio({ platform: 'darwin', audioRequested: true }), false);
  assert.equal(offerSystemAudio({ platform: 'linux', audioRequested: true }), false);
});

// 2026-10-02 (re-review): shortcuts must not be suspended merely because a
// request is loading sources (that can take up to the getSources timeout);
// only once the picker is actually in front of the operator does toggling
// Slack, swapping panes or reloading a view risk disrupting anything visible.
test('isScreenShareShowing: true only once the picker has actually been shown (a resolver exists)', () => {
  assert.equal(isScreenShareShowing(null), false);
  assert.equal(isScreenShareShowing(undefined), false);
  assert.equal(isScreenShareShowing({ loading: true }), false);
  assert.equal(isScreenShareShowing({ sources: [], canShareAudio: false, resolve: () => {}, requestId: 1 }), true);
});

// A request whose slot was marked closed (the window closed while sources
// were still loading) must never reach showPicker once getSources finally
// answers, and must still answer Chromium's callback(null) instead of hanging.
test('isScreenShareAbandoned: true once the slot has been marked closed', () => {
  assert.equal(isScreenShareAbandoned(null), false);
  assert.equal(isScreenShareAbandoned({ loading: true }), false);
  assert.equal(isScreenShareAbandoned({ loading: true, closed: true }), true);
});

test('withTimeout resolves normally when the promise settles before the deadline', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'too slow'), 'ok');
});

test('withTimeout rejects with the given message once the deadline passes without the promise settling', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10, 'too slow'), /too slow/);
});

test('withTimeout propagates the original rejection, not a timeout one, when the promise rejects first', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50, 'too slow'), /boom/);
});

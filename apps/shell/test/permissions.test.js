// apps/shell/test/permissions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionDecision, ORIGIN_SCOPED } from '../src/lib/permissions.js';

const allow = (role, permission) => permissionDecision({ role, permission });
const SLACK_ORIGIN = 'https://app.slack.com';

test('Slack may notify; the dashboard may not', () => {
  assert.equal(allow('slack', 'notifications'), true);
  assert.equal(allow('dashboard', 'notifications'), false);
});

test('clipboard writes and fullscreen for both panes', () => {
  for (const role of ['slack', 'dashboard']) {
    assert.equal(allow(role, 'clipboard-sanitized-write'), true);
    assert.equal(allow(role, 'fullscreen'), true);
  }
});

test('everything else is denied, including reaching the kernel from Slack', () => {
  for (const p of ['geolocation', 'clipboard-read', 'local-network', 'local-network-access', 'loopback-network', 'openExternal', 'unknown']) {
    assert.equal(allow('slack', p), false, p);
    assert.equal(allow('dashboard', p), false, p);
  }
});

test('Slack may use the camera and microphone for a huddle, from its own origin; the dashboard may not from the Slack origin, local pages never may', () => {
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio', 'video'], origin: SLACK_ORIGIN }), true);
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio'], origin: SLACK_ORIGIN }), true);
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['video'], origin: 'https://my-team.slack.com' }), true);
  assert.equal(permissionDecision({ role: 'dashboard', permission: 'media', mediaTypes: ['audio', 'video'], origin: SLACK_ORIGIN }), false);
  assert.equal(permissionDecision({ role: 'local', permission: 'media', mediaTypes: ['audio', 'video'], origin: SLACK_ORIGIN }), false);
});

// 2026-10-02 (PR #29 review): a slack-role session can still host a
// cross-origin frame (an embedded third-party widget, an ad); the grant is
// scoped to the actual requesting origin, never the partition/role alone.
test('a media or display-capture grant is scoped to the requesting origin, not just the slack partition', () => {
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio', 'video'], origin: 'https://evil.example.com' }), false);
  assert.equal(permissionDecision({ role: 'slack', permission: 'display-capture', origin: 'https://evil.example.com' }), false);
  // A look-alike host is refused too, same as navigation.js's own classifyUrl.
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio', 'video'], origin: 'https://app.slack.com.evil.test' }), false);
});

test('an absent origin denies a media or display-capture grant even for the slack role', () => {
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio', 'video'] }), false);
  assert.equal(permissionDecision({ role: 'slack', permission: 'display-capture' }), false);
});

test('a media request naming anything beyond audio and video is denied even from the Slack origin', () => {
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['audio', 'midi'], origin: SLACK_ORIGIN }), false);
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: ['unknown'], origin: SLACK_ORIGIN }), false);
  assert.equal(permissionDecision({ role: 'slack', permission: 'media', mediaTypes: [], origin: SLACK_ORIGIN }), true);
});

test('Slack may share its screen from its own origin; the dashboard and local pages may not', () => {
  assert.equal(permissionDecision({ role: 'slack', permission: 'display-capture', origin: SLACK_ORIGIN }), true);
  assert.equal(allow('dashboard', 'display-capture'), false);
  assert.equal(allow('local', 'display-capture'), false);
});

test('the shell-local pages get nothing, and an unknown role gets nothing', () => {
  assert.equal(allow('local', 'notifications'), false);
  assert.equal(allow('local', 'clipboard-sanitized-write'), false);
  assert.equal(allow('other', 'notifications'), false);
});

// 2026-10-02 (re-review): exported so shell-window.js's diagnostic "no
// requesting origin" log derives its condition from this one list instead of
// repeating 'media' and 'display-capture' as a second, driftable copy.
test('ORIGIN_SCOPED names exactly the permissions that reach real hardware', () => {
  assert.equal(ORIGIN_SCOPED.has('media'), true);
  assert.equal(ORIGIN_SCOPED.has('display-capture'), true);
  assert.equal(ORIGIN_SCOPED.has('notifications'), false);
  assert.equal(ORIGIN_SCOPED.size, 2);
});

test('prototype-shadowing role names fail closed instead of throwing', () => {
  for (const role of ['__proto__', 'constructor', 'toString']) {
    assert.equal(allow(role, 'notifications'), false, role);
    assert.equal(allow(role, 'clipboard-sanitized-write'), false, role);
    assert.equal(allow(role, 'fullscreen'), false, role);
  }
});

// 2026-10-27 (card glmps-2-0-runtime-82): the dashboard huddle needs the
// microphone. Audio only, and only for the configured dashboard origin.
const DASH = 'http://127.0.0.1:8123';
const dash = (o) => permissionDecision({ role: 'dashboard', permission: 'media', dashboardOrigin: DASH, ...o });

test('the dashboard may use the microphone from its own origin', () => {
  assert.equal(dash({ mediaTypes: ['audio'], origin: DASH }), true);
  assert.equal(dash({ mediaTypes: ['audio'], origin: `${DASH}/` }), true);
  assert.equal(dash({ mediaTypes: ['audio'], origin: DASH, dashboardOrigin: `${DASH}/` }), true);
});

test('the dashboard never gets the camera or an unknown media type', () => {
  assert.equal(dash({ mediaTypes: ['video'], origin: DASH }), false);
  assert.equal(dash({ mediaTypes: ['audio', 'video'], origin: DASH }), false);
  assert.equal(dash({ mediaTypes: ['unknown'], origin: DASH }), false);
  assert.equal(dash({ mediaTypes: ['audio', 'midi'], origin: DASH }), false);
  assert.equal(dash({ mediaTypes: [], origin: DASH }), false);
  assert.equal(dash({ origin: DASH }), false);
});

test('the dashboard microphone grant refuses other origins and a missing origin', () => {
  assert.equal(dash({ mediaTypes: ['audio'], origin: 'http://127.0.0.1:8124' }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: 'http://localhost:8123' }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: 'https://127.0.0.1:8123' }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: SLACK_ORIGIN }), false);
  assert.equal(dash({ mediaTypes: ['audio'] }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: 'null' }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: DASH, dashboardOrigin: undefined }), false);
  assert.equal(dash({ mediaTypes: ['audio'], origin: 'not a url', dashboardOrigin: 'not a url' }), false);
});

test('the dashboard still gets no screen share, and local pages no microphone', () => {
  assert.equal(permissionDecision({ role: 'dashboard', permission: 'display-capture', origin: DASH, dashboardOrigin: DASH }), false);
  assert.equal(permissionDecision({ role: 'local', permission: 'media', mediaTypes: ['audio'], origin: DASH, dashboardOrigin: DASH }), false);
});

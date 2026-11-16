// server/test/scut-channel-health.test.js
// SCUT Slack channel poll-failure visibility (glmps-44). Before this,
// a channel that could not read its own thread (missing channels:history scope,
// an archived channel, a reinstall that dropped a scope) logged
// `poll failed (missing_scope)` to the child process's own stderr and nothing
// else happened - a live session the operator can see, that will never hear
// them again, with no signal anywhere on the dashboard. That cost a full test
// cycle on 2026-08-04.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackError } from '../lib/scut/slack-web.js';
import {
  classifyPollError,
  recordPollFailure,
  clearChannelHealth,
  scutChannelHealth,
} from '../lib/scut/channel-health.js';

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scut-health-')); }

test('classifyPollError: a missing-scope SlackError is auth, not transient', () => {
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  assert.equal(classifyPollError(err), 'auth');
});

test('classifyPollError: known config-fatal Slack codes all classify as auth', () => {
  for (const code of ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_in_channel', 'channel_not_found', 'is_archived']) {
    const err = new SlackError('conversations.replies', code, {});
    assert.equal(classifyPollError(err), 'auth', code);
  }
});

test('classifyPollError: a rate-limit SlackError is transient', () => {
  const err = new SlackError('conversations.replies', 'ratelimited', {});
  assert.equal(classifyPollError(err), 'transient');
});

test('classifyPollError: a plain network Error (no Slack code) is transient', () => {
  assert.equal(classifyPollError(new Error('fetch failed')), 'transient');
  assert.equal(classifyPollError(undefined), 'transient');
});

test('scutChannelHealth: an empty or missing dir has no failing channels', () => {
  const dir = mkTmp();
  assert.deepEqual(scutChannelHealth(dir), {});
  assert.deepEqual(scutChannelHealth(path.join(dir, 'does-not-exist')), {});
});

test('recordPollFailure writes a snapshot entry naming the channel and the reason', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  recordPollFailure(dir, { channel: 'C123', threadTs: '111.222', ticket: 'glmps-44' }, err, { now: 1000 });
  const h = scutChannelHealth(dir);
  assert.equal(h['C123'].degraded, true);
  assert.equal(h['C123'].channel, 'C123');
  assert.equal(h['C123'].lastReason, 'missing_scope');
  assert.equal(h['C123'].ticket, 'glmps-44');
  assert.equal(h['C123'].failures, 1);
  assert.equal(h['C123'].firstFailTs, 1000);
  assert.equal(h['C123'].lastFailTs, 1000);
});

test('repeated failures on the same channel accumulate a count, not a new entry', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'ratelimited', {});
  recordPollFailure(dir, { channel: 'C123' }, err, { now: 1000 });
  recordPollFailure(dir, { channel: 'C123' }, err, { now: 2000 });
  recordPollFailure(dir, { channel: 'C123' }, err, { now: 3000 });
  const h = scutChannelHealth(dir);
  assert.equal(Object.keys(h).length, 1);
  assert.equal(h['C123'].failures, 3);
  assert.equal(h['C123'].firstFailTs, 1000, 'first-seen time does not move on repeat failures');
  assert.equal(h['C123'].lastFailTs, 3000);
});

test('a config-fatal (auth) classification reads critical on the very first failure', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  recordPollFailure(dir, { channel: 'C1' }, err, { now: 1000 });
  assert.equal(scutChannelHealth(dir)['C1'].critical, true,
    'a scope that is missing will not clear on retry - waiting for a streak only delays the alert');
});

test('a transient classification stays warn (non-critical) until it has recurred enough to look durable', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'ratelimited', {});
  recordPollFailure(dir, { channel: 'C2' }, err, { now: 1000 });
  assert.equal(scutChannelHealth(dir)['C2'].critical, false, 'a single transient blip is not yet a durable failure');
});

test('a transient classification escalates to critical once it has failed several polls straight', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'ratelimited', {});
  for (let i = 0; i < 5; i++) recordPollFailure(dir, { channel: 'C3' }, err, { now: 1000 + i * 1000 });
  assert.equal(scutChannelHealth(dir)['C3'].critical, true,
    'a "transient" error that keeps recurring every poll is not clearing on its own either');
});

test('clearChannelHealth removes the entry: a channel that recovers stops alerting', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  recordPollFailure(dir, { channel: 'C123' }, err, { now: 1000 });
  assert.ok(scutChannelHealth(dir)['C123']);
  clearChannelHealth(dir, { channel: 'C123' });
  assert.equal(scutChannelHealth(dir)['C123'], undefined);
});

test('clearing a channel that was never recorded is a no-op, not a crash', () => {
  const dir = mkTmp();
  assert.doesNotThrow(() => clearChannelHealth(dir, { channel: 'never-seen' }));
});

test('two different channels are tracked independently', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  recordPollFailure(dir, { channel: 'C1' }, err, { now: 1000 });
  recordPollFailure(dir, { channel: 'C2' }, err, { now: 2000 });
  const h = scutChannelHealth(dir);
  assert.equal(Object.keys(h).length, 2);
  clearChannelHealth(dir, { channel: 'C1' });
  const h2 = scutChannelHealth(dir);
  assert.equal(h2['C1'], undefined);
  assert.ok(h2['C2']);
});

test('a channel id is sanitized before touching the filesystem', () => {
  const dir = mkTmp();
  const err = new SlackError('conversations.replies', 'missing_scope', {});
  assert.doesNotThrow(() => recordPollFailure(dir, { channel: '../../evil' }, err, { now: 1000 }));
  // the write must land inside dir, not escape it
  const entries = fs.readdirSync(dir);
  assert.ok(entries.every((f) => fs.existsSync(path.join(dir, f))));
});

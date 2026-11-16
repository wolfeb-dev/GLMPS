// Tests for the Slack app manifest the setup wizard opens (server/lib/scut/app-manifest.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_SCOPES, BOT_EVENTS, slackAppManifest, manifestCreateUrl } from '../lib/scut/app-manifest.js';
import { setupInstructions } from '../lib/scut/wizard.js';
import { createSlackWeb } from '../lib/scut/slack-web.js';

test('every bot scope the manual instructions name is in BOT_SCOPES', () => {
  const text = setupInstructions();
  const block = /Bot Token Scopes, add:([\s\S]*?)The two history scopes/.exec(text)[1];
  const named = block.match(/[a-z_]+(?:[.:][a-z_]+)+/g);
  assert.ok(named.length >= 10, 'parsed the scope list');
  for (const scope of named) assert.ok(BOT_SCOPES.includes(scope), `BOT_SCOPES is missing ${scope}`);
});

test('BOT_SCOPES carries the spec list, with the email lookup scopes', () => {
  assert.deepEqual([...BOT_SCOPES].sort(), [
    'app_mentions:read', 'channels:history', 'channels:manage', 'channels:read', 'chat:write',
    'chat:write.customize', 'files:read', 'groups:history', 'groups:read', 'reactions:write',
    'users:read', 'users:read.email',
  ]);
  assert.deepEqual(BOT_EVENTS, ['app_mention', 'message.channels']);
});

test('the manifest is a Socket Mode app named Riker with a bot user, events and interactivity', () => {
  const m = slackAppManifest();
  assert.equal(m.display_information.name, 'Riker');
  assert.equal(m.features.bot_user.display_name, 'Riker');
  assert.deepEqual(m.oauth_config.scopes.bot, BOT_SCOPES);
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.deepEqual(m.settings.event_subscriptions.bot_events, BOT_EVENTS);
  assert.equal(m.settings.interactivity.is_enabled, true);
  assert.equal(m.settings.org_deploy_enabled, false);
  assert.equal(m.settings.token_rotation_enabled, false);
  assert.equal(slackAppManifest({ name: 'Bob' }).display_information.name, 'Bob');
});

test('manifestCreateUrl round-trips the manifest through the query string', () => {
  const m = slackAppManifest();
  const url = manifestCreateUrl(m);
  assert.ok(url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json='));
  const raw = url.slice(url.indexOf('manifest_json=') + 'manifest_json='.length);
  assert.deepEqual(JSON.parse(decodeURIComponent(raw)), m);
});

test('usersLookupByEmail posts a form-encoded read', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ ok: true, user: { id: 'U123' } }) };
  };
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl });
  const r = await web.usersLookupByEmail({ email: 'a@b.co' });
  assert.equal(r.user.id, 'U123');
  assert.equal(calls[0].url, 'https://slack.com/api/users.lookupByEmail');
  assert.match(calls[0].init.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.equal(calls[0].init.body.get('email'), 'a@b.co');
});

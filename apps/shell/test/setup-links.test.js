import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkUrl, slackAppManifest, manifestCreateUrl, BOT_SCOPES, BOT_EVENTS } from '../src/lib/setup/links.js';
import * as server from '../../../server/lib/scut/app-manifest.js';

test('the shell copy of the Slack manifest is identical to the server module', () => {
  assert.deepEqual(BOT_SCOPES, server.BOT_SCOPES);
  assert.deepEqual(BOT_EVENTS, server.BOT_EVENTS);
  assert.deepEqual(slackAppManifest(), server.slackAppManifest());
  assert.deepEqual(slackAppManifest({ name: 'Bob' }), server.slackAppManifest({ name: 'Bob' }));
  assert.equal(linkUrl('slack-create-app'), server.manifestCreateUrl(server.slackAppManifest()));
  assert.equal(manifestCreateUrl({ a: 1 }), server.manifestCreateUrl({ a: 1 }));
});

test('only the three fixed keys resolve; everything else is refused', () => {
  assert.equal(linkUrl('slack-apps'), 'https://api.slack.com/apps');
  assert.equal(linkUrl('github-tokens'), 'https://github.com/settings/tokens');
  assert.match(linkUrl('slack-create-app'), /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  for (const bad of ['https://evil.example', 'constructor', '__proto__', 'toString', '', null, undefined, 5, {}]) assert.equal(linkUrl(bad), null, String(bad));
});

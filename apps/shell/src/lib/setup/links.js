// apps/shell/src/lib/setup/links.js
// The only URLs the wizard window may open, by key. The Slack manifest is a
// parity-tested copy of server/lib/scut/app-manifest.js: the packaged shell
// must not import server code.
export const BOT_SCOPES = Object.freeze([
  'chat:write', 'chat:write.customize', 'channels:manage', 'channels:read', 'groups:read',
  'app_mentions:read', 'reactions:write', 'channels:history', 'groups:history', 'files:read',
  'users:read', 'users:read.email',
]);

export const BOT_EVENTS = Object.freeze(['app_mention', 'message.channels']);

export function slackAppManifest({ name = 'Riker' } = {}) {
  return {
    display_information: { name },
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export function manifestCreateUrl(manifest) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

const FIXED = Object.freeze({
  'slack-apps': 'https://api.slack.com/apps',
  'github-tokens': 'https://github.com/settings/tokens',
});

// Anything that is not a known key (including inherited names) is refused.
export function linkUrl(key) {
  if (key === 'slack-create-app') return manifestCreateUrl(slackAppManifest());
  return typeof key === 'string' && Object.hasOwn(FIXED, key) ? FIXED[key] : null;
}

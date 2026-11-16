// server/lib/scut/app-manifest.js
// The Slack app the setup wizard asks for, as a manifest Slack's "create app
// from manifest" page accepts. The scopes and events are the ones the manual
// steps in wizard.js setupInstructions() name, plus the two user scopes the
// wizard needs to find the operator by email. A test keeps the two in step.

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

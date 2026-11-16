#!/usr/bin/env node
// scripts/setup/slack-connect.mjs - the desktop setup wizard's Slack step (thin
// shell around server/lib/scut/connect.js). Inputs come only from the
// environment, never argv, so a token is never in a process list:
//   SETUP_BOT_TOKEN, SETUP_APP_TOKEN, SETUP_SIGNING_SECRET (optional),
//   SETUP_SLACK_EMAIL, SETUP_SLACK_MEMBER_ID
// Prints exactly one JSON line and never a token.
import { connectSlack } from '../../server/lib/scut/connect.js';
import { saveCreds } from '../../server/lib/scut/config.js';
import { createSlackWeb } from '../../server/lib/scut/slack-web.js';
import { ensureChannels, postHello } from '../../server/lib/scut/provision.js';
import { resolveTheme } from '../../server/lib/scut/bobiverse.js';
import { getBobMode, addAllowedUser, getAvatarBaseUrl, getProjectSystems, getDefaultProjects } from '../../server/lib/scut/settings.js';
import { bindProjectChannels } from '../../server/lib/scut/channel-map.js';

const env = process.env;
const projects = env.SCUT_PROJECTS
  ? env.SCUT_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean)
  : getDefaultProjects();

let result;
try {
  result = await connectSlack({
    botToken: (env.SETUP_BOT_TOKEN ?? '').trim(),
    appToken: (env.SETUP_APP_TOKEN ?? '').trim(),
    signingSecret: (env.SETUP_SIGNING_SECRET ?? '').trim() || undefined,
    email: (env.SETUP_SLACK_EMAIL ?? '').trim() || undefined,
    memberId: (env.SETUP_SLACK_MEMBER_ID ?? '').trim() || undefined,
    saveCreds: (c) => saveCreds(c),
    makeWeb: (token) => createSlackWeb({ token }),
    ensureChannels,
    postHello,
    theme: resolveTheme(getBobMode(), { avatarBaseUrl: getAvatarBaseUrl(), projectSystems: getProjectSystems() }),
    addAllowedUser: (id) => addAllowedUser(id),
    projects,
    bindProjectChannels: (project) => bindProjectChannels(project),
  });
} catch (e) {
  result = { ok: false, error: 'unexpected', detail: [e?.message ?? String(e)] };
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

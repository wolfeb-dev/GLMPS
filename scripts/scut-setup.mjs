#!/usr/bin/env node
// scripts/scut-setup.mjs
// SCUT setup wizard (thin shell). Wires real readline + fs + slack-web into the
// injectable wizard core (server/lib/scut/wizard.js). Run:  node scripts/scut-setup.mjs
//
// Idempotent and re-runnable. Everything up to the live Slack calls works with no
// credentials; when you paste the 3 tokens it validates them and provisions the
// Bobiverse channels.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output, exit } from 'node:process';
import { runWizard } from '../server/lib/scut/wizard.js';
import { loadCreds, saveCreds, credsPath } from '../server/lib/scut/config.js';
import { createSlackWeb, SlackError } from '../server/lib/scut/slack-web.js';
import { ensureChannels, postHello } from '../server/lib/scut/provision.js';
import { resolveTheme } from '../server/lib/scut/bobiverse.js';
import { getBobMode, addAllowedUser, getHeartbeatMinutes, getAvatarBaseUrl, settingsPath, getProjectSystems, getDefaultProjects } from '../server/lib/scut/settings.js';
import { bindProjectChannels } from '../server/lib/scut/channel-map.js';

// SCUT_PROJECTS (comma-separated) lets the operator widen or narrow the
// provisioned project list without editing code. Absent -> the settings'
// defaultProjects, empty on a fresh install.
const projects = process.env.SCUT_PROJECTS
  ? process.env.SCUT_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean)
  : getDefaultProjects();

const rl = createInterface({ input, output });
// NOTE: readline/promises does not mask input; the signing secret echoes. Fine
// for a local single-operator wizard. It is stored gitignored + never logged.
const prompt = (q) => rl.question(q);
const out = (m) => console.log(m);

// Host-liveness tripwire probe (wizard-side half of glmps-31). This
// PROVES the round trip - schedule a probe message, then immediately delete it -
// without leaving anything booked. It must NOT arm the real tripwire: this
// script exits right after setup, and an armed-but-unrefreshed alarm would fire
// a false "HOST UNREACHABLE" a few minutes after a successful install. Arming
// (and re-arming on every heartbeat) belongs to the long-running server.
async function verifyHeartbeat(web, channelId) {
  if (!channelId) return { ok: false, detail: 'no radar/alerts channel resolved' };
  try {
    // 60s out is comfortably inside the 120-day max and the 30-per-5-min cap
    // (this is the only scheduled message the wizard ever books).
    const postAt = Math.floor(Date.now() / 1000) + 60;
    const scheduled = await web.chatScheduleMessage({
      channel: channelId,
      post_at: postAt,
      text: 'SCUT setup: host-liveness tripwire probe (cancelling immediately).',
    });
    await web.chatDeleteScheduledMessage({
      channel: channelId,
      scheduled_message_id: scheduled.scheduled_message_id,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e?.code ?? e?.message ?? String(e) };
  }
}

try {
  // Channel names AND agent profile pictures follow the current Bob-mode
  // setting (professional by default).
  const avatarBaseUrl = getAvatarBaseUrl();
  const theme = resolveTheme(getBobMode(), { avatarBaseUrl, projectSystems: getProjectSystems() });
  await runWizard({
    avatarBaseUrl,
    out,
    prompt,
    loadCreds: () => loadCreds(),
    saveCreds: (c) => saveCreds(c),
    makeWeb: (botToken) => createSlackWeb({ token: botToken }),
    ensureChannels,
    postHello,
    theme,
    addAllowedUser: (id) => addAllowedUser(id),
    projects,
    bindProjectChannels: (project) => bindProjectChannels(project),
    verifyHeartbeat,
  });
  out(`\n  Credentials stored at: ${credsPath()}`);
  const heartbeatMinutes = getHeartbeatMinutes();
  out(`  Host-liveness tripwire: once the SCUT engine is running, it keeps re-booking a`);
  out(`  "HOST UNREACHABLE" Slack alert a few minutes into the future (every ${heartbeatMinutes} minute(s)`);
  out(`  by default), so Slack fires it on its own if this machine dies or sleeps. To`);
  out(`  change the interval or disable it (0 = off), edit "heartbeatMinutes" in ${settingsPath()}.`);
  if (!avatarBaseUrl) {
    out('  Agent profile pictures: publish assets/scut/ to a public https host, then run');
    out('    node scripts/scut-avatar-check.mjs https://<host>/<path>');
    out('  to verify the upload and get the exact setting to paste. Walkthrough:');
    out('  docs/scut-profile-pictures.md');
  }
  out('  Next: start the SCUT engine (Phase 2/3) to route @mentions to your Bobs.\n');
} catch (e) {
  if (e instanceof SlackError) {
    out(`\n  Slack rejected the request: ${e.code}`);
    if (e.code === 'invalid_auth' || e.code === 'not_authed') {
      out('  -> The bot token looks wrong. Re-check step 5 (Bot User OAuth Token, xoxb-...).');
    } else if (e.code === 'missing_scope') {
      out(`  -> The app is missing a scope. Needed: ${e.data?.needed ?? 'see step 2'}. Add it and reinstall.`);
    }
    out('  Fix it and run the wizard again.\n');
  } else {
    out(`\n  Setup could not complete: ${e?.message ?? e}\n`);
  }
  rl.close();
  exit(1);
} finally {
  rl.close();
}

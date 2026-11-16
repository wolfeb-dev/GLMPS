// server/lib/scut/wizard.js
// The SCUT setup-wizard CORE. All I/O (printing, prompting, credential storage,
// the Slack client) is injected, so the whole flow is unit-testable with fakes.
// `scripts/scut-setup.mjs` is the thin shell that wires real readline + fs +
// slack-web into runWizard().

/** The click-by-click Slack-app setup the user follows (when back from AFK). */
export function setupInstructions() {
  return [
    '',
    '  SCUT :: Subspace Communications Universal Transceiver',
    '  ----------------------------------------------------',
    '  One-time Slack app setup (about 3 minutes):',
    '',
    '  1. Go to https://api.slack.com/apps  ->  Create New App  ->  From scratch.',
    '     Name it "Riker" and pick your workspace. (SCUT is the name of the',
    '     transport layer in the code; Riker is who you address in Slack.',
    '     If the app already exists, rename it under Basic Information ->',
    '     Display Information -> App name, then check whether this workspace',
    '     also shows a separate bot-user display name and set that too.)',
    '  2. OAuth & Permissions -> Bot Token Scopes, add:',
    '       chat:write, chat:write.customize, channels:manage, channels:read,',
    '       groups:read, app_mentions:read, reactions:write,',
    '       channels:history, groups:history, files:read',
    '     The two history scopes are what a session\'s own Slack channel reads',
    '     its thread with (conversations.replies). Without them a session',
    '     connects and then never hears a single follow-up.',
    '     files:read is what lets a session actually receive an image or file',
    '     you attach to a message. Slack sends the file\'s metadata either way,',
    '     but without this scope the download answers with a sign-in page and',
    '     the agent gets your text with a note saying the attachment is missing.',
    '     Adding it to an app that is already installed needs a reinstall.',
    '  3. Socket Mode -> toggle Enable Socket Mode ON. Generate an App-Level',
    '     Token with the connections:write scope. Copy it (starts with xapp-).',
    '  4. Event Subscriptions -> Enable. Under "Subscribe to bot events" add:',
    '       app_mention',
    '       message.channels   (optional, and it needs a reinstall)',
    '     message.channels is what lets you talk inside a ticket channel',
    '     WITHOUT addressing anyone. It delivers every message in every channel',
    '     the bot is in, so SCUT only ever acts on messages in a channel that is',
    '     registered as a ticket channel, or on replies in a thread whose',
    '     session is still open; starting anything new still needs an',
    '     @mention. Add it, reinstall, then set "scut": { "channelMessages": true }',
    '     in config.json. Leave it out and everything else still works.',
    '  5. Install App -> Install to Workspace. Copy the Bot User OAuth Token',
    '     (starts with xoxb-).',
    '  6. (Optional) Basic Information -> App Credentials -> Signing Secret.',
    '     NOT needed for Socket Mode (events + interactivity ride the app token);',
    '     skip it unless you later switch to HTTP event delivery.',
    '  7. (Optional) Basic Information -> Display Information -> App icon:',
    '     upload assets/scut/app-icon.png. This is the one picture no bot token',
    '     can set, so Slack only takes it from this page.',
    '  8. (Optional) Agent profile pictures - a professional set by default, a',
    '     Bobiverse set in Bob mode. Both are in assets/scut/. Slack fetches a',
    '     message icon from ITS servers and GLMPS binds to 127.0.0.1,',
    '     so publish assets/scut/ to a public https host (a public GitHub repo',
    '     works) and point SCUT at it:',
    '       node scripts/scut-avatar-check.mjs https://<host>/<path>',
    '     That checks the upload actually worked and prints the line to set.',
    '     Full walkthrough: docs/scut-profile-pictures.md',
    '     Leave it unset and agents keep their emoji icons. Either way the scope',
    '     is the same one from step 2 (chat:write.customize), so there is nothing',
    '     extra to install.',
    '',
    '  Then paste the values below. They are stored locally (gitignored)',
    '  and never committed. You can re-run this wizard any time; it is idempotent.',
    '',
  ].join('\n');
}

/**
 * Run the wizard. Dependencies are injected:
 *   out(msg)            - print a line
 *   prompt(q, opts)     - async, returns the user's answer
 *   loadCreds()         - returns {botToken, appToken, signingSecret, source}
 *   saveCreds(creds)    - persists creds (throws if invalid)
 *   makeWeb(botToken)   - returns a slack-web client
 *   ensureChannels(web, names) -> {created, existing, byName}
 *   postHello(web, {channelId})
 *   channelNames        - [hub, dev, radar]
 *   hubName             - the hub channel name (for the hello)
 *   projects            - string[] of project names to provision a channel for.
 *                          Absent or empty skips the whole step (today's behavior).
 *   bindProjectChannels(project) -> string[] - records every name a project can
 *                          ever be reached by (both the professional slug and the
 *                          Bobiverse star system) so routing works in either mode
 *                          regardless of which name got created just now.
 *   verifyHeartbeat(web, channelId) -> {ok, detail?} - OPTIONAL. Proves the
 *                          host-liveness tripwire's round trip by scheduling a
 *                          probe message and immediately deleting it, so nothing
 *                          is left booked. This wizard is a short-lived process:
 *                          it must never ARM the tripwire itself, only prove the
 *                          capability works. Arming (and re-arming on every
 *                          heartbeat) is the long-running server's job. A failed
 *                          or throwing probe is a warning, never fatal - printed
 *                          and the wizard carries on to the hello.
 *   avatarBaseUrl        - string|null. OPTIONAL. Where the agent profile
 *                          pictures are published, already resolved by the
 *                          caller so this core stays I/O free. Reported, never
 *                          written: turning pictures on is a setting, not a
 *                          wizard prompt.
 */
export async function runWizard(deps) {
  const {
    out, prompt, loadCreds, saveCreds, makeWeb,
    ensureChannels, postHello, theme, addAllowedUser,
    projects, bindProjectChannels, verifyHeartbeat, avatarBaseUrl,
  } = deps;

  out(setupInstructions());

  let creds = loadCreds();
  // Only the bot + app tokens are required (signing secret is optional for a
  // Socket-Mode app).
  const haveRequired = creds.botToken && creds.appToken;
  if (haveRequired) {
    out(`Found existing SCUT credentials (source: ${creds.source}). Using them.`);
  } else {
    const botToken = (await prompt('  Bot token (xoxb-...): ')).trim();
    const appToken = (await prompt('  App-level token (xapp-...): ')).trim();
    const sig = (await prompt('  Signing secret (optional, press Enter to skip): ', { hidden: true })).trim();
    creds = { botToken, appToken, ...(sig ? { signingSecret: sig } : {}) };
    saveCreds(creds); // throws with a clear message if a value is malformed
    out('  Saved (gitignored, local only).');
  }

  const web = makeWeb(creds.botToken);
  out('  Validating token with Slack auth.test ...');
  const auth = await web.authTest(); // throws SlackError on a bad token
  out(`  Authenticated as ${auth.user} in team ${auth.team}.`);
  // Say it out loud either way. A run that quietly ends with emoji icons looks
  // like the feature failed rather than like it was never switched on.
  out(avatarBaseUrl
    ? `  Agent profile pictures: ${avatarBaseUrl}/${theme.mode}/  (verify: node scripts/scut-avatar-check.mjs)`
    : '  Agent profile pictures: not configured - agents will use emoji icons (step 8 above).');

  out(`  Provisioning channels (${theme.bobMode ? 'Bob-themed' : 'professional'} names) ...`);
  const channelNames = theme.channelNames();
  const prov = await ensureChannels(web, channelNames);
  out(`  created: ${prov.created.join(', ') || '(none)'}`);
  out(`  existing: ${prov.existing.join(', ') || '(none)'}`);

  // Every channel the operator must end up a member of. Accumulated here (and
  // extended by the project loop below) because conversations.create leaves the
  // BOT as the only member - see the invite step at the end of this function.
  const provisionedChannels = channelNames
    .map((name) => ({ name, id: prov.byName[name]?.id }))
    .filter((c) => c.id);

  // Host-liveness tripwire (optional): prove the schedule-then-delete round
  // trip works against the radar/alerts channel, the same channel the running
  // server will later arm the real tripwire in. This wizard NEVER arms it -
  // it exits right after setup, and an armed-but-never-refreshed alarm would
  // fire a false "HOST UNREACHABLE" a few minutes after a successful install.
  if (verifyHeartbeat) {
    out('  Verifying the host-liveness tripwire (schedules and cancels a test probe) ...');
    const radarName = theme.channels.radar.name;
    const radarChannel = prov.byName[radarName];
    try {
      const result = await verifyHeartbeat(web, radarChannel?.id);
      if (result?.ok) {
        out('  Tripwire capability verified. It arms automatically once the SCUT engine is running.');
      } else {
        out(`  Warning: could not verify the host-liveness tripwire (${result?.detail ?? 'unknown reason'}). Continuing - this is optional and never blocks setup.`);
      }
    } catch (e) {
      out(`  Warning: could not verify the host-liveness tripwire (${e?.message ?? e}). Continuing - this is optional and never blocks setup.`);
    }
  }

  // One channel per active project, named under the CURRENT mode's theme
  // (theme.channelForProject) because a channel is named once and never
  // renamed. Every project is then bound under BOTH names it could ever have
  // (bindProjectChannels), so an @mention routes correctly whether or not Bob
  // mode is flipped later, regardless of which name was actually created here.
  // A failure provisioning one project is reported and skipped, never abort
  // the wizard: a half-provisioned workspace is recoverable; a wizard that
  // dies partway through is not.
  const projectList = projects ?? [];
  if (projectList.length > 0) {
    out('  Provisioning project channels ...');
    for (const project of projectList) {
      try {
        const name = theme.channelForProject(project);
        const r = await ensureChannels(web, [name]);
        const status = r.created.includes(name) ? 'created' : 'existing';
        out(`    ${project} -> #${name} (${status})`);
        if (r.byName?.[name]?.id) provisionedChannels.push({ name, id: r.byName[name].id });
        const bound = bindProjectChannels(project);
        out(`    ${project}: bound [${bound.join(', ')}]`);
      } catch (e) {
        out(`    ${project}: failed to provision (${e?.message ?? e}) - continuing.`);
      }
    }
  }

  const hubName = theme.channels.hub.name;
  const hub = prov.byName[hubName];
  await postHello(web, { channelId: hub.id }, theme);
  out(`  SCUT online. Posted the hello to #${hubName}. Standing by.`);

  // Authorize the operator so the fail-closed inbound guard isn't dead on
  // arrival (nobody can command an agent until they are on the allowlist).
  const uid = ((await prompt('  Your Slack member ID to authorize yourself (Slack profile -> ... -> Copy member ID; Enter to skip): ')) ?? '').trim();
  if (uid && addAllowedUser) {
    addAllowedUser(uid);
    out(`  Authorized ${uid} to command agents.`);
  } else {
    out('  No operator authorized yet - the guard is fail-closed. Add your member ID later to command agents.');
  }

  // Put the operator IN the rooms. conversations.create makes the bot the only
  // member, and an unjoined public channel does not appear in your Slack
  // sidebar - so without this a clean run ends with the operator unable to see
  // any of the channels the wizard just provisioned. Best-effort per channel,
  // matching every other step here: a partially-invited operator is trivially
  // recoverable, a wizard that dies on its last step is not.
  if (uid) {
    const joined = [];
    for (const ch of provisionedChannels) {
      try {
        await web.conversationsInvite({ channel: ch.id, users: uid });
        joined.push(ch.name);
      } catch (e) {
        // already_in_channel is the NORMAL outcome of any re-run, and of any
        // channel the operator joined by hand. The goal is already met, so it
        // is success - warning about it would make an idempotent wizard look
        // broken on its second run.
        if (e?.code === 'already_in_channel') { joined.push(ch.name); continue; }
        out(`    could not add you to #${ch.name} (${e?.code ?? e?.message ?? e}) - join it manually.`);
      }
    }
    out(`  You are in ${joined.length} channel(s): ${joined.map((n) => `#${n}`).join(', ') || '(none)'}`);
  }

  return { auth, prov };
}

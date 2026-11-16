// Tests for the SCUT setup wizard core (server/lib/scut/wizard.js).
// All I/O (prompt, print, creds, web) is injected -> no TTY, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupInstructions, runWizard } from '../lib/scut/wizard.js';
import { resolveTheme } from '../lib/scut/bobiverse.js';

function harness({ existingCreds = null, answers = [], projects, bindProjectChannels, inviteImpl, overrides = {} } = {}) {
  const out = [];
  const saved = [];
  const q = [...answers];
  const calls = { authTest: 0, ensure: null, hello: null, madeWebWith: null, addAllowed: null, invites: [] };
  const deps = {
    out: (m) => out.push(m),
    prompt: async () => q.shift(),
    loadCreds: () => existingCreds || { botToken: null, appToken: null, signingSecret: null, source: 'none' },
    saveCreds: (c) => saved.push(c),
    makeWeb: (token) => { calls.madeWebWith = token; return {
      authTest: async () => { calls.authTest++; return { user: 'scut-bot', team: 'ACME' }; },
      conversationsInvite: async ({ channel, users }) => {
        calls.invites.push({ channel, users });
        return inviteImpl ? inviteImpl({ channel, users }) : { ok: true };
      },
    }; },
    ensureChannels: async (_web, names) => { calls.ensure = names; return {
      created: names.slice(1), existing: names.slice(0, 1),
      byName: Object.fromEntries(names.map((n, i) => [n, { id: `C${i}`, name: n }])),
    }; },
    postHello: async (_web, arg) => { calls.hello = arg; },
    addAllowedUser: (id) => { calls.addAllowed = id; },
    theme: resolveTheme(false), // professional default
    // Project-channel provisioning deps: absent/empty projects skips
    // the step entirely, matching runWizard's own default behavior.
    projects: projects ?? [],
    bindProjectChannels: bindProjectChannels ?? (() => []),
    ...overrides,
  };
  return { deps, out, saved, calls };
}

test('setupInstructions covers the load-bearing Slack steps', () => {
  const t = setupInstructions();
  // chat.getPermalink (used for the roll-up line) requires NO scope, per
  // https://docs.slack.dev/reference/methods/chat.getPermalink - links:read is
  // for link_shared unfurling, which SCUT does not use. Do not add it back.
  for (const needle of ['api.slack.com/apps', 'Socket Mode', 'app_mentions:read', 'chat:write', 'reactions:write', 'xoxb-', 'xapp-', 'Signing Secret']) {
    assert.ok(t.includes(needle), `instructions missing: ${needle}`);
  }
});

test('setupInstructions asks for the history scope the thread channel reads with', () => {
  // glmps-42's channel server polls conversations.replies, which
  // requires channels:history (public) / groups:history (private) on the bot
  // token - verified against https://docs.slack.dev/reference/methods/conversations.replies,
  // not assumed. Without it the channel CONNECTS and then fails every poll with
  // missing_scope, which is logged to the MCP server's stderr and nowhere else:
  // the operator sees a live session that silently never hears them.
  const t = setupInstructions();
  assert.match(t, /channels:history/, 'the channel cannot read its own thread without it');
  assert.match(t, /groups:history/, 'private channels need the groups variant');
});

test('setupInstructions covers the two pictures an operator has to install by hand', () => {
  const t = setupInstructions();
  // Two separate uploads, easy to confuse. The app icon is the ONE picture no
  // bot token can set; the agent set has to be published somewhere Slack can
  // reach. Assert that each has a NEXT ACTION attached, not merely a mention -
  // "publish it somewhere public" with no command is the gap this replaced.
  assert.match(t, /assets[/\\]scut[/\\]app-icon\.png/, 'names the app-icon file to upload');
  assert.match(t, /scut-avatar-check\.mjs/, 'gives a command that verifies the upload');
  assert.match(t, /docs[/\\]scut-profile-pictures\.md/, 'points at the full walkthrough');
  assert.match(t, /chat:write\.customize/, 'says the scope is already covered');
});

test('the wizard reports whether agent profile pictures are configured', async () => {
  const off = harness({ existingCreds: EXISTING_CREDS });
  await runWizard(off.deps);
  assert.match(off.out.join('\n'), /profile pictures: not configured/i);

  const on = harness({
    existingCreds: EXISTING_CREDS,
    overrides: { avatarBaseUrl: 'https://cdn.example/scut' },
  });
  await runWizard(on.deps);
  assert.ok(on.out.join('\n').includes('https://cdn.example/scut'));
});

test('fresh run: prompts, saves creds, auths, provisions, posts hello', async () => {
  const { deps, saved, calls, out } = harness({
    answers: ['xoxb-new', 'xapp-new', 'topsecret', 'U123'], // 4th = operator member ID
  });
  const r = await runWizard(deps);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { botToken: 'xoxb-new', appToken: 'xapp-new', signingSecret: 'topsecret' });
  assert.equal(calls.addAllowed, 'U123'); // operator authorized during setup
  assert.equal(calls.madeWebWith, 'xoxb-new');
  assert.equal(calls.authTest, 1);
  assert.deepEqual(calls.ensure, ['agents', 'dev', 'alerts']); // pro channel names
  assert.equal(calls.hello.channelId, 'C0'); // hub is byName['agents'] = C0
  assert.equal(r.auth.team, 'ACME');
  assert.ok(out.join('\n').includes('SCUT online'));
});

test('existing valid creds: skips prompting + saving, still auths + provisions', async () => {
  const { deps, saved, calls } = harness({
    existingCreds: { botToken: 'xoxb-old', appToken: 'xapp-old', signingSecret: 'sec', source: 'file' },
  });
  await runWizard(deps);
  assert.equal(saved.length, 0);
  assert.equal(calls.madeWebWith, 'xoxb-old');
  assert.equal(calls.authTest, 1);
  assert.ok(calls.hello);
});

const EXISTING_CREDS = { botToken: 'xoxb-old', appToken: 'xapp-old', signingSecret: 'sec', source: 'file' };

test('runWizard provisions a channel per project and binds both names', async () => {
  const bound = [];
  const created = [];
  const { deps } = harness({
    existingCreds: EXISTING_CREDS,
    projects: ['glmps', 'Harbor-App'],
    bindProjectChannels: (p) => { bound.push(p); return ['x', 'y']; },
    overrides: {
      ensureChannels: async (_web, names) => {
        created.push(...names);
        return {
          created: names, existing: [],
          byName: Object.fromEntries(names.map((n) => [n, { id: 'C-' + n }])),
        };
      },
    },
  });
  await runWizard(deps);
  assert.deepEqual(bound, ['glmps', 'Harbor-App']);
  assert.ok(created.includes('glmps'));
});

test('runWizard with no projects still completes the original flow', async () => {
  const { deps } = harness({ existingCreds: EXISTING_CREDS, projects: [] });
  const r = await runWizard(deps);
  assert.ok(r.auth);
});

test('a failing project channel does not abort the wizard', async () => {
  let helloPosted = false;
  const { deps } = harness({
    existingCreds: EXISTING_CREDS,
    projects: ['boom'],
    overrides: {
      ensureChannels: async (_web, names) => {
        if (names.includes('boom')) throw new Error('name_taken');
        return {
          created: names, existing: [],
          byName: Object.fromEntries(names.map((n) => [n, { id: 'C-' + n }])),
        };
      },
      postHello: async () => { helloPosted = true; },
    },
  });
  await runWizard(deps);
  assert.equal(helloPosted, true);
});

// Host-liveness tripwire: the wizard only PROVES the capability via
// the injected verifyHeartbeat dep; it must never arm anything itself, since
// the wizard is a short-lived process and would leave the tripwire unrefreshed.

test('verifyHeartbeat is called after channel provisioning, against the radar channel', async () => {
  const calls = [];
  const { deps, out } = harness({
    existingCreds: EXISTING_CREDS,
    overrides: {
      verifyHeartbeat: async (web, channelId) => { calls.push({ web, channelId }); return { ok: true }; },
    },
  });
  await runWizard(deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelId, 'C2'); // radar = byName['alerts'] = the 3rd provisioned channel
  assert.ok(calls[0].web, 'the same slack-web client used for the rest of setup is reused');
  assert.ok(out.join('\n').toLowerCase().includes('tripwire'));
});

test('a successful verifyHeartbeat probe does not abort or alter the rest of the flow', async () => {
  const { deps } = harness({
    existingCreds: EXISTING_CREDS,
    overrides: { verifyHeartbeat: async () => ({ ok: true }) },
  });
  const r = await runWizard(deps);
  assert.ok(r.auth);
  assert.ok(r.prov);
});

test('a false/rejected verifyHeartbeat probe warns but does not abort the wizard (the hello still posts)', async () => {
  let helloPosted = false;
  const { deps, out } = harness({
    existingCreds: EXISTING_CREDS,
    overrides: {
      verifyHeartbeat: async () => ({ ok: false, detail: 'missing_scope' }),
      postHello: async () => { helloPosted = true; },
    },
  });
  await runWizard(deps);
  assert.equal(helloPosted, true);
  assert.ok(out.join('\n').includes('missing_scope'));
});

test('a throwing verifyHeartbeat probe also warns but does not abort the wizard', async () => {
  let helloPosted = false;
  const { deps, out } = harness({
    existingCreds: EXISTING_CREDS,
    overrides: {
      verifyHeartbeat: async () => { throw new Error('slack down'); },
      postHello: async () => { helloPosted = true; },
    },
  });
  await runWizard(deps);
  assert.equal(helloPosted, true);
  assert.ok(out.join('\n').includes('slack down'));
});

test('verifyHeartbeat is optional: the wizard still completes with no dep provided', async () => {
  const { deps } = harness({ existingCreds: EXISTING_CREDS });
  const r = await runWizard(deps);
  assert.ok(r.auth);
});

test('the wizard never leaves a scheduled probe booked: every schedule is paired with a delete', async () => {
  const scheduled = [];
  const deleted = [];
  const fakeVerify = async (web, channelId) => {
    const s = await web.chatScheduleMessage({ channel: channelId, post_at: 1, text: 'probe' });
    scheduled.push(s.scheduled_message_id);
    await web.chatDeleteScheduledMessage({ channel: channelId, scheduled_message_id: s.scheduled_message_id });
    deleted.push(s.scheduled_message_id);
    return { ok: true };
  };
  const { deps } = harness({
    existingCreds: EXISTING_CREDS,
    overrides: {
      verifyHeartbeat: fakeVerify,
      makeWeb: (token) => ({
        authTest: async () => ({ user: 'scut-bot', team: 'ACME' }),
        chatScheduleMessage: async () => ({ scheduled_message_id: 'P1' }),
        chatDeleteScheduledMessage: async () => ({ ok: true }),
      }),
    },
  });
  await runWizard(deps);
  assert.deepEqual(scheduled, ['P1']);
  assert.deepEqual(scheduled, deleted, 'nothing scheduled was left without a matching delete');
});

// Operator invite: conversations.create makes the BOT the only member, so a
// clean run used to end with the operator unable to see the channels the
// wizard just provisioned (they exist, but an unjoined public channel is not
// in your sidebar). The wizard authorizes the operator on the allowlist, so it
// must also put them in the rooms.

const slackErr = (code) => Object.assign(new Error(code), { code });

test('the operator is invited to every provisioned channel, project channels included', async () => {
  const { deps, calls } = harness({
    existingCreds: EXISTING_CREDS,
    answers: ['U777'],
    projects: ['glmps'],
    bindProjectChannels: () => [],
  });
  await runWizard(deps);
  const channels = calls.invites.map((i) => i.channel);
  assert.deepEqual(channels, ['C0', 'C1', 'C2', 'C0'], 'the 3 themed channels plus the project channel');
  assert.ok(calls.invites.every((i) => i.users === 'U777'), 'every invite targets the operator');
});

test('already_in_channel is treated as success, not a warning (the wizard is re-runnable)', async () => {
  const { deps, out } = harness({
    existingCreds: EXISTING_CREDS,
    answers: ['U777'],
    inviteImpl: () => { throw slackErr('already_in_channel'); },
  });
  await runWizard(deps);
  const text = out.join('\n');
  assert.ok(!/could not invite/i.test(text), 'a re-run must not warn about channels the operator already joined');
  assert.ok(!text.includes('already_in_channel'), 'the raw Slack code must not leak into the transcript');
});

test('a failing invite warns and does not stop the remaining invites', async () => {
  const { deps, out, calls } = harness({
    existingCreds: EXISTING_CREDS,
    answers: ['U777'],
    inviteImpl: ({ channel }) => { if (channel === 'C0') throw slackErr('user_not_found'); return { ok: true }; },
  });
  await runWizard(deps);
  assert.equal(calls.invites.length, 3, 'the failure on the first channel did not abort the loop');
  assert.ok(out.join('\n').includes('user_not_found'));
});

test('no member ID given: no invites are attempted', async () => {
  const { deps, calls } = harness({ existingCreds: EXISTING_CREDS, answers: [] });
  await runWizard(deps);
  assert.deepEqual(calls.invites, []);
});

test('setupInstructions asks for files:read and says what breaks without it', () => {
  const t = setupInstructions();
  assert.match(t, /files:read/);
  assert.match(t, /attachment|image/i);
});

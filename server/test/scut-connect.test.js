// Tests for the non-interactive Slack connect core (server/lib/scut/connect.js).
// Every dependency is injected: no network, no credential file, no prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectSlack, checkSlackTokens } from '../lib/scut/connect.js';
import { resolveTheme } from '../lib/scut/bobiverse.js';
import { SlackError } from '../lib/scut/slack-web.js';

const BOT = 'xoxb-secret-bot';
const APP = 'xapp-secret-app';

function harness({ input = {}, web = {}, overrides = {} } = {}) {
  const calls = { saved: [], ensure: [], hello: null, allowed: [], invites: [], lookups: [], madeWebWith: [], appCalls: [], bound: [] };
  const deps = {
    botToken: BOT, appToken: APP,
    saveCreds: (c) => calls.saved.push(c),
    makeWeb: (token) => {
      calls.madeWebWith.push(token);
      return {
        authTest: async () => ({ user: 'riker', team: 'ACME' }),
        call: async (method) => { calls.appCalls.push(method); return { ok: true, url: 'wss://example.invalid' }; },
        usersLookupByEmail: async ({ email }) => { calls.lookups.push(email); return { user: { id: 'U42' } }; },
        conversationsInvite: async ({ channel, users }) => { calls.invites.push({ channel, users }); return { ok: true }; },
        ...web,
      };
    },
    ensureChannels: async (_w, names) => {
      calls.ensure.push(names);
      return { created: names.slice(1), existing: names.slice(0, 1), byName: Object.fromEntries(names.map((n, i) => [n, { id: `C${calls.ensure.length}${i}`, name: n }])) };
    },
    postHello: async (_w, arg) => { calls.hello = arg; },
    theme: resolveTheme(false),
    addAllowedUser: (id) => calls.allowed.push(id),
    projects: ['alpha'],
    bindProjectChannels: (p) => { calls.bound.push(p); return [p]; },
    ...input, ...overrides,
  };
  return { deps, calls };
}

test('happy path: validates, saves, provisions, greets, looks up by email, authorizes and invites', async () => {
  const { deps, calls } = harness({ input: { email: 'me@acme.co', signingSecret: 'sig' } });
  const r = await connectSlack(deps);
  assert.equal(r.ok, true);
  assert.equal(r.team, 'ACME');
  assert.equal(r.botUser, 'riker');
  assert.equal(r.userId, 'U42');
  assert.deepEqual(calls.saved, [{ botToken: BOT, appToken: APP, signingSecret: 'sig' }]);
  assert.deepEqual(calls.madeWebWith, [BOT, APP, BOT]);
  assert.deepEqual(calls.appCalls, ['apps.connections.open']);
  assert.deepEqual(calls.lookups, ['me@acme.co']);
  assert.deepEqual(calls.allowed, ['U42']);
  assert.ok(calls.hello.channelId);
  assert.ok(r.channels.created.length + r.channels.existing.length >= 3);
  assert.deepEqual(calls.bound, ['alpha']);
  // every provisioned channel (theme + project) got the invite
  assert.equal(calls.invites.length, r.joined.length);
  assert.ok(r.joined.length >= 4);
  assert.ok(calls.invites.every((i) => i.users === 'U42'));
  assert.deepEqual(r.warnings, []);
});

test('a pasted member id skips the email lookup', async () => {
  const { deps, calls } = harness({ input: { memberId: 'U99', email: 'me@acme.co' } });
  const r = await connectSlack(deps);
  assert.equal(r.userId, 'U99');
  assert.deepEqual(calls.lookups, []);
  assert.deepEqual(calls.allowed, ['U99']);
});

test('no email and no member id: connected, nobody authorized, a warning says so', async () => {
  const { deps, calls } = harness();
  const r = await connectSlack(deps);
  assert.equal(r.ok, true);
  assert.equal(r.userId, null);
  assert.deepEqual(calls.allowed, []);
  assert.deepEqual(calls.invites, []);
  assert.deepEqual(r.joined, []);
  assert.ok(r.warnings.some((w) => /member/i.test(w)));
});

test('a failed email lookup is a warning, not a failure', async () => {
  const { deps } = harness({
    input: { email: 'x@y.z' },
    web: { usersLookupByEmail: async () => { throw new SlackError('users.lookupByEmail', 'users_not_found', {}); } },
  });
  const r = await connectSlack(deps);
  assert.equal(r.ok, true);
  assert.equal(r.userId, null);
  assert.ok(r.warnings.some((w) => w.includes('users_not_found')));
});

test('already_in_channel counts as joined; other invite failures are warnings', async () => {
  let n = 0;
  const { deps } = harness({
    input: { memberId: 'U9' },
    web: {
      conversationsInvite: async () => {
        n += 1;
        if (n === 1) throw new SlackError('conversations.invite', 'already_in_channel', {});
        if (n === 2) throw new SlackError('conversations.invite', 'cant_invite_self', {});
        return { ok: true };
      },
    },
  });
  const r = await connectSlack(deps);
  assert.equal(r.ok, true);
  assert.equal(r.joined.length, n - 1);
  assert.equal(r.warnings.filter((w) => w.includes('cant_invite_self')).length, 1);
});

test('a project that fails to provision is a warning and the rest carry on', async () => {
  let call = 0;
  const { deps } = harness({
    input: { projects: ['a', 'b'] },
    overrides: {
      ensureChannels: async (_w, names) => {
        call += 1;
        if (call === 2) throw new Error('boom');
        return { created: names, existing: [], byName: Object.fromEntries(names.map((n, i) => [n, { id: `C${call}${i}` }])) };
      },
    },
  });
  const r = await connectSlack(deps);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('a') && w.includes('boom')));
});

test('malformed tokens fail before anything is saved or called', async () => {
  const { deps, calls } = harness({ input: { botToken: 'nope' } });
  const r = await connectSlack(deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_tokens');
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.madeWebWith, []);
});

test('a bad token returns the slack code and saves nothing', async () => {
  const { deps, calls } = harness({
    web: { authTest: async () => { throw new SlackError('auth.test', 'invalid_auth', {}); } },
  });
  const r = await connectSlack(deps);
  assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'invalid_auth' });
  assert.deepEqual(calls.saved, []);
});

test('a missing scope while provisioning is reported by its slack code', async () => {
  const { deps } = harness({
    overrides: { ensureChannels: async () => { throw new SlackError('conversations.list', 'missing_scope', { needed: 'channels:read' }); } },
  });
  const r = await connectSlack(deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_scope');
  assert.equal(r.credsSaved, true);
});

test('no token appears anywhere in any result', async () => {
  for (const scenario of [harness({ input: { email: 'a@b.co' } }), harness({ input: { botToken: 'bad' } }),
    harness({ web: { authTest: async () => { throw new SlackError('auth.test', 'invalid_auth', { token: BOT }); } } })]) {
    const r = await connectSlack(scenario.deps);
    const text = JSON.stringify(r);
    assert.ok(!text.includes(BOT) && !text.includes(APP), text);
  }
});

// Card glmps-2-0-205: the app-level token is checked live, not only by prefix.
test('a rejected app token returns app_token:<code> and saves nothing', async () => {
  for (const code of ['invalid_auth', 'not_allowed_token_type', 'missing_scope']) {
    const { deps, calls } = harness({ web: { call: async (m) => { throw new SlackError(m, code, { token: APP }); } } });
    const r = await connectSlack(deps);
    assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: `app_token:${code}` });
    assert.deepEqual(calls.saved, []);
    assert.ok(!JSON.stringify(r).includes(APP));
  }
});

test('checkSlackTokens checks the bot token then the app token, and names the failing one', async () => {
  const made = [];
  const ok = (token) => { made.push(token); return { authTest: async () => ({ user: 'riker', team: 'ACME' }), call: async () => ({ ok: true }) }; };
  assert.deepEqual(await checkSlackTokens({ botToken: BOT, appToken: APP, makeWeb: ok }), { ok: true, team: 'ACME', botUser: 'riker' });
  assert.deepEqual(made, [BOT, APP]);
  const badBot = () => ({ authTest: async () => { throw new SlackError('auth.test', 'token_revoked', {}); } });
  assert.deepEqual(await checkSlackTokens({ botToken: BOT, appToken: APP, makeWeb: badBot }), { ok: false, error: 'token_revoked' });
  const badApp = () => ({ authTest: async () => ({}), call: async () => { throw new SlackError('apps.connections.open', 'invalid_auth', {}); } });
  assert.deepEqual(await checkSlackTokens({ botToken: BOT, appToken: APP, makeWeb: badApp }), { ok: false, error: 'app_token:invalid_auth' });
});

test('checkSlackTokens: a network failure is unreachable, never a rejection of the tokens', async () => {
  const offline = () => ({ authTest: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await checkSlackTokens({ botToken: BOT, appToken: APP, makeWeb: offline }), { ok: false, error: 'unreachable', unreachable: true });
});

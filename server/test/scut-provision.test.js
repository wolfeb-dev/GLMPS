// Tests for SCUT provisioning helpers (server/lib/scut/provision.js).
// A fake `web` + a resolved theme are injected - no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postAs, ensureChannels, postHello } from '../lib/scut/provision.js';
import { resolveTheme } from '../lib/scut/bobiverse.js';

const PRO = resolveTheme(false);
const BOB = resolveTheme(true);
// The same two themes with profile pictures published (glmps-34).
const PRO_PIX = resolveTheme(false, { avatarBaseUrl: 'https://cdn.example/scut' });
const BOB_PIX = resolveTheme(true, { avatarBaseUrl: 'https://cdn.example/scut' });

function fakeWeb({ existing = [] } = {}) {
  const posts = [];
  const created = [];
  return {
    posts, created,
    conversationsList: async () => ({ ok: true, channels: existing.map((name, i) => ({ id: `C${i}`, name })) }),
    conversationsCreate: async (name) => { created.push(name); return { ok: true, channel: { id: `NEW-${name}`, name } }; },
    chatPostMessage: async (p) => { posts.push(p); return { ok: true, ts: '1.1' }; },
  };
}

test('postAs stamps the persona from the ACTIVE theme (pro vs bob)', async () => {
  const web = fakeWeb();
  await postAs(web, 'bill', { channel: 'C1', text: 'hi' }, PRO);
  assert.equal(web.posts[0].username, 'Builder'); // professional default
  await postAs(web, 'bill', { channel: 'C1', text: 'hi' }, BOB);
  assert.equal(web.posts[1].username, 'Bill');     // Bob mode
  assert.equal(web.posts[1].icon_emoji, ':hammer_and_wrench:');
});

test('postAs falls back to a generic persona for an unknown agent', async () => {
  const web = fakeWeb();
  await postAs(web, 'nobody', { channel: 'C1', text: 'x' }, PRO);
  assert.equal(web.posts[0].username, 'nobody');
  assert.match(web.posts[0].icon_emoji, /^:[a-z0-9_+-]+:$/);
});

test('postAs sends icon_url once avatars are configured, and switches with the mode', async () => {
  const web = fakeWeb();
  await postAs(web, 'bill', { channel: 'C1', text: 'hi' }, PRO_PIX);
  assert.equal(web.posts[0].username, 'Builder');
  assert.equal(web.posts[0].icon_url, 'https://cdn.example/scut/pro/bill.png');

  await postAs(web, 'bill', { channel: 'C1', text: 'hi' }, BOB_PIX);
  assert.equal(web.posts[1].username, 'Bill');
  assert.equal(web.posts[1].icon_url, 'https://cdn.example/scut/bob/bill.png');
});

test('postAs sends exactly ONE picture field, never both', async () => {
  const web = fakeWeb();
  // Slack's precedence when icon_url and icon_emoji are both set is not
  // contractual, so the picture must be unambiguous on the wire.
  await postAs(web, 'riker', { channel: 'C1', text: 'hi' }, PRO_PIX);
  assert.equal(web.posts[0].icon_emoji, undefined);
  await postAs(web, 'riker', { channel: 'C1', text: 'hi' }, PRO);
  assert.equal(web.posts[1].icon_url, undefined);
  assert.equal(web.posts[1].icon_emoji, ':satellite:');
});

test('postAs gives an unknown agent the SCUT face rather than a stock robot', async () => {
  const web = fakeWeb();
  await postAs(web, 'nobody', { channel: 'C1', text: 'x' }, BOB_PIX);
  assert.equal(web.posts[0].username, 'nobody');
  assert.equal(web.posts[0].icon_url, 'https://cdn.example/scut/bob/scut.png');
  assert.equal(web.posts[0].icon_emoji, undefined);
});

test('postAs tolerates a theme with no avatar support at all', async () => {
  // Defensive: a caller (or an old test fake) may pass a bare theme object.
  const web = fakeWeb();
  await postAs(web, 'bill', { channel: 'C1', text: 'x' }, { agentById: () => null });
  assert.equal(web.posts[0].icon_emoji, ':robot_face:');
  assert.equal(web.posts[0].icon_url, undefined);
});

test('ensureChannels creates only the missing channels (idempotent)', async () => {
  const web = fakeWeb({ existing: ['agents'] });
  const r = await ensureChannels(web, ['agents', 'dev', 'alerts']);
  assert.deepEqual(r.existing, ['agents']);
  assert.deepEqual(r.created, ['dev', 'alerts']);
  assert.equal(r.byName['agents'].id, 'C0');
  assert.equal(r.byName['dev'].id, 'NEW-dev');

  const web2 = fakeWeb({ existing: ['agents', 'dev', 'alerts'] });
  const r2 = await ensureChannels(web2, ['agents', 'dev', 'alerts']);
  assert.deepEqual(r2.created, []);
});

test('postHello posts a SCUT-online greeting as two agents in the active theme', async () => {
  const web = fakeWeb();
  await postHello(web, { channelId: 'CHUB' }, BOB);
  assert.equal(web.posts.length, 2);
  const names = web.posts.map((p) => p.username);
  assert.ok(names.includes('Riker'));
  assert.ok(names.includes('Bill'));
  assert.ok(web.posts.every((p) => p.channel === 'CHUB'));
});


test('a post with no thread omits thread_ts entirely rather than sending null', () => {
  const sent = [];
  const web = { chatPostMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); } };
  postAs(web, 'riker', { channel: 'C1', text: 'hi', thread_ts: null }, undefined);
  assert.ok(!('thread_ts' in sent[0]), 'a null thread_ts would go on the wire as JSON null');
  assert.equal(sent[0].channel, 'C1');
});

test('a threaded post still carries its thread_ts', () => {
  const sent = [];
  const web = { chatPostMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); } };
  postAs(web, 'riker', { channel: 'C1', text: 'hi', thread_ts: '1.1' }, undefined);
  assert.equal(sent[0].thread_ts, '1.1');
});

test('blocks are omitted when absent rather than sent as undefined', () => {
  const sent = [];
  const web = { chatPostMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); } };
  postAs(web, 'riker', { channel: 'C1', text: 'hi' }, undefined);
  assert.ok(!('blocks' in sent[0]));
});

test('glmps-2-0-104: postAs passes reply_broadcast through on a thread reply only', async () => {
  const web = fakeWeb();
  await postAs(web, 'riker', { channel: 'C1', thread_ts: '1.2', reply_broadcast: true, text: 'x' }, PRO);
  await postAs(web, 'riker', { channel: 'C1', reply_broadcast: true, text: 'x' }, PRO);
  await postAs(web, 'riker', { channel: 'C1', thread_ts: '1.2', text: 'x' }, PRO);
  assert.equal(web.posts[0].reply_broadcast, true);
  assert.equal('reply_broadcast' in web.posts[1], false);
  assert.equal('reply_broadcast' in web.posts[2], false);
});

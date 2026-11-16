// server/test/web-access-token.test.js
// Review focus 1, browser half: EventSource cannot send an Authorization
// header, so in remote mode the stored token rides its URL. The wiki iframe
// shows UNTRUSTED HTML whose script can read location.href, so it must never
// carry the master token: it gets a short-lived read-only wiki ticket (C1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withAccessToken, getWikiTicket, downloadBaselineReport, _resetWikiTicketCache } from '../../web/shared/api.js';
import { wikiFrameSrc } from '../../web/observability/wiki.js';

test('withAccessToken appends an encoded access_token only when a token is set', () => {
  assert.equal(withAccessToken('/api/events', ''), '/api/events');
  assert.equal(withAccessToken('/api/events', 't k&x'), '/api/events?access_token=t%20k%26x');
  assert.equal(withAccessToken('/wiki-ext/r/core.html?v=1', 'abc'), '/wiki-ext/r/core.html?v=1&access_token=abc');
});

test('C1: the wiki lens iframe src carries a wiki ticket and never the stored token', () => {
  const origLS = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'tok-SECRET-123', setItem() {}, removeItem() {} };
  try {
    const src = wikiFrameSrc('/wiki-ext/repo', 'core a', '?v=1', 'T.mac');
    assert.equal(src, '/wiki-ext/repo/core%20a.html?v=1&wiki_ticket=T.mac');
    assert.doesNotMatch(src, /tok-SECRET-123|access_token/);
    assert.equal(wikiFrameSrc('/wiki', 'core', '', ''), '/wiki/core.html', 'no ticket (loopback, fetch failed): bare URL');
  } finally { globalThis.localStorage = origLS; }
  const lens = fs.readFileSync(new URL('../../web/observability/wiki.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lens, /withAccessToken|access_token/, 'the lens never builds a token-bearing URL');
});

test('every EventSource opens through withAccessToken, the huddle dock included', () => {
  const huddle = fs.readFileSync(new URL('../../web/shared/huddle.js', import.meta.url), 'utf8');
  assert.match(huddle, /new EventSource\(withAccessToken\(/);
  assert.doesNotMatch(huddle, /new EventSource\('/);
});

test('C1: getWikiTicket fetches /api/wiki/ticket once and reuses it until a minute before expiry', async () => {
  _resetWikiTicketCache();
  const calls = [];
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); n++; return { ok: true, status: 200, json: async () => ({ ticket: `t${n}`, expiresAt: 1_000_000 + 600_000 }) }; };
  try {
    assert.equal(await getWikiTicket('/wiki', 1_000_000), 't1');
    assert.equal(await getWikiTicket('/wiki', 1_000_000 + 500_000), 't1', 'cached');
    assert.equal(await getWikiTicket('/wiki', 1_000_000 + 545_000), 't2', 'refreshed inside the last minute');
    // Scan 2026-10-15 F4: each wiki gets its own ticket.
    assert.equal(await getWikiTicket('/wiki-ext/repo-x', 1_000_000), 't3');
    assert.equal(await getWikiTicket('/wiki-ext/repo-x', 1_000_000 + 1000), 't3', 'cached per base');
    assert.deepEqual(calls, ['/api/wiki/ticket?base=%2Fwiki', '/api/wiki/ticket?base=%2Fwiki', '/api/wiki/ticket?base=%2Fwiki-ext%2Frepo-x']);
    _resetWikiTicketCache();
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.equal(await getWikiTicket('/wiki', 1_000_000), '', 'a refused ticket is empty, never thrown');
  } finally { globalThis.fetch = orig; _resetWikiTicketCache(); }
});

test('I2: the baseline report download goes through fetch (Authorization header) and is saved as a blob', async () => {
  const calls = [];
  const saved = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => '<html>report</html>' }; };
  try {
    await downloadBaselineReport({ save: (...a) => saved.push(a) });
    assert.deepEqual(calls, ['/api/report/baseline?download=1']);
    assert.deepEqual(saved, [['ai-usage-risk-baseline.html', '<html>report</html>', 'text/html']]);
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
    await assert.rejects(downloadBaselineReport({ save: () => assert.fail('must not save a refusal') }), /401/);
  } finally { globalThis.fetch = orig; }
  const view = fs.readFileSync(new URL('../../web/surface/declared/engagement.js', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /\.href\s*=\s*baselineReportUrl/, 'no header-less top-level download link');
  assert.match(view, /downloadBaselineReport/);
});

// Scan 2026-10-15 F2: the browser keeps the local session from the dashboard link.
test('F2: acceptLocalSession stores only a well-formed session value', async () => {
  const { acceptLocalSession, getLocalSession } = await import('../../web/shared/api.js');
  const store = new Map();
  const origLS = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(acceptLocalSession('nope'), false);
    assert.equal(acceptLocalSession(''), false);
    assert.equal(getLocalSession(), '');
    assert.equal(acceptLocalSession('d'.repeat(64)), true);
    assert.equal(getLocalSession(), 'd'.repeat(64));
  } finally { globalThis.localStorage = origLS; }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedEgressHost, guardedFetch, DEFAULT_ALLOWLIST } from '../lib/governance/egress-guard.js';


test('isAllowedEgressHost: allows arxiv.org (a listing-page URL)', () => {
  assert.equal(isAllowedEgressHost('https://arxiv.org/list/cs.AI/recent'), true);
});

test('isAllowedEgressHost: allows export.arxiv.org', () => {
  assert.equal(isAllowedEgressHost('https://export.arxiv.org/api/query'), true);
});

test('isAllowedEgressHost: allows www.anthropic.com (the engineering blog host)', () => {
  assert.equal(isAllowedEgressHost('https://www.anthropic.com/engineering'), true);
});

test('isAllowedEgressHost: REFUSES a non-allowlisted host (fail-closed)', () => {
  assert.equal(isAllowedEgressHost('https://evil.example.com/x'), false);
});

test('isAllowedEgressHost: REFUSES a lookalike host that merely contains an allowlisted name', () => {
  // exact-hostname match only - no substring/suffix matching
  assert.equal(isAllowedEgressHost('https://arxiv.org.evil.com/x'), false);
  assert.equal(isAllowedEgressHost('https://not-arxiv.org/x'), false);
});

test('isAllowedEgressHost: REFUSES an unparseable URL', () => {
  assert.equal(isAllowedEgressHost('not a url'), false);
  assert.equal(isAllowedEgressHost(''), false);
  assert.equal(isAllowedEgressHost(undefined), false);
  assert.equal(isAllowedEgressHost(null), false);
});

test('isAllowedEgressHost: host match is case-insensitive', () => {
  assert.equal(isAllowedEgressHost('https://ARXIV.ORG/list/cs.AI/recent'), true);
});

test('isAllowedEgressHost: DEFAULT_ALLOWLIST is exactly the three sanctioned hosts', () => {
  assert.deepEqual([...DEFAULT_ALLOWLIST].sort(), ['arxiv.org', 'export.arxiv.org', 'www.anthropic.com']);
});


test('guardedFetch: allowlisted host -> calls fetchImpl exactly once with the url', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return '<html>ok</html>'; };
  const out = await guardedFetch('https://arxiv.org/list/cs.AI/recent', { fetchImpl });
  assert.equal(out, '<html>ok</html>');
  assert.deepEqual(calls, ['https://arxiv.org/list/cs.AI/recent']);
});

test('guardedFetch: non-allowlisted host -> throws and NEVER calls fetchImpl', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return 'should never happen'; };
  await assert.rejects(
    () => guardedFetch('https://evil.example.com/x', { fetchImpl }),
    /refusing to fetch/,
  );
  assert.equal(called, false);
});

test('guardedFetch: an unparseable url also refuses without calling fetchImpl', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return 'x'; };
  await assert.rejects(() => guardedFetch('not a url', { fetchImpl }));
  assert.equal(called, false);
});

test('guardedFetch: a caller-supplied allowlist can narrow what a single call accepts', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return 'x'; };
  await assert.rejects(
    () => guardedFetch('https://www.anthropic.com/engineering', { fetchImpl, allowlist: ['arxiv.org'] }),
  );
  assert.equal(called, false);
});

// server/test/skill-registry-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRegistrySkills, registryFetch, matchGapToCandidate, DEFAULT_GAP_MATCH_THRESHOLD } from '../lib/governance/skill-registry-scan.js';

const SKILL_MD_TEXT = `---
name: cool-skill
description: Does a cool thing for you.
version: 1.2.0
---
# Cool Skill

Instructions body text goes here.
`;

function spyFetch(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (!(url in map)) throw new Error(`unexpected fetch: ${url}`);
    const v = map[url];
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}


test('listRegistrySkills: skill-md format fetches baseUrl once and parses frontmatter + body', async () => {
  const registries = [{ name: 'reg-a', baseUrl: 'https://example.com/cool-skill/SKILL.md', format: 'skill-md' }];
  const fetchImpl = spyFetch({ 'https://example.com/cool-skill/SKILL.md': SKILL_MD_TEXT });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'cool-skill');
  assert.equal(out[0].description, 'Does a cool thing for you.');
  assert.equal(out[0].version, '1.2.0');
  assert.equal(out[0].sourceRepo, 'https://example.com/cool-skill/SKILL.md');
  assert.equal(out[0].registryName, 'reg-a');
  assert.equal(out[0].format, 'skill-md');
  assert.match(out[0].instructionsBody, /Instructions body text/);
  assert.deepEqual(fetchImpl.calls, ['https://example.com/cool-skill/SKILL.md']);
});

test('listRegistrySkills: skill-md with no frontmatter block falls back to registry name, empty description', async () => {
  const registries = [{ name: 'reg-b', baseUrl: 'https://example.com/plain.md', format: 'skill-md' }];
  const fetchImpl = spyFetch({ 'https://example.com/plain.md': 'just plain text, no frontmatter' });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'reg-b');
  assert.equal(out[0].description, '');
});


test('listRegistrySkills: marketplace format (bare array) with metadata-only skills (no path)', async () => {
  const indexUrl = 'https://example.com/marketplace.json';
  const index = JSON.stringify([
    { name: 'plugin-1', source: 'https://github.com/org/plugin-1', version: '2.0.0',
      skills: [{ name: 'skill-one', description: 'first skill' }, { name: 'skill-two', description: 'second skill' }] },
  ]);
  const registries = [{ name: 'reg-c', baseUrl: indexUrl, format: 'claude-plugin-marketplace' }];
  const fetchImpl = spyFetch({ [indexUrl]: index });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'skill-one');
  assert.equal(out[0].sourceRepo, 'https://github.com/org/plugin-1');
  assert.equal(out[0].version, '2.0.0'); // falls back to plugin.version
  assert.deepEqual(fetchImpl.calls, [indexUrl]); // no follow-up fetches without `path`
});

test('listRegistrySkills: marketplace format ({plugins:[...]}) with a path -> follow-up fetch joined onto baseUrl', async () => {
  const indexUrl = 'https://example.com/registry/marketplace.json';
  const index = JSON.stringify({
    plugins: [{ name: 'plugin-2', source: 'https://github.com/org/plugin-2',
      skills: [{ name: 'skill-x', path: 'plugins/plugin-2/skills/skill-x/SKILL.md' }] }],
  });
  const skillUrl = 'https://example.com/registry/plugins/plugin-2/skills/skill-x/SKILL.md';
  const registries = [{ name: 'reg-d', baseUrl: indexUrl, format: 'claude-plugin-marketplace' }];
  const fetchImpl = spyFetch({ [indexUrl]: index, [skillUrl]: SKILL_MD_TEXT });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'cool-skill'); // from the fetched SKILL.md frontmatter, not the index's sk.name
  assert.equal(out[0].sourceRepo, 'https://github.com/org/plugin-2');
  assert.deepEqual(fetchImpl.calls.sort(), [indexUrl, skillUrl].sort());
});

test('listRegistrySkills: marketplace format with a path whose follow-up fetch fails falls back to metadata-only row (fail-open)', async () => {
  const indexUrl = 'https://example.com/marketplace.json';
  const index = JSON.stringify([{ name: 'plugin-3', skills: [{ name: 'skill-y', description: 'desc-y', path: 'bad/path.md' }] }]);
  const registries = [{ name: 'reg-e', baseUrl: indexUrl, format: 'claude-plugin-marketplace' }];
  const fetchImpl = spyFetch({ [indexUrl]: index, 'https://example.com/bad/path.md': new Error('404') });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'skill-y');
  assert.equal(out[0].description, 'desc-y');
});

test('listRegistrySkills: malformed JSON index -> [] for that registry, never throws', async () => {
  const registries = [{ name: 'reg-f', baseUrl: 'https://example.com/broken.json', format: 'claude-plugin-marketplace' }];
  const fetchImpl = spyFetch({ 'https://example.com/broken.json': 'not json{' });
  assert.deepEqual(await listRegistrySkills(registries, { fetchImpl }), []);
});


test('listRegistrySkills: one registry throwing does not knock out sibling registries', async () => {
  const registries = [
    { name: 'broken', baseUrl: 'https://example.com/broken', format: 'skill-md' },
    { name: 'ok', baseUrl: 'https://example.com/ok/SKILL.md', format: 'skill-md' },
  ];
  const fetchImpl = spyFetch({ 'https://example.com/broken': new Error('timeout'), 'https://example.com/ok/SKILL.md': SKILL_MD_TEXT });
  const out = await listRegistrySkills(registries, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'cool-skill');
});

test('listRegistrySkills: unrecognized format contributes nothing, never throws', async () => {
  const registries = [{ name: 'weird', baseUrl: 'https://example.com/x', format: 'some-future-format' }];
  const fetchImpl = spyFetch({});
  assert.deepEqual(await listRegistrySkills(registries, { fetchImpl }), []);
  assert.deepEqual(fetchImpl.calls, []); // never even fetched - unknown format is skipped up front
});

test('listRegistrySkills: empty/malformed registries -> [], never throws', async () => {
  const fetchImpl = spyFetch({});
  assert.deepEqual(await listRegistrySkills([], { fetchImpl }), []);
  assert.deepEqual(await listRegistrySkills(undefined, { fetchImpl }), []);
  assert.deepEqual(await listRegistrySkills([null, { name: 'x' }, { name: 'y', baseUrl: '' }], { fetchImpl }), []);
});


test('acceptance #4: every URL fetchImpl observes derives from the registries allowlist baseUrls, never from gap/candidate text', async () => {
  const indexUrl = 'https://allow.example.com/marketplace.json';
  const index = JSON.stringify({ plugins: [{ name: 'p', source: 'https://github.com/org/p', skills: [{ name: 's', path: 'skills/s/SKILL.md' }] }] });
  const registries = [
    { name: 'reg-md', baseUrl: 'https://allow.example.com/single/SKILL.md', format: 'skill-md' },
    { name: 'reg-mk', baseUrl: indexUrl, format: 'claude-plugin-marketplace' },
  ];
  const fetchImpl = spyFetch({
    'https://allow.example.com/single/SKILL.md': SKILL_MD_TEXT,
    [indexUrl]: index,
    'https://allow.example.com/skills/s/SKILL.md': SKILL_MD_TEXT,
  });
  await listRegistrySkills(registries, { fetchImpl });
  const allowedRoots = registries.map((r) => new URL(r.baseUrl).origin);
  for (const url of fetchImpl.calls) {
    assert.ok(allowedRoots.some((root) => url.startsWith(root)), `fetched URL ${url} escaped the allowlist`);
  }
  assert.equal(fetchImpl.calls.length, 3);
});


const registrySkills = [
  { id: 'a', name: 'frontend-design', description: 'UI/UX design intelligence. Use before UI/CSS/layout work.' },
  { id: 'b', name: 'poison-scan', description: 'Zero-dependency detection core for AI-agent poisoning signals in ingested text.' },
];

test('matchGapToCandidate: a gap whose text is close to a candidate name+description is matched', () => {
  const gap = { code: 'ui-without-frontend-design', message: 'built UI without invoking the design skill' };
  const m = matchGapToCandidate(gap, registrySkills);
  assert.ok(m, 'expected a match');
  assert.equal(m.candidate.id, 'a');
  assert.ok(m.score >= DEFAULT_GAP_MATCH_THRESHOLD);
});

test('matchGapToCandidate: a gap with no relevant candidate returns null, never invents a match', () => {
  const gap = { code: 'unrelated-billing-issue', message: 'invoice totals do not reconcile' };
  const m = matchGapToCandidate(gap, registrySkills);
  assert.equal(m, null);
});

test('matchGapToCandidate: empty gap / empty candidate list / malformed gap -> null, never throws', () => {
  assert.equal(matchGapToCandidate(null, registrySkills), null);
  assert.equal(matchGapToCandidate({ code: '', message: '' }, registrySkills), null);
  assert.equal(matchGapToCandidate({ code: 'x' }, []), null);
  assert.equal(matchGapToCandidate({ code: 'x' }, undefined), null);
});

test('matchGapToCandidate: an explicit threshold higher than the default can reject a match the default would accept', () => {
  const gap = { code: 'ui-without-frontend-design', message: 'built UI without invoking the design skill' };
  const permissive = matchGapToCandidate(gap, registrySkills, 0.01);
  const strict = matchGapToCandidate(gap, registrySkills, 0.99);
  assert.ok(permissive);
  assert.equal(strict, null);
});

test('F24: a skill path that resolves to another origin is never fetched; the skill falls back to metadata only', async () => {
  const base = 'https://registry.example/market/marketplace.json';
  const index = JSON.stringify({ plugins: [{ name: 'p', skills: [
    { name: 'loopback', path: 'http://127.0.0.1:8124/api/qa-trends?refresh=1' },
    { name: 'protocol-relative', path: '//evil.example/x/SKILL.md' },
  ] }] });
  const fetchImpl = spyFetch({ [base]: index });
  const out = await listRegistrySkills([{ name: 'r', baseUrl: base, format: 'claude-plugin-marketplace' }], { fetchImpl });
  assert.deepEqual(fetchImpl.calls, [base], 'only the index itself was fetched');
  assert.equal(out.length, 2);
  for (const c of out) assert.equal(c.instructionsBody, null);
});

test('F24: registryFetch refuses redirects and asks fetch not to follow them', async () => {
  let init = null;
  const fetchImpl = async (url, i) => { init = i; return { status: 302, ok: false, type: 'basic', text: async () => '' }; };
  await assert.rejects(registryFetch('https://registry.example/x', { fetchImpl }), /redirect/);
  assert.equal(init.redirect, 'manual');
  const ok = await registryFetch('https://registry.example/x', { fetchImpl: async () => ({ status: 200, ok: true, type: 'basic', text: async () => 'body' }) });
  assert.equal(ok, 'body');
});

test('F24: an off-origin skip and a failed skill fetch each produce a named record', async () => {
  const base = 'https://registry.example/market/marketplace.json';
  const index = JSON.stringify({ plugins: [{ name: 'p', skills: [
    { name: 'away', path: 'http://127.0.0.1:8124/x' },
    { name: 'broken', path: 'broken/SKILL.md' },
  ] }] });
  const skips = [];
  const out = await listRegistrySkills([{ name: 'r', baseUrl: base, format: 'claude-plugin-marketplace' }], {
    fetchImpl: spyFetch({ [base]: index, 'https://registry.example/market/broken/SKILL.md': new Error('registry fetch refused a redirect') }),
    onSkip: (rec) => skips.push(rec),
  });
  assert.equal(out.length, 2);
  assert.equal(skips.length, 2);
  assert.equal(skips[0].registry, 'r');
  assert.equal(skips[0].url, 'http://127.0.0.1:8124/x');
  assert.match(skips[0].reason, /off-origin/);
  assert.equal(skips[1].url, 'https://registry.example/market/broken/SKILL.md');
  assert.match(skips[1].reason, /redirect/);
});

test('F24: userinfo and port mismatches count as off-origin', async () => {
  const base = 'https://registry.example/m/marketplace.json';
  const index = JSON.stringify({ plugins: [{ name: 'p', skills: [
    { name: 'userinfo', path: 'https://registry.example@evil.example/SKILL.md' },
    { name: 'port', path: 'https://registry.example:8443/SKILL.md' },
  ] }] });
  const fetchImpl = spyFetch({ [base]: index });
  const skips = [];
  await listRegistrySkills([{ name: 'r', baseUrl: base, format: 'claude-plugin-marketplace' }], { fetchImpl, onSkip: (r) => skips.push(r) });
  assert.deepEqual(fetchImpl.calls, [base]);
  assert.equal(skips.length, 2);
});

test('F24: a 3xx index through the default fetch path is reported, not silently empty', async () => {
  const realFetch = globalThis.fetch;
  let init = null;
  globalThis.fetch = async (url, i) => { init = i; return { status: 301, ok: false, type: 'basic', text: async () => '' }; };
  const skips = [];
  try {
    const out = await listRegistrySkills([{ name: 'r', baseUrl: 'https://registry.example/m.json', format: 'claude-plugin-marketplace' }], { onSkip: (r) => skips.push(r) });
    assert.deepEqual(out, []);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(init.redirect, 'manual');
  assert.equal(skips.length, 1);
  assert.equal(skips[0].url, 'https://registry.example/m.json');
  assert.match(skips[0].reason, /redirect/);
});

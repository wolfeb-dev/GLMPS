// Tests for the SCUT dual-mode theming (server/lib/scut/bobiverse.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT, resolveTheme, validateTheme, AGENT_IDS, channelNamesForProject, projectForSystem, radarChannelNames, SCUT_AVATAR_SLUG } from '../lib/scut/bobiverse.js';

const SYSTEMS = { 'Acme-App': 'epsilon-eridani', 'Northwind Portal': 'poseidon', 'Garden': 'kappa-ceti' };

test('PRODUCT is SCUT (same in both modes)', () => {
  assert.equal(PRODUCT.name, 'SCUT');
  assert.match(PRODUCT.full, /Subspace Communications Universal Transceiver/);
});

test('default theme is PROFESSIONAL (role-based personas + neutral channels)', () => {
  const t = resolveTheme();
  assert.equal(t.bobMode, false);
  assert.equal(t.agents.bill.display, 'Builder');
  assert.equal(t.agents.riker.display, 'Lead');
  assert.equal(t.channels.hub.name, 'agents');
  assert.equal(t.channels.dev.name, 'dev');
  assert.equal(t.channels.radar.name, 'alerts');
  assert.deepEqual(t.channelNames(), ['agents', 'dev', 'alerts']);
});

test('Bob mode flips to the Bobiverse personas + channels', () => {
  const t = resolveTheme(true);
  assert.equal(t.bobMode, true);
  assert.equal(t.agents.bill.display, 'Bill');
  assert.equal(t.agents.riker.display, 'Riker');
  assert.equal(t.agents.guppy.icon, ':tropical_fish:');
  assert.deepEqual(t.channelNames(), ['bob-moot', 'skunk-works', 'suddar']);
});

test('every agent carries aliases so a mention matches in either mode', () => {
  const t = resolveTheme(false); // pro mode
  // "bill" (id), "builder" (role/pro display), and "bill"/"builder" all resolve
  assert.ok(t.agents.bill.aliases.includes('bill'));
  assert.ok(t.agents.bill.aliases.includes('builder'));
  const bob = resolveTheme(true);
  assert.ok(bob.agents.bill.aliases.includes('bill'));   // bob display
  assert.ok(bob.agents.bill.aliases.includes('builder')); // still matches the pro handle
});

test('agentById is case-insensitive and null for unknown', () => {
  const t = resolveTheme();
  assert.equal(t.agentById('BILL').id, 'bill');
  assert.equal(t.agentById('riker').display, 'Lead');
  assert.equal(t.agentById('nobody'), null);
  assert.equal(t.agentById(null), null);
});

test('channelForProject: pro uses the slug, bob uses the star system', () => {
  assert.equal(resolveTheme(false, { projectSystems: SYSTEMS }).channelForProject('Acme-App'), 'acme-app');
  assert.equal(resolveTheme(true, { projectSystems: SYSTEMS }).channelForProject('Acme-App'), 'epsilon-eridani');
  assert.match(resolveTheme(true).channelForProject('Weird Name!!'), /^[a-z0-9-]+$/);
});

test('AGENT_IDS lists the roster and validateTheme passes for both modes', () => {
  for (const id of ['riker', 'bill', 'garfield', 'mario', 'homer', 'guppy', 'medeiros']) {
    assert.ok(AGENT_IDS.includes(id));
  }
  const r = validateTheme();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('channelNamesForProject returns both the pro slug and the bob system, mode-independently', () => {
  assert.deepEqual(channelNamesForProject('Acme-App', SYSTEMS).sort(), ['acme-app', 'epsilon-eridani']);
  assert.deepEqual(channelNamesForProject('Northwind Portal', SYSTEMS).sort(), ['northwind-portal', 'poseidon']);
});

test('channelNamesForProject dedupes when a project has no distinct star system', () => {
  const names = channelNamesForProject('some-unmapped-project', SYSTEMS);
  assert.deepEqual(names, ['some-unmapped-project']);
});

test('projectForSystem reverses the star-system mapping', () => {
  assert.equal(projectForSystem('epsilon-eridani', SYSTEMS), 'Acme-App');
  assert.equal(projectForSystem('kappa-ceti', SYSTEMS), 'Garden');
  assert.equal(projectForSystem('not-a-system', SYSTEMS), null);
});

test('a shipped build names no project: with no settings there is no star system', () => {
  assert.equal(projectForSystem('epsilon-eridani'), null);
  assert.deepEqual(channelNamesForProject('Acme-App'), ['acme-app']);
  assert.equal(resolveTheme(true).channelForProject('Acme-App'), 'acme-app');
  assert.equal(resolveTheme(true, { projectSystems: SYSTEMS }).channelForProject('Acme-App'), 'epsilon-eridani');
  assert.deepEqual(validateTheme({ x: 'Not A Slug' }).errors, ['invalid project-system slug: Not A Slug']);
});

test('1.0 retired: #sol is no star system', () => {
  assert.equal(projectForSystem('sol', SYSTEMS), null);
  assert.equal(resolveTheme(true, { projectSystems: SYSTEMS }).channelForProject('glmps'), 'glmps');
});

test('validateTheme still passes with Vault added', () => {
  assert.equal(validateTheme().ok, true);
});


test('agents have no avatar until a base URL is configured', () => {
  const t = resolveTheme(false);
  assert.equal(t.avatarBase, null);
  for (const a of Object.values(t.agents)) assert.equal(a.avatar, null);
  assert.equal(t.avatarFor('riker'), null);
  assert.equal(t.avatarFor('nobody'), null);
});

test('avatars follow the active mode, exactly like names and icons do', () => {
  const avatarBaseUrl = 'https://cdn.example/scut/';
  const pro = resolveTheme(false, { avatarBaseUrl });
  const bob = resolveTheme(true, { avatarBaseUrl });
  assert.equal(pro.agents.riker.avatar, 'https://cdn.example/scut/pro/riker.png');
  assert.equal(bob.agents.riker.avatar, 'https://cdn.example/scut/bob/riker.png');
  assert.equal(pro.avatarBase, 'https://cdn.example/scut');
  // every agent, not just the two we spot-check
  for (const id of AGENT_IDS) {
    assert.equal(pro.agents[id].avatar, `https://cdn.example/scut/pro/${id}.png`);
    assert.equal(bob.agents[id].avatar, `https://cdn.example/scut/bob/${id}.png`);
  }
});

test('an unknown agent falls back to SCUT own face, per mode', () => {
  const avatarBaseUrl = 'https://cdn.example/scut';
  assert.equal(resolveTheme(true, { avatarBaseUrl }).avatarFor('nobody'), 'https://cdn.example/scut/bob/scut.png');
  assert.equal(resolveTheme(false, { avatarBaseUrl }).avatarFor('nobody'), 'https://cdn.example/scut/pro/scut.png');
  assert.equal(SCUT_AVATAR_SLUG, 'scut');
});

test('an unusable base URL degrades to emoji, it never throws', () => {
  for (const bad of ['http://127.0.0.1:8123/x', 'file:///tmp/x', 'nonsense', '']) {
    const t = resolveTheme(false, { avatarBaseUrl: bad });
    assert.equal(t.avatarBase, null, bad);
    assert.equal(t.agents.bill.avatar, null, bad);
  }
});

// The radar channel is named ONCE at provisioning; a later bob-mode flip
// changes what the ACTIVE theme calls it but never the Slack channel itself.
// The 2026-07-29 flip left rollupChannel resolving 'suddar' against a
// workspace whose channel is 'alerts' - never matching, so the host tripwire
// silently stopped arming and every roll-up line was dropped.
test('radarChannelNames lists both modes names, active theme first', () => {
  assert.deepEqual(radarChannelNames(false), ['alerts', 'suddar']);
  assert.deepEqual(radarChannelNames(true), ['suddar', 'alerts']);
});

test('the product names the layer and the address separately', () => {
  assert.equal(PRODUCT.name, 'SCUT');
  assert.equal(PRODUCT.address, 'Riker');
  // The addressed voice must be a real agent id, not a loose string: the
  // router falls back to this persona when nobody is named.
  assert.ok(AGENT_IDS.includes(PRODUCT.address.toLowerCase()));
});

test('only the Lead is addressable from Slack; every persona stays in agents for huddle seats', () => {
  for (const bob of [false, true]) {
    const t = resolveTheme(bob);
    assert.deepEqual(Object.keys(t.addressable), ['riker']);
    assert.equal(t.addressable.riker, t.agents.riker);
    assert.deepEqual(Object.keys(t.agents), AGENT_IDS);
  }
});

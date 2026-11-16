// server/lib/scut/bobiverse.js
// SCUT theming. Two name sets per agent: a PROFESSIONAL set (the default, role
// based) and a BOB set (the Bobiverse Easter egg). resolveTheme(bobMode) returns
// the active theme; nothing here does I/O, so it stays pure + testable. Renaming
// or re-casting a Bob is a config edit.
//
// SCUT = Subspace Communications Universal Transceiver - the product name is the
// same in both modes; only the agent personas (and, at setup time, the channel
// names) differ.
//
// A persona is a name, an emoji, and - once the operator has published the
// avatar set somewhere public - a profile picture. The picture is resolved from
// an injected base URL (avatars.js) rather than read from anywhere, so this
// module keeps doing no I/O.
import { avatarUrl, normalizeAvatarBase } from './avatars.js';

// SCUT is the LAYER (the transceiver). Riker is the ADDRESS (the officer
// holding it) - he is already `defaultAgent` in engine.js and DEFAULT_AGENT in
// notify.js, so an unaddressed message has always routed to him. Naming the
// Slack app after the layer was the level error glmps-92 fixed:
// you address the officer, not the radio. Renaming the app is a Slack admin
// change; the internal name stays SCUT everywhere (module paths, env vars,
// state files and /api/scut/park are load-bearing and are NOT renamed).
export const PRODUCT = {
  name: 'SCUT',
  full: 'Subspace Communications Universal Transceiver',
  tagline: 'One transceiver for every agent.',
  address: 'Riker',
  addressRole: 'orchestrator',
};

// id -> { role, pro:{display,icon}, bob:{display,icon} }. The id is the stable
// internal handle used for routing; displays are what Slack shows.
const AGENTS_BASE = {
  riker:    { role: 'orchestrator', pro: { display: 'Lead',       icon: ':satellite:' },         bob: { display: 'Riker',    icon: ':military_medal:' } },
  bill:     { role: 'builder',      pro: { display: 'Builder',    icon: ':hammer_and_wrench:' },  bob: { display: 'Bill',     icon: ':hammer_and_wrench:' } },
  garfield: { role: 'reviewer',     pro: { display: 'Reviewer',   icon: ':mag:' },                bob: { display: 'Garfield', icon: ':mag:' } },
  mario:    { role: 'scout',        pro: { display: 'Scout',      icon: ':compass:' },            bob: { display: 'Mario',    icon: ':rocket:' } },
  homer:    { role: 'researcher',   pro: { display: 'Researcher', icon: ':books:' },              bob: { display: 'Homer',    icon: ':telescope:' } },
  guppy:    { role: 'assistant',    pro: { display: 'Assistant',  icon: ':speech_balloon:' },     bob: { display: 'Guppy',    icon: ':tropical_fish:' } },
  medeiros: { role: 'critic',       pro: { display: 'Critic',     icon: ':warning:' },            bob: { display: 'Medeiros', icon: ':crossed_swords:' } },
};

// key -> { pro, bob, purpose }. Channels are named ONCE at setup (no live rename).
const CHANNELS_BASE = {
  hub:   { pro: 'agents', bob: 'bob-moot',    purpose: 'Agent hub / all-hands.' },
  dev:   { pro: 'dev',    bob: 'skunk-works', purpose: 'Build / dev work.' },
  radar: { pro: 'alerts', bob: 'suddar',      purpose: 'Observability, alerts, signals.' },
};

// Bob-mode per-project "room" names (star systems) are the installation's own
// data, read from the SCUT settings file (getProjectSystems) and passed in here
// as `systems`; pro mode uses the project slug.

export const AGENT_IDS = Object.keys(AGENTS_BASE);

// The personas a Slack mention can address. Only the Lead: 155 of 157 Slack
// cards went to it, so naming another persona in Slack was noise (card
// glmps-2-0-143). The rest stay as huddle seats (huddle/roster.js), which read
// `agents`, not this list.
export const ADDRESSABLE_AGENT_IDS = Object.freeze(['riker']);

// SCUT's own face, used for any post that is not attributed to a named agent.
// It is an avatar slug like any other, so the same per-mode layout covers it.
export const SCUT_AVATAR_SLUG = 'scut';

function slugify(s) {
  const out = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return out || 'project';
}

/**
 * Resolve the active theme. bobMode=false (default) -> professional personas.
 * Returns { bobMode, mode, product, agents, channels, agentById, channelForProject,
 *   channelNames, avatarBase, avatarFor }. Each agent:
 * { id, role, display, icon, aliases:[...], avatar } where aliases (lowercased
 * id/role/both displays) let a mention match in either mode, and `avatar` is the
 * profile-picture URL for THIS mode, or null when none is configured.
 *
 * @param {boolean} bobMode
 * @param {{avatarBaseUrl?: string|null}} [opts] - public https base the avatar
 *   set is published under. Unusable or absent -> every avatar is null and SCUT
 *   keeps its emoji icons.
 */
export function resolveTheme(bobMode = false, { avatarBaseUrl = null, projectSystems = {} } = {}) {
  const m = bobMode ? 'bob' : 'pro';
  const avatarBase = normalizeAvatarBase(avatarBaseUrl);
  const agents = {};
  for (const [id, a] of Object.entries(AGENTS_BASE)) {
    const aliases = [...new Set([id, a.role, a.pro.display.toLowerCase(), a.bob.display.toLowerCase()])];
    agents[id] = { id, role: a.role, display: a[m].display, icon: a[m].icon, aliases, avatar: avatarUrl(avatarBase, m, id) };
  }
  const channels = {};
  for (const [key, c] of Object.entries(CHANNELS_BASE)) {
    channels[key] = { key, name: c[m], purpose: c.purpose };
  }
  return {
    bobMode,
    mode: m,
    product: PRODUCT,
    agents,
    addressable: Object.fromEntries(ADDRESSABLE_AGENT_IDS.map((id) => [id, agents[id]])),
    channels,
    agentById: (x) => agents[String(x ?? '').toLowerCase()] ?? null,
    channelForProject: (p) => (bobMode ? (projectSystems[p] || slugify(p)) : slugify(p)),
    channelNames: () => [channels.hub.name, channels.dev.name, channels.radar.name],
    avatarBase,
    // A post from an unnamed sender should still look like SCUT rather than
    // like a stock robot, so unknown ids resolve to SCUT's own face.
    avatarFor: (x) => agents[String(x ?? '').toLowerCase()]?.avatar ?? avatarUrl(avatarBase, m, SCUT_AVATAR_SLUG),
  };
}

/**
 * Every channel name a project can ever have, mode-independently: the
 * professional slug and (when one exists) the Bob star system. A channel is
 * named once at creation and never renamed, so provisioning must register
 * both forms up front regardless of which mode is active right now.
 */
export function channelNamesForProject(project, systems = {}) {
  const names = [slugify(project)];
  const system = systems[project];
  if (system) names.push(system);
  return [...new Set(names)];
}

/**
 * Every name the radar (roll-up/alerts) channel can carry, active theme's name
 * first. Same doctrine as channelNamesForProject: the channel is named once at
 * provisioning and never renamed, so a bob-mode flip after setup changes what
 * the theme CALLS it but not the Slack channel itself. A resolver that matches
 * only the active name silently unarms the host tripwire and drops every
 * roll-up line the moment the mode differs from the one provisioning ran in.
 */
export function radarChannelNames(bobMode = false) {
  const { pro, bob } = CHANNELS_BASE.radar;
  return bobMode ? [bob, pro] : [pro, bob];
}

/** Reverse lookup: the project whose Bob star system is `name` in `systems`, else null. */
export function projectForSystem(name, systems = {}) {
  for (const [project, system] of Object.entries(systems)) if (system === name) return project;
  return null;
}

/** Sanity-check both name sets: unique displays per mode + valid channel slugs. */
export function validateTheme(systems = {}) {
  const errors = [];
  const slug = /^[a-z0-9-]{1,80}$/;
  const emoji = /^:[a-z0-9_+-]+:$/;
  for (const mode of ['pro', 'bob']) {
    const displays = [];
    for (const [id, a] of Object.entries(AGENTS_BASE)) {
      displays.push(a[mode].display);
      if (!a.role) errors.push(`agent ${id} missing role`);
      if (!emoji.test(a[mode].icon || '')) errors.push(`agent ${id} ${mode} icon must be a :emoji:`);
    }
    if (new Set(displays).size !== displays.length) errors.push(`duplicate ${mode} agent displays`);
    const chans = Object.values(CHANNELS_BASE).map((c) => c[mode]);
    for (const name of chans) if (!slug.test(name)) errors.push(`invalid ${mode} channel slug: ${name}`);
    if (new Set(chans).size !== chans.length) errors.push(`duplicate ${mode} channel names`);
  }
  for (const name of Object.values(systems)) {
    if (!slug.test(name)) errors.push(`invalid project-system slug: ${name}`);
  }
  // An agent id doubles as its avatar filename, so a rename that is not a plain
  // slug would silently produce an unfetchable icon_url instead of a picture.
  for (const id of [...Object.keys(AGENTS_BASE), SCUT_AVATAR_SLUG]) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push(`agent id is not a usable avatar slug: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

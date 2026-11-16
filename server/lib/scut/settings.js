// server/lib/scut/settings.js
// Non-secret SCUT runtime settings (bobMode persona toggle, the allowlist,
// and the outbound thread/channel mode). Persisted to a small JSON file,
// kept SEPARATE from the credentials (config.js) since it carries no
// secrets. Path is injectable.
import { join } from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { normalizeAvatarBase } from './avatars.js';
import { resolveStateDir } from '../state-dir.js';

const DEFAULTS = { bobMode: false, allowedUsers: [], outbound: 'both', heartbeatMinutes: 5, avatarBaseUrl: null, parkHours: 168, projectSystems: {}, defaultProjects: [] };
const OUTBOUND_MODES = ['thread', 'channel', 'both'];

// `env` is injectable for the same reason as room-mapper.roomsPath: a caller
// threading its own env object resolves this path from that env.
export function settingsPath(env = process.env) {
  if (env.SCUT_SETTINGS_FILE) return env.SCUT_SETTINGS_FILE;
  const stateDir = resolveStateDir({ env });
  return join(stateDir, 'scut-settings.json');
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// A reader degrades to defaults for this one call (and logs); it never writes.
export function getSettings({ file = settingsPath() } = {}) {
  return { ...DEFAULTS, ...readJsonStoreOrDegrade(file, { fallback: {}, validate: isObject }) };
}

// Read-modify-write, so the read is strict: a settings file that cannot be read
// throws instead of being replaced by defaults plus the patch (which would
// silently drop the allowlist).
export function saveSettings(patch, { file = settingsPath() } = {}) {
  const current = readJsonStore(file, { fallback: {}, validate: isObject });
  const next = { ...DEFAULTS, ...current, ...patch };
  writeJsonStore(file, next, { trailingNewline: true });
  return next;
}

// The installation's own projects live here, not in code, so a shipped build
// names none of the maintainer's (card glmps-2-0-220). projectSystems maps a
// project to its Bob-mode star-system channel; defaultProjects is the list the
// setup wizard provisions channels for when SCUT_PROJECTS is not set.
export function getProjectSystems(opts) {
  const m = getSettings(opts).projectSystems;
  if (!isObject(m)) return {};
  return Object.fromEntries(Object.entries(m).filter(([p, s]) => p && typeof s === 'string' && s));
}
export function getDefaultProjects(opts) {
  const a = getSettings(opts).defaultProjects;
  return Array.isArray(a) ? a.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
}

export function getBobMode(opts) { return !!getSettings(opts).bobMode; }
export function setBobMode(on, opts) { return saveSettings({ bobMode: !!on }, opts).bobMode; }

// Authorization allowlist: Slack user IDs permitted to command agents. Empty =
// fail-closed (nobody authorized) so an @mention can never launch/steer an agent
// until the operator adds themselves.
export function getAllowedUsers(opts) {
  const a = getSettings(opts).allowedUsers;
  return Array.isArray(a) ? a : [];
}
export function addAllowedUser(userId, opts) {
  const cur = getAllowedUsers(opts);
  if (!userId || cur.includes(userId)) return cur;
  return saveSettings({ allowedUsers: [...cur, userId] }, opts).allowedUsers;
}

// Outbound routing mode: 'thread' replies into the originating Slack thread
// only, 'channel' posts a roll-up summary to the roll-up channel only, and
// 'both' (the default) does both - full detail in the thread you started, plus
// a compact line in one place to review multiple jobs at once. Anything else
// is a caller bug, not a degraded default, so it throws.
export function getOutbound(opts) {
  const mode = getSettings(opts).outbound;
  return OUTBOUND_MODES.includes(mode) ? mode : DEFAULTS.outbound;
}
export function setOutbound(mode, opts) {
  if (!OUTBOUND_MODES.includes(mode)) {
    throw new Error(`invalid outbound mode: ${mode} (expected one of ${OUTBOUND_MODES.join(', ')})`);
  }
  return saveSettings({ outbound: mode }, opts).outbound;
}

// Host-liveness heartbeat interval, in minutes: how often the running server
// re-books the Slack-held "HOST UNREACHABLE" tripwire (server/lib/scut/heartbeat.js).
// 0 disables the tripwire entirely. A stored value that is missing or corrupt
// (not a finite, non-negative number) falls back to the default rather than
// arming with garbage. setHeartbeatMinutes rejects negatives and non-numbers by
// throwing, same as setOutbound - a caller bug should surface immediately, not
// silently degrade into a bogus interval.
export function getHeartbeatMinutes(opts) {
  const n = getSettings(opts).heartbeatMinutes;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : DEFAULTS.heartbeatMinutes;
}
export function setHeartbeatMinutes(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(`invalid heartbeat minutes: ${n} (expected a non-negative number, 0 disables)`);
  }
  return saveSettings({ heartbeatMinutes: n }, opts).heartbeatMinutes;
}

// Parked-session TTL, in hours (spec 2026-07-31-scut-parked-sessions): how long
// a parked session may idle before auto-release. Default 168 (7 days, D27). 0
// disables the TTL. Getter degrades, setter throws: same contract as
// heartbeatMinutes above.
export function getParkHours(opts) {
  const n = getSettings(opts).parkHours;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : DEFAULTS.parkHours;
}
export function setParkHours(n, opts) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(`invalid park hours: ${n} (expected a non-negative number, 0 disables)`);
  }
  return saveSettings({ parkHours: n }, opts).parkHours;
}

// Where the agent profile pictures are published (glmps-34). Slack
// fetches icon_url from SLACK's servers, so this has to be a public https base;
// a 127.0.0.1 URL would resolve inside Slack, not on this host. Unset (the
// default) means agents keep their emoji icons.
//
// The split is deliberate: the SETTER throws, so a typo surfaces at the moment a
// human made it, while the GETTER degrades to null, so a hand-edited settings
// file can never take every outbound post down with it.
export function getAvatarBaseUrl({ file = settingsPath(), env = process.env } = {}) {
  const fromEnv = normalizeAvatarBase(env?.SCUT_AVATAR_BASE_URL);
  if (fromEnv) return fromEnv;
  return normalizeAvatarBase(getSettings({ file }).avatarBaseUrl);
}

/** Set or clear the avatar base URL. null/'' clears it; anything unusable throws. */
export function setAvatarBaseUrl(value, opts) {
  if (value == null || value === '') return saveSettings({ avatarBaseUrl: null }, opts).avatarBaseUrl;
  const norm = normalizeAvatarBase(value);
  if (!norm) throw new Error(`invalid avatar base URL: ${value} (expected a public https:// URL Slack can fetch)`);
  return saveSettings({ avatarBaseUrl: norm }, opts).avatarBaseUrl;
}

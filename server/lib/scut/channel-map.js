// server/lib/scut/channel-map.js
// Persistent channel-name -> project map. Slack channels are named once and
// never renamed, so a channel created in one mode (e.g. `glmps`)
// keeps that name forever, and a hand-made channel (e.g. `sol`) keeps its
// name too. bindProjectChannels registers EVERY name a project can ever have
// (professional slug + Bob star system) at creation time so routing works no
// matter which mode is active when a mention arrives later. Atomic tmp+rename
// persistence, mirrors server/lib/scut/room-mapper.js.
import { join } from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { channelNamesForProject, projectForSystem } from './bobiverse.js';
import { CANONICAL_PROJECT_DEFAULTS, canonicalTable, resolveProject, isRetiredProject } from '../orchestration/canonical-project.js';
import { resolveStateDir } from '../state-dir.js';
import { getProjectSystems } from './settings.js';

// `env` is injectable so a caller that already threads an env object (server.js
// startServer({ env })) can isolate this path too. Defaulting to process.env
// keeps every existing call site unchanged.
export function channelsPath(stateDir, env = process.env) {
  if (env.SCUT_CHANNELS_FILE) return env.SCUT_CHANNELS_FILE;
  const dir = stateDir ?? resolveStateDir({ env });
  return join(dir, 'scut', 'channels.json');
}

const validStore = (v) => v && typeof v.channels === 'object' && v.channels !== null;
const emptyStore = () => ({ channels: {} });

// Strict read for read-modify-write: a failed read throws rather than becoming
// an empty map that a later write would persist.
function readStore(file) {
  return readJsonStore(file, { fallback: emptyStore, validate: validStore });
}

// Pure readers degrade to empty for this one call and log. Never written back.
function readStoreForRead(file) {
  return readJsonStoreOrDegrade(file, { fallback: emptyStore, validate: validStore });
}

function writeStore(file, store) {
  writeJsonStore(file, store, { trailingNewline: true });
}

// Upsert: merges the patch into any existing binding, stamps updatedTs on
// every write, sets createdTs only on the first write.
export function bindChannel(patch, { file = channelsPath() } = {}) {
  const { name } = patch;
  const store = readStore(file);
  const now = Date.now();
  const existing = store.channels[name] ?? null;
  const binding = {
    ...existing,
    ...patch,
    createdTs: existing?.createdTs ?? now,
    updatedTs: now,
  };
  store.channels[name] = binding;
  writeStore(file, store);
  return store.channels[name];
}

// Registers EVERY name a project can ever have (professional slug + Bob star
// system), regardless of which mode is active right now. This is what
// satisfies "reverse mapping by default regardless of mode": both names route
// to the same project forever, no matter which one Slack actually shows.
export function bindProjectChannels(project, { file = channelsPath(), systems = getProjectSystems() } = {}) {
  const names = channelNamesForProject(project, systems);
  for (const name of names) bindChannel({ name, project }, { file });
  return names;
}

// Resolution order: persisted binding, then the settings' star-system reverse
// lookup, then a name the canonical-project table knows (`glmps` is one), then
// null. Every answer goes through the table, so a channel bound to an old 2.0
// project name routes to the canonical project too.
export function projectForChannelName(name, { file = channelsPath(), table = CANONICAL_PROJECT_DEFAULTS, systems = getProjectSystems() } = {}) {
  const store = readStoreForRead(file);
  const bound = store.channels[name]?.project ?? projectForSystem(name, systems);
  // The channel store is never pruned, so 1.0's own bindings (#sol,
  // #glmps) are still on disk; they route nowhere, not to 1.0.
  if (bound) return isRetiredProject(bound) ? null : resolveProject(bound, table);
  const known = resolveProject(name, table);
  return known === canonicalTable(table).target ? known : null;
}

export function listChannelBindings({ file = channelsPath() } = {}) {
  const store = readStoreForRead(file);
  return Object.values(store.channels).sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0));
}

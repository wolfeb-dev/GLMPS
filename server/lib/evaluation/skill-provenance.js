// server/lib/evaluation/skill-provenance.js
//
// Provenance manifest for installed skills - required before "update
// available" can mean anything at all. scanInventory() does not persist a
// source-repo/version per skill today, so a skill with no entry here (every
// hand-authored local skill, forever) MUST stay permanently
// upstreamStatus:'unknown' and never appear in updateCandidates() - flagging
// an update for something with no known upstream would be inventing a
// number, which this whole design explicitly refuses to do (see
// system-changes.js's own "never invents a rate" docstring guarantee).
//
// stateDir/skills/provenance.json
// manifest shape: { [skillId]: {
//   sourceRepo: string|null, sourceRef: string|null, version: string|null,
//   checkedTs: number|null, latestVersion: string|null,
//   upstreamStatus: 'up-to-date'|'update-available'|'unknown'|'unreachable',
//   lastError: string|null,
// } }
import fs from 'node:fs';
import path from 'node:path';

function storePath(stateDir) {
  return path.join(stateDir, 'skills', 'provenance.json');
}

/** Load the provenance manifest. Missing/corrupt/non-object files resolve to {}. */
export function loadProvenance(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(stateDir), 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch { return {}; }
}

export function saveProvenance(stateDir, manifest) {
  const file = storePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest && typeof manifest === 'object' ? manifest : {}, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Registration entrypoint: called manually by an operator, OR automatically
 * when glmps-87's adopt pipeline reaches 'kept' for a registry-sourced
 * candidate (the discovery step already knows sourceRepo/sourceRef/version).
 * Pure state-machine transform + fs wrapper, same load->mutate->save shape
 * as learning-store.js's *In() convenience wrappers.
 */
export function setProvenance(stateDir, skillId, { sourceRepo = null, sourceRef = null, version = null } = {}) {
  if (typeof skillId !== 'string' || !skillId) return loadProvenance(stateDir);
  const manifest = loadProvenance(stateDir);
  manifest[skillId] = {
    sourceRepo, sourceRef, version,
    checkedTs: manifest[skillId]?.checkedTs ?? null,
    latestVersion: manifest[skillId]?.latestVersion ?? null,
    upstreamStatus: manifest[skillId]?.upstreamStatus ?? 'unknown',
    lastError: manifest[skillId]?.lastError ?? null,
  };
  saveProvenance(stateDir, manifest);
  return manifest;
}

/**
 * @param {object} manifest
 * @param {(entry:{sourceRepo,sourceRef}) => Promise<string|null>} fetchLatestVersionFn
 *   injectable; tests always stub it, no real network in test.
 * @returns {Promise<object>} manifest' - fail-open per entry: a fetch error
 *   sets upstreamStatus:'unreachable' + lastError, never throws to the caller.
 */
export async function checkForUpdates(manifest, fetchLatestVersionFn) {
  const src = (manifest && typeof manifest === 'object') ? manifest : {};
  const out = {};
  for (const [skillId, entry] of Object.entries(src)) {
    if (!entry || typeof entry !== 'object') { out[skillId] = entry; continue; }
    // No known source repo -> permanently unknown, never checked, never flagged.
    if (!entry.sourceRepo) { out[skillId] = { ...entry, upstreamStatus: 'unknown' }; continue; }
    try {
      const latestVersion = await fetchLatestVersionFn({ sourceRepo: entry.sourceRepo, sourceRef: entry.sourceRef ?? null });
      if (typeof latestVersion !== 'string' || !latestVersion) {
        out[skillId] = { ...entry, checkedTs: Date.now(), upstreamStatus: 'unreachable', lastError: 'no version returned' };
        continue;
      }
      const upstreamStatus = latestVersion === entry.version ? 'up-to-date' : 'update-available';
      out[skillId] = { ...entry, checkedTs: Date.now(), latestVersion, upstreamStatus, lastError: null };
    } catch (e) {
      out[skillId] = { ...entry, checkedTs: Date.now(), upstreamStatus: 'unreachable', lastError: String(e?.message ?? e) };
    }
  }
  return out;
}

/** Pure filter - the propose-only surface. Never re-installs anything. */
export function updateCandidates(manifest) {
  const src = (manifest && typeof manifest === 'object') ? manifest : {};
  return Object.entries(src)
    .filter(([, e]) => e && e.upstreamStatus === 'update-available')
    .map(([id, e]) => ({ id, sourceRepo: e.sourceRepo, version: e.version, latestVersion: e.latestVersion }));
}

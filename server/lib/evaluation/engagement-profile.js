// server/lib/evaluation/engagement-profile.js
//
// C2's portable improvement-loop config: 3 pluggable slots per the aligned
// design doc (sec 2 "C2"): `objective` (what to optimize - a C1 measurable id),
// `sourceAllowlist` (where candidate ideas may come from - a FIXED list; a
// candidate's source is always one of these entries, never a URL derived
// from ingested text),
// and `verifier` (how a candidate is validated - replay-set). One profile =
// one engagement instance; GLMPS is instance #1
// (engagement-profiles/glmps.json). The trading instance (backtest-skeptic
// verifier) stays with GLMPS 1.0 and is not part of 2.0 (card glmps-2-0-143).
import fs from 'node:fs';

const ALLOWED_SOURCE_KINDS = new Set(['url', 'skill', 'repo']);
const ALLOWED_VERIFIER_KINDS = new Set(['replay-set']);

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

/**
 * @param {object} profile
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEngagementProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['profile must be an object'] };

  if (!isNonEmptyString(profile.id)) errors.push('id must be a non-empty string');

  if (!profile.objective || typeof profile.objective !== 'object' || !isNonEmptyString(profile.objective.measurableId)) {
    errors.push('objective.measurableId must be a non-empty string (a C1 measurable id)');
  }

  if (!Array.isArray(profile.sourceAllowlist) || profile.sourceAllowlist.length === 0) {
    errors.push('sourceAllowlist must be a non-empty array');
  } else {
    profile.sourceAllowlist.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`sourceAllowlist[${i}] must be an object`); return; }
      if (!isNonEmptyString(s.name)) errors.push(`sourceAllowlist[${i}].name must be a non-empty string`);
      if (!ALLOWED_SOURCE_KINDS.has(s.kind)) errors.push(`sourceAllowlist[${i}].kind must be one of 'url'|'skill'|'repo'`);
      if (!isNonEmptyString(s.ref)) errors.push(`sourceAllowlist[${i}].ref must be a non-empty string`);
    });
  }

  if (!profile.verifier || typeof profile.verifier !== 'object' || !ALLOWED_VERIFIER_KINDS.has(profile.verifier.kind)) {
    errors.push("verifier.kind must be 'replay-set'");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} json  an already-parsed candidate profile object
 * @returns {{ ok: true, profile: object } | { ok: false, errors: string[] }}
 */
export function loadEngagementProfile(json) {
  const v = validateEngagementProfile(json);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, profile: json };
}

/**
 * @param {string} filePath
 * @returns {{ ok: true, profile: object } | { ok: false, errors: string[] }}
 */
export function loadEngagementProfileFromFile(filePath) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return { ok: false, errors: [`failed to read/parse ${filePath}: ${String(e?.message ?? e)}`] };
  }
  return loadEngagementProfile(json);
}

/**
 * Structural discipline: a candidate is only ever considered "from an
 * allowlisted source" if its sourceRef literally matches one of the
 * profile's sourceAllowlist entries' `ref` - never a URL the research runner
 * merely mentioned or discovered mid-scan. Mirrors skill-registry-scan.js's
 * own "never derive a fetch URL from untrusted text" discipline.
 * @param {object} profile
 * @param {string} sourceRef
 * @returns {boolean}
 */
export function isAllowlistedSource(profile, sourceRef) {
  if (!profile || !Array.isArray(profile.sourceAllowlist)) return false;
  return profile.sourceAllowlist.some((s) => s?.ref === sourceRef);
}

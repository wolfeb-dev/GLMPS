// server/lib/evaluation/skill-adopt-store.js
//
// Propose-only approval queue + trial state machine for glmps-87's
// adopt-external-skill remediation path. Mirrors learning-store.js's
// load/save/upsert shape and backlog-store.js's "approval is deliberately
// NOT a generic PATCH" pattern (approveCandidate/rejectCandidate/
// releaseQuarantine are each their own explicit, logged operator action).
//
// The enforcement of "propose-and-vet, never auto-install" is STRUCTURAL,
// not a convention comment: there is no function in this module that writes
// to ~/.claude/skills, a project .claude/skills dir, or any plugin-cache
// path. Every mutating function here only ever writes this module's own
// JSON store file (stateDir/skill-adopt/store.json) - the same category of
// write guard-retire.js's candidates and gap-pipeline.js's shadow recording
// already make today. 'kept' is the highest reachable status and means
// "recommended," not "installed" - actually installing a kept candidate
// remains a manual, human-executed file operation forever outside this
// system (see the design doc's Part A.5 non-goal).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, quarantineDecision } from '../governance/poison-scan.js';
import { DEFAULT_MIN_OBSERVATIONS } from './guard-retire.js';

export const SKILL_ADOPT_STATUSES = Object.freeze([
  'discovered', 'quarantined', 'pending-approval', 'approved', 'trialing', 'kept', 'rejected',
]);

function sha1(s) { return crypto.createHash('sha1').update(s, 'utf8').digest('hex'); }

export function emptyState() { return { items: [] }; }

// dedup key: sha1(gapCode|sourceRepo|name) - stable across rediscovery, so a
// registry re-scan that turns up the same candidate again never resets its
// vetting progress.
function dedupId(candidate, gapCode) {
  return sha1(`${gapCode ?? ''}|${candidate?.sourceRepo ?? ''}|${candidate?.name ?? ''}`);
}

function itemsOf(state) { return Array.isArray(state?.items) ? state.items : []; }

function requireItem(items, id) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error(`skill-adopt-store: no candidate with id '${id}'`);
  return idx;
}

/**
 * Insert a newly-discovered candidate. ALWAYS poison-scans first - there is
 * no insert path that skips this (acceptance criterion #3). A discovered
 * candidate never originated at the operator's keyboard by definition, so
 * trust is hardcoded 'external' here (mirrors poison-scan.js's own
 * classifyTrust() OPERATOR_SOURCES exclusion - 'manual'/'dashboard'/
 * 'operator' never applies to a registry-discovered skill).
 *
 * Idempotent on rediscovery: an existing item (any status) is returned
 * untouched - re-scanning never resets vetting progress or resurrects a
 * terminal (kept/rejected) verdict.
 *
 * @param {object} state
 * @param {{name,description,sourceRepo,sourceRef,version,registryName,format,rawFrontmatter,instructionsBody}} candidate
 * @param {string|null} [gapCode]
 * @returns {{ state, item, isNew }}
 */
export function upsertCandidateInto(state, candidate, gapCode = null) {
  const items = itemsOf(state);
  const id = dedupId(candidate, gapCode);
  const existing = items.find((i) => i.id === id);
  if (existing) return { state: { ...state, items }, item: existing, isNew: false };

  const trust = 'external'; // ALWAYS - see module docstring
  const scanText_ = [candidate?.name, candidate?.description,
    candidate?.rawFrontmatter ? JSON.stringify(candidate.rawFrontmatter) : '', candidate?.instructionsBody]
    .filter(Boolean).join('\n');
  const scanned = scanText(scanText_);
  const quarantined = quarantineDecision({ trust, severity: scanned.severity });

  const now = Date.now();
  const item = {
    id,
    gapCode: gapCode ?? null,
    candidate: {
      name: candidate?.name ?? null,
      description: candidate?.description ?? null,
      sourceRepo: candidate?.sourceRepo ?? null,
      sourceRef: candidate?.sourceRef ?? null,
      version: candidate?.version ?? null,
      registryName: candidate?.registryName ?? null,
      format: candidate?.format ?? null,
    },
    provenance: { trust, flags: scanned.flags, severity: scanned.severity, quarantined, matches: scanned.matches },
    status: quarantined ? 'quarantined' : 'pending-approval',
    trial: null,
    createdTs: now,
    updatedTs: now,
  };
  return { state: { ...state, items: [...items, item] }, item, isNew: true };
}

// Two SEPARATE human gates (matching backlog-store.js's approveItem
// precedent - deliberately not folded into one generic mutation):

/** quarantined -> pending-approval. Throws if the item is not quarantined. */
export function releaseQuarantine(state, id) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'quarantined') {
    throw new Error(`skill-adopt-store: cannot release quarantine from status '${item.status}' (must be 'quarantined')`);
  }
  const next = { ...item, status: 'pending-approval', updatedTs: Date.now() };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/** pending-approval -> approved. Throws if quarantined or already past approved. */
export function approveCandidate(state, id) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'pending-approval') {
    throw new Error(`skill-adopt-store: cannot approve from status '${item.status}' (must be 'pending-approval' \u2014 a quarantined item must be released first)`);
  }
  const next = { ...item, status: 'approved', updatedTs: Date.now() };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/** -> rejected. Terminal. Reachable from any non-terminal status. */
export function rejectCandidate(state, id, reason = null) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  const TERMINAL = new Set(['kept', 'rejected']);
  if (TERMINAL.has(item.status)) {
    throw new Error(`skill-adopt-store: cannot reject a terminal status '${item.status}'`);
  }
  const next = { ...item, status: 'rejected', rejectReason: reason ?? null, updatedTs: Date.now() };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/** approved -> trialing. The ONLY reachable transition into a trial. */
export function startTrial(state, id) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'approved') {
    throw new Error(`skill-adopt-store: cannot start a trial from status '${item.status}' (must be 'approved')`);
  }
  const next = {
    ...item,
    status: 'trialing',
    trial: { startedTs: Date.now(), endedTs: null, taskClass: item.gapCode, n: 0, counterfactualRate: null, fireRate: null },
    updatedTs: Date.now(),
  };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/**
 * trialing -> kept (counterfactualRate stayed at/reached 0 across >=
 * minObservations, i.e. the gap stopped recurring) or rejected (still
 * recurring, or too few observations to support a positive verdict - a
 * SYSTEM proposal either way; a human still decides whether to actually
 * install anything; see the design doc's Part A.5 non-goal).
 */
export function resolveTrial(state, id, { n, counterfactualRate, fireRate } = {}, { minObservations = DEFAULT_MIN_OBSERVATIONS } = {}) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'trialing') {
    throw new Error(`skill-adopt-store: cannot resolve a trial from status '${item.status}' (must be 'trialing')`);
  }
  const verdict = (typeof n === 'number' && n >= minObservations && counterfactualRate === 0) ? 'kept' : 'rejected';
  const next = {
    ...item,
    status: verdict,
    trial: {
      ...item.trial,
      endedTs: Date.now(),
      n: typeof n === 'number' ? n : (item.trial?.n ?? 0),
      counterfactualRate: counterfactualRate ?? null,
      fireRate: fireRate ?? null,
    },
    updatedTs: Date.now(),
  };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

// stateDir/skill-adopt/store.json

function storeFile(stateDir) {
  return path.join(stateDir, 'skill-adopt', 'store.json');
}

export function load(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(stateDir), 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyState();
    return raw;
  } catch { return emptyState(); }
}

export function save(stateDir, state) {
  const file = storeFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function upsertCandidate(stateDir, candidate, gapCode) {
  const r = upsertCandidateInto(load(stateDir), candidate, gapCode);
  if (r.isNew) save(stateDir, r.state);
  return r;
}
export function releaseQuarantineIn(stateDir, id) { const r = releaseQuarantine(load(stateDir), id); save(stateDir, r.state); return r; }
export function approveCandidateIn(stateDir, id) { const r = approveCandidate(load(stateDir), id); save(stateDir, r.state); return r; }
export function rejectCandidateIn(stateDir, id, reason) { const r = rejectCandidate(load(stateDir), id, reason); save(stateDir, r.state); return r; }
export function startTrialIn(stateDir, id) { const r = startTrial(load(stateDir), id); save(stateDir, r.state); return r; }
export function resolveTrialIn(stateDir, id, measured, opts) { const r = resolveTrial(load(stateDir), id, measured, opts); save(stateDir, r.state); return r; }

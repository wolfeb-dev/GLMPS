// server/lib/governance/cross-agent-memory-store.js
//
// Propose-only approval queue + trial state machine for cross-agent shared
// memory (glmps-pro flagship feature) - mirrors
// server/lib/evaluation/skill-adopt-store.js's state machine shape exactly,
// per the C1/C2/B Coordination Contract (reuse the SAME propose-only shape
// C2 introduces for its research-scanner). A local memory fact becomes a
// candidate for CROSS-AGENT distribution here; nothing in this module
// writes to a vendor's memory surface directly (that's
// cross-agent-memory.js's distributeMemory(), gated on 'approved'/
// 'trialing'/'kept' status only).
//
// ALWAYS poison-scans on insert (mandatory, non-bypassable - Coordination
// Contract sec 3): sharing a fact across every connected agent is a strictly
// bigger blast radius than the project-local write memory-writer.js already
// poison-scanned before, so intake here re-scans regardless.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, quarantineDecision } from './poison-scan.js';
import { DEFAULT_MIN_OBSERVATIONS } from '../evaluation/guard-retire.js';

export const SHARED_MEMORY_STATUSES = Object.freeze([
  'discovered', 'quarantined', 'pending-approval', 'approved', 'trialing', 'kept', 'rejected',
]);

function sha1(s) { return crypto.createHash('sha1').update(s, 'utf8').digest('hex'); }

export function emptyState() { return { items: [] }; }

// dedup key: sha1(sourceProject|name) - stable across re-capture, so
// re-running capture on the same project never resets vetting progress.
function dedupId(fact, sourceProject) {
  return sha1(`${sourceProject ?? ''}|${fact?.name ?? ''}`);
}

function itemsOf(state) { return Array.isArray(state?.items) ? state.items : []; }

function requireItem(items, id) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error(`cross-agent-memory-store: no candidate with id '${id}'`);
  return idx;
}

/**
 * Insert a newly-captured local memory fact as a shared-memory candidate.
 * ALWAYS poison-scans first - no insert path skips this. Trust is hardcoded
 * 'external' (mirrors skill-adopt-store.js): a fact captured for
 * cross-agent sharing did not originate at the operator's keyboard in THIS
 * sharing action, so it gets the stricter external quarantine rule (any
 * flag at all quarantines it).
 *
 * Idempotent on re-capture: an existing item (any status) is returned
 * untouched - re-capturing never resets vetting progress or resurrects a
 * terminal (kept/rejected) verdict.
 *
 * @param {object} state
 * @param {{name,description,type,body,confidence}} fact
 * @param {string} sourceProject
 * @returns {{ state, item, isNew }}
 */
export function upsertCandidateInto(state, fact, sourceProject) {
  const items = itemsOf(state);
  const id = dedupId(fact, sourceProject);
  const existing = items.find((i) => i.id === id);
  if (existing) return { state: { ...state, items }, item: existing, isNew: false };

  const trust = 'external'; // ALWAYS - see module docstring
  const scanned = scanText(`${fact?.name ?? ''}\n${fact?.description ?? ''}\n${fact?.body ?? ''}`);
  const quarantined = quarantineDecision({ trust, severity: scanned.severity });

  const now = Date.now();
  const item = {
    id,
    sourceProject: sourceProject ?? null,
    fact: {
      name: fact?.name ?? null,
      description: fact?.description ?? null,
      type: fact?.type ?? null,
      body: fact?.body ?? null,
      confidence: typeof fact?.confidence === 'number' ? fact.confidence : null,
    },
    provenance: { trust, flags: scanned.flags, severity: scanned.severity, quarantined, matches: scanned.matches },
    status: quarantined ? 'quarantined' : 'pending-approval',
    trial: null,
    createdTs: now,
    updatedTs: now,
  };
  return { state: { ...state, items: [...items, item] }, item, isNew: true };
}

/** quarantined -> pending-approval. Throws if the item is not quarantined. */
export function releaseQuarantine(state, id) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'quarantined') {
    throw new Error(`cross-agent-memory-store: cannot release quarantine from status '${item.status}' (must be 'quarantined')`);
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
    throw new Error(`cross-agent-memory-store: cannot approve from status '${item.status}' (must be 'pending-approval' \u2014 a quarantined item must be released first)`);
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
    throw new Error(`cross-agent-memory-store: cannot reject a terminal status '${item.status}'`);
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
    throw new Error(`cross-agent-memory-store: cannot start a trial from status '${item.status}' (must be 'approved')`);
  }
  const next = {
    ...item,
    status: 'trialing',
    trial: { startedTs: Date.now(), endedTs: null, n: 0, drifted: false },
    updatedTs: Date.now(),
  };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/**
 * trialing -> kept (synced with zero drift across >= minObservations
 * attestation ticks) or rejected (drifted at least once, or too few
 * observations to support a positive verdict). A SYSTEM verdict - actually
 * pushing to a vendor surface already happened during 'approved'/
 * 'trialing' (distributeMemory()); this only decides whether to keep
 * auto-syncing it.
 */
export function resolveTrial(state, id, { n, drifted } = {}, { minObservations = DEFAULT_MIN_OBSERVATIONS } = {}) {
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const item = items[idx];
  if (item.status !== 'trialing') {
    throw new Error(`cross-agent-memory-store: cannot resolve a trial from status '${item.status}' (must be 'trialing')`);
  }
  const verdict = (typeof n === 'number' && n >= minObservations && !drifted) ? 'kept' : 'rejected';
  const next = {
    ...item,
    status: verdict,
    trial: { ...item.trial, endedTs: Date.now(), n: typeof n === 'number' ? n : (item.trial?.n ?? 0), drifted: !!drifted },
    updatedTs: Date.now(),
  };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

/**
 * Mark an item shareable (or not) with the generic text a customer install may
 * receive (card glmps-2-0-183). Optional fields: an item that never passes
 * through here carries neither, so existing rows and readers are unchanged.
 */
export function setShareable(state, id, { shareable, shareText = null } = {}) {
  if (typeof shareable !== 'boolean') throw new Error('cross-agent-memory-store: shareable must be a boolean');
  const items = itemsOf(state);
  const idx = requireItem(items, id);
  const next = { ...items[idx], shareable, shareText: typeof shareText === 'string' ? shareText : null, updatedTs: Date.now() };
  const nextItems = items.slice(); nextItems[idx] = next;
  return { state: { ...state, items: nextItems }, item: next };
}

// stateDir/cross-agent-memory/store.json

function storeFile(stateDir) {
  return path.join(stateDir, 'cross-agent-memory', 'store.json');
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

export function upsertCandidate(stateDir, fact, sourceProject) {
  const r = upsertCandidateInto(load(stateDir), fact, sourceProject);
  if (r.isNew) save(stateDir, r.state);
  return r;
}
export function releaseQuarantineIn(stateDir, id) { const r = releaseQuarantine(load(stateDir), id); save(stateDir, r.state); return r; }
export function approveCandidateIn(stateDir, id) { const r = approveCandidate(load(stateDir), id); save(stateDir, r.state); return r; }
export function rejectCandidateIn(stateDir, id, reason) { const r = rejectCandidate(load(stateDir), id, reason); save(stateDir, r.state); return r; }
export function startTrialIn(stateDir, id) { const r = startTrial(load(stateDir), id); save(stateDir, r.state); return r; }
export function resolveTrialIn(stateDir, id, measured, opts) { const r = resolveTrial(load(stateDir), id, measured, opts); save(stateDir, r.state); return r; }
export function setShareableIn(stateDir, id, share) { const r = setShareable(load(stateDir), id, share); save(stateDir, r.state); return r; }

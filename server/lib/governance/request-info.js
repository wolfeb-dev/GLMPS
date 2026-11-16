// server/lib/governance/request-info.js
//
// One checkpointed pending-request primitive behind the ad-hoc HITL
// (human-in-the-loop) seams - glmps-81 Phase 4. Persisted as
// stateDir/requests/<id>.json. Mirrors
// server/lib/evaluation/memory-writer.js's
// stageProposal/listProposals/approveProposal pattern exactly: this module
// generalizes that pattern (kind-tagged payload instead of a fact-shaped
// proposal, pluggable id instead of a slugify(fact.name) baked in) rather
// than inventing a new one. No network. Fail-open: malformed/missing
// requests are reported via return value, never thrown.
//
// A session (or a future chat-notified pause) can createRequest() before
// stopping and listPending()/resolveRequest() on the next tick - including
// after a full server restart - because the store is nothing but files on
// disk; there is no in-memory cache to lose.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function requestsDir(stateDir) {
  return path.join(stateDir, 'requests');
}

function requestFile(stateDir, id) {
  return path.join(requestsDir(stateDir), `${id}.json`);
}

// Stable (key-order-independent) stringify so two payloads that are
// deep-equal but built with keys in a different order still hash the same.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// Content-addressed default id: the same (kind, payload) pair always maps to
// the same id, so re-creating an identical pending request overwrites the
// existing one instead of piling up duplicates (the same "same key -> same
// file" dedup memory-writer.js gets for free from slugify(fact.name),
// generalized to arbitrary payload shapes). Callers that already own a
// natural dedup key (e.g. memory-writer.js's fact-name slug) can pass an
// explicit `id` to preserve their own identity scheme exactly.
function defaultId(kind, payload) {
  return crypto.createHash('sha1').update(`${kind}\n${stableStringify(payload ?? null)}`).digest('hex').slice(0, 16);
}


export function createRequest(stateDir, { kind, payload, actor, id } = {}) {
  if (!kind) throw new TypeError('createRequest requires a kind');
  const reqId = id ?? defaultId(kind, payload);
  fs.mkdirSync(requestsDir(stateDir), { recursive: true });
  const record = {
    kind,
    payload: payload ?? null,
    actor: actor ?? null,
    status: 'pending',
    createdAt: Date.now(),
  };
  fs.writeFileSync(requestFile(stateDir, reqId), JSON.stringify(record, null, 2));
  return reqId;
}

export function listPending(stateDir, { kind } = {}) {
  let names;
  try {
    names = fs.readdirSync(requestsDir(stateDir));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(requestsDir(stateDir), name), 'utf8'));
    } catch {
      continue; // skip malformed request file
    }
    if (!record || record.status !== 'pending') continue;
    if (kind && record.kind !== kind) continue;
    out.push({ ...record, id });
  }
  return out;
}

export function resolveRequest(stateDir, id, { decision, by } = {}) {
  const file = requestFile(stateDir, id);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { resolved: false, reason: 'missing' };
  }
  const resolvedAt = Date.now();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ ...record, status: 'resolved', decision: decision ?? null, resolvedBy: by ?? null, resolvedAt }, null, 2)
    );
  } catch {
    // best-effort persist of the resolution marker; caller still gets the
    // original payload back below so it can complete the kind-specific
    // side effect (e.g. writing a memory file) regardless.
  }
  return { resolved: true, id, kind: record.kind, payload: record.payload, actor: record.actor, decision: decision ?? null };
}

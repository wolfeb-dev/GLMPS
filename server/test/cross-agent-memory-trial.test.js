import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runTrialTick } from '../lib/governance/cross-agent-memory.js';
import { upsertCandidate, approveCandidateIn, startTrialIn, load } from '../lib/governance/cross-agent-memory-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cam-trial-')); }
function trialingItem(sd, name = 'a fact', sourceProject = 'proj-a') {
  const { item } = upsertCandidate(sd, { name, description: 'd', type: 'project', body: 'b', confidence: 0.8 }, sourceProject);
  approveCandidateIn(sd, item.id);
  return startTrialIn(sd, item.id).item;
}

test('no drift, reaches minObservations -> kept', () => {
  const sd = tmp();
  const item = trialingItem(sd);
  let observationCounts = new Map();
  let result;
  for (let i = 0; i < 3; i++) {
    result = runTrialTick(sd, { attestationFindings: [], observationCounts }, { minObservations: 3 });
  }
  assert.deepEqual(result.kept, [item.id]);
  assert.equal(load(sd).items[0].status, 'kept');
});

test('drift finding rejects immediately, even before minObservations', () => {
  const sd = tmp();
  const item = trialingItem(sd);
  const observationCounts = new Map();
  const result = runTrialTick(sd, {
    attestationFindings: [{ kind: 'guardrail-modified', id: 'x' }],
    observationCounts,
  }, { minObservations: 5 });
  assert.deepEqual(result.rejected, [item.id]);
  assert.equal(load(sd).items[0].status, 'rejected');
});

test('below minObservations and no drift -> stays trialing', () => {
  const sd = tmp();
  const item = trialingItem(sd);
  const observationCounts = new Map();
  const result = runTrialTick(sd, { attestationFindings: [], observationCounts }, { minObservations: 5 });
  assert.deepEqual(result.stillTrialing, [item.id]);
  assert.equal(load(sd).items[0].status, 'trialing');
});

test('non-trialing items are ignored', () => {
  const sd = tmp();
  upsertCandidate(sd, { name: 'a fact', description: 'd', type: 'project', body: 'b', confidence: 0.8 }, 'proj-a');
  const result = runTrialTick(sd, { attestationFindings: [], observationCounts: new Map() }, { minObservations: 1 });
  assert.deepEqual(result, { kept: [], rejected: [], stillTrialing: [] });
});

// FILE-LEVEL invariant (see cross-agent-memory.js's "Trial lifecycle" header
// comment): drift is measured per managed-file block, not per entry, so a
// single drift finding must reject EVERY item currently trialing in that
// tick - not just the first one encountered in the loop. Every other test
// above uses a single trialing item, leaving this invariant uncovered.
test('drift finding rejects ALL currently-trialing items in the same tick, not just one', () => {
  const sd = tmp();
  const itemA = trialingItem(sd, 'fact a', 'proj-a');
  const itemB = trialingItem(sd, 'fact b', 'proj-b');
  const itemC = trialingItem(sd, 'fact c', 'proj-c');
  const observationCounts = new Map();
  const result = runTrialTick(sd, {
    attestationFindings: [{ kind: 'guardrail-modified', id: 'x' }],
    observationCounts,
  }, { minObservations: 5 });

  assert.deepEqual(result.rejected.slice().sort(), [itemA.id, itemB.id, itemC.id].sort());
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.stillTrialing, []);

  const state = load(sd);
  for (const id of [itemA.id, itemB.id, itemC.id]) {
    assert.equal(state.items.find((i) => i.id === id).status, 'rejected');
  }
});

test('resolving a trial prunes its id out of observationCounts', () => {
  const sd = tmp();
  const item = trialingItem(sd);
  const observationCounts = new Map();
  const result = runTrialTick(sd, {
    attestationFindings: [{ kind: 'guardrail-modified', id: 'x' }],
    observationCounts,
  }, { minObservations: 5 });

  assert.deepEqual(result.rejected, [item.id]);
  assert.equal(observationCounts.has(item.id), false);
});

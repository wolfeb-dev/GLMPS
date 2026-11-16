// Routes under test: server/lib/routes/guards-routes.js
// server/test/guard-retire-gepa-exclusion.test.js
//
// Guard proposer cutover: appliedGuardCatalog()
// used to key every applied guard by `code`. A GEPA-derived item's code is
// always the literal string 'gepa-proposal' (learning-store.js's
// upsertProposal), so every applied GEPA guard collapsed onto the SAME map
// entry, and there is no shadow-arm bucket for that fake taskClass anyway
// (nothing ever calls recordShadow with 'gepa-proposal') - a retire/stale
// verdict for a GEPA guard would need to join across the shadow-arm buckets
// of the several different gap codes it was derived from
// (item.derivedFrom), which is not a sound 1:1 statistical join (see
// task-10-report.md's fix-round-1 appendix). Chosen fix: exclude GEPA-
// sourced applied guards from retire-candidate evaluation entirely, and
// surface how many were excluded on the one route that returns candidates
// directly, rather than silently collapsing them into one entry that could
// never be evaluated anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// every adapter dir this server scans for
// gaps/alerts, plus the assets dir, must be a throwaway temp dir - matching
// gepa-route.test.js's own isolatedEnv. Without this, a real session/asset
// on the operator's machine leaks into these tests as a phantom finding.
function isolatedEnv(overrides) {
  return {
    ...process.env,
    GLMPS_ANTIGRAVITY_DIR: tmp('mc-gge-ag-'),
    GLMPS_GEMINI_TMP_DIR: tmp('mc-gge-gemini-'),
    GLMPS_VSCODE_STORAGE_DIR: tmp('mc-gge-vscode-'),
    GLMPS_AGY_CLI_DIR: tmp('mc-gge-agy-'),
    GLMPS_CODEX_DIR: tmp('mc-gge-codex-'),
    GLMPS_COPILOT_CLI_DIR: tmp('mc-gge-copilot-'),
    GLMPS_HERMES_DIR: tmp('mc-gge-hermes-'),
    GLMPS_OPENCODE_DIR: tmp('mc-gge-opencode-'),
    GLMPS_ASSETS_DIR: tmp('mc-gge-assets-'),
    ...overrides,
  };
}

function seedAppliedGepaGuard(stateDir) {
  const proposal = learningStore.upsertProposal(learningStore.emptyState(), {
    source: 'gepa', title: 'Proposed guard', body: 'from GEPA', rule: '- Read the file before editing it.',
    sourceItemIds: ['g1'],
  });
  const applied = learningStore.markApplied(proposal.state, proposal.item.id, 'commit1');
  learningStore.save(stateDir, applied.state);
  return applied.item;
}

test('an applied GEPA guard never becomes a retire candidate, even with abundant never-fired shadow evidence, and is counted as excluded', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  seedAppliedGepaGuard(stateDir);
  // If appliedGuardCatalog() still collapsed GEPA guards onto the literal
  // code 'gepa-proposal', this would make it a slam-dunk retire candidate.
  for (let i = 0; i < 30; i++) {
    recordShadow(stateDir, { taskClass: 'gepa-proposal', wouldFire: false, fired: false });
  }
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/guards/retire-candidates?minObservations=1`);
    const body = await r.json();
    assert.ok(!body.candidates.some((c) => c.code === 'gepa-proposal'),
      'a GEPA guard must never surface as a retire candidate under the collapsed fake code');
    assert.equal(body.excludedGepaGuards, 1, 'the one applied GEPA guard is counted, not silently dropped');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('excludedGepaGuards is 0 when there are no applied GEPA guards', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/guards/retire-candidates`);
    const body = await r.json();
    assert.equal(body.excludedGepaGuards, 0);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

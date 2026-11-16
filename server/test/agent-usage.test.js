import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateAgentUsage } from '../lib/observability/agent-usage.js';
import { startServer } from '../server.js';
import { IndexStore } from '../lib/index-store.js';
import { extractClaudeEvents } from '../lib/observability/extract-claude.js';

test('aggregates dispatches and model split across sessions', () => {
  const usage = aggregateAgentUsage([
    { id: 's1', agentsUsed: [{ name: 'web-researcher', model: 'sonnet', count: 2, lastTs: 20 }] },
    { id: 's2', agentsUsed: [{ name: 'web-researcher', model: 'haiku', count: 1, lastTs: 90 }] },
    { id: 's3' },
  ]);
  const row = usage.get('web-researcher');
  assert.equal(row.dispatches, 3);
  assert.deepEqual(row.modelSplit, { sonnet: 2, haiku: 1, opus: 0, none: 0 });
  assert.equal(row.lastUsed, 90);
});

test('a null model counts as none', () => {
  const usage = aggregateAgentUsage([
    { id: 's1', agentsUsed: [{ name: 'backtest-skeptic', model: null, count: 4, lastTs: 1 }] },
  ]);
  assert.equal(usage.get('backtest-skeptic').modelSplit.none, 4);
});

test('an unknown model label does not throw and is bucketed as none', () => {
  const usage = aggregateAgentUsage([
    { id: 's1', agentsUsed: [{ name: 'x', model: 'fable', count: 1, lastTs: 1 }] },
  ]);
  assert.equal(usage.get('x').modelSplit.none, 1);
  assert.equal(usage.get('x').dispatches, 1);
});

test('model:null and model:sonnet for the same agent stay separate buckets', () => {
  const usage = aggregateAgentUsage([
    { id: 's1', agentsUsed: [{ name: 'backtest-skeptic', model: null, count: 3, lastTs: 5 }] },
    { id: 's2', agentsUsed: [{ name: 'backtest-skeptic', model: 'sonnet', count: 2, lastTs: 8 }] },
  ]);
  const row = usage.get('backtest-skeptic');
  assert.deepEqual(row.modelSplit, { sonnet: 2, haiku: 0, opus: 0, none: 3 });
  assert.equal(row.dispatches, 5);
});

test('GET /api/agents reports zero-use agents as 0, not missing', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/agents`)).json();
    assert.ok(Array.isArray(body.agents));
    for (const a of body.agents) {
      assert.equal(typeof a.dispatchCount, 'number');
      assert.ok(a.modelSplit && typeof a.modelSplit.sonnet === 'number');
    }
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /api/agents joins real persisted usage: installed agent gets non-zero counts, history-only agent surfaces as source:unknown', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-'));
  // Seed the index at the exact path IndexStore reads: <stateDir>/state/index.json
  // (see server/lib/paths.js indexFile), so the route has real agentsUsed rows to
  // join against, not an always-empty freshly-started store.
  const indexStateDir = path.join(stateDir, 'state');
  fs.mkdirSync(indexStateDir, { recursive: true });
  fs.writeFileSync(path.join(indexStateDir, 'index.json'), JSON.stringify([
    {
      id: 's1',
      agentsUsed: [
        // 'general-purpose' ships in agent-fleet.js's DEFAULT_REGISTRY, so it is
        // always present in fleet.agents regardless of disk contents: a
        // deterministic stand-in for "an installed agent".
        { name: 'general-purpose', model: 'sonnet', count: 3, lastTs: 50 },
        // Not in the registry and not on disk (agentsDir is empty) -> must
        // surface via the source:'unknown' fallback, not be dropped.
        { name: 'retired-agent', model: 'haiku', count: 2, lastTs: 40 },
      ],
    },
  ]));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_AGENTS_DIR: agentsDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/agents`)).json();

    const known = body.agents.find(a => (a.name ?? '').toLowerCase() === 'general-purpose');
    assert.ok(known, 'general-purpose must be present (DEFAULT_REGISTRY)');
    assert.equal(known.dispatchCount, 3);
    assert.deepEqual(known.modelSplit, { sonnet: 3, haiku: 0, opus: 0, none: 0 });
    assert.equal(known.lastUsed, 50);

    const unknown = body.agents.find(a => (a.name ?? '').toLowerCase() === 'retired-agent');
    assert.ok(unknown, 'an agent seen only in history must still be returned, not dropped');
    assert.equal(unknown.source, 'unknown');
    assert.equal(unknown.dispatchCount, 2);
    assert.deepEqual(unknown.modelSplit, { sonnet: 0, haiku: 2, opus: 0, none: 0 });
    assert.equal(unknown.lastUsed, 40);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

// Every case above hand-writes a numeric `lastTs`, which is not the shape real
// capture produces: extract-claude.js passes a transcript's ISO-8601 STRING
// `timestamp` through as `e.ts`, IndexStore's counter compared it against a
// number, and the comparison was always false - so /api/agents returned
// `lastUsed: 0` for EVERY agent and the Capability Registry showed the whole
// roster as last used in 1970. This drives the real chain end to end:
// transcript line -> extractClaudeEvents -> IndexStore -> persisted index.json
// -> GET /api/agents. Nothing here is hand-shaped to agree with the code.
function assistantLine(timestamp, subagent_type, model) {
  return JSON.stringify({
    type: 'assistant', sessionId: 's-real', timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type, description: 'do the thing', model } }] },
  });
}

test('GET /api/agents reports a real epoch lastUsed when usage came from a real transcript, not 0', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-'));
  const EARLY = '2026-06-05T10:00:00.000Z';
  const LATE = '2026-06-05T12:00:00.000Z';
  try {
    // Build the index through the REAL store + REAL extractor, then let
    // IndexStore itself write index.json at the path the server reads.
    const indexFile = path.join(stateDir, 'state', 'index.json');
    const store = new IndexStore(indexFile);
    store.applyEvents('s-real', extractClaudeEvents(assistantLine(EARLY, 'general-purpose', 'sonnet'), 's-real'));
    store.applyEvents('s-real', extractClaudeEvents(assistantLine(LATE, 'general-purpose', 'sonnet'), 's-real'));
    store.flush();

    // The same records, aggregated: the pure layer must already be right.
    const usage = aggregateAgentUsage(store.list({}));
    assert.equal(usage.get('general-purpose').dispatches, 2);
    assert.equal(usage.get('general-purpose').lastUsed, Date.parse(LATE));

    const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_AGENTS_DIR: agentsDir };
    const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
    try {
      const body = await (await fetch(`http://127.0.0.1:${h.port}/api/agents`)).json();
      const row = body.agents.find(a => (a.name ?? '').toLowerCase() === 'general-purpose');
      assert.ok(row, 'general-purpose must be present (DEFAULT_REGISTRY)');
      assert.equal(row.dispatchCount, 2);
      assert.ok(Number.isFinite(row.lastUsed) && row.lastUsed > 0, `lastUsed must be a real epoch, got ${JSON.stringify(row.lastUsed)}`);
      assert.equal(row.lastUsed, Date.parse(LATE));
    } finally {
      await h.close?.();
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

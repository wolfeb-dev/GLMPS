// Routes under test: server/lib/routes/plugins-routes.js
// server/test/model-runner-disabled.test.js
// finalizing a session with real events
// used to trigger the judge inline, which calls the shared chatCompletion
// wired at boot to the real runClaude - i.e. a real `claude -p` spawn on the
// operator's plan, from a test. This proves the GLMPS_MODEL_RUNNER=off override
// (claude-model.js runClaude) stops that end to end, both for the direct
// model route every plugin calls, and via a real finalize-with-events ->
// judge path: the judge's own failure (the disabled runner, not a network or
// parsing error) is caught by the registered plugin-retry loop,
// which bumps the job for a later attempt, with no hang and no verdict ever
// recorded. Post-B4 (judge on quiescence), the judge only ever runs via a
// manually-triggered retry tick (idleMs:0 here makes the job due
// immediately) rather than inline at finalize time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Full GLMPS_* isolation (matching gepa-route.test.js's isolatedEnv): every
// adapter dir this server scans for gaps/alerts must be a throwaway temp
// dir, or a real session on the operator's machine leaks in as a phantom
// alert - never the operator's real state.
function isolatedEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_MODEL_RUNNER: 'off',
    GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_CLAUDE_DIR: tmp('mc-mr-claude-'),
    GLMPS_ANTIGRAVITY_DIR: tmp('mc-mr-ag-'),
    GLMPS_GEMINI_TMP_DIR: tmp('mc-mr-gemini-'),
    GLMPS_VSCODE_STORAGE_DIR: tmp('mc-mr-vscode-'),
    GLMPS_AGY_CLI_DIR: tmp('mc-mr-agy-'),
    GLMPS_CODEX_DIR: tmp('mc-mr-codex-'),
    GLMPS_COPILOT_CLI_DIR: tmp('mc-mr-copilot-'),
    GLMPS_HERMES_DIR: tmp('mc-mr-hermes-'),
    GLMPS_OPENCODE_DIR: tmp('mc-mr-opencode-'),
    ...extra,
  };
}

test('POST /api/plugins/model/v1/chat/completions rejects fast with GLMPS_MODEL_RUNNER=off, no real spawn', async () => {
  const stateDir = tmp('mc-model-runner-off-route-');
  const env = isolatedEnv(stateDir);
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const start = Date.now();
    const r = await fetch(`http://127.0.0.1:${h.port}/api/plugins/model/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const elapsedMs = Date.now() - start;
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.match(body.error, /GLMPS_MODEL_RUNNER=off/);
    // A real `claude -p` cold start takes well over a second; this must
    // reject before ever reaching spawn.
    assert.ok(elapsedMs < 1000, `expected a fast rejection, took ${elapsedMs}ms`);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('finalize with real events under GLMPS_MODEL_RUNNER=off never spawns claude; the judge failure bumps the retry job, no verdict recorded', async () => {
  const stateDir = tmp('mc-model-runner-off-finalize-');
  const env = isolatedEnv(stateDir);
  // idleMs:0 makes the upserted judge.session job due immediately, so a
  // single manually-triggered plugin-retry loop run (below) is deterministic
  // instead of waiting the real 20-minute default.
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: { judge: { idleMs: 0 } } }));
  const h = await startServer({ port: 0, env, configFile });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const otlp = {
      resourceSpans: [{
        resource: { attributes: [] },
        scopeSpans: [{
          spans: [{
            attributes: [
              { key: 'session.id', value: { stringValue: 'norunner' } },
              { key: 'gen_ai.tool.name', value: { stringValue: 'Bash' } },
            ],
            startTimeUnixNano: String(Date.now() * 1e6),
          }],
        }],
      }],
    };
    const ingest = await fetch(base + '/api/otel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp),
    });
    assert.equal(ingest.status, 200);

    const fin = await fetch(base + '/api/outcomes/finalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'otel:norunner' }),
    });
    assert.equal(fin.status, 200);
    // The judge.session job is due (idleMs:0): the plugin-retry loop (K Task
    // 6) picks it up, the judge call fails under GLMPS_MODEL_RUNNER=off, and
    // the job is bumped for a later attempt. Fix round 1, I5: the tick
    // itself FAILS whenever anything was bumped, naming the job's own
    // reason - the alert stays up for the whole outage.
    const retryResult = await h.loopRegistry.runNow('plugin-retry');
    assert.equal(retryResult.outcome, 'failed');
    assert.match(retryResult.reason, /judge\.session/);

    // No verdict was ever recorded - the model was never called.
    const verdicts = await (await fetch(base + '/api/judge/verdicts')).json();
    assert.deepEqual(verdicts.verdicts, []);

    // the failure is not just an internal outcome
    // string - it must actually reach the operator-visible alert center, as
    // a visible (unacknowledged) alert whose own detail names the real
    // cause (GLMPS_MODEL_RUNNER=off), not just "judge.session" or some other
    // generic wrapper text.
    const alertsBody = await (await fetch(base + '/api/alerts')).json();
    const hit = (alertsBody.alerts || []).find((a) => /GLMPS_MODEL_RUNNER=off/.test(a.detail || ''));
    assert.ok(hit, `expected a visible alert naming GLMPS_MODEL_RUNNER=off, got: ${JSON.stringify(alertsBody.alerts)}`);
    assert.equal(hit.acknowledged, false, 'a fresh failure must not already read as acknowledged');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

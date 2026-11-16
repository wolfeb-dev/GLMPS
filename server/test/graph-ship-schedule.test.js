// graphify plan task 14 (card glmps-2-0-103): the version tick runs once
// after boot, the rebuild tick builds a ship root's first graph, and the ship
// graph is merged after a rebuild that updated a ship root or when none exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { REPO_ROOT } from '../lib/paths.js';
import { waitFor } from './helpers/wait-for.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const k = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function mkEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ship-sched-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  const corpus = path.join(base, 'corpus');
  fs.mkdirSync(corpus);
  execFileSync('git', ['init', '-q', corpus], { windowsHide: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [] } }));
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ graph: { ship: { corpusRoot: corpus } } }));
  const stateDir = path.join(base, 'state');
  return {
    corpus, configFile, stateDir,
    shipDir: path.join(stateDir, 'graphs', 'ship'),
    healthFile: path.join(stateDir, 'state', 'graph-sync-health.json'),
    markerFile: path.join(stateDir, 'state', 'graphify-pending-rollback.json'),
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: stateDir,
           GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(base, 'agy-cli'), GLMPS_CODEX_DIR: path.join(base, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(base, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(base, 'opencode') },
  };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function versionOverrides(extra = {}) {
  return {
    graphifyVersion: async () => '0.9.95',
    latestGraphifyVersion: async () => '0.9.95',
    runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...extra,
  };
}

test('the version tick runs once after boot and clears a stale marker for the pinned version', async () => {
  const e = mkEnv();
  fs.mkdirSync(path.dirname(e.markerFile), { recursive: true });
  fs.writeFileSync(e.markerFile, JSON.stringify({ prior: '0.9.90', candidate: '0.9.95', ts: Date.now() }));
  const srv = await startServer({
    port: 0, pollMs: 100000, env: e.env, configFile: e.configFile,
    graphifyVersionOverrides: versionOverrides({ bootDelayMs: 10 }),
  });
  try {
    await waitFor(() => !fs.existsSync(e.markerFile), { message: 'boot tick cleared the marker' });
  } finally { await srv.close(); }
});

test('without a named boot delay a test server never runs the version tick at boot', async () => {
  const e = mkEnv();
  fs.mkdirSync(path.dirname(e.markerFile), { recursive: true });
  fs.writeFileSync(e.markerFile, JSON.stringify({ prior: '0.9.90', candidate: '0.9.95', ts: Date.now() }));
  const srv = await startServer({
    port: 0, pollMs: 100000, env: e.env, configFile: e.configFile,
    graphifyVersionOverrides: versionOverrides(),
  });
  try {
    // A quiet period: the assertion is that nothing happens.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(e.markerFile), 'marker untouched');
  } finally { await srv.close(); }
});

test('the rebuild tick builds the corpus ship root first graph, then the ship graph when none exists', async () => {
  const e = mkEnv();
  const spawned = [];
  const builds = [];
  const srv = await startServer({
    port: 0, pollMs: 100000, env: e.env, configFile: e.configFile,
    spawnGraphifyUpdate: async (root) => { spawned.push(k(root)); return { code: 0, stdout: 'Rebuilt: 12 nodes', stderr: '' }; },
    buildShipGraphFn: async (opts) => { builds.push(opts); return { nodes: 24 }; },
  });
  try {
    await srv.graphRebuildTick();
    assert.ok(spawned.includes(k(e.corpus)), `corpus first build: ${JSON.stringify(spawned)}`);
    assert.equal(builds.length, 1);
    assert.equal(k(builds[0].kernelRoot), k(REPO_ROOT));
    assert.equal(k(builds[0].corpusRoot), k(e.corpus));
    assert.equal(builds[0].skipUpdate, true, 'the tick already updated both roots');
    assert.equal(k(builds[0].shipDir), k(e.shipDir));
    const h = readJson(e.healthFile)['graphify-ship@build'];
    assert.equal(h.outcome, 'updated');
  } finally { await srv.close(); }
});

test('with a ship graph on disk the merge waits for a ship root update; a failed build reaches health', async () => {
  const e = mkEnv();
  fs.writeFileSync(e.configFile, JSON.stringify({ graph: { ship: { corpusRoot: e.corpus } }, graphRebuild: { minIntervalMs: 0 } }));
  fs.mkdirSync(e.shipDir, { recursive: true });
  fs.writeFileSync(path.join(e.shipDir, 'ship-manifest.json'), JSON.stringify({ builtAt: '2026-10-29T00:00:00.000Z' }));
  let stdout = 'No code-graph topology changes detected';
  const builds = [];
  const srv = await startServer({
    port: 0, pollMs: 100000, env: e.env, configFile: e.configFile,
    spawnGraphifyUpdate: async () => ({ code: 0, stdout, stderr: '' }),
    buildShipGraphFn: async (opts) => { builds.push(opts); throw new Error('ship graph labels failed: 1 node(s) lost their curated community label'); },
  });
  try {
    await srv.graphRebuildTick();
    assert.equal(builds.length, 0, 'no-op rebuild and a ship graph on disk: nothing to merge');

    stdout = 'Rebuilt: 12 nodes';
    await srv.graphRebuildTick();
    assert.equal(builds.length, 1, 'a ship root update triggers the merge');
    const h = readJson(e.healthFile)['graphify-ship@build'];
    assert.equal(h.outcome, 'failed');
    assert.match(h.reason, /curated community label/);
  } finally { await srv.close(); }
});

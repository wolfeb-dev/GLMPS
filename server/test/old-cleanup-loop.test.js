// Card glmps-2-0-runtime-127: the old-cleanup loop is the only actor that
// deletes, and every deletion lands on the event spine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { startServer } from '../server.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp(pfx) { return fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot(), pfx))); }
function rmBestEffort(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* Windows EPERM */ } }

async function boot(stateDir, config) {
  const claudeDir = tmp('mc-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: tmp('mc-assets-'), GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  return { h, cleanup: async () => { await h.close?.(); rmBestEffort(stateDir); rmBestEffort(claudeDir); } };
}

test('old-cleanup is off in a test process unless config turns it on', async () => {
  const s = await boot(tmp('mc-state-'), {});
  try {
    assert.equal(s.h.loopRegistry.snapshot()['old-cleanup'], undefined);
  } finally { await s.cleanup(); }
});

test('old-cleanup deletes an aged .old in a tracked repo, records it on the spine, and its checker passes', async () => {
  const repo = tmp('mc-oldloop-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, 'a.txt.old'), 'x');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'x');
  const dir = tmp('mc-state-');
  // Past the baseline run, which would otherwise exempt a.txt.old.
  fs.writeFileSync(path.join(dir, 'old-cleanup.json'), JSON.stringify({ seen: {}, refused: {}, baseline: {} }));
  const s = await boot(dir, { oldCleanup: { enabled: true, roots: [repo], maxAgeMs: 0, everyMs: 24 * 3_600_000 } });
  try {
    const first = await s.h.loopRegistry.runNow('old-cleanup');
    assert.equal(first.outcome, 'done', JSON.stringify(first));
    assert.ok(!fs.existsSync(path.join(repo, 'a.txt.old')));
    assert.ok(fs.existsSync(path.join(repo, 'keep.txt')));
    const ev = readSpineEvents(dir, { kind: SPINE_KINDS.CLEANUP_OLD_DELETED });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.path, path.join(repo, 'a.txt.old'));
    assert.equal(ev[0].actor, 'old-cleanup');
    const second = await s.h.loopRegistry.runNow('old-cleanup');
    assert.equal(second.outcome, 'nothing-to-do');
  } finally { await s.cleanup(); rmBestEffort(repo); }
});

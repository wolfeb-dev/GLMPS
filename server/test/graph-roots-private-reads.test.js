import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '../server.js';

// Card glmps-2-0-runtime-68 AC-4: root discovery read the private-dirs file
// once per session cwd. With ~2,200 sessions on the live box that was a
// 330-450 ms stall on every worktree sweep; the list is now read once per call.
test('project root discovery reads the private-dirs file once per call, not once per session', async () => {
  const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  const openRepo = tmp('mc-openrepo-');
  const privateRepo = tmp('mc-privaterepo-');
  for (const r of [openRepo, privateRepo]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
  const privateDirsFile = path.join(stateDir, 'private-dirs.json');
  fs.writeFileSync(privateDirsFile, JSON.stringify({ private: [privateRepo.replace(/\\/g, '/')] }));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const sessions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, tool: 'claude-code', cwd: i % 2 ? openRepo : privateRepo, lastTs: Date.now() }));
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'), JSON.stringify(sessions));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_PRIVATE_DIRS_FILE: privateDirsFile, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(privateDirsFile)) reads++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/projects`)).json();
    const keys = body.projects.map((p) => p.key);
    assert.ok(keys.includes(path.basename(openRepo)), `open repo listed (keys=${keys.join(',')})`);
    assert.ok(!keys.includes(path.basename(privateRepo)), 'private repo still excluded');
    assert.ok(reads > 0 && reads < 20, `private-dirs file read ${reads} times for 200 sessions`);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
    await h.close?.();
    for (const d of [stateDir, claudeDir, openRepo, privateRepo]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

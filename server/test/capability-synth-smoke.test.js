// server/test/capability-synth-smoke.test.js
// Smoke test for scripts/capability-synth.mjs. Its job is to catch the failure
// that shipped undetected through the pillar reorg: a stale dynamic-import path
// crashing the script at module load - before it processes anything or writes
// its watermark. Nothing exercised the script's real import chain end to end
// (only its pure helpers had unit tests), so the breakage was invisible.
//
// The script runs its whole sweep at module load (top-level await, no exports),
// so we run it as a child process rather than importing it, pointing
// GLMPS_STATE_DIR / GLMPS_PROJECTS_DIR at throwaway dirs so the real learning store
// is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'capability-synth.mjs');

test('capability-synth.mjs runs end-to-end and writes its watermark', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-synth-state-'));
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-synth-proj-'));

  // One minimal transcript so the extract/gap/upsert chain is actually invoked,
  // not merely imported. Content need not produce gaps; the script is fail-open
  // per line and per file, so this only needs to be valid JSONL in the expected
  // <projects>/<project>/<session>.jsonl layout.
  const proj = path.join(projectsDir, 'D--example');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'sess1.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: new Date(0).toISOString() }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }, timestamp: new Date(0).toISOString() }),
    ].join('\n') + '\n',
  );

  // --all forces a full scan regardless of watermark/mtime, so the transcript is
  // deterministically selected and the extract->detect->upsert->digest path runs.
  const res = spawnSync(process.execPath, [SCRIPT, '--all'], {
    env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_PROJECTS_DIR: projectsDir },
    encoding: 'utf-8',
  });

  try {
    assert.equal(res.status, 0, `script exited non-zero.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /synth: scanned \d+ transcript/, `unexpected stdout:\n${res.stdout}`);
    assert.match(res.stdout, /watermark updated/);

    const watermark = path.join(stateDir, 'learning', 'synth-watermark.json');
    assert.ok(fs.existsSync(watermark), 'watermark file was not written');
    const wm = JSON.parse(fs.readFileSync(watermark, 'utf-8'));
    assert.equal(typeof wm.lastRunMs, 'number');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

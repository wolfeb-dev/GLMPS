// glmps-76: the runner tick (worktree create/remove/reclaim) and
// ticket enrichment on POST /api/backlog run on the server's one event loop.
// A synchronous child process anywhere on those paths stalls every request for
// as long as git or graphify takes, which is what blew through the 5s
// keep-alive window in glmps-75. These modules must stay async.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'server.js',
  'lib/orchestration/queue-runner.js',
  'lib/orchestration/worktrees.js',
  'lib/orchestration/worktree-outcome.js',
  'lib/orchestration/test-write-guard.js',
  'lib/orchestration/ticket-enrich.js',
  'lib/orchestration/graphify-spawn.js',
];
const SYNC = /\b(execFileSync|spawnSync|execSync)\s*\(|import\s*\{[^}]*\b(execFileSync|spawnSync|execSync)\b[^}]*\}\s*from\s*['"](node:)?child_process['"]/;

function syncSubprocessLines(text) {
  return text.split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !line.trim().startsWith('//') && SYNC.test(line));
}

test('the matcher catches a sync call and a sync import but not a comment', () => {
  assert.equal(syncSubprocessLines("const r = execFileSync('git', []);").length, 1);
  assert.equal(syncSubprocessLines("import { spawn, spawnSync } from 'node:child_process';").length, 1);
  assert.equal(syncSubprocessLines('// used to run execFileSync(git) here').length, 0);
  assert.equal(syncSubprocessLines('const gz = zlib.gzipSync(json);').length, 0);
});

for (const rel of FILES) {
  test(`${rel} makes no synchronous subprocess call`, () => {
    const hits = syncSubprocessLines(fs.readFileSync(path.join(SERVER, rel), 'utf8'));
    assert.deepEqual(hits.map(({ n, line }) => `${rel}:${n}: ${line.trim()}`), []);
  });
}

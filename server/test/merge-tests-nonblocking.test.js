// Card glmps-2-0-runtime-68: the merge queue's test checkout is a whole repo,
// and rmSync's retries back off linearly on the event loop (10 x 200 ms is 11 s
// when Windows still holds a file the killed test process had open). Every
// delete in the merge-queue test stage must be the async one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'orchestration', 'merge-tests.js');

test('the merge-queue test stage never deletes its checkout synchronously', () => {
  const code = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /\brmSync\s*\(/);
  assert.match(code, /fs\.promises\.rm\(/);
});

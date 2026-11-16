// affected-tests: always
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// scripts.test passes an explicit glob ("**/*.test.js") to node --test. Glob
// support in node --test starts at Node 21, so the engines floor and the CI
// matrix must not include Node 20 once that glob is in place.

test('package.json engines.node floor is >=22.5 (node --test glob support starts at 21)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, '>=22.5');
});

test.skip('CI test job matrix runs node 22, 24 and 26, and does not run node 20', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const testJobMatch = yml.match(/\r?\n {2}test:\r?\n[\s\S]*?(?=\r?\n {2}smoke:)/);
  assert.ok(testJobMatch, 'expected a `test:` job block before `smoke:`');
  const nodeLine = testJobMatch[0].match(/node:\s*\[([^\]]+)\]/);
  assert.ok(nodeLine, 'expected a node version matrix array in the test job');
  const versions = nodeLine[1].split(',').map((s) => s.trim());
  assert.deepEqual(versions, ['22', '24', '26']);
});

test.skip('CI keeps a single Windows leg (on node 24), excluding windows for the other two versions', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const testJobMatch = yml.match(/\r?\n {2}test:\r?\n[\s\S]*?(?=\r?\n {2}smoke:)/);
  const testJob = testJobMatch[0];
  const excludeBlock = testJob.slice(testJob.indexOf('exclude:'));
  const windowsExcludedVersions = [...excludeBlock.matchAll(/os:\s*windows-latest\s*\n\s*node:\s*(\d+)/g)]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(windowsExcludedVersions, ['22', '26']);
});

// glmps-2-0-73: the merge queue already runs npm test on Windows before every
// merge, so the billed-x2 Windows leg runs on manual dispatch only.
test.skip('CI runs the Windows leg only on workflow_dispatch and cancels superseded runs', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const osLine = yml.match(/^\s*os:\s*(.+)$/m)[1];
  assert.match(osLine, /github\.event_name == 'workflow_dispatch' && '\["ubuntu-latest", "windows-latest"\]' \|\| '\["ubuntu-latest"\]'/);
  assert.match(yml, /concurrency:\s*\r?\n\s*group: ci-.*\r?\n\s*cancel-in-progress: true/);
  assert.doesNotMatch(yml, /\n {2}shell:/, 'the shell job lives in shell.yml');
});

// glmps-2-0-134: per-PR runs cost ~3x the monthly allowance and gate nothing,
// so every workflow runs nightly on the default branch and on demand only.
test.skip('no workflow runs per PR or per push: nightly schedule and workflow_dispatch only', () => {
  for (const name of ['ci.yml', 'shell.yml', 'tap.yml']) {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
    const on = yml.match(/^on:\r?\n((?: {2}.*\r?\n)+)/m);
    assert.ok(on, `${name}: expected an on: block`);
    const triggers = [...on[1].matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(triggers, ['schedule', 'workflow_dispatch'], name);
    assert.match(on[1], /- cron: '\d+ \d+ \* \* \*'/, `${name}: one daily cron`);
  }
});

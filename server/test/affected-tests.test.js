import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAffectedTests, affectedCommand, affectedCommands, MAX_COMMAND_CHARS } from '../lib/orchestration/affected-tests.js';

const SCRIPT = 'node --test --env-file=test.env --test-concurrency=4 "**/*.test.js"';
const sources = {
  'server/test/merge-queue.test.js': "import { x } from '../lib/orchestration/merge-queue.js';",
  'server/test/server-boot.test.js': "import { startServer } from '../server.js';",
  'server/test/styles.test.js': "const css = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');",
  'server/test/merge-queue-routes.test.js': "import { startServer } from '../server.js';\nimport { y } from './helpers/fake-gh.js';",
  'server/test/unrelated.test.js': "import { z } from '../lib/other.js'; // mentions merge-queue in a comment only",
};
const testFiles = Object.keys(sources);
const readFile = (f) => sources[f];

test('selectAffectedTests: a changed module selects the test files that name it, not the rest', () => {
  const r = selectAffectedTests({ changed: ['server/lib/orchestration/merge-queue.js'], testFiles, readFile });
  assert.equal(r.full, null);
  assert.deepEqual(r.files, ['server/test/merge-queue.test.js']);
});

test('selectAffectedTests: an import that cannot be read is not followed, so a missing module selects nothing through it', () => {
  const r = selectAffectedTests({ changed: ['server/lib/other.js'], testFiles, readFile });
  assert.deepEqual(r.files, ['server/test/unrelated.test.js']);
});

test('selectAffectedTests: a changed test file, a test helper and a fixture read by path are all followed', () => {
  const r = selectAffectedTests({
    changed: ['server/test/server-boot.test.js', 'server/test/helpers/fake-gh.js', 'web/styles.css'],
    testFiles, readFile,
  });
  assert.deepEqual(r.files, ['server/test/merge-queue-routes.test.js', 'server/test/server-boot.test.js', 'server/test/styles.test.js']);
});

test('selectAffectedTests: a deleted test file is not selected, and a docs-only change selects nothing', () => {
  assert.deepEqual(selectAffectedTests({ changed: ['server/test/gone.test.js'], testFiles, readFile }).files, []);
  assert.deepEqual(selectAffectedTests({ changed: ['docs/specs/x.md', 'README.md'], testFiles, readFile }).files, []);
});

test('selectAffectedTests: a test marked always-run joins every pick that touches a non-markdown file', () => {
  const src = {
    ...sources,
    'server/test/rule.test.js': "import x from 'y';\n// affected-tests: always\ntest('walks the tree', () => {});",
    'server/test/mention.test.js': "const s = 'not a marker: // affected-tests: always';",
  };
  const files = Object.keys(src);
  const read = (f) => src[f];
  const r = selectAffectedTests({ changed: ['server/lib/other.js'], testFiles: files, readFile: read });
  assert.deepEqual(r.files, ['server/test/rule.test.js', 'server/test/unrelated.test.js']);
  assert.deepEqual(selectAffectedTests({ changed: ['web/app.css'], testFiles: files, readFile: read }).files, ['server/test/rule.test.js']);
  assert.deepEqual(selectAffectedTests({ changed: ['docs/specs/x.md'], testFiles: files, readFile: read }).files, []);
  assert.deepEqual(selectAffectedTests({ changed: [], testFiles: files, readFile: read }).files, []);
  assert.ok(selectAffectedTests({ changed: ['package.json'], testFiles: files, readFile: read }).full);
});

test('the repo-invariant tests carry the always-run marker', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const shell = path.join(dir, '..', '..', 'apps', 'shell', 'test');
  const files = [
    ...['loop-registry', 'web-dom-util', 'plugin-boundary', 'fixed-sleep-ratchet', 'guard-apply-boundary', 'plugin-node-floor', 'loop-catalog',
      'ascii-source', 'cutover-deletions', 'state-dir-seam', 'vendor-budget', 'web-time-format-sweep', 'obligation-kinds'].map((n) => path.join(dir, `${n}.test.js`)),
    ...['no-file-protocol', 'no-kernel-ownership'].map((n) => path.join(shell, `${n}.test.js`)),
  ];
  for (const f of files) {
    assert.match(fs.readFileSync(f, 'utf8'), /^\/\/ affected-tests: always$/m, `${path.basename(f)} lacks the marker`);
  }
});

test('selectAffectedTests: package.json, the lockfile or test.env changes ask for the full suite', () => {
  for (const f of ['package.json', 'package-lock.json', 'test.env']) {
    const r = selectAffectedTests({ changed: ['server/lib/other.js', f], testFiles, readFile });
    assert.match(r.full, new RegExp(f.replace('.', '\\.')));
  }
});

test('selectAffectedTests: Windows separators and an unreadable test file do not throw', () => {
  const r = selectAffectedTests({
    changed: ['server\\lib\\orchestration\\merge-queue.js'],
    testFiles: [...testFiles, 'server/test/locked.test.js'],
    readFile: (f) => { if (f.includes('locked')) throw new Error('EBUSY'); return sources[f]; },
  });
  assert.deepEqual(r.files, ['server/test/merge-queue.test.js']);
});

test('selectAffectedTests: a change reached through an import chain selects the test (card glmps-2-0-179)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const r = selectAffectedTests({
    changed: ['apps/shell/src/lib/vendor-card.js'],
    testFiles: ['apps/shell/test/gitops-runner.test.js', 'server/test/merge-queue.test.js'],
    readFile: read,
  });
  assert.equal(r.full, null);
  assert.deepEqual(r.files, ['apps/shell/test/gitops-runner.test.js']);
});

test('selectAffectedTests: imports are followed transitively, without the extension, through cycles and within the bound', () => {
  const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/m${i}.js`, `import x from './m${i + 1}.js';`]));
  const src = {
    'test/deep.test.js': "import a from '../lib/a';",
    'lib/a.js': "export * from './b.js';\nconst c = await import('./c.mjs');",
    'lib/b.js': "import a from './a.js';\nimport fs from 'node:fs';\nimport pkg from 'some-pkg';",
    'lib/c.mjs': "const d = require('./d.cjs');",
    'lib/d.cjs': '',
    'test/far.test.js': "import x from '../lib/m0.js';",
    ...chain(40),
    'test/escape.test.js': "import x from '../../outside/target.js';",
  };
  const reads = [];
  const read = (f) => { reads.push(f); if (!(f in src)) throw new Error('ENOENT'); return src[f]; };
  const testFiles = ['test/deep.test.js', 'test/far.test.js', 'test/escape.test.js'];
  assert.deepEqual(selectAffectedTests({ changed: ['lib/d.cjs'], testFiles, readFile: read }).files, ['test/deep.test.js']);
  assert.deepEqual(selectAffectedTests({ changed: ['lib/b.js'], testFiles, readFile: read }).files, ['test/deep.test.js']);
  assert.deepEqual(selectAffectedTests({ changed: ['lib/m5.js'], testFiles, readFile: read }).files, ['test/far.test.js']);
  assert.deepEqual(selectAffectedTests({ changed: ['lib/m39.js'], testFiles, readFile: read }).files, [], 'past the depth bound');
  assert.ok(reads.length && reads.every((f) => !f.startsWith('..') && !f.startsWith('/')), 'never reads outside the repo');
});

test('affectedCommand swaps the trailing glob for the file list', () => {
  assert.equal(
    affectedCommand(SCRIPT, ['server/test/a.test.js', 'server/test/b.test.js']),
    'node --test --env-file=test.env --test-concurrency=4 server/test/a.test.js server/test/b.test.js',
  );
  assert.equal(affectedCommand("node --test '**/*.test.js'", ['a.test.js']), 'node --test a.test.js');
  assert.equal(affectedCommand('node --test test/**/*.test.js', ['a.test.js']), 'node --test a.test.js');
});

test('affectedCommand returns null for a script it cannot rewrite safely', () => {
  assert.equal(affectedCommand('jest', ['a.test.js']), null);
  assert.equal(affectedCommand('node --test', ['a.test.js']), null, 'no glob to replace');
  assert.equal(affectedCommand('node --test "**/*.test.js" && npm run lint', ['a.test.js']), null, 'the glob is not last');
  assert.equal(affectedCommand(SCRIPT, ['a "b".test.js']), null, 'a quote in a path');
  assert.equal(affectedCommand(SCRIPT, []), null);
});

test('affectedCommands splits a long list into commands under the length budget, every file once', () => {
  const many = Array.from({ length: 400 }, (_, i) => `server/test/some-fairly-long-test-name-${i}.test.js`);
  const cmds = affectedCommands(SCRIPT, many);
  assert.ok(cmds.length > 1);
  assert.ok(cmds.every((c) => c.length <= MAX_COMMAND_CHARS && c.startsWith('node --test --env-file=test.env --test-concurrency=4 ')));
  const named = cmds.flatMap((c) => c.split(' ').filter((t) => t.endsWith('.test.js')));
  assert.deepEqual(named, many);
  assert.equal(affectedCommand(SCRIPT, many), null, 'the single-command form refuses a split list');
  assert.deepEqual(affectedCommands(SCRIPT, ['a.test.js']), ['node --test --env-file=test.env --test-concurrency=4 a.test.js']);
  assert.equal(affectedCommands('jest', ['a.test.js']), null);
  assert.ok(MAX_COMMAND_CHARS < 8191);
});

// Mirror of validTestCommand in apps/shell/src/lib/gitops-allow.js: core may
// not import the shell, so a change to that rule must be copied here.
const SHELL_TEST_TOKEN = /^[A-Za-z0-9_.=:@*/-]+$/;
const SHELL_CODE_FLAGS = /^(--import|--require|-r|--eval|-e|-p|--print|--loader|--experimental-loader)\b/;
const shellAllows = (command) => {
  const m = /^(?:(?:npm|pnpm|yarn)(?: run)? test|node --test)((?: \S+)*)$/.exec(command);
  if (!m) return false;
  return m[1].split(' ').filter(Boolean)
    .every((t) => SHELL_TEST_TOKEN.test(t) && !t.startsWith('/') && !t.includes('..') && !SHELL_CODE_FLAGS.test(t));
};

test('every narrowed command passes the desktop shell test-command rule (no quoted paths)', () => {
  const many = Array.from({ length: 400 }, (_, i) => `server/test/some-fairly-long-test-name-${i}.test.js`);
  const lists = [['server/test/a.test.js'], ['server/test/a.test.js', 'apps/shell/test/gitops-e2e.test.js'], many];
  for (const script of [SCRIPT, "node --test '**/*.test.js'", 'node --test test/**/*.test.js']) {
    for (const files of lists) {
      const cmds = affectedCommands(script, files);
      assert.ok(cmds?.length, `narrowed ${script}`);
      for (const c of cmds) assert.ok(shellAllows(c), `shell refuses: ${c.slice(0, 120)}`);
      assert.deepEqual(cmds.flatMap((c) => c.split(' ').filter((t) => t.endsWith('.test.js'))), files);
    }
  }
  assert.deepEqual(affectedCommands(SCRIPT, ['server/test/a.test.js']), ['node --test --env-file=test.env --test-concurrency=4 server/test/a.test.js']);
});

test('a path the shell cannot take unquoted yields no narrowed command, so the stage runs the full suite', () => {
  for (const bad of ['server/test/has space.test.js', 'server/test/a+b.test.js', '/abs/a.test.js', '../up.test.js', 'server/test/(x).test.js']) {
    assert.equal(affectedCommands(SCRIPT, ['server/test/ok.test.js', bad]), null, bad);
  }
  assert.equal(affectedCommands('node  --test --env-file=test.env "**/*.test.js"', ['a.test.js']), null, 'a prefix the shell refuses');
});

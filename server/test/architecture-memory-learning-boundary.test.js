// Static boundary guard (glmps-81, substrate refactor Phase 1 - "decouple
// memory from learning"). The learning loop (gap-detect -> rule-synth ->
// learning-apply) must read RAW events only, never the session-memory
// distiller's condensed/summarized output. This test never imports or
// executes any of the guarded modules - it reads their SOURCE TEXT off disk
// and greps for an actual import/require of the two distiller modules that
// must stay off-limits. Cheap and durable: it catches the regression even if
// someone adds the forbidden import inside a branch that unit tests never
// execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Files whose source must never import the distiller's condensed-facts layer.
const GUARDED_FILES = [
  path.join(repoRoot, 'server', 'lib', 'observability', 'gap-detect.js'),
  path.join(repoRoot, 'server', 'lib', 'observability', 'correction-signals.js'),
  path.join(repoRoot, 'server', 'lib', 'evaluation', 'rule-synth.js'),
  path.join(repoRoot, 'server', 'lib', 'evaluation', 'learning-apply.js'),
];

// Modules the learner must never read from (the memory/retrieval layer).
const FORBIDDEN_MODULES = ['memory-distill-core', 'memory-writer'];

// Matches only an actual ES import / dynamic import() / CJS require() of a
// module path ending in one of the forbidden basenames - NOT a comment or
// prose string that merely mentions the filename (gap-detect.js documents
// this very boundary in a comment, so a naive substring search would
// false-positive on its own documentation).
function importsForbiddenModule(source, moduleBasename) {
  const escaped = moduleBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const specifier = `[^'"\`]*${escaped}(?:\\.js)?`;
  const re = new RegExp(
    `(?:from\\s+['"\`]${specifier}['"\`])` +
    `|(?:import\\(\\s*['"\`]${specifier}['"\`]\\s*\\))` +
    `|(?:require\\(\\s*['"\`]${specifier}['"\`]\\s*\\))`
  );
  return re.test(source);
}

for (const file of GUARDED_FILES) {
  const rel = path.relative(repoRoot, file);

  test(`${rel} exists and is readable`, () => {
    assert.ok(fs.existsSync(file), `expected ${rel} to exist`);
  });

  for (const forbidden of FORBIDDEN_MODULES) {
    test(`${rel} does not import ${forbidden}.js`, () => {
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(
        importsForbiddenModule(source, forbidden),
        false,
        `${rel} must never import ${forbidden}.js \u2014 the learning loop reads raw events only, ` +
        `never the memory distiller's condensed facts (see the boundary comment in gap-detect.js)`
      );
    });
  }
}

// Sanity check on the guard itself: prove the regex actually fires on a real
// import shape, so a typo in the pattern can't silently make every case above
// pass for the wrong reason.
test('importsForbiddenModule detects a real import (regex self-check)', () => {
  const fakeEs = `import { distill } from '../evaluation/memory-distill-core.js';\n`;
  const fakeRequire = `const { stageProposal } = require('./memory-writer.js');\n`;
  const fakeDynamic = `await import('../evaluation/memory-distill-core.js');\n`;
  assert.equal(importsForbiddenModule(fakeEs, 'memory-distill-core'), true);
  assert.equal(importsForbiddenModule(fakeRequire, 'memory-writer'), true);
  assert.equal(importsForbiddenModule(fakeDynamic, 'memory-distill-core'), true);

  // A comment merely mentioning the filename must NOT trip the guard (this is
  // exactly the shape gap-detect.js's boundary documentation uses).
  const justAComment = `// This must never import memory-distill-core.js or memory-writer.js.\n`;
  assert.equal(importsForbiddenModule(justAComment, 'memory-distill-core'), false);
  assert.equal(importsForbiddenModule(justAComment, 'memory-writer'), false);
});

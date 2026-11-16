// server/lib/governance/full-suite-guard.js
//
// F3 (card glmps-2-0-runtime-98): a runner session runs only the tests its
// change touches. Concurrent agent full-suite runs were what pushed the merge
// queue past its 30-minute ceiling on 2026-10-28 (C2 and C3 in
// <repo>\merge-queue-bottleneck-2026-10-29.md); the full suite runs once,
// batched on the base, instead. Pure: a tokenized simple command in, a verdict
// out. checkRoleCommand applies it only to role sessions, so an operator
// session is never blocked.

export const AFFECTED_TESTS_COMMAND = 'node scripts/affected-tests.mjs';

const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// node flags whose value is the next token when not written as --flag=value.
const NODE_FLAG_VALUES = new Set([
  '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-reporter', '--test-reporter-destination',
  '--test-shard', '--test-timeout', '--env-file', '--import', '--require', '-r', '--loader', '--experimental-loader',
  '--conditions', '-C', '--test-coverage-include', '--test-coverage-exclude',
]);

const isRecursiveGlob = (t) => /^(\.\/)?\*\*/.test(t);

/** True when the simple command runs the whole test suite. */
export function isFullSuiteRun(tokens) {
  const [prog, ...rest] = Array.isArray(tokens) ? tokens : [];
  if (PKG_MANAGERS.has(prog)) {
    // Arguments to `npm test` are appended to the script, whose glob still
    // matches every test file, so any form of it is the full suite.
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === 'test' || sub === 't' || sub === 'tst') return true;
    if (sub === 'run' || sub === 'run-script') {
      const name = rest.slice(rest.indexOf(sub) + 1).find((t) => !t.startsWith('-'));
      return name === 'test';
    }
    return false;
  }
  if (prog !== 'node') return false;
  if (!rest.some((t) => t === '--test' || t.startsWith('--test='))) return false;
  const files = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t.startsWith('-')) {
      if (NODE_FLAG_VALUES.has(t)) i += 1;
      continue;
    }
    files.push(t);
  }
  return !files.length || files.every(isRecursiveGlob);
}

export const FULL_SUITE_REASON = 'session may not run the full test suite: the merge queue tests each PR with the tests it affects and runs the full suite batched on the base. '
  + `Run the tests your change touches instead: ${AFFECTED_TESTS_COMMAND} (add --print to see the command first), or node --test with the test files named.`;

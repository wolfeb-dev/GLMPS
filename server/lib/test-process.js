// server/lib/test-process.js
// The one shared "is this a test run?" predicate. Every place that must refuse real operator state in
// a test process asks here, so the signals stay identical everywhere:
// paths.js (adapter, claude, state, assets and memory dir defaults),
// claude-model.js (the last guard before a real `claude -p` spawn) and
// scripts/install-hooks-lib.mjs (the installer's home-fallback backstop).
// The Slack branch's test-write guard (and, through its re-export, the
// archived-channel migration script) use it too.
//
// True when ANY of three independent signals is present:
//   - NODE_TEST_CONTEXT: node --test's own per-child-process marker. Checked
//     on the real ambient process.env (covers a server-booting test that
//     builds its env as a bare literal, never spreading process.env) AND on
//     the injected `env` (a caller that sets it explicitly, or a pure test
//     of this predicate).
//   - GLMPS_TEST === '1': test.env sets this, loaded via --env-file by every
//     `npm test` run; checked the same two ways.
//   - argv[1] matching a *.test.js/.mjs file: a direct `node x.test.js` run
//     outside node --test's own child-process wrapping.
// `processEnv`/`argv` are injectable so a test can drive every branch as a
// pure function without depending on its own real process state.
export function isTestProcess({ env = {}, processEnv = process.env, argv = process.argv } = {}) {
  return !!(
    env?.NODE_TEST_CONTEXT || processEnv?.NODE_TEST_CONTEXT ||
    env?.GLMPS_TEST === '1' || processEnv?.GLMPS_TEST === '1' ||
    /\.test\.m?js$/.test(argv?.[1] ?? '')
  );
}

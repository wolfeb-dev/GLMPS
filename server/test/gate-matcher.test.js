// Tests for the approval-gate matcher (glmps-29). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldGate } from '../lib/orchestration/gate-matcher.js';

const OFF = { enabled: false, paths: [] };
const ON = { enabled: true, paths: [] };
const LIVE = { enabled: true, paths: ['D:/live-install'], includeBash: true };

test('gates OFF by default: even a configured path is not gated', () => {
  // Default-off is deliberate: a false gate stalls an AFK job for the whole
  // hook budget, which trains the operator to switch the feature off entirely.
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/live-install/x.dll' }, cwd: 'D:/repo', config: OFF });
  assert.equal(r.gated, false);
});

test('an ordinary dev-file write is not gated even with gates on', () => {
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/repo/server/lib/x.js' }, cwd: 'D:/repo', config: ON });
  assert.equal(r.gated, false);
});

test('a write into a configured path is gated and names the file', () => {
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/live-install/bin/a.dll' }, cwd: 'D:/repo', config: LIVE });
  assert.equal(r.gated, true);
  assert.match(r.summary, /a\.dll/);
  assert.ok(r.why);
});

test('Edit and MultiEdit are gated on the same rule as Write', () => {
  for (const tool of ['Edit', 'MultiEdit']) {
    assert.equal(shouldGate({ tool, toolInput: { file_path: 'D:/live-install/x' }, cwd: 'D:/r', config: LIVE }).gated, true, tool);
  }
});

test('a Bash command naming a configured path is gated', () => {
  const r = shouldGate({ tool: 'Bash', toolInput: { command: 'cp build/x.dll D:/live-install/bin/' }, cwd: 'D:/r', config: LIVE });
  assert.equal(r.gated, true);
});

test('a Bash command touching nothing configured is not gated', () => {
  assert.equal(shouldGate({ tool: 'Bash', toolInput: { command: 'npm test' }, cwd: 'D:/r', config: LIVE }).gated, false);
});

test('a read-only tool is never gated', () => {
  for (const tool of ['Read', 'Grep', 'Glob']) {
    assert.equal(shouldGate({ tool, toolInput: { file_path: 'D:/live-install/x' }, cwd: 'D:/r', config: LIVE }).gated, false, tool);
  }
});

test('path matching is case- and separator-insensitive (Windows)', () => {
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: String.raw`d:\LIVE-INSTALL\bin\a.dll` }, cwd: 'D:/r', config: LIVE });
  assert.equal(r.gated, true);
});

test('a sibling directory with the configured path as a name PREFIX is not gated', () => {
  // 'D:/live-install-backup' must not match 'D:/live-install': prefix matching
  // has to respect the path boundary or the gate fires on unrelated trees.
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/live-install-backup/a.dll' }, cwd: 'D:/r', config: LIVE });
  assert.equal(r.gated, false);
});

test('a path in a prod zone is gated by zone classification alone, with no configured paths', () => {
  // The second source of "risky" (zones.js protectedSegments: any 'prod' dir
  // segment). Reused rather than reinvented so the codebase has ONE definition
  // of prod. Without this case the whole classifyPath branch is untested.
  const r = shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/repo/prod/deploy.js' }, cwd: 'D:/repo', config: ON });
  assert.equal(r.gated, true);
  assert.match(r.why, /prod zone/);
});

test('a malformed tool input never throws and never gates', () => {
  assert.equal(shouldGate({ tool: 'Write', toolInput: null, cwd: null, config: ON }).gated, false);
  assert.equal(shouldGate({}).gated, false);
});

test('a missing config is treated as gates off', () => {
  assert.equal(shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/live-install/x' }, cwd: 'D:/r' }).gated, false);
});

//
// Found in production the moment gates were first switched on: a read-only
// `curl` whose JSON body happened to contain a prod path was gated and the
// caller blocked for the full 9-minute budget. Bash has no structured target,
// so the first version matched the raw command text, which means every grep,
// echo, curl or comment that NAMES a prod path stalls an agent.
//
// Cost asymmetry decides this. A false gate is near-certain (paths get
// mentioned constantly) and costs 9 minutes plus the operator's trust in the
// feature. A missed gate needs a mutating command the matcher failed to
// recognise, and live-install-guard covers that layer separately. So Bash gates
// only when a MUTATION indicator appears alongside the path.

const LIVE2 = { enabled: true, paths: ['D:/glmps_prod'], includeBash: true };

test('Bash: merely naming a prod path does not gate (the production false positive)', () => {
  const cmds = [
    `curl -X POST http://127.0.0.1:8123/api/x -d '{"summary":"Write D:/glmps_prod/probe"}'`,
    'grep -rn "foo" D:/glmps_prod',
    'ls -la D:/glmps_prod',
    'echo "deploying to D:/glmps_prod later"',
    'cat D:/glmps_prod/README.md',
    'git -C D:/glmps_prod status',
  ];
  for (const command of cmds) {
    assert.equal(shouldGate({ tool: 'Bash', toolInput: { command }, cwd: 'D:/r', config: LIVE2 }).gated, false, command);
  }
});

test('Bash: a mutating command targeting a prod path DOES gate', () => {
  const cmds = [
    'cp build/x.dll D:/glmps_prod/bin/',
    'mv a.txt D:/glmps_prod/',
    'rm -rf D:/glmps_prod/old',
    'echo hi > D:/glmps_prod/f.txt',
    'cat a >> D:/glmps_prod/f.txt',
    'tee D:/glmps_prod/f.txt',
    'robocopy src D:/glmps_prod',
    'xcopy src D:/glmps_prod',
    'rsync -a src/ D:/glmps_prod/',
    'install -m 644 a D:/glmps_prod/a',
  ];
  for (const command of cmds) {
    assert.equal(shouldGate({ tool: 'Bash', toolInput: { command }, cwd: 'D:/r', config: LIVE2 }).gated, true, command);
  }
});

test('Bash: a mutating verb with no prod path does not gate', () => {
  assert.equal(shouldGate({ tool: 'Bash', toolInput: { command: 'cp a.txt b.txt' }, cwd: 'D:/r', config: LIVE2 }).gated, false);
  assert.equal(shouldGate({ tool: 'Bash', toolInput: { command: 'rm -rf node_modules' }, cwd: 'D:/r', config: LIVE2 }).gated, false);
});

test('Bash: the gate summary names the command so the operator can judge it', () => {
  const r = shouldGate({ tool: 'Bash', toolInput: { command: 'cp x.dll D:/glmps_prod/bin/' }, cwd: 'D:/r', config: LIVE2 });
  assert.match(r.summary, /cp x\.dll/);
  assert.match(r.why, /glmps_prod/);
});

test('Write/Edit are unaffected: a structured target still gates on the path alone', () => {
  // File tools declare exactly what they touch, so no verb heuristic is needed
  // or wanted there. Only Bash is free text.
  assert.equal(shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/glmps_prod/x' }, cwd: 'D:/r', config: LIVE2 }).gated, true);
});

//
// Even with the mutation-verb requirement, Bash matching is a guess against
// free text: `grep foo D:/prod > /tmp/out` still reads as a write. Once a gate
// can wait for hours instead of minutes, a false positive stops costing nine
// minutes and starts costing "until someone notices", so the guessy matcher
// must be something you turn ON, not something you inherit. Write and Edit
// declare exactly what they touch and stay on.

const BASH_ON = { enabled: true, paths: ['D:/glmps_prod'], includeBash: true };
const BASH_OFF = { enabled: true, paths: ['D:/glmps_prod'] };

test('Bash is NOT gated unless includeBash is set', () => {
  const r = shouldGate({ tool: 'Bash', toolInput: { command: 'cp x.dll D:/glmps_prod/bin/' }, cwd: 'D:/r', config: BASH_OFF });
  assert.equal(r.gated, false, 'the guessy matcher is opt-in');
});

test('Bash IS gated when includeBash is set', () => {
  const r = shouldGate({ tool: 'Bash', toolInput: { command: 'cp x.dll D:/glmps_prod/bin/' }, cwd: 'D:/r', config: BASH_ON });
  assert.equal(r.gated, true);
});

test('includeBash still requires a mutation verb', () => {
  const r = shouldGate({ tool: 'Bash', toolInput: { command: 'grep -rn foo D:/glmps_prod' }, cwd: 'D:/r', config: BASH_ON });
  assert.equal(r.gated, false);
});

test('Write and Edit gate with includeBash off: precise tools are always on', () => {
  assert.equal(shouldGate({ tool: 'Write', toolInput: { file_path: 'D:/glmps_prod/a' }, cwd: 'D:/r', config: BASH_OFF }).gated, true);
  assert.equal(shouldGate({ tool: 'Edit', toolInput: { file_path: 'D:/glmps_prod/a' }, cwd: 'D:/r', config: BASH_OFF }).gated, true);
});

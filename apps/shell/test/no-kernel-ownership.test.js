// affected-tests: always
// D26: the kernel is never a child of Electron and quitting the shell never
// stops it. Structural guard: one file may touch child_process, and it only
// ever builds `sc.exe start <name>`. The one exception (glmps-2-0-59) is
// kernel-host.js, which runs the BUNDLED kernel on a machine with no service,
// and is pinned below to exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

// A bare or method-call exec/execFile/spawn/fork, the literal module name
// child_process, or Electron's utilityProcess (its own way to fork a child
// process, D26's other bypass route) flags a file as touching a child
// process. The dot exemption applies to `exec` only: `pattern.exec(text)` is
// RegExp.prototype.exec, but `child.spawn(...)`, `cp.fork(...)` and
// `utilityProcess.fork(...)` are all still genuine child-process calls and
// must still be caught even as a method call (fix round 2, defect 1: the
// round 1 lookbehind wrongly covered spawn/fork/execFile too).
const CHILD_PROCESS_RE = /child_process|utilityProcess|(?<!\.)\bexec\(|\bexecFile\(|\bspawn\(|\bfork\(/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(m?js|cjs)$/.test(e.name)) yield p;
  }
}

function scanForChildProcess(dir, { except = [] } = {}) {
  const offenders = [];
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f).replaceAll('\\', '/');
    if (except.includes(rel)) continue;
    if (CHILD_PROCESS_RE.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel);
  }
  return offenders;
}

// Task 12b: the launch runner is the desktop shell's half of the launch
// queue (server/lib/orchestration/launch-broker.js) - it is the ONE other
// file allowed to start a process, and only ever to open the terminal a
// queued launch asked for (checked below), never the kernel and never
// sc.exe.
// The agy runner is the third: it runs one agy model call per queued 'agy'
// record in the operator's session (the service cannot hold the operator's
// sign-in), and taskkill for that call's own process tree on a timeout.
// The gitops runner is the fourth: it runs the git, gh and test operations the
// merge queue queued, each only after gitops-allow.js accepted it.
// The vendor session (card glmps-2-0-162) runs in a card's Antigravity tab, not
// in the desktop app: it starts the vendor CLI (agy, codex) it is handed
// through an injected spawn, with the argv fixed in vendor-card.js.
test('only service-control.js, launch-runner.js, agy-runner.js, gitops-runner.js, editor-runner.js, setup/actions.js, kernel-host.js and vendor-session.js may start processes', () => {
  assert.deepEqual(scanForChildProcess(SRC, { except: ['lib/service-control.js', 'lib/launch-runner.js', 'lib/agy-runner.js', 'lib/gitops-runner.js', 'lib/editor-runner.js', 'lib/kernel-host.js', 'lib/setup/actions.js', 'lib/vendor-session.js'] }), []);
});

// Card glmps-2-0-runtime-12: the node is the bundled one or the absolute
// kernelNode from settings (checkoutKernel), never one resolved from PATH.
test('the kernel host starts only node on the kernel server entry, and taskkill for its own child: never sc.exe, a shell or a command from a record', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'kernel-host.js'), 'utf8');
  assert.doesNotMatch(text, /process\.execPath|sc\.exe|shell:\s*true|terminalRecipe|utilityProcess|\bfork\(/);
  const spawned = [...text.matchAll(/\b(?:spawn|spawnImpl)\(\s*([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(spawned, ["'taskkill'", 'nodePath']);
  assert.match(text, /const nodePath = nodeOverride \?\? path\.join\(kernelDir, 'node\.exe'\);/);
  assert.match(text, /const entry = path\.join\(kernelDir, 'server', 'server\.js'\);/);
  assert.match(text, /spawnImpl\(nodePath, \[entry\],/);
  assert.match(text, /!path\.isAbsolute\(kernelNode\)/);
});

test('main.js only builds a kernel host from checkoutKernel() or bundledKernel(), both null outside a packaged Windows build', () => {
  const text = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(text, /const kernelHost = kernelDir\s*\?\s*createKernelHost\(/);
  assert.match(text, /const checkout = checkoutKernel\(\{ isPackaged: app\.isPackaged,/);
  assert.match(text, /const kernelDir = checkout\?\.kernelDir \?\? bundledKernel\(\{ isPackaged: app\.isPackaged,/);
});

test('the gitops runner starts only what the allowlist produced (git, gh, a validated test command): never node, the kernel or sc.exe', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'gitops-runner.js'), 'utf8');
  assert.doesNotMatch(text, /process\.execPath|['"]node(\.exe)?['"]|sc\.exe|server\.js|terminalRecipe/);
  assert.match(text, /validateGitopsOp\(/);
  const spawned = [...text.matchAll(/realSpawn\(\s*([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(spawned, ['recipe.command', 'recipe.file']);
  assert.equal((text.match(/shell:\s*true/g) ?? []).length, 1, 'only the validated test command goes through a shell');
});

test('the agy runner starts only agy (and taskkill for its own pid): never node, the kernel, sc.exe or a command from a record', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'agy-runner.js'), 'utf8');
  assert.doesNotMatch(text, /process\.execPath|['"]node(\.exe)?['"]|sc\.exe|server\.js|shell:\s*true|terminalRecipe/);
  const spawned = [...text.matchAll(/spawn\(\s*'([^']+)'/g), ...text.matchAll(/realSpawn\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(spawned, ['agy', 'taskkill']);
});

test('the launch runner opens terminals only: never node, never the kernel, never sc.exe', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'launch-runner.js'), 'utf8');
  assert.doesNotMatch(text, /process\.execPath|['"]node(\.exe)?['"]|sc\.exe|server\.js/);
  assert.match(text, /terminalRecipe\(/);
});

// Card glmps-2-0-202: the setup wizard's actions start three kinds of process
// and no others: a visible console through cmd.exe for argv built from
// constants, an allowlisted kernel script on the bundled node, and reg query.
test('the setup actions start only cmd.exe on constant argv, an allowlisted kernel script on the given node, and reg query: never the kernel server, sc.exe or a shell', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'setup', 'actions.js'), 'utf8');
  assert.doesNotMatch(text, /process\.execPath|sc\.exe|server\.js|shell:\s*true|terminalRecipe|utilityProcess|\bfork\(/);
  const spawned = [...text.matchAll(/\b(?:spawn|spawnImpl|spawnSync)\(\s*([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(spawned, ['argv[0]', 'node', 'r.file']);
  assert.match(text, /\['reg', 'query', key, '\/v', 'Path'\]/);
  assert.match(text, /if \(!isAllowedVisibleArgv\(argv\)\)/);
  assert.match(text, /if \(!KERNEL_SCRIPTS\.includes\(script\)\)/);
});

test('service-control only ever starts the service', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib', 'service-control.js'), 'utf8');
  assert.match(text, /\['start', name\]/);
  assert.doesNotMatch(text, /['"](stop|delete|create|config|pause)['"]/);
  assert.doesNotMatch(text, /\bnode(\.exe)?['"]/);
});

test('the ownership scan does not false-flag RegExp.prototype.exec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ownership-'));
  try {
    fs.writeFileSync(path.join(dir, 'regex-user.js'), "export const m = /FAILED (\\d+):/.exec(stdout);\n");
    assert.deepEqual(scanForChildProcess(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ownership scan still catches a bare child-process call and a child_process string fragment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ownership-'));
  try {
    fs.writeFileSync(path.join(dir, 'bare-exec.js'), "exec('sc.exe start X');\n");
    fs.writeFileSync(path.join(dir, 'imports-cp.js'), "import { spawn } from 'node:child_process';\n");
    assert.deepEqual(scanForChildProcess(dir).sort(), ['bare-exec.js', 'imports-cp.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ownership scan still catches utilityProcess.fork and any x.spawn method call (fix round 2, defect 1: the dot exemption must be exec-only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ownership-'));
  try {
    // Electron's utilityProcess.fork is D26's other bypass route: it can make
    // the kernel a child of Electron just like child_process.fork can.
    fs.writeFileSync(path.join(dir, 'utility-fork.js'), "import { utilityProcess } from 'electron';\nutilityProcess.fork(modulePath);\n");
    fs.writeFileSync(path.join(dir, 'method-spawn.js'), "const cp = require('node:child_process');\ncp.spawn('sc.exe', ['start', name]);\n");
    assert.deepEqual(scanForChildProcess(dir).sort(), ['method-spawn.js', 'utility-fork.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

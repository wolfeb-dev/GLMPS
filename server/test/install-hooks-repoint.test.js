// server/test/install-hooks-repoint.test.js
// Card glmps-2-0-147: the 2026-11-05 cutover moved the live checkout to
// D:/glmps-2.0-live but left the 20 global hooks and the statusline tap on
// D:/glmps-2.0-runtime. `install.mjs --repoint-from=<dir>` moves them through
// the hook manifest. Every child process runs against a temp home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planHookRepoint, hookCommand } from '../../scripts/install-hooks-lib.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const installScript = path.join(repoRoot, 'scripts', 'install.mjs');
const W = path.win32.join;

test('planHookRepoint moves GLMPS hooks and the statusline tap from the old root, both slash styles, and nothing else', () => {
  const OLD = W('D:/glmps-2.0-runtime');
  const NEW = W('D:/glmps-2.0-live');
  const settings = {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('node', OLD, 'done-gate.js') }] }],
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node D:/glmps-2.0-runtime/hooks/workspace-steer.js', timeout: 50000 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('node', W('D:/glmps-2.0-runtime2'), 'push-lease-guard.js') }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('node', OLD, 'someone-elses.js') }] },
      ],
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand('node', OLD, 'sync-project-dirs.mjs', 'scripts') }] }],
    },
    statusLine: { type: 'command', command: `node "${W(OLD, 'taps', 'statusline-chain.js')}"` },
    permissions: { additionalDirectories: ['D:/glmps-2.0-runtime'] },
  };
  const record = { added: [{ id: 'done-gate', event: 'Stop', matcher: '', command: hookCommand('node', OLD, 'done-gate.js') }] };
  const r = planHookRepoint(settings, { fromRoot: OLD, toRoot: NEW, record });
  assert.equal(r.changes.length, 4, JSON.stringify(r.changes, null, 2));
  assert.equal(r.patched.hooks.Stop[0].hooks[0].command, hookCommand('node', NEW, 'done-gate.js'));
  assert.equal(r.patched.hooks.PreToolUse[0].hooks[0].command, 'node D:/glmps-2.0-live/hooks/workspace-steer.js', 'a forward-slash command keeps its style');
  assert.equal(r.patched.hooks.PreToolUse[0].hooks[0].timeout, 50000);
  assert.equal(r.patched.hooks.PreToolUse[1].hooks[0].command, settings.hooks.PreToolUse[1].hooks[0].command, 'a sibling folder is not the old root');
  assert.equal(r.patched.hooks.PreToolUse[2].hooks[0].command, settings.hooks.PreToolUse[2].hooks[0].command, 'a script outside the manifest is not ours to move');
  assert.equal(r.patched.hooks.SessionStart[0].hooks[0].command, hookCommand('node', NEW, 'sync-project-dirs.mjs', 'scripts'));
  assert.match(r.patched.statusLine.command, /glmps-2\.0-live\\taps\\statusline-chain\.js/);
  assert.deepEqual(r.patched.permissions, settings.permissions, 'other settings are untouched');
  assert.equal(r.record.added[0].command, hookCommand('node', NEW, 'done-gate.js'), 'the install record follows so --uninstall still matches');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, hookCommand('node', OLD, 'done-gate.js'), 'the input is not mutated');
  const again = planHookRepoint(r.patched, { fromRoot: OLD, toRoot: NEW });
  assert.equal(again.changes.length, 0, 'a fixed point');
  assert.equal(again.patched, r.patched);
});

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-repoint-home-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
function run(home, ...args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: path.join(home, '.claude'), GLMPS_STATE_DIR: path.join(home, '.glmps2'), GLMPS_CONFIG_FILE: path.join(home, 'config.json') };
  try {
    return { status: 0, out: execFileSync(process.execPath, [installScript, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { status: e.status, out: `${e.stdout}${e.stderr}` }; }
}

test('install.mjs --repoint-from: dry run writes nothing; apply moves the entries to this checkout with a backup; a re-run has nothing to do', () => {
  withHome((home) => {
    const old = path.join(home, 'old-runtime');
    const settingsFile = path.join(home, '.claude', 'settings.json');
    const recordFile = path.join(home, '.glmps2', 'hooks-installed.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand(process.execPath, old, 'done-gate.js') }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/elsewhere/mine.js' }] }],
      },
      statusLine: { type: 'command', command: `node "${path.join(old, 'taps', 'statusline-chain.js')}"` },
    };
    const raw = `${JSON.stringify(settings, null, 2)}\n`;
    fs.writeFileSync(settingsFile, raw);
    fs.writeFileSync(recordFile, JSON.stringify({ added: [{ id: 'done-gate', event: 'Stop', matcher: '', command: settings.hooks.Stop[0].hooks[0].command }] }));

    const dry = run(home, `--repoint-from=${old}`, '--dry-run');
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /would repoint hooks\.Stop/);
    assert.match(dry.out, /would repoint statusLine/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), raw, 'a dry run leaves settings.json byte-identical');

    const r = run(home, `--repoint-from=${old}`);
    assert.equal(r.status, 0, r.out);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(after.hooks.Stop[0].hooks[0].command, hookCommand(process.execPath, repoRoot, 'done-gate.js'));
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'node C:/elsewhere/mine.js');
    assert.ok(after.statusLine.command.includes(path.join(repoRoot, 'taps', 'statusline-chain.js')));
    const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.equal(rec.added[0].command, after.hooks.Stop[0].hooks[0].command);
    const backups = fs.readdirSync(path.dirname(settingsFile)).filter((n) => n.startsWith('settings.json.bak-repoint-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(settingsFile), backups[0]), 'utf8'), raw);

    const again = run(home, `--repoint-from=${old}`);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /nothing to do/);
  });
});

test('install.mjs refuses --dry-run without --repoint-from, and extra flags beside it', () => {
  withHome((home) => {
    assert.equal(run(home, '--dry-run').status, 2);
    assert.equal(run(home, '--repoint-from=D:/x', '--uninstall').status, 2);
  });
});

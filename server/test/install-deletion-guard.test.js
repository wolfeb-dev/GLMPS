// Card glmps-2-0-runtime-127 AC-4: the deletion guard reaches the live hook
// config only through an operator-run script, dry run by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'install-deletion-guard.mjs');

function home() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-delguard-home-'));
  const env = { ...process.env, GLMPS_CLAUDE_DIR: path.join(tmp, 'claude'), GLMPS_STATE_DIR: path.join(tmp, 'mc') };
  fs.mkdirSync(env.GLMPS_CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(env.GLMPS_STATE_DIR, { recursive: true });
  const settingsFile = path.join(env.GLMPS_CLAUDE_DIR, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2));
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', windowsHide: true });
  return { tmp, env, settingsFile, run };
}

const guardCommands = (file) => (JSON.parse(fs.readFileSync(file, 'utf8')).hooks?.PreToolUse ?? [])
  .filter((g) => g.matcher === 'Bash|PowerShell' && g.hooks.some((h) => /deletion-guard\.js/.test(h.command)));

test('the dry run names the change and writes nothing', () => {
  const h = home();
  try {
    const before = fs.readFileSync(h.settingsFile, 'utf8');
    const out = h.run();
    assert.match(out, /deletion-guard: would add PreToolUse \[Bash\|PowerShell\]/);
    assert.match(out, /dry run: nothing changed/);
    assert.equal(fs.readFileSync(h.settingsFile, 'utf8'), before);
  } finally { fs.rmSync(h.tmp, { recursive: true, force: true }); }
});

test('--apply backs up settings.json, installs the guard once, and a re-run is a no-op', () => {
  const h = home();
  try {
    const out = h.run('--apply');
    assert.match(out, /backed up settings.json/);
    assert.match(out, /deletion-guard: installed/);
    assert.equal(guardCommands(h.settingsFile).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(h.settingsFile, 'utf8')).theme, 'dark', 'other settings kept');
    assert.ok(fs.readdirSync(h.env.GLMPS_CLAUDE_DIR).some((f) => /^settings\.json\.deletion-guard-.*\.bak$/.test(f)));
    const rec = JSON.parse(fs.readFileSync(path.join(h.env.GLMPS_STATE_DIR, 'hooks-installed.json'), 'utf8'));
    assert.ok(rec.added.some((a) => a.id === 'deletion-guard'), 'recorded so install.mjs --uninstall removes it');
    assert.match(h.run('--apply'), /already installed/);
    assert.equal(guardCommands(h.settingsFile).length, 1);
  } finally { fs.rmSync(h.tmp, { recursive: true, force: true }); }
});

test('an unknown flag changes nothing', () => {
  const h = home();
  try {
    assert.throws(() => h.run('--yes'), (e) => e.status === 2);
  } finally { fs.rmSync(h.tmp, { recursive: true, force: true }); }
});

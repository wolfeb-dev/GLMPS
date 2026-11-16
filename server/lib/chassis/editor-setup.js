// server/lib/chassis/editor-setup.js
// The two effects of the wizard's Default IDE step, run by
// scripts/setup/editor-setup.mjs: save the pick, and install the companion into
// the picked IDE with that IDE's own CLI. Every effect is injected so it tests
// without an IDE. Nothing here takes a command or path from the caller: the CLI
// comes from detection, the package from the kernel's companion folder, and the
// flags are fixed.
import fs from 'node:fs';
import path from 'node:path';
import { TARGET_IDS, IDE_TARGETS, windowsCmdPath } from '../orchestration/editor-targets.js';
import { editorCommand } from '../orchestration/editor-detect.js';

export function saveEditorPick({ target, saveConfig }) {
  if (typeof target !== 'string' || !TARGET_IDS.includes(target)) return { ok: false, reason: 'bad-target' };
  try { saveConfig({ lastTarget: target, openTarget: target }); } catch (e) { return { ok: false, reason: `not-saved: ${e?.message ?? e}` }; }
  return { ok: true, target };
}

// No quote, percent, caret, ampersand, pipe, angle bracket or bang: cmd.exe
// would re-parse any of them even inside the quoted command line.
const SAFE_PATH = /^[A-Za-z0-9_.:\\/ ()+,@~-]+$/;

export function installCommand({ platform = process.platform, cli, vsix, env = process.env }) {
  if (![cli, vsix].every((p) => typeof p === 'string' && p.length < 500 && SAFE_PATH.test(p))) return null;
  const options = { windowsHide: true, shell: false, encoding: 'utf8', timeout: 120_000 };
  if (platform === 'win32') {
    return {
      file: windowsCmdPath(env),
      args: ['/d', '/s', '/c', `""${cli}" --install-extension "${vsix}" --force"`],
      options: { ...options, windowsVerbatimArguments: true, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } },
    };
  }
  return { file: cli, args: ['--install-extension', vsix, '--force'], options };
}

export function findCompanionPackage({ kernelDir, readdir = fs.readdirSync }) {
  const dir = path.join(kernelDir, 'companion');
  let names;
  try { names = readdir(dir); } catch { return null; }
  const versionKey = (n) => (/(\d+(?:\.\d+)*)\.vsix$/.exec(n)?.[1] ?? '0').split('.').map(Number);
  const cmp = (a, b) => { const x = versionKey(a); const y = versionKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };
  const vsix = names.filter((n) => /\.vsix$/i.test(n)).sort(cmp).pop();
  return vsix ? path.join(dir, vsix) : null;
}

export function installCompanion({ target, home, programFiles = [], kernelDir, platform = process.platform, env = process.env, exists = fs.existsSync, findPackage = () => findCompanionPackage({ kernelDir }), run }) {
  if (!IDE_TARGETS.includes(target)) return { ok: false, reason: 'bad-target' };
  const cli = editorCommand(target, { home, programFiles, exists });
  if (!cli) return { ok: false, reason: 'not-installed' };
  const vsix = findPackage();
  if (!vsix) return { ok: false, reason: 'no-package' };
  const cmd = installCommand({ platform, cli, vsix, env });
  if (!cmd) return { ok: false, reason: 'unsafe-path' };
  let r;
  try { r = run(cmd); } catch (e) { return { ok: false, reason: `install-failed: ${e?.message ?? e}` }; }
  if (r?.status !== 0) return { ok: false, reason: `install-failed: exit ${r?.status ?? 'unknown'} ${String(r?.stderr ?? '').trim().slice(0, 200)}`.trim() };
  return { ok: true, target };
}

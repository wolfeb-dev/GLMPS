#!/usr/bin/env node
// Retires the Headscale remote-access setup (spec
// docs/specs/2026-11-10-glmps-2-0-171-local-only-mtls.md): the "GLMPS Headscale" boot task, its
// firewall rule and port proxy, the glmps-headscale WSL distro, the unconstrained CA in the
// machine and user Trusted Root stores, and the <stateDir>/remote-access/headscale folder (moved
// to a dated backup, never deleted). Every removal is backed up first and every step is
// idempotent. Report only by default; --apply acts (from an elevated terminal); --json prints
// the step array. Exit: 0 all done, 2 something needs the operator, 1 error.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveStateDir } from '../server/lib/state-dir.js';

export const OLD_CA_THUMBPRINT = 'bd17b79a116262bbc2c2b75a12cb1eb7897b2b47';
const TASK_NAME = 'GLMPS Headscale';
const RULE_NAME = 'GLMPS Headscale 8443';
const DISTRO = 'glmps-headscale';
const HS_PORT = 8443;
const ELEVATE = 'rerun from an elevated terminal; nothing was changed';

const step = (id, title, status, detail = '') => ({ id, title, status, detail });

// wsl.exe -l -q writes UTF-16LE; a utf8-decoded copy shows NULs and replacement characters.
export function decodeWslList(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf16le') : String(raw ?? '');
  return text.replace(/[\u0000\uFEFF\uFFFD]/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const defaultRun = (cmd, args, { timeout = 60000, raw = false } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, encoding: raw ? 'buffer' : 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', error: err?.code === 'ENOENT' ? 'ENOENT' : undefined });
  });
});

const failed = (r) => String(r.stderr || r.stdout || `exit ${r.code}`).replace(/[\u0000\r]/g, '').trim().slice(0, 300);
const stampOf = (now) => now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export async function runRetire({
  argv = [], run = defaultRun, env = process.env, stateDir = resolveStateDir({ env }), now = () => new Date(),
} = {}) {
  const apply = argv.includes('--apply');
  const stamp = stampOf(now);
  const backupDir = path.join(stateDir, 'backups', `headscale-retirement-${stamp}`);
  const hsDir = path.join(stateDir, 'remote-access', 'headscale');
  const elevated = (await run('net', ['session'])).code === 0;
  const steps = [];

  steps.push(!apply
    ? step('elevation', 'Elevated terminal', 'done', elevated ? 'elevated' : 'not elevated: report only is fine, --apply needs an elevated terminal')
    : elevated ? step('elevation', 'Elevated terminal', 'done', 'elevated') : step('elevation', 'Elevated terminal', 'needs-operator', ELEVATE));

  const gate = (id, title, willDo) => {
    if (!apply) return step(id, title, 'apply-will-do', willDo);
    if (!elevated) return step(id, title, 'needs-operator', `${ELEVATE}. Would: ${willDo}`);
    return null;
  };
  const mkBackupDir = () => fs.mkdirSync(backupDir, { recursive: true });

  {
    const title = `Scheduled task ${TASK_NAME}`;
    if ((await run('schtasks', ['/Query', '/TN', TASK_NAME])).code !== 0) steps.push(step('task', title, 'done', 'not registered'));
    else {
      const g = gate('task', title, `export its definition to ${backupDir}, stop it, and delete it`);
      if (g) steps.push(g);
      else {
        mkBackupDir();
        const xml = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/XML']);
        const file = path.join(backupDir, 'GLMPS-Headscale-task.xml');
        if (xml.code === 0) fs.writeFileSync(file, xml.stdout);
        await run('schtasks', ['/End', '/TN', TASK_NAME]);
        const d = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
        steps.push(d.code === 0 ? step('task', title, 'done', `deleted, definition saved to ${file}`) : step('task', title, 'needs-operator', `schtasks /Delete failed: ${failed(d)}`));
      }
    }
  }

  {
    const title = `Firewall rule ${RULE_NAME}`;
    const q = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`]);
    if (q.code !== 0) steps.push(step('firewall', title, 'done', 'not present'));
    else {
      const g = gate('firewall', title, 'delete the rule');
      if (g) steps.push(g);
      else {
        const d = await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${RULE_NAME}`]);
        steps.push(d.code === 0 ? step('firewall', title, 'done', 'deleted') : step('firewall', title, 'needs-operator', `netsh delete failed: ${failed(d)}`));
      }
    }
  }

  {
    const title = `Port proxy for ${HS_PORT}`;
    const q = await run('netsh', ['interface', 'portproxy', 'show', 'v4tov4']);
    const listens = [...String(q.stdout).matchAll(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+\S+\s+\d+\s*$/gm)].filter((m) => Number(m[2]) === HS_PORT).map((m) => m[1]);
    if (!listens.length) steps.push(step('portproxy', title, 'done', 'none'));
    else {
      const g = gate('portproxy', title, `delete the v4tov4 proxy on ${listens.join(', ')}:${HS_PORT} that the boot script added`);
      if (g) steps.push(g);
      else {
        let bad = null;
        for (const ip of listens) {
          const d = await run('netsh', ['interface', 'portproxy', 'delete', 'v4tov4', `listenaddress=${ip}`, `listenport=${HS_PORT}`]);
          if (d.code !== 0) bad = failed(d);
        }
        steps.push(bad ? step('portproxy', title, 'needs-operator', `netsh delete failed: ${bad}`) : step('portproxy', title, 'done', `deleted ${listens.join(', ')}`));
      }
    }
  }

  {
    const title = `WSL distro ${DISTRO}`;
    const l = await run('wsl.exe', ['-l', '-q'], { raw: true });
    if (l.code !== 0 || !decodeWslList(l.stdout).includes(DISTRO)) steps.push(step('distro', title, 'done', l.code !== 0 ? 'WSL not available, so nothing to remove' : 'not registered'));
    else {
      const g = gate('distro', title, `export it to ${backupDir}, then wsl --unregister ${DISTRO}`);
      if (g) steps.push(g);
      else {
        mkBackupDir();
        const tar = path.join(backupDir, `${DISTRO}.tar`);
        const x = await run('wsl.exe', ['--export', DISTRO, tar], { timeout: 300000 });
        if (x.code !== 0) steps.push(step('distro', title, 'needs-operator', `wsl --export failed, so the distro was kept: ${failed(x)}`));
        else {
          const u = await run('wsl.exe', ['--unregister', DISTRO], { timeout: 120000 });
          steps.push(u.code === 0 ? step('distro', title, 'done', `unregistered, export saved to ${tar}`) : step('distro', title, 'needs-operator', `wsl --unregister failed: ${failed(u)}`));
        }
      }
    }
  }

  for (const [id, label, flags] of [['ca-machine', 'LocalMachine', []], ['ca-user', 'CurrentUser', ['-user']]]) {
    const title = `Old Headscale CA removed from ${label}\\Root`;
    const q = await run('certutil', [...flags, '-store', 'Root', OLD_CA_THUMBPRINT]);
    if (q.code !== 0) steps.push(step(id, title, 'done', 'not present'));
    else {
      const g = gate(id, title, `export it as a .cer to ${backupDir}, then certutil ${[...flags, '-delstore', 'Root', OLD_CA_THUMBPRINT].join(' ')}`);
      if (g) steps.push(g);
      else {
        mkBackupDir();
        const file = path.join(backupDir, `${id}-${OLD_CA_THUMBPRINT}.cer`);
        const x = await run('certutil', [...flags, '-store', 'Root', OLD_CA_THUMBPRINT, file]);
        if (x.code !== 0 || !fs.existsSync(file)) steps.push(step(id, title, 'needs-operator', `could not export the certificate first, so it was kept: ${failed(x)}`));
        else {
          const d = await run('certutil', [...flags, '-delstore', 'Root', OLD_CA_THUMBPRINT]);
          steps.push(d.code === 0 ? step(id, title, 'done', `removed, backup ${file}`) : step(id, title, 'needs-operator', `certutil -delstore failed: ${failed(d)}`));
        }
      }
    }
  }

  {
    const title = 'Headscale state folder moved aside';
    if (!fs.existsSync(hsDir)) steps.push(step('folder', title, 'done', 'not present'));
    else {
      let dest = `${hsDir}.bak-${stamp}`;
      for (let i = 2; fs.existsSync(dest); i++) dest = `${hsDir}.bak-${stamp}-${i}`;
      const g = gate('folder', title, `rename ${hsDir} to ${dest} (it holds the old CA key; the copy is kept, delete it yourself when sure)`);
      if (g) steps.push(g);
      else {
        try { fs.renameSync(hsDir, dest); steps.push(step('folder', title, 'done', `moved to ${dest}`)); } catch (e) {
          steps.push(step('folder', title, 'needs-operator', `could not move ${hsDir}: ${e.message}. Close anything using it and rerun`));
        }
      }
    }
  }

  steps.push(step('tailscale-client', 'Tailscale client (optional, not touched)', 'done',
    'Optional, only if nothing else on this PC uses it: Settings > Apps > Installed apps > Tailscale > Uninstall. This script never does it.'));

  if (argv.includes('--json')) return { steps, exitCode: steps.every((s) => s.status === 'done') ? 0 : 2, output: JSON.stringify(steps, null, 2) };
  const out = [];
  for (const s of steps) { out.push(`[${s.status}] ${s.id}: ${s.title}`); if (s.detail) out.push(s.detail.split('\n').map((l) => `    ${l}`).join('\n')); }
  out.push('', apply ? 'Mode: apply.' : 'Mode: report only (add --apply to act).');
  return { steps, exitCode: steps.every((s) => s.status === 'done') ? 0 : 2, output: out.join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRetire({ argv: process.argv.slice(2) }).then((r) => {
    console.log(r.output);
    process.exitCode = r.exitCode;
  }, (e) => {
    console.error(`retire-headscale failed: ${e?.message || e}`);
    process.exitCode = 1;
  });
}

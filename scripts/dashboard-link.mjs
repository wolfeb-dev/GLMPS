#!/usr/bin/env node
// Scan 2026-10-15 F2: prints the one-time link that authorizes a plain
// browser for the dashboard's file, terminal, resume, open-in-editor and
// restart actions. It reads the owner-only <stateDir>/local-session-key the
// kernel created, so only the operator account can produce it. The desktop
// shell needs no link. Usage: npm run dashboard-link [-- --port <n>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPaths } from '../server/lib/paths.js';
import { loadProfile } from '../server/lib/chassis/profile.js';
import { localSessionValue, LOCAL_SESSION_KEY_FILE } from '../server/lib/governance/access-guard.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function dashboardLink({ stateDir, port, readFile = fs.readFileSync }) {
  const file = path.join(stateDir, LOCAL_SESSION_KEY_FILE);
  let key;
  try { key = String(readFile(file, 'utf8')).trim(); }
  catch (e) { return { link: null, reason: `no local session key at ${file} (${e?.code || e?.message || e}); start the GLMPS server once to create it` }; }
  if (!/^[0-9a-f]{64}$/.test(key)) return { link: null, reason: `the local session key at ${file} is malformed; stop the server, delete it, and start the server again` };
  return { link: `http://127.0.0.1:${port}/local-auth.html#${localSessionValue(key)}`, reason: null };
}

function configuredPort(argv) {
  const i = argv.indexOf('--port');
  if (i >= 0 && /^\d+$/.test(argv[i + 1] ?? '')) return Number(argv[i + 1]);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    if (Number.isInteger(cfg?.port)) return cfg.port;
  } catch { /* no config.json: the server default */ }
  return 8123;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const profile = loadProfile({ cwd: process.cwd(), env: process.env, home: os.homedir() });
  const { stateDir } = getPaths(process.env, profile);
  const { link, reason } = dashboardLink({ stateDir, port: configuredPort(process.argv.slice(2)) });
  if (!link) { console.error(reason); process.exit(1); }
  console.log('Open this link once in the browser you use for the dashboard. Do not share it; anyone with it can edit files and open terminals as you.');
  console.log(link);
}

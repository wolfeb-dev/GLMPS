// apps/shell/smoke/run-smoke.mjs
// Launches the real Electron shell against the stub kernel with a throwaway
// profile, waits for the in-app probe to write its checks, prints them, and
// exits non-zero on any failure. Never touches %APPDATA%\GLMPS2.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startStubKernel } from './stub-kernel.mjs';
import { smokeEnv } from './smoke-env.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // the electron package resolves to its binary path under Node
const APP_DIR = path.resolve(import.meta.dirname, '..');
const START_DOWN = process.argv.includes('--start-down');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-shell-smoke-'));
const result = path.join(dir, 'result.json');
const stub = await startStubKernel({ healthy: !START_DOWN });
// built by smoke-env.mjs, which also isolates GLMPS_STATE_DIR.
const env = smokeEnv({ base: process.env, dir, stubUrl: stub.url, stubControlUrl: stub.controlUrl, result });
const child = spawn(electronBinary, [APP_DIR], { env, stdio: 'inherit' });
const killer = setTimeout(() => child.kill(), 90_000);
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
clearTimeout(killer);
await stub.close();
const out = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8'))
  : { checks: [{ name: 'the probe wrote its result file', ok: false, detail: `electron exited ${code}` }] };
for (const c of out.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` ${JSON.stringify(c.detail)}`}`);
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(code !== 0 || out.checks.some((c) => !c.ok) ? 1 : 0);

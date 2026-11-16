// Entry point the runner types into a card's Antigravity tab (AC-6):
//   node vendor-session.mjs <session.json> <prompt.md>
// The prompt path is on the line so the companion closes the tab's shell when
// the session ends (companion/src/shell-exit.ts matches runner prompt files).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolveVendorBinary, parseAgyModels } from '../src/lib/vendor-card.js';
import { runVendorSession, validateSession } from '../src/lib/vendor-session.js';

const [sessionFile, promptArg] = process.argv.slice(2);
let session;
try { session = JSON.parse(fs.readFileSync(String(sessionFile ?? ''), 'utf8')); } catch (e) {
  console.error(`GLMPS: could not read the session file ${sessionFile}: ${e?.message ?? e}`);
  process.exit(2);
}
const bad = validateSession(session, { promptArg: promptArg ?? null });
if (bad) { console.error(`GLMPS: ${bad}`); process.exit(2); }

// Ctrl+C belongs to the agent CLI; this process stays to report its exit.
process.on('SIGINT', () => {});

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: parsed };
}

// The tab is about to hand the terminal to agy, so a blocking read is fine here.
function listModels() {
  const bin = resolveVendorBinary('agy');
  if (!bin) return [];
  const r = spawnSync(bin, ['models'], { cwd: session.cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? parseAgyModels(r.stdout) : [];
}

const out = await runVendorSession(session, {
  spawn, resolveBinary: (n) => resolveVendorBinary(n), exists: fs.existsSync, post,
  log: (t) => console.log(t), env: process.env, listModels,
});
process.exit(out.exitCode >= 0 ? out.exitCode : 1);

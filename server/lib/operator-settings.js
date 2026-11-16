// server/lib/operator-settings.js
// The operator's own preferences that the server needs (card
// glmps-2-0-runtime-66): today only the timezone every human-facing time is
// shown in. Kept in <stateDir>/operator.json, apart from config.json, so the
// settings dropdown can write it without rewriting the operator's config file.
import fs from 'node:fs';
import path from 'node:path';
import { isValidTimeZone, systemTimeZone } from '../../web/shared/time-format.js';

const file = (stateDir) => path.join(stateDir, 'operator.json');

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}

// A saved zone the runtime no longer knows falls back to the OS zone rather
// than failing every formatted time.
export function loadOperatorSettings(stateDir) {
  const saved = readJson(file(stateDir));
  if (saved && isValidTimeZone(saved.timeZone)) return { timeZone: saved.timeZone, source: 'saved' };
  return { timeZone: systemTimeZone(), source: 'os' };
}

function merge(stateDir, patch) {
  const f = file(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...(readJson(f) ?? {}), ...patch }, null, 2));
  fs.renameSync(tmp, f);
}

export function saveOperatorTimeZone(stateDir, timeZone) {
  if (!isValidTimeZone(timeZone)) return { ok: false, error: `unknown timezone: ${String(timeZone).slice(0, 80)}` };
  merge(stateDir, { timeZone });
  return { ok: true, timeZone, source: 'saved' };
}

// Card glmps-2-0-201: guard auto-approval and age-out. On unless the operator
// turned it off; read on every loop run, so the switch needs no restart.
export function loadGuardAutoApprove(stateDir) {
  const saved = readJson(file(stateDir));
  return { enabled: saved?.guardAutoApprove !== false, source: typeof saved?.guardAutoApprove === 'boolean' ? 'saved' : 'default' };
}

export function saveGuardAutoApprove(stateDir, enabled) {
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  merge(stateDir, { guardAutoApprove: enabled });
  return { ok: true, enabled, source: 'saved' };
}

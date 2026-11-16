// server/lib/orchestration/runner-store.js
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = { enabled: false, maxConcurrent: 1, maxRuntimeMs: 1800000, maxRetries: 2, lastTarget: null, openTarget: null, useWorktrees: false, operatorSlots: 0 };

const dir = (stateDir) => path.join(stateDir, 'runner');
const configFile = (stateDir) => path.join(dir(stateDir), 'config.json');
const ledgerFile = (stateDir) => path.join(dir(stateDir), 'launched.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function loadConfig(stateDir) { return { ...DEFAULTS, ...readJson(configFile(stateDir), {}) }; }
export function saveConfig(stateDir, partial = {}) {
  const merged = { ...loadConfig(stateDir), ...partial };
  if ('operatorSlots' in partial) merged.operatorSlots = Math.max(0, Math.floor(Number(partial.operatorSlots)) || 0);
  writeJson(configFile(stateDir), merged);
  return merged;
}
export function loadLedger(stateDir) { return readJson(ledgerFile(stateDir), {}); }
// loadLedger's {} on ANY read error is indistinguishable
// from a genuinely empty ledger. A caller that would act on "no entry
// points at this" (expiring a launch as orphaned) needs the difference: a
// missing file is an empty ledger; a corrupt or unreadable one is a named
// error with ledger null.
export function readLedger(stateDir) {
  let text;
  try { text = fs.readFileSync(ledgerFile(stateDir), 'utf-8'); }
  catch (e) {
    if (e?.code === 'ENOENT') return { ledger: {}, error: null };
    return { ledger: null, error: `${e?.code || 'read failed'}: ${e?.message || e}` };
  }
  try { return { ledger: JSON.parse(text), error: null }; }
  catch (e) { return { ledger: null, error: `ledger is not valid JSON: ${e?.message || e}` }; }
}
export function saveLedger(stateDir, ledger) { writeJson(ledgerFile(stateDir), ledger ?? {}); return ledger; }
export function writePrompt(stateDir, id, prompt) {
  const f = path.join(dir(stateDir), `${id}.prompt.md`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, String(prompt ?? ''));
  return path.resolve(f);
}

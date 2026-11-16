// taps/tap-budget.js
// The tap's budget collector (card glmps-2-0-runtime-38). It runs readBudget on
// this machine, keeps only the whitelisted derived numbers (projectBudget) and
// spools them as a `budget` record. This is the only tap module that touches the
// Claude credentials file, and the OAuth token goes no further than the usage
// call made with the `fetch` handed in here; the agent's server fetch and the
// client token never reach it.
import os from 'node:os';
import path from 'node:path';
import { readBudget as defaultReadBudget, projectBudget } from '../server/lib/observability/budget.js';

export const BUDGET_REFRESH_MS = 10 * 60_000;

export function createBudgetCollector({
  claudeDir, spool, fetch: usageFetch, readBudget = defaultReadBudget, now = Date.now,
  refreshMs = BUDGET_REFRESH_MS, log = console.error, env = process.env, homeDir = os.homedir(),
} = {}) {
  const dir = claudeDir ?? env.GLMPS_CLAUDE_DIR ?? path.join(homeDir, '.claude');
  const credentialsFile = path.join(dir, '.credentials.json');
  const statuslineFile = path.join(dir, '.claude-manager', 'statusline.json');
  const cache = { at: 0, value: null };
  let lastKey = null;
  let lastAppendTs = null;

  async function tick() {
    try {
      const t = now();
      const value = await readBudget({ credentialsFile, statuslineFile, now: t, fetchImpl: usageFetch, cache });
      const payload = projectBudget(value);
      if (!payload) return { appended: false };
      const { updatedTs, ...rest } = payload;
      const key = JSON.stringify(rest);
      if (key === lastKey && lastAppendTs !== null && t - lastAppendTs < refreshMs) return { appended: false };
      spool.append('budget', payload);
      lastKey = key; lastAppendTs = t;
      return { appended: true };
    } catch (e) {
      const error = e?.message || String(e);
      log(`[tap-budget] ${error}`);
      return { appended: false, error };
    }
  }
  return { tick };
}

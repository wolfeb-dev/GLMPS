// The orphan-sweep loop body (card glmps-2-0-171 D4): once a day, from 16:00
// UTC, one post to the operator listing every card nobody is steering. The
// registry schedules it (hourly); this decides whether today's post is due.
import fs from 'node:fs';
import path from 'node:path';
import { selectOrphans, orphanPost } from './orphans.js';

export const DUE_HOUR_UTC = 16;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function orphanSweepLoop({ stateDir, readItems, live, parked, post, canPost = () => true, now = Date.now }) {
  const file = path.join(stateDir, 'orphan-sweep.json');
  const lastPostDay = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).lastPostDay ?? null; } catch { return null; } };
  const remember = (day) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastPostDay: day }));
  };
  return {
    maker: async () => {
      const t = now();
      const today = dayOf(t);
      // No Slack configured is the same fail-open as 163: nothing to say, nobody to say it to.
      if (!canPost() || new Date(t).getUTCHours() < DUE_HOUR_UTC || lastPostDay() === today) return { outcome: 'nothing-to-do', result: { posted: 0, failed: [] } };
      const orphans = selectOrphans({ items: readItems(), live: live(), parked: parked(), now: t });
      if (!orphans.length) return { outcome: 'nothing-to-do', result: { posted: 0, failed: [] } };
      try {
        await post(orphanPost(orphans));
      } catch (e) {
        // done, not nothing-to-do: the registry skips the checker for nothing-to-do, so the failure would go unseen.
        return { outcome: 'done', result: { posted: 0, failed: [e?.message ?? String(e)] } };
      }
      remember(today);
      return { outcome: 'done', result: { posted: orphans.length, failed: [] } };
    },
    checker: async ({ failed }) => (failed.length ? { ok: false, reason: `orphan post failed: ${failed.join('; ').slice(0, 400)}` } : { ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
    sla: { maxAgeMs: 3 * 3_600_000 },
  };
}

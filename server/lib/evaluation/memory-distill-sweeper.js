// server/lib/evaluation/memory-distill-sweeper.js
//
// Safety net for sessions that never reached the Stop hook (crash, kill,
// terminal close, machine sleep, context-limit abort). Idle-detects abandoned
// sessions and enqueues them into the SAME distiller queue the Stop-hook ping
// feeds, so "abandoned" is not a special case - just a session that went quiet.
//
// Restricted to KNOWN project roots. That restriction also isolates the
// extractor's own `claude -p` session: it runs in a throwaway temp cwd whose
// slug matches no known root, so the sweeper never distills the distiller.

import fs from 'node:fs';
import path from 'node:path';
import { discoverClaudeSessions } from '../observability/sessions.js';
import { enqueue, getWatermark, setWatermark } from './memory-distill-queue.js';

// Claude Code buckets a cwd into a project dir name by replacing EACH
// non-alphanumeric character with '-'. e.g. 'D:\\proj' ->
// 'D--glmps', 'D:/proj' -> 'D--proj'. (Verified against real
// ~/.claude/projects dir names.)
export function sanitizeRoot(root) {
  return String(root).replace(/[^A-Za-z0-9]/g, '-');
}

export function slugMatchesRoot(slug, knownRoots) {
  if (!Array.isArray(knownRoots)) return false;
  return knownRoots.some((r) => sanitizeRoot(r) === slug);
}

/**
 * Pure decision core - all IO injected. Returns the sessionIds it enqueued.
 * @returns {{enqueued:string[], seeded:boolean}}
 */
export function sweepAbandoned({ sessions, watermark = {}, nowMs, cfg, knownRoots, enqueueFn, countLines }) {
  const enqueued = [];
  for (const s of sessions || []) {
    if (!s || s.live) continue;                                  // still running
    if (!(nowMs - s.mtimeMs > cfg.sweepIdleMs)) continue;        // not idle long enough
    const slug = path.basename(path.dirname(s.transcriptPath || ''));
    if (!slugMatchesRoot(slug, knownRoots)) continue;           // unknown/throwaway project
    const lines = countLines(s.transcriptPath);
    if (lines <= (watermark[s.id] || 0)) continue;             // already processed (no new delta)
    enqueueFn({ sessionId: s.id, transcriptPath: s.transcriptPath, cwd: s.cwd });
    enqueued.push(s.id);
  }
  return { enqueued, seeded: false };
}

function countFileLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

/**
 * IO wrapper: discover sessions, apply backfill-skip on first run, else sweep.
 */
export function runSweep({ stateDir, paths, cfg, knownRoots, nowMs = Date.now() }) {
  let sessions;
  try {
    sessions = discoverClaudeSessions({
      activeSessionsFile: paths.activeSessionsFile,
      claudeSessionsDir: paths.claudeSessionsDir,
      projectsDir: paths.projectsDir,
    });
  } catch { return { enqueued: [], seeded: false }; }

  const wm = getWatermark(stateDir);
  const wmEmpty = !wm || Object.keys(wm).length === 0;
  // First-run backfill = skip: mark all current history as processed so the
  // initial sweep does not flood the queue with hundreds of old sessions.
  if (wmEmpty && cfg.sweepBackfill === false) {
    const seeded = {};
    for (const s of sessions) seeded[s.id] = countFileLines(s.transcriptPath);
    setWatermark(stateDir, seeded);
    return { enqueued: [], seeded: true };
  }
  return sweepAbandoned({
    sessions,
    watermark: wm,
    nowMs,
    cfg,
    knownRoots,
    enqueueFn: (r) => enqueue(stateDir, r),
    countLines: countFileLines,
  });
}

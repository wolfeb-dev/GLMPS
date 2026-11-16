#!/usr/bin/env node
// Stop hook: records ~/.claude/settings.json changes for the decision log
// (glmps-143).
//
// settings.json is the one surface the git spine cannot see: ~/.claude is not a
// git repo, so the file has no version history anywhere on the machine. That is
// the gap that forced the manual archaeology this feature exists to eliminate.
// Only key NAMES, counts and a hash are recorded, never raw values, because
// settings.json can carry env secrets.
//
// Commit history is NOT this hook's job: the server-side sweep
// (decision-log-sweep.js) already captures every merge across every repo.
//
// Stdin: Claude Code Stop-hook JSON { session_id, transcript_path, cwd,
// stop_hook_active }. Always exits 0 - must never block the stop.

import { fileURLToPath } from 'node:url';
import { resolveStateDir } from '../server/lib/state-dir.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch(() => process.exit(0));
}

async function run() {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const os = (await import('node:os')).default;

  // The memory distiller's own headless session sets this. Bail so our capture
  // never runs on machinery-driven sessions (same guard as capability-feed.js).
  if (process.env.GLMPS_MEMORY_DISTILL) process.exit(0);

  const [{ summarize }, hookCore, store] = await Promise.all([
    import('../server/lib/observability/decision-log-config.js'),
    import('../server/lib/observability/decision-log-hook-core.js'),
    import('../server/lib/observability/decision-log-store.js'),
  ]);

  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* keep going with defaults */ }

  const home = os.homedir();
  const stateDir = resolveStateDir({ home });
  const settingsFile = process.env.GLMPS_SETTINGS_FILE || path.join(home, '.claude', 'settings.json');
  const now = Date.now();
  const rows = [];

  try {
    const next = summarize(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')));
    const prev = store.loadSnapshot(stateDir);
    const row = hookCore.buildConfigRow({ prev, next, ts: now });
    if (row) rows.push(row);
    // Snapshot even when unchanged, so a first run establishes a baseline
    // instead of reporting the entire file as "added" on the second run.
    store.saveSnapshot(stateDir, next);
  } catch { /* unreadable or malformed settings: skip, never block the stop */ }

  // The design deferred LLM enrichment out of v1, and without a model there is
  // no honest source for a "why": git has only the body the author wrote, and
  // the transcript would have to be summarized to yield one.
  //
  // The first cut of this hook papered over that by reading
  // `payload.session_start_ms` and `payload.decision_why`. The Stop hook
  // payload carries only { session_id, transcript_path, cwd, stop_hook_active },
  // so both were always undefined and the branch could never run. Dead code
  // that looks live is worse than no code, so it is gone.
  //
  // The seam it would plug into is real and tested: append a row shaped
  // { ts, commit, why, source:'enrichment' } and decision-log-store.js's
  // joinEnrichment() folds it onto the matching git row at read time, without
  // ever rewriting history. selectThinCommits() in decision-log-hook-core.js
  // already decides WHICH commits qualify (body under 80 chars). What is
  // missing is only the why-producer.

  // The rows go to the server's decision log (the snapshot above stays local hook
  // state). Only a connection that never opened falls back to the direct append.
  try {
    if (rows.length) {
      const { postIngest } = await import('../server/lib/ingest-post.js');
      const sent = await postIngest('/api/ingest/decision-log', { rows });
      if (!sent.sent) store.append(stateDir, rows);
    }
  } catch { /* never block the stop */ }
  process.exit(0);
}

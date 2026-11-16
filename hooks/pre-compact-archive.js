#!/usr/bin/env node
// PreCompact hook: archives the session transcript JSONL before compaction
// destroys detail, so the replay/eval corpus (server/lib/evaluation/) keeps
// full-fidelity transcripts. Borrows the PreCompact-archive idea from
// daaain/claude-code-log.
//
// Stdin: Claude Code PreCompact-hook JSON
//   { session_id, transcript_path, cwd, hook_event_name, trigger, custom_instructions }
//   (trigger is 'manual' | 'auto')
// Always exits 0 - must never block or slow compaction. Every failure path
// is silent (fail-open).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from '../server/lib/state-dir.js';

// CLI entry guard - only run when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch(() => process.exit(0));
}

// Resolves the archive root: GLMPS_TRANSCRIPT_ARCHIVE_DIR env override, else
// <state dir>/transcript-archive (server/lib/state-dir.js). Mirrors the GLMPS_*-env-override
// convention used throughout server/lib/paths.js.
export function resolveArchiveRoot(env = process.env, { home, exists } = {}) {
  return env.GLMPS_TRANSCRIPT_ARCHIVE_DIR || path.join(resolveStateDir({ env, home, exists }), 'transcript-archive');
}

// Archives `transcriptPath` into `<archiveRoot>/<sessionId>/<epochMs>-<trigger>.jsonl`.
//
// Pure-ish: it only touches the filesystem paths it is explicitly given
// (transcriptPath, archiveRoot) - no implicit home-dir defaulting happens in
// here, that's the CLI wrapper's job (resolveArchiveRoot), so tests can never
// accidentally write into a real home dir just by omitting a param. `now` is
// injectable (a function or a Date/number) for deterministic tests. Never
// throws.
//
// Subagent transcripts: Claude Code writes each dispatched subagent ("Task") as
// its OWN file at <transcriptPath-without-.jsonl>/subagents/**/agent-*.jsonl - 
// there is NO isSidechain-inlined copy in the main transcript. Only the dispatch
// tool_use/tool_result lines land in transcriptPath; the subagent's actual report
// text does not. So archiving transcriptPath alone loses all subagent detail - 
// including any bug/flaw a subagent surfaced - so we discover and archive those
// sibling files too (see archiveSubagents below).
export function archiveTranscript({ transcriptPath, sessionId, trigger = 'manual', archiveRoot, now = Date.now }) {
  try {
    if (!archiveRoot) return { archived: false, reason: 'no-archive-root' };
    if (!transcriptPath || typeof transcriptPath !== 'string') {
      return { archived: false, reason: 'no-transcript-path' };
    }

    let stat;
    try { stat = fs.statSync(transcriptPath); }
    catch { return { archived: false, reason: 'transcript-not-found' }; }
    if (!stat.isFile()) return { archived: false, reason: 'transcript-not-found' };

    const sessionDir = path.join(archiveRoot, String(sessionId || 'unknown'));

    // Dedupe guard: if the most recent existing archive for this session has
    // the same byte size as the current transcript, skip (compaction was
    // re-triggered, or nothing changed since the last archive).
    let existing = [];
    try {
      existing = fs.readdirSync(sessionDir)
        .filter(f => /^\d+-.+\.jsonl$/.test(f))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    } catch { /* session dir doesn't exist yet -> no prior archives */ }

    if (existing.length > 0) {
      const latest = existing[existing.length - 1];
      try {
        const latestStat = fs.statSync(path.join(sessionDir, latest));
        if (latestStat.size === stat.size) {
          return { archived: false, reason: 'unchanged' };
        }
      } catch { /* stat failed -> fall through and archive anyway */ }
    }

    fs.mkdirSync(sessionDir, { recursive: true });

    const nowVal = typeof now === 'function' ? now() : now;
    const epochMs = nowVal instanceof Date ? nowVal.getTime() : nowVal;
    const safeTrigger = String(trigger || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
    const destPath = path.join(sessionDir, `${epochMs}-${safeTrigger}.jsonl`);

    fs.copyFileSync(transcriptPath, destPath);

    // Also snapshot the session's subagent transcripts - the subagent report text
    // lives only in these sibling files, never inlined in transcriptPath.
    const subagents = archiveSubagents({ transcriptPath, sessionDir, epochMs, safeTrigger });

    return { archived: true, path: destPath, subagents };
  } catch {
    return { archived: false, reason: 'error' };
  }
}

// Discovers a session's subagent transcripts (mirrors server.js findSubagentFiles:
// <transcriptPath-without-.jsonl>/subagents/**/agent-*.jsonl) and copies each into
// <sessionDir>/subagents/. Best-effort and fail-open - never throws; returns the
// count archived. Each snapshot is name-stamped with the same epoch+trigger as the
// main archive, so repeated compactions keep full-fidelity subagent history too.
function archiveSubagents({ transcriptPath, sessionDir, epochMs, safeTrigger }) {
  let count = 0;
  try {
    const base = transcriptPath.replace(/\.jsonl$/, '');
    const roots = [path.join(base, 'subagents')];
    const files = [];
    while (roots.length) {
      const d = roots.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) roots.push(full);
        else if (/^agent-.*\.jsonl$/.test(e.name)) files.push(full);
      }
    }
    if (!files.length) return 0;
    const subDest = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subDest, { recursive: true });
    for (const f of files) {
      try {
        fs.copyFileSync(f, path.join(subDest, `${epochMs}-${safeTrigger}-${path.basename(f)}`));
        count++;
      } catch { /* one bad subagent file must not abort the rest */ }
    }
  } catch { /* fail-open */ }
  return count;
}

async function run() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    process.stdin.on('data', d => { raw += d; });
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  try {
    const inp = JSON.parse(raw || '{}');
    const transcriptPath = inp.transcript_path ?? null;
    const sessionId = inp.session_id ?? 'unknown';
    const trigger = inp.trigger ?? 'manual';
    const archiveRoot = resolveArchiveRoot(process.env);

    archiveTranscript({ transcriptPath, sessionId, trigger, archiveRoot });
  } catch {
    // Top-level fail-open: a hook bug must never trap the user.
  }

  process.exit(0);
}

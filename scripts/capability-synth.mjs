#!/usr/bin/env node
// scripts/capability-synth.mjs
// Weekly batch synthesizer: walks all Claude Code transcripts, extracts
// capability gaps, upserts them into the learning store, and writes a
// watermark so subsequent runs only re-scan changed files.
//
// Usage:
//   node scripts/capability-synth.mjs             # since watermark (default)
//   node scripts/capability-synth.mjs --all       # every transcript
//   node scripts/capability-synth.mjs --days 3    # since 3 days ago
//   node scripts/capability-synth.mjs --projects-dir /path/to/projects
//
// Environment overrides:
//   GLMPS_PROJECTS_DIR - override the ~/.claude/projects root
//   GLMPS_STATE_DIR - override ~/.glmps (via getPaths)

import fs from 'node:fs';
import path from 'node:path';

// Literal specifiers relative to this script (not the cwd), so the tap bundle
// (apps/tap) can inline them.

const { extractClaudeEvents } = await import('../server/lib/observability/extract-claude.js');
const { detectGaps } = await import('../server/lib/observability/gap-detect.js');
const { scanTranscriptForGaps } = await import('../server/lib/observability/transcript-gaps.js');
const { upsertGap } = await import('../server/lib/evaluation/learning-store.js');
const { getPaths } = await import('../server/lib/paths.js');
const { selectStaleTranscripts, digest } = await import('../server/lib/evaluation/synth-core.js');

// Parse CLI args

const args = process.argv.slice(2);
let useAll = false;
let daysArg = null;
let projectsDirArg = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') { useAll = true; continue; }
  if (args[i] === '--days' && args[i + 1] != null) { daysArg = Number(args[++i]); continue; }
  if (args[i] === '--projects-dir' && args[i + 1] != null) { projectsDirArg = args[++i]; continue; }
}

// Resolve paths

const P = getPaths();
const stateDir = P.stateDir;
const projectsRoot = process.env.GLMPS_PROJECTS_DIR ?? projectsDirArg ?? P.projectsDir;
const watermarkFile = path.join(stateDir, 'learning', 'synth-watermark.json');

// Watermark helpers

function readWatermark() {
  try {
    const raw = fs.readFileSync(watermarkFile, 'utf-8');
    const obj = JSON.parse(raw);
    return typeof obj.lastRunMs === 'number' ? obj.lastRunMs : null;
  } catch {
    return null;
  }
}

function writeWatermark(nowMs) {
  fs.mkdirSync(path.dirname(watermarkFile), { recursive: true });
  const tmp = watermarkFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ lastRunMs: nowMs }));
  fs.renameSync(tmp, watermarkFile);
}

// Determine sinceMs

const lastRunMs = readWatermark();

// Cold-start bound: with no watermark (a true first run, or a reactivation
// after the script had been broken), scan only the last week instead of the
// entire transcript history - otherwise one run floods the learning store with
// a huge backlog of gaps. Use --all to force a full backfill deliberately.
const DEFAULT_LOOKBACK_DAYS = 7;

let sinceMs;
if (useAll) {
  sinceMs = null;
} else if (daysArg != null && !isNaN(daysArg)) {
  sinceMs = Date.now() - daysArg * 24 * 3600 * 1000;
} else if (lastRunMs != null) {
  // Incremental: only transcripts changed since the last successful run
  sinceMs = lastRunMs;
} else {
  sinceMs = Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 3600 * 1000;
}

// Walk projects root for *.jsonl files

function collectJsonlFiles(root) {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return result; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projectDir = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(projectDir, { withFileTypes: true }); }
    catch { continue; }

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, f.name);
      let stat;
      try { stat = fs.statSync(fullPath); }
      catch { continue; }
      result.push({ path: fullPath, mtimeMs: stat.mtimeMs, project: ent.name });
    }
  }
  return result;
}

const allFiles = collectJsonlFiles(projectsRoot);

// selectStaleTranscripts works on {path, mtimeMs}; project field passes through
const selected = selectStaleTranscripts(allFiles, sinceMs);

// Process each transcript

let totalFiles = 0;
let totalGaps = 0;
const runGaps = [];

for (const file of selected) {
  try {
    const rawContent = fs.readFileSync(file.path, 'utf-8');
    const lines = rawContent.split('\n').filter(Boolean);
    const sessionId = path.basename(file.path, '.jsonl');
    const project = file.project ?? path.basename(path.dirname(file.path));

    // Extract events + skillsUsed
    const events = [];
    const skillsUsed = [];
    for (const line of lines) {
      const evs = extractClaudeEvents(line, sessionId);
      for (const e of evs) {
        events.push(e);
        if (e.kind === 'skill' && e.label && !skillsUsed.includes(e.label)) {
          skillsUsed.push(e.label);
        }
      }
    }

    // Detect gaps from both detectors
    const gaps1 = detectGaps(events, skillsUsed);
    const gaps2 = scanTranscriptForGaps(lines, { project });
    const gaps = [...gaps1, ...gaps2];

    // Upsert each gap; fail-open per gap
    for (const gap of gaps) {
      try {
        upsertGap(stateDir, gap, { project, sessionId });
        runGaps.push(gap);
        totalGaps++;
      } catch {
        // fail-open: one bad upsert must not abort the sweep
      }
    }

    totalFiles++;
  } catch {
    // fail-open: one bad transcript must not abort the sweep
  }
}

// Write watermark

const nowMs = Date.now();
writeWatermark(nowMs);

// Print concise digest

const table = digest(runGaps);
console.log(`synth: scanned ${totalFiles} transcript(s), ${totalGaps} gap(s) upserted`);
if (table.length > 0) {
  console.log('  code                                    count');
  console.log('  ' + '-'.repeat(46));
  for (const row of table) {
    console.log('  ' + row.code.padEnd(40) + row.count);
  }
}
console.log(`synth: watermark updated (${new Date(nowMs).toISOString()})`);

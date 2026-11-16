// server/lib/adapters/pi.js
// Pi coding agent adapter. Ported from the Pi session layout and message-graph
// parsing in Orca (https://github.com/stablyai/orca, MIT, see THIRD_PARTY_NOTICES.md):
// src/main/ai-vault/session-scanner-agent-sources.ts, session-scanner-values.ts
// (normalizeAgentSessionsDir) and session-scanner-graph-parsers.ts
// (parseMessageGraphSessionFile).
// base = P.piDir ($GLMPS_PI_DIR, else $PI_CODING_AGENT_DIR, else ~/.pi/agent). Sessions
// are *.jsonl under <base>/sessions, bucketed by cwd; each line is one record:
//   { type:'session', id, cwd, timestamp }          header
//   { type:'model_change', modelId }                 model switch
//   { type:'message', timestamp, message:{ role, content, model } }
// Assistant content blocks include { type:'toolCall', name, arguments } (pi-ai
// ToolCall), which Orca does not read; we turn them into tool/command/git events
// (Pi tools: read, edit, write, bash, ...). oh-my-pi (OMP) shares this folder, so
// its stamp_UUID artifact dirs and OMP-written files are skipped, as Orca does.
import path from 'node:path';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf, walkFiles, readHeadLines } from './fs-util.js';
import { userEvent, toolCallEvent } from './event-build.js';

export const id = 'pi';
export const displayName = 'Pi';
export const controllable = false;

const OMP_ARTIFACT_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELL_RE = /^bash$/i;
const EDIT_RE = /^(edit|write)$/i;

/**
 * The sessions dir for a configured Pi dir. Orca normalises by leaf name:
 * .../sessions as is, .../agent + sessions, .../.pi + agent/sessions. Any other
 * leaf is the agent dir when it has a sessions/ child, else taken as the
 * sessions dir itself.
 */
export function sessionsDirOf(raw) {
  const trimmed = String(raw ?? '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const leaf = path.basename(trimmed);
  if (leaf === 'sessions') return trimmed;
  if (leaf === 'agent') return path.join(trimmed, 'sessions');
  if (leaf === '.pi') return path.join(trimmed, 'agent', 'sessions');
  const child = path.join(trimmed, 'sessions');
  return isDirectory(child) ? child : trimmed;
}

export function detect(P) {
  const base = P?.piDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  const dir = sessionsDirOf(base);
  return { installed: dir !== '' && isDirectory(dir), dataDirs: [base] };
}

// OMP stamps its own records into the shared folder; Pi never writes these.
function isOmpWritten(rec) {
  return (rec.type === 'title' && rec.v === 1)
    || (rec.runtime != null && typeof rec.runtime === 'object')
    || (rec.type === 'model_change' && rec.modelId === undefined && typeof rec.model === 'string');
}


export function discover(P) {
  const base = P?.piDir;
  if (typeof base !== 'string') return [];
  const root = sessionsDirOf(base);
  if (!root) return [];
  const out = [];
  const files = walkFiles(root, {
    maxDepth: 3,
    match: (name) => name.endsWith('.jsonl'),
    enterDir: (name, depth) => depth === 0 || !OMP_ARTIFACT_DIR.test(name),
  });
  for (const file of files) {
    const mtimeMs = mtimeMsOf(file);
    if (mtimeMs == null) continue;
    let sessionId = path.basename(file, '.jsonl');
    let cwd = null;
    let omp = false;
    for (const l of readHeadLines(file)) {
      let rec;
      try { rec = JSON.parse(l); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      if (isOmpWritten(rec)) { omp = true; break; }
      if (rec.type === 'session') {
        if (typeof rec.id === 'string' && rec.id) sessionId = rec.id;
        if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
      }
    }
    if (omp) continue;
    out.push({ id: `${id}:${sessionId}`, tool: id, kind: 'jsonl-tail', file, cwd, label: null, mtimeMs });
  }
  return out;
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** jsonl-tail: one line -> events[] (canonical {kind,lane,label,path,tool,ts,sessionId}). */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; } // transient partial read, not drift
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (Object.keys(obj).length === 0) return [];

  if (typeof obj.type !== 'string') {
    reportMiss(id, 'session record missing string type');
    return [];
  }
  const ts = obj.timestamp ?? null;

  if (obj.type === 'session') {
    const cwd = obj.cwd;
    return typeof cwd === 'string' && cwd ? [{ kind: 'meta', lane: 'feed', label: 'cwd', path: cwd, sessionId }] : [];
  }
  if (obj.type === 'model_change') {
    const model = obj.modelId ?? obj.model;
    return typeof model === 'string' && model ? [{ kind: 'meta', lane: 'feed', label: 'model', model, sessionId }] : [];
  }
  if (obj.type !== 'message') return [];

  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return [];
  const blocks = contentBlocks(msg.content);

  if (msg.role === 'user') {
    const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    const ev = userEvent(text, ts, sessionId);
    return ev ? [ev] : [];
  }
  if (msg.role === 'assistant') {
    const out = [];
    if (typeof msg.model === 'string' && msg.model) out.push({ kind: 'meta', lane: 'feed', label: 'model', model: msg.model, sessionId });
    for (const b of blocks) {
      if (!b || b.type !== 'toolCall') continue;
      out.push(toolCallEvent(b.name, b.arguments, ts, sessionId, { shell: SHELL_RE, edit: EDIT_RE }));
    }
    return out;
  }
  return [];
}

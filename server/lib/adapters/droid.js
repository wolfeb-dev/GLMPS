// server/lib/adapters/droid.js
// SPECULATIVE (capture-registry `speculative: true`): the tool_use and tool_call
// shapes below are not confirmed by Orca or by a real session; the fixture
// matches the guess.
// Factory Droid adapter. Ported from the Droid session layout and record parsing
// in Orca (https://github.com/stablyai/orca, MIT, see THIRD_PARTY_NOTICES.md):
// src/main/ai-vault/session-scanner-agent-sources.ts and
// session-scanner-droid-parser.ts.
// base = P.factoryDir ($GLMPS_FACTORY_DIR, else ~/.factory). Sessions are *.jsonl
// under <base>/sessions and <base>/projects; each line is one record:
//   { type:'session_start', id, title, cwd }
//   { type:'system', cwd, model }
//   { type:'message', role, text }  or  { type:'message', message:{ role, content } }
//   { type:'completion', finalText, usage }
// Orca reads only those. Tool calls are emitted from assistant `tool_use` content
// blocks and from `tool_call` records ({ toolName, parameters }, Factory's
// stream-json shape); neither is confirmed by Orca's tests, so the committed
// sample session is sanitized from Orca's shapes plus those two assumptions.
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf, walkFiles, readHeadLines } from './fs-util.js';
import { userEvent, toolCallEvent } from './event-build.js';

export const id = 'droid';
export const displayName = 'Factory Droid';
export const controllable = false;

const SHELL_RE = /^(execute|bash|shell)$/i;
const EDIT_RE = /^(edit|create|write|multiedit|applypatch)$/i;
const SUBDIRS = ['sessions', 'projects'];

export function detect(P) {
  const base = P?.factoryDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  return { installed: SUBDIRS.some(d => isDirectory(path.join(base, d))), dataDirs: [base] };
}

export function discover(P) {
  const base = P?.factoryDir;
  if (typeof base !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const sub of SUBDIRS) {
    for (const file of walkFiles(path.join(base, sub), { maxDepth: 3, match: (n) => n.endsWith('.jsonl') })) {
      const mtimeMs = mtimeMsOf(file);
      if (mtimeMs == null) continue;
      let sessionId = path.basename(file, '.jsonl');
      let cwd = null;
      let title = null;
      for (const l of readHeadLines(file)) {
        let rec;
        try { rec = JSON.parse(l); } catch { continue; }
        if (!rec || typeof rec !== 'object' || rec.type !== 'session_start') continue;
        if (typeof rec.id === 'string' && rec.id) sessionId = rec.id;
        if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
        if (typeof rec.title === 'string' && rec.title.trim()) title = rec.title;
        break;
      }
      const descId = `${id}:${sessionId}`;
      if (seen.has(descId)) continue;
      seen.add(descId);
      out.push({
        id: descId,
        tool: id,
        kind: 'jsonl-tail',
        file,
        cwd,
        label: title ? (cleanTitle(title, 80) ?? title.slice(0, 80)) : null,
        mtimeMs,
      });
    }
  }
  return out;
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function metaEvents(obj, sessionId) {
  const out = [];
  if (typeof obj.cwd === 'string' && obj.cwd) out.push({ kind: 'meta', lane: 'feed', label: 'cwd', path: obj.cwd, sessionId });
  if (typeof obj.model === 'string' && obj.model) out.push({ kind: 'meta', lane: 'feed', label: 'model', model: obj.model, sessionId });
  return out;
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

  switch (obj.type) {
    case 'session_start':
      return typeof obj.cwd === 'string' && obj.cwd
        ? [{ kind: 'meta', lane: 'feed', label: 'cwd', path: obj.cwd, sessionId }]
        : [];
    case 'system':
      return metaEvents(obj, sessionId);
    case 'tool_call':
      return typeof obj.toolName === 'string' && obj.toolName
        ? [toolCallEvent(obj.toolName, obj.parameters, ts, sessionId, { shell: SHELL_RE, edit: EDIT_RE })]
        : [];
    case 'message': {
      const role = obj.role ?? obj.message?.role;
      if (role === 'user') {
        const flat = typeof obj.text === 'string' ? obj.text : null;
        const text = flat ?? contentBlocks(obj.message?.content)
          .filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        const ev = userEvent(text, ts, sessionId);
        return ev ? [ev] : [];
      }
      if (role === 'assistant') {
        const out = [];
        for (const b of contentBlocks(obj.message?.content)) {
          if (!b || b.type !== 'tool_use') continue;
          out.push(toolCallEvent(b.name, b.input, ts, sessionId, { shell: SHELL_RE, edit: EDIT_RE }));
        }
        return out;
      }
      return [];
    }
    default:
      return [];
  }
}

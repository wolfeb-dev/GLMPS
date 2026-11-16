// server/lib/adapters/grok.js
// Grok CLI adapter. Ported from the Grok session layout and record parsing in
// Orca (https://github.com/stablyai/orca, MIT, see THIRD_PARTY_NOTICES.md):
// src/main/ai-vault/session-scanner-agent-sources.ts, session-scanner-grok-parser.ts,
// session-scanner-grok-user-text.ts and src/shared/grok-session-paths.ts.
// base = P.grokDir ($GLMPS_GROK_DIR, else $GROK_HOME, else ~/.grok). Each session is
// a dir under sessions/ (nested by encoded cwd) holding:
//   summary.json        { info:{id,cwd}, generated_title, current_model_id, ... }
//   chat_history.jsonl  one record per line: { type:'user'|'assistant', content, timestamp }
// We tail chat_history.jsonl (jsonl-tail) and read cwd/title from summary.json at
// discover time. Orca extracts user/assistant text only, and the records Orca's
// tests show carry no tool-call blocks, so this adapter emits `User:` prompt
// events and nothing for assistant rows. The model (current_model_id) lives in
// summary.json, outside the tailed file, so it is not emitted as a meta event.
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf, readJsonFile, walkFiles } from './fs-util.js';
import { userEvent } from './event-build.js';

export const id = 'grok';
export const displayName = 'Grok';
export const controllable = false;

const SUMMARY = 'summary.json';
const HISTORY = 'chat_history.jsonl';

export function detect(P) {
  const base = P?.grokDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  return { installed: isDirectory(path.join(base, 'sessions')), dataDirs: [base] };
}

export function discover(P) {
  const base = P?.grokDir;
  if (typeof base !== 'string') return [];
  const out = [];
  for (const summaryFile of walkFiles(path.join(base, 'sessions'), { maxDepth: 3, match: (n) => n === SUMMARY })) {
    const dir = path.dirname(summaryFile);
    const file = path.join(dir, HISTORY);
    const mtimeMs = mtimeMsOf(file);
    if (mtimeMs == null) continue; // summary only: nothing to tail yet
    const summary = readJsonFile(summaryFile);
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    const info = summary.info && typeof summary.info === 'object' ? summary.info : {};
    const sessionId = typeof info.id === 'string' && info.id ? info.id : path.basename(dir);
    const cwd = typeof info.cwd === 'string' && info.cwd ? info.cwd : null;
    const title = [summary.generated_title, summary.session_summary].find(t => typeof t === 'string' && t.trim());
    out.push({
      id: `${id}:${sessionId}`,
      tool: id,
      kind: 'jsonl-tail',
      file,
      cwd,
      label: title ? (cleanTitle(title, 80) ?? title.slice(0, 80)) : null,
      mtimeMs,
    });
  }
  return out;
}

function flattenUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') { parts.push(item); continue; }
    if (!item || typeof item !== 'object') continue;
    if (typeof item.type === 'string' && item.type !== 'text') continue;
    if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.length ? parts.join('\n') : null;
}

// Grok wraps the real ask in <user_query>; a missing closer can be a partial
// write, so keep everything after the opener.
function stripUserQueryEnvelope(text) {
  const lower = text.toLowerCase();
  const start = lower.indexOf('<user_query>');
  if (start === -1) return text;
  const bodyStart = start + '<user_query>'.length;
  const end = lower.indexOf('</user_query>', bodyStart);
  return (end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end)).trim();
}

// The first user row is often bootstrap context (<user_info> plus an optional
// <git_status> snapshot) with no prompt in it.
function isBootstrapOnly(text) {
  const t = text.trim().toLowerCase();
  if (!t.startsWith('<user_info>')) return false;
  const end = t.indexOf('</user_info>');
  if (end === -1) return !t.includes('<user_query>');
  const rest = t.slice(end + '</user_info>'.length).trim();
  return rest.length === 0 || (rest.startsWith('<git_status>') && rest.endsWith('</git_status>'));
}

/** jsonl-tail: one line -> events[] (canonical {kind,lane,label,path,tool,ts,sessionId}). */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; } // transient partial read, not drift
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (Object.keys(obj).length === 0) return [];

  if (typeof obj.type !== 'string') {
    reportMiss(id, 'chat_history record missing string type');
    return [];
  }
  if (obj.type !== 'user') return [];

  const raw = flattenUserContent(obj.content);
  if (!raw || isBootstrapOnly(raw)) return [];
  const ev = userEvent(stripUserQueryEnvelope(raw), obj.timestamp ?? null, sessionId);
  return ev ? [ev] : [];
}

// server/lib/adapters/cursor-cli.js
// SPECULATIVE (capture-registry `speculative: true`): the tool_use shape below is
// not confirmed by Orca or by a real transcript; the fixture matches the guess.
// Cursor CLI (cursor-agent) adapter. Ported from the Cursor session layout and
// record parsing in Orca (https://github.com/stablyai/orca, MIT, see
// THIRD_PARTY_NOTICES.md): src/main/ai-vault/session-scanner-agent-sources.ts,
// session-scanner-cursor-parser.ts and session-scanner-cursor-chat-meta.ts.
// base = P.cursorDir ($GLMPS_CURSOR_DIR, else ~/.cursor).
//   projects/<project>/agent-transcripts/<chatId>/<chatId>.jsonl
//       one record per line: { role: 'user'|'assistant', message: { content } }
//       content is a string or an array of { type:'text', text } blocks
//   chats/<workspaceHash>/<chatId>/meta.json   { cwd, title, createdAtMs, updatedAtMs }
// We tail the transcript (jsonl-tail) and read cwd/title from meta.json at
// discover time. Orca itself only reads user/assistant text and metadata. Tool
// calls are emitted from assistant `tool_use` content blocks when a record
// carries them (Cursor names them Shell, Read, StrReplace, Write, ...); that
// block shape is NOT confirmed by Orca's tests, so the committed sample
// transcript is sanitized from Orca's record shapes plus that assumption.
// Records carry no timestamp or model, so events have ts null and no meta.
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf, readJsonFile, walkFiles } from './fs-util.js';
import { userEvent, toolCallEvent } from './event-build.js';

export const id = 'cursor-cli';
export const displayName = 'Cursor CLI';
export const controllable = false;

const SHELL_RE = /^(shell|bash|run_terminal_cmd|terminal)$/i;
const EDIT_RE = /^(write|strreplace|str_replace|edit|edit_file|delete|editnotebook|apply_patch|multiedit)$/i;

export function detect(P) {
  const base = P?.cursorDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  return { installed: isDirectory(path.join(base, 'projects')), dataDirs: [base] };
}

/** chatId -> { cwd, title } for every chats/<workspaceHash>/<chatId>/meta.json. */
function readChatMetas(base) {
  const out = new Map();
  const files = walkFiles(path.join(base, 'chats'), { maxDepth: 2, match: (n) => n === 'meta.json' });
  for (const f of files) {
    const chatId = path.basename(path.dirname(f));
    if (out.has(chatId)) continue;
    const m = readJsonFile(f);
    if (m && typeof m === 'object') out.set(chatId, m);
  }
  return out;
}

export function discover(P) {
  const base = P?.cursorDir;
  if (typeof base !== 'string') return [];
  const root = path.join(base, 'projects');
  if (!isDirectory(root)) return [];
  const files = walkFiles(root, {
    maxDepth: 4,
    match: (name, full) => name.endsWith('.jsonl') && path.relative(root, full).split(path.sep).includes('agent-transcripts'),
  });
  if (files.length === 0) return [];
  const metas = readChatMetas(base);
  const out = [];
  for (const file of files) {
    const mtimeMs = mtimeMsOf(file);
    if (mtimeMs == null) continue;
    const dir = path.dirname(file);
    const chatId = path.basename(path.dirname(dir)) === 'agent-transcripts'
      ? path.basename(dir)
      : path.basename(file, '.jsonl');
    const meta = metas.get(chatId);
    const cwd = typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : null;
    const title = typeof meta?.title === 'string' && meta.title ? meta.title : null;
    out.push({
      id: `${id}:${chatId}`,
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

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function userQuery(text) {
  const m = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/i.exec(text);
  return (m ? m[1] : text).trim();
}

/** jsonl-tail: one line -> events[] (canonical {kind,lane,label,path,tool,ts,sessionId}). */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; } // transient partial read, not drift
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (Object.keys(obj).length === 0) return [];

  const role = obj.role;
  if (typeof role !== 'string') {
    reportMiss(id, 'transcript record missing string role');
    return [];
  }
  const ts = obj.timestamp ?? null;
  const blocks = contentBlocks(obj.message?.content ?? obj.content);

  if (role === 'user') {
    const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    const ev = userEvent(userQuery(text), ts, sessionId);
    return ev ? [ev] : [];
  }
  if (role === 'assistant') {
    const out = [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      out.push(toolCallEvent(b.name, b.input, ts, sessionId, { shell: SHELL_RE, edit: EDIT_RE }));
    }
    return out;
  }
  return [];
}

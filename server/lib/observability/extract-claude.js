// server/lib/observability/extract-claude.js
import { makeChange } from './change-capture.js';
import { classifyGit } from './git-events.js';
import { reportMiss } from '../adapters/health.js';

const CONTEXT_FILE_RE = /(^|[\\/])(CLAUDE|AGENTS|GEMINI|acceptance)\.md$/i;
const MEMORY_RE = /[\\/]memory[\\/][^\\/]+\.md$/i;

export function extractClaudeEvents(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (obj?.type === 'user') return extractUserPrompt(obj, sessionId);
  if (obj?.type !== 'assistant') return [];
  const content = obj.message?.content;
  if (!Array.isArray(content)) {
    // Assistant transcript lines always carry message.content blocks; a
    // missing/renamed field means the transcript schema drifted.
    reportMiss('claude-code', 'assistant record missing message.content array');
    return [];
  }
  const ts = obj.timestamp ?? null;
  const out = [];
  for (const item of content) {
    if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;
    out.push(classify(item, ts, sessionId));
  }
  return out;
}

// A transcript "user" line is either a real human-typed prompt or the
// harness echoing a tool's result back in (the turn immediately after an
// assistant tool_use, posted with role:'user' and message.content made of
// tool_result blocks). Only the former is a turn; counting the echo would
// inflate `turns` by one per tool call and recreate exactly the class of
// dead-metric bug this extractor exists to fix. Mirrors
// extract-antigravity.js's USER_INPUT handling: kind:'tool', tool:'user',
// label prefixed 'User: ' and capped at 120 chars.
function extractUserPrompt(obj, sessionId) {
  // isMeta lines are harness bookkeeping (slash-command echoes, caveat
  // notices), not a person typing - measured 2026-07-29: 20% of real
  // transcripts' non-tool_result 'user' lines carry isMeta:true. Skipping
  // here covers both content shapes below (string and array-with-text) in
  // one place, same as the tool_result-echo skip already does.
  if (obj.isMeta) return [];
  const content = obj.message?.content;
  if (typeof content !== 'string' && !Array.isArray(content)) {
    // A real transcript user line always carries message.content as a string
    // or a content-block array; anything else means the schema drifted.
    reportMiss('claude-code', 'user record missing message.content string/array');
    return [];
  }
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (!content.some(b => b?.type === 'tool_result')) {
    // Skip the whole line when any block is a tool_result echo; only pull
    // text out of a line that carries none.
    text = content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
  }
  if (!text) return [];
  const ts = obj.timestamp ?? null;
  return [{ kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
    label: 'User: ' + text.slice(0, 120) }];
}

function classify(item, ts, sessionId) {
  const { name, input = {} } = item;
  const base = { tool: name, ts, sessionId, path: input.file_path ?? null };
  if (name === 'Skill')
    return { ...base, kind: 'skill', lane: 'context', label: input.skill ?? 'unknown skill' };
  if (name === 'Agent' || name === 'Task')
    return { ...base, kind: 'agent', lane: 'context',
      agent: input.subagent_type ?? null,
      label: [input.subagent_type, input.description].filter(Boolean).join(': ') || 'subagent',
      model: input.model ?? null };
  if (name === 'Workflow')
    return { ...base, kind: 'agent', lane: 'context', agent: null, label: input.name ?? 'workflow', model: null };
  if (name.startsWith('mcp__'))
    return { ...base, kind: 'mcp', lane: 'context', label: name.replace(/^mcp__/, '') };
  const p = input.file_path ?? '';
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && CONTEXT_FILE_RE.test(p)) {
    const op = name === 'Read' ? 'read' : 'write';
    const change = op === 'write' ? buildChange(name, input) : undefined;
    const c = op === 'write' ? countEdit(name, input) : null;
    return { ...base, kind: 'context-file', lane: 'context', label: p, op, ...(change !== undefined && { change }), ...(c && { add: c.add, del: c.del }) };
  }
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && MEMORY_RE.test(p)) {
    const op = name === 'Read' ? 'read' : 'write';
    const change = op === 'write' ? buildChange(name, input) : undefined;
    const c = op === 'write' ? countEdit(name, input) : null;
    return { ...base, kind: 'memory', lane: 'context', label: p, op, ...(change !== undefined && { change }), ...(c && { add: c.add, del: c.del }) };
  }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit') {
    const c = countEdit(name, input);
    return { ...base, kind: 'file-edit', lane: 'feed', label: p || name, ...(c && { add: c.add, del: c.del }) };
  }
  if (name === 'Bash') {
    const g = classifyGit(input.command);
    if (g) return { ...base, ...g, ts, sessionId };
    return { ...base, kind: 'command', lane: 'feed', label: input.description ?? input.command ?? 'command' };
  }
  return { ...base, kind: 'tool', lane: 'feed', label: name };
}

function buildChange(name, input) {
  if (name === 'Edit') return makeChange(input.old_string, input.new_string);
  if (name === 'Write') return makeChange(null, input.content);
  // NotebookEdit: no tracked content
  return undefined;
}

// Approximate added/removed line counts for an edit, for the feed's +N/-M badge.
function lineCount(s) { return (typeof s === 'string' && s.length) ? s.split('\n').length : 0; }
function countEdit(name, input = {}) {
  if (name === 'Edit') return { add: lineCount(input.new_string), del: lineCount(input.old_string) };
  if (name === 'Write') return { add: lineCount(input.content), del: 0 };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let add = 0, del = 0;
    for (const e of input.edits) { add += lineCount(e?.new_string); del += lineCount(e?.old_string); }
    return { add, del };
  }
  return null; // NotebookEdit / unknown
}

// server/lib/adapters/event-build.js
// Canonical-event builders shared by the on-disk transcript adapters that read
// tool-call content blocks (cursor-cli, grok, pi, droid). Output is the common
// {kind,lane,label,path,tool,ts,sessionId} shape; callers own the format-specific
// parsing and only hand over a tool name, its argument object and a timestamp.
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../observability/git-events.js';

const COMMAND_KEYS = ['command', 'cmd', 'script', 'commandLine'];
const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'target_file', 'targetFile'];

export function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** A real user prompt as a feed event, or null when there is no text. */
export function userEvent(text, ts, sessionId) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return {
    kind: 'tool', lane: 'feed', tool: 'user', path: null, ts: ts ?? null, sessionId,
    label: 'User: ' + (cleanTitle(text, 120) ?? text.trim().slice(0, 120)),
  };
}

/**
 * One tool call -> one event. A call is a shell call when its name matches
 * `shell` or its arguments carry a command string; those become git or command
 * events with tool 'Bash'. Names matching `edit` become file-edit events.
 */
export function toolCallEvent(rawName, args, ts, sessionId, { shell = null, edit = null } = {}) {
  const name = typeof rawName === 'string' && rawName ? rawName : 'tool';
  const cmd = firstString(args, COMMAND_KEYS);
  if ((shell && shell.test(name)) || cmd) {
    if (cmd) {
      const g = classifyGit(cmd);
      if (g) return { ...g, tool: 'Bash', path: null, ts: ts ?? null, sessionId };
      return { kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts: ts ?? null, sessionId, label: cleanTitle(cmd, 120) ?? 'Bash' };
    }
    return { kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts: ts ?? null, sessionId, label: 'Bash' };
  }
  const p = firstString(args, PATH_KEYS);
  const kind = edit && edit.test(name) ? 'file-edit' : 'tool';
  return { kind, lane: 'feed', tool: name, path: p, ts: ts ?? null, sessionId, label: p ?? name };
}

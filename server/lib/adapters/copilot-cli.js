// server/lib/adapters/copilot-cli.js
// GitHub Copilot CLI adapter (distinct from copilot-chat, the VS Code extension).
// base = P.copilotCliDir ($GLMPS_COPILOT_CLI_DIR, else ~/.copilot). Each session is a
// dir under session-state/<uuid>/ containing:
//   events.jsonl  - append-only stream of {type,data,id,timestamp,parentId}
//   workspace.yaml - flat key:value metadata (cwd, repository, branch, name, ...)
// We tail events.jsonl (jsonl-tail kind, mirroring codex-cli) and read cwd/title
// from workspace.yaml at discover time.
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../observability/git-events.js';
import { reportMiss } from './health.js';
import { isDirectory, mtimeMsOf } from './fs-util.js';

export const id = 'copilot-cli';
export const displayName = 'GitHub Copilot CLI';
export const controllable = false;

export function detect(P) {
  const base = P?.copilotCliDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  return { installed: isDirectory(path.join(base, 'session-state')), dataDirs: [base] };
}

/**
 * Minimal flat-YAML reader for workspace.yaml: `key: value` per line, values
 * unquoted (may contain Windows backslashes/colons after the first ": "). Good
 * enough for the flat metadata Copilot writes; not a general YAML parser.
 */
function readWorkspaceMeta(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf-8');
    const out = {};
    for (const rawLine of raw.split(/\r?\n/)) {
      const idx = rawLine.indexOf(':');
      if (idx <= 0) continue;
      const key = rawLine.slice(0, idx).trim();
      const val = rawLine.slice(idx + 1).trim();
      if (key && !(key in out)) out[key] = val;
    }
    return out;
  } catch { return {}; }
}

export function discover(P) {
  const base = P?.copilotCliDir;
  const out = [];
  if (typeof base !== 'string') return out;
  const root = path.join(base, 'session-state');
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const file = path.join(dir, 'events.jsonl');
    const mtimeMs = mtimeMsOf(file);
    if (mtimeMs == null) continue; // no events.jsonl yet -> not a capturable session
    const meta = readWorkspaceMeta(dir);
    const cwd = typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : null;
    const name = typeof meta.name === 'string' && meta.name ? meta.name : null;
    out.push({
      id: `copilot-cli:${e.name}`,
      tool: id,
      kind: 'jsonl-tail',
      file,
      cwd,
      label: name,
      mtimeMs,
    });
  }
  return out;
}


// Shell-execution tools get normalised to 'Bash' (so git classification + the
// command lane apply). Copilot's exact shell tool name varies by version, so we
// detect structurally (name pattern OR a command-bearing argument) rather than
// against a fixed allowlist.
const SHELL_NAME_RE = /(^|_)(shell|bash|pwsh|powershell|sh|zsh|cmd|terminal|exec|run)($|_)/i;
const COMMAND_KEYS = ['command', 'cmd', 'script', 'commandLine', 'commandline'];
const PATH_KEYS = ['file_path', 'filePath', 'filepath', 'path', 'file', 'target_file', 'targetFile'];

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function isShellTool(name, args) {
  if (typeof name === 'string' && SHELL_NAME_RE.test(name)) return true;
  return firstString(args, COMMAND_KEYS) != null;
}

/** jsonl-tail: one line -> events[] (canonical {kind,lane,label,path,tool,ts,sessionId}). */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; } // transient partial read, not drift
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (Object.keys(obj).length === 0) return []; // empty {} is not a record

  const type = obj.type;
  if (typeof type !== 'string') {
    // Every Copilot event record carries a string `type`; its absence on an
    // otherwise-populated record is upstream schema drift.
    reportMiss(id, 'event record missing string type');
    return [];
  }
  const data = obj.data ?? {};
  const ts = obj.timestamp ?? null;

  switch (type) {
    case 'session.start': {
      const cwd = data?.context?.cwd ?? null;
      if (typeof cwd === 'string' && cwd) {
        return [{ kind: 'meta', lane: 'feed', label: 'cwd', path: cwd, sessionId }];
      }
      return [];
    }
    case 'assistant.turn_start':
    case 'session.model_change': {
      const model = data?.model ?? data?.newModel ?? null;
      if (typeof model === 'string' && model) {
        return [{ kind: 'meta', lane: 'feed', label: 'model', model, sessionId }];
      }
      return [];
    }

    case 'user.message': {
      // `content` is the clean prompt; `transformedContent` is the datetime/
      // system-reminder-wrapped copy - never surface that.
      const text = typeof data?.content === 'string' ? data.content : '';
      if (!text.trim()) return [];
      return [{
        kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
        label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
      }];
    }

    //    duplicate view and are dropped below) ---------------------------------
    case 'tool.execution_start': {
      const rawName = data?.toolName;
      if (typeof rawName !== 'string' || !rawName) {
        reportMiss(id, 'tool.execution_start missing toolName');
        return [];
      }
      const args = data?.arguments ?? {};
      if (isShellTool(rawName, args)) {
        const cmd = firstString(args, COMMAND_KEYS);
        if (cmd) {
          const g = classifyGit(cmd);
          if (g) return [{ ...g, tool: 'Bash', path: null, ts, sessionId }];
          return [{ kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts, sessionId, label: cleanTitle(cmd, 120) ?? 'Bash' }];
        }
        return [{ kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts, sessionId, label: 'Bash' }];
      }
      const p = firstString(args, PATH_KEYS);
      return [{ kind: 'tool', lane: 'feed', tool: rawName, path: p, ts, sessionId, label: p ?? rawName }];
    }

    // assistant.message / assistant.turn_end / tool.execution_complete /
    // hook.* / permission.* / system.message / session.info
    default:
      return [];
  }
}
